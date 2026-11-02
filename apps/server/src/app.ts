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
import { createHash, timingSafeEqual } from 'node:crypto';

/** Porovnanie tokenu v konštantnom čase (hash vyrovná dĺžky). */
const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

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
  /** /api/check + /api/search na IP za minútu */
  apiPerMinute: number;
  /**
   * Previerky na IP za deň — SPOLOČNE pre web (/api) aj MCP (tools/call), lebo obe siahajú na štátne
   * zdroje. Drahšie volanie (viac rokov financií) spotrebuje viac jednotiek.
   */
  apiPerDay: number;
  /** /mcp na IP (všetky JSON-RPC správy) — jedno použitie nástroja v Claude = 2–4 správy */
  mcpPerMinute: number;
  mcpPerDay: number;
  /** tools/call na IP za minútu */
  mcpToolCallsPerMinute: number;
  /** IPv6: súhrnný denný strop previerok na sieť /48 (jeden poskytovateľ/zákazník má tisíce /64) */
  netPerDay: number;
}

export const DEFAULT_LIMITS: Limits = {
  apiPerMinute: 20, apiPerDay: 300, mcpPerMinute: 60, mcpPerDay: 1500, mcpToolCallsPerMinute: 20, netPerDay: 3000,
};

/** Cena volania nástroja v jednotkách denného limitu: financie za 10 rokov = 4× toľko dopytov na RÚZ. */
function toolCost(params: unknown): number {
  const p = (params ?? {}) as { name?: unknown; arguments?: { years?: unknown } };
  if (p.name !== 'skfirma_check' && p.name !== 'skfirma_financials') return 1;
  const years = typeof p.arguments?.years === 'number' ? p.arguments.years : 3;
  return Math.max(1, Math.ceil(years / 3));
}

/** Telo /mcp požiadavky — volanie nástroja má pár stoviek bajtov. */
const MCP_MAX_BODY_BYTES = 64 * 1024;

/**
 * Kľúč pre limity: IPv4 celá adresa, IPv6 prefix /64 — poskytovateľ prideľuje klientovi celú /64
 * a rotáciou adries v nej by sa limit dal obísť.
 */
export function rateKey(ip: string, prefix: 48 | 64 = 64): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, prefix / 16).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/${prefix}`;
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
  type Rule = { limiter: RateLimiter; net?: boolean };
  // denný limit previerok je jeden pre web aj MCP — inak by sa dal zdvojnásobiť striedaním kanálov
  const lookupsDay: Rule = { limiter: new RateLimiter({ limit: L.apiPerDay, windowMs: DAY }) };
  const lookupsNet: Rule = { limiter: new RateLimiter({ limit: L.netPerDay, windowMs: DAY }), net: true };
  const api: Rule[] = [{ limiter: new RateLimiter({ limit: L.apiPerMinute, windowMs: 60_000 }) }, lookupsDay, lookupsNet];
  const toolL: Rule[] = [{ limiter: new RateLimiter({ limit: L.mcpToolCallsPerMinute, windowMs: 60_000 }) }, lookupsDay, lookupsNet];
  const mcpL: Rule[] = [
    { limiter: new RateLimiter({ limit: L.mcpPerMinute, windowMs: 60_000 }) },
    { limiter: new RateLimiter({ limit: L.mcpPerDay, windowMs: DAY }) },
  ];

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

  /** null = povolené, inak { retry (s), msg } */
  const checkLimits = (c: Context, rules: Rule[], cost = 1): { retry: number; msg: string } | null => {
    const ip = clientIp(c);
    for (const { limiter, net } of rules) {
      const r = limiter.hit(rateKey(ip, net ? 48 : 64), cost);
      if (!r.allowed) {
        const retry = Math.ceil(r.retryAfterMs / 1000);
        c.header('Retry-After', String(retry));
        const msg = retry > 3600
          ? 'Dosiahol si denný limit previerok z jednej adresy. Skús to zajtra.'
          : `Príliš veľa požiadaviek. Skús o ${retry} s.`;
        return { retry, msg };
      }
    }
    return null;
  };
  const limited = (rules: Rule[]) => async (c: Context, next: () => Promise<void>) => {
    const denied = checkLimits(c, rules);
    if (denied) return c.json({ error: denied.msg }, 429);
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
      return { dataset: d, as_of: m?.as_of ?? null, fetched_at: m?.fetched_at ?? null, records: m?.record_count ?? null };
    });
    const pub = { ok: true, version: SERVER_INFO.version, index_available: deps.index.available(), index };
    // limity a spotrebu rozpočtu nevidí každý — útočník by z nich čítal, ako blízko je k vyčerpaniu
    const admin = !!opts.adminToken && safeEqual(c.req.header('authorization') ?? '', `Bearer ${opts.adminToken}`);
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
  app.use('/mcp', async (c, next) => {
    const denied = checkLimits(c, mcpL);
    if (denied) return c.json({ jsonrpc: '2.0', error: { code: -32000, message: denied.msg }, id: null }, 429);
    await next();
  });
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
    const call = msg as { method?: unknown; id?: unknown; params?: unknown } | null;
    if (call?.method === 'tools/call') {
      const denied = checkLimits(c, toolL, toolCost(call.params));
      // výsledok nástroja s isError: Claude ukáže používateľovi text, nie všeobecnú chybu transportu
      if (denied) {
        return c.json({ jsonrpc: '2.0', id: call.id ?? null, result: { content: [{ type: 'text', text: denied.msg }], isError: true } });
      }
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
