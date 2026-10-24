// Jeden HTTP proces pre všetko verejné:
//   /api/*  — JSON API pre web (živý test previerky)
//   /mcp    — remote MCP konektor (Streamable HTTP, bezstavový)
//   /*      — statický web (Vite build) so SPA fallbackom
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
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
}

export const DEFAULT_LIMITS: Limits = { apiPerMinute: 20, apiPerDay: 300, mcpPerMinute: 60, mcpPerDay: 1500 };

export interface AppOptions {
  deps: Deps;
  /** Adresár s buildom webu (index.html + assets). Bez neho sa servuje len API + MCP. */
  webDir?: string;
  trustProxy?: TrustProxy;
  limits?: Partial<Limits>;
}

export function createApp(opts: AppOptions): Hono {
  const { deps } = opts;
  const app = new Hono();
  const L = { ...DEFAULT_LIMITS, ...opts.limits };
  const trust = opts.trustProxy ?? 'none';
  const DAY = 24 * 3600_000;
  const api = [new RateLimiter({ limit: L.apiPerMinute, windowMs: 60_000 }), new RateLimiter({ limit: L.apiPerDay, windowMs: DAY })];
  const mcpL = [new RateLimiter({ limit: L.mcpPerMinute, windowMs: 60_000 }), new RateLimiter({ limit: L.mcpPerDay, windowMs: DAY })];

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

  const limited = (limiters: RateLimiter[]) => async (c: Context, next: () => Promise<void>) => {
    const ip = clientIp(c);
    for (const limiter of limiters) {
      const r = limiter.hit(ip);
      if (!r.allowed) {
        const retry = Math.ceil(r.retryAfterMs / 1000);
        c.header('Retry-After', String(retry));
        const msg = retry > 3600
          ? 'Dosiahol si denný limit previerok z jednej adresy. Skús to zajtra.'
          : 'Príliš veľa požiadaviek. Skús o chvíľu.';
        return c.json({ error: msg }, 429);
      }
    }
    await next();
  };

  // ---------- API ----------

  // health nelimitujeme (Docker healthcheck, monitoring) a nesiaha na zdroje
  app.use('/api/check', limited(api));
  app.use('/api/search', limited(api));

  app.get('/api/health', (c) => {
    const index = DATASET_NAMES.map((d) => {
      const m = deps.index.meta(d);
      return { dataset: d, as_of: m?.as_of ?? null, records: m?.record_count ?? null };
    });
    return c.json({ ok: true, version: SERVER_INFO.version, index_available: deps.index.available(), index, upstream: upstreamStats(), limits: L });
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
  app.all('/mcp', (c) => mcp(c.req.raw));

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
