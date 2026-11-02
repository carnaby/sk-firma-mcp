// Jeden HTTP proces pre všetko verejné:
//   /api/*  — JSON API pre web (živý test previerky)
//   /mcp    — remote MCP konektor (Streamable HTTP, bezstavový)
//   /*      — statický web (Vite build) so SPA fallbackom
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CONFIG, DATASET_NAMES, ToolError, BusyError, isIcoLike, upstreamStats,
  checkCompany, checkReportToJson, searchCompanies,
  type Deps, type ApiCheckResponse,
} from '@skfirma/core';
import { createMcpHttpHandler, renderCheckOutcome, SERVER_INFO } from 'sk-firma-mcp-server';
import { RateLimiter } from './rate-limit.js';

/**
 * Odkiaľ brať IP klienta (kľúč pre limity):
 * - 'none'       — priame spojenie (TCP adresa)
 * - 'cloudflare' — za Cloudflare Tunnel/proxy: hlavička CF-Connecting-IP
 * - 'xff'        — za vlastnou reverse proxy (Caddy, Traefik, nginx): POSLEDNÁ
 *                  položka X-Forwarded-For, tú pridala naša proxy. Prvá položka
 *                  je od klienta a dá sa podvrhnúť → obchádzanie limitu.
 */
export type TrustProxy = 'none' | 'cloudflare' | 'xff';

export interface Limits {
  /** /api/check + /api/search na IP */
  apiPerMinute: number;
  apiPerDay: number;
  /** /mcp na IP — jedno použitie nástroja v Claude = 2–4 JSON-RPC volania */
  mcpPerMinute: number;
  mcpPerDay: number;
  /** tools/call na IP — len tieto siahajú na štátne zdroje (initialize, tools/list sú lacné) */
  mcpToolCallsPerMinute: number;
  mcpToolCallsPerDay: number;
}

export const DEFAULT_LIMITS: Limits = {
  apiPerMinute: 20, apiPerDay: 300, mcpPerMinute: 60, mcpPerDay: 1500, mcpToolCallsPerMinute: 20, mcpToolCallsPerDay: 300,
};

/** Telo /mcp požiadavky — volanie nástroja má pár stoviek bajtov. */
const MCP_MAX_BODY_BYTES = 64 * 1024;

/**
 * Kľúč pre limity: IPv4 celá adresa, IPv6 prefix /64 — poskytovateľ prideľuje klientovi celú /64
 * a rotáciou adries v nej by sa limit dal obísť.
 */
export function rateKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export interface AppOptions {
  deps: Deps;
  /** Adresár s buildom webu (index.html + assets). Bez neho sa servuje len API + MCP. */
  webDir?: string;
  trustProxy?: TrustProxy;
  limits?: Partial<Limits>;
  /** Bearer token pre detailný /api/health (limity, spotreba upstream rozpočtu, IP). Bez neho len verejný stav. */
  adminToken?: string;
}

export function createApp(opts: AppOptions): Hono {
  const { deps } = opts;
  const app = new Hono();
  const L = { ...DEFAULT_LIMITS, ...opts.limits };
  const trust = opts.trustProxy ?? 'none';
  const DAY = 24 * 3600_000;
  const api = [new RateLimiter({ limit: L.apiPerMinute, windowMs: 60_000 }), new RateLimiter({ limit: L.apiPerDay, windowMs: DAY })];
  const mcpL = [new RateLimiter({ limit: L.mcpPerMinute, windowMs: 60_000 }), new RateLimiter({ limit: L.mcpPerDay, windowMs: DAY })];
  const toolL = [new RateLimiter({ limit: L.mcpToolCallsPerMinute, windowMs: 60_000 }), new RateLimiter({ limit: L.mcpToolCallsPerDay, windowMs: DAY })];

  const clientIp = (c: Context): string => {
    if (trust === 'cloudflare') {
      const ip = c.req.header('cf-connecting-ip');
      if (ip) return ip.trim();
    } else if (trust === 'xff') {
      const xff = c.req.header('x-forwarded-for');
      if (xff) return xff.split(',').at(-1)!.trim();
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  /** null = povolené, inak 429 odpoveď */
  const checkLimits = (c: Context, limiters: RateLimiter[]): Response | null => {
    const key = rateKey(clientIp(c));
    for (const limiter of limiters) {
      const r = limiter.hit(key);
      if (!r.allowed) {
        const retry = Math.ceil(r.retryAfterMs / 1000);
        c.header('Retry-After', String(retry));
        const msg = retry > 3600
          ? 'Dosiahol si denný limit previerok z jednej adresy. Skús to zajtra.'
          : 'Príliš veľa požiadaviek. Skús o chvíľu.';
        return c.json({ error: msg }, 429);
      }
    }
    return null;
  };
  const limited = (limiters: RateLimiter[]) => async (c: Context, next: () => Promise<void>) => {
    const denied = checkLimits(c, limiters);
    if (denied) return denied;
    await next();
  };

  // ---------- hlavičky ----------

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://analytics.carnaby.sk'],
      connectSrc: ["'self'", 'https://analytics.carnaby.sk'],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: false, // HSTS nastavuje TLS proxy pred nami
  }));

  // ---------- API ----------

  // health nelimitujeme (Docker healthcheck, monitoring) a nesiaha na zdroje
  app.use('/api/check', limited(api));
  app.use('/api/search', limited(api));

  app.get('/api/health', (c) => {
    const index = DATASET_NAMES.map((d) => {
      const m = deps.index.meta(d);
      return { dataset: d, as_of: m?.as_of ?? null, records: m?.record_count ?? null };
    });
    const pub = { ok: true, version: SERVER_INFO.version, index_available: deps.index.available(), index };
    // limity a spotrebu rozpočtu nevidí každý — útočník by z nich čítal, ako blízko je k vyčerpaniu
    const admin = !!opts.adminToken && c.req.header('authorization') === `Bearer ${opts.adminToken}`;
    return c.json(admin ? { ...pub, upstream: upstreamStats(), limits: L, client_ip: clientIp(c) } : pub);
  });

  app.get('/api/check', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ error: 'Zadaj IČO alebo názov firmy (parameter q).' }, 400);
    if (q.length > 200) return c.json({ error: 'Dopyt je pridlhý.' }, 400);
    const outcome = await checkCompany(deps, isIcoLike(q) ? { ico: q } : { name: q });
    const markdown = renderCheckOutcome(outcome);
    const body: ApiCheckResponse = outcome.kind === 'report'
      ? { kind: 'report', report: checkReportToJson(outcome), markdown }
      : { kind: 'ambiguous', query: outcome.query, total_count: outcome.total_count, candidates: outcome.candidates, markdown };
    return c.json(body);
  });

  app.get('/api/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length > 200) return c.json({ error: 'Dopyt je pridlhý.' }, 400);
    const r = await searchCompanies(deps, { query: q, limit: Math.min(Number(c.req.query('limit')) || 10, CONFIG.search.maxLimit) });
    return c.json(r);
  });

  app.all('/api/*', (c) => c.json({ error: 'Neznámy endpoint.' }, 404));

  // ---------- MCP ----------

  const mcp = createMcpHttpHandler(deps);
  app.use('/mcp', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
    exposeHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
  }));
  app.use('/mcp', limited(mcpL));
  app.use('/mcp', bodyLimit({
    maxSize: MCP_MAX_BODY_BYTES,
    onError: (c) => c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request too large.' }, id: null }, 413),
  }));
  app.all('/mcp', async (c) => {
    if (c.req.method !== 'POST') return mcp(c.req.raw);
    const text = await c.req.text();
    let msg: unknown;
    try { msg = JSON.parse(text); } catch { msg = null; }
    // batch by v jednom HTTP requeste (= 1 hit limitu) niesol desiatky volaní nástrojov; MCP 2025-06-18 ho aj tak nepodporuje
    if (Array.isArray(msg)) {
      return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'JSON-RPC batch is not supported, send one message per request.' }, id: null }, 400);
    }
    if ((msg as { method?: unknown } | null)?.method === 'tools/call') {
      const denied = checkLimits(c, toolL);
      if (denied) return denied;
    }
    return mcp(new Request(c.req.raw.url, { method: 'POST', headers: c.req.raw.headers, body: text }));
  });

  // ---------- errors ----------

  app.onError((err, c) => {
    if (err instanceof BusyError) {
      c.header('Retry-After', String(err.retryAfterSec));
      return c.json({ error: err.message }, 503);
    }
    if (err instanceof ToolError) return c.json({ error: err.message }, 400);
    console.error('[server] neošetrená chyba:', err);
    return c.json({ error: 'Zdroj je momentálne nedostupný alebo odpovedal neočakávane. Skús o chvíľu.' }, 502);
  });

  // ---------- web ----------

  if (opts.webDir && existsSync(join(opts.webDir, 'index.html'))) {
    const root = relative(process.cwd(), opts.webDir) || '.';
    const indexHtml = readFileSync(join(opts.webDir, 'index.html'), 'utf8');
    app.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable'); // hashované názvy z Vite
    });
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => c.html(indexHtml)); // SPA fallback
  }

  return app;
}
