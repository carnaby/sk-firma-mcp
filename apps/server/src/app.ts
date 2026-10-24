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
  CONFIG, DATASET_NAMES, ToolError, isIcoLike,
  checkCompany, checkReportToJson, searchCompanies,
  type Deps, type ApiCheckResponse,
} from '@skfirma/core';
import { createMcpHttpHandler, renderCheckOutcome, SERVER_INFO } from 'sk-firma-mcp-server';
import { RateLimiter } from './rate-limit.js';

export interface AppOptions {
  deps: Deps;
  /** Adresár s buildom webu (index.html + assets). Bez neho sa servuje len API + MCP. */
  webDir?: string;
  /** Za reverse proxy (Fly, Railway, Caddy…) ber IP z X-Forwarded-For. */
  trustProxy?: boolean;
  /** Požiadavky na IP za minútu, zvlášť pre /api a /mcp. */
  rateLimitPerMinute?: number;
}

export function createApp(opts: AppOptions): Hono {
  const { deps } = opts;
  const app = new Hono();
  const limit = opts.rateLimitPerMinute ?? 30;
  const apiLimiter = new RateLimiter({ limit, windowMs: 60_000 });
  const mcpLimiter = new RateLimiter({ limit: limit * 2, windowMs: 60_000 }); // LLM klient volá viac nástrojov za sebou

  const clientIp = (c: Context): string => {
    if (opts.trustProxy) {
      const xff = c.req.header('x-forwarded-for');
      if (xff) return xff.split(',')[0]!.trim();
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const limited = (limiter: RateLimiter) => async (c: Context, next: () => Promise<void>) => {
    const r = limiter.hit(clientIp(c));
    if (!r.allowed) {
      c.header('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      return c.json({ error: 'Príliš veľa požiadaviek. Skús o chvíľu.' }, 429);
    }
    await next();
  };

  // ---------- API ----------

  app.use('/api/*', limited(apiLimiter));

  app.get('/api/health', (c) => {
    const index = DATASET_NAMES.map((d) => {
      const m = deps.index.meta(d);
      return { dataset: d, as_of: m?.as_of ?? null, records: m?.record_count ?? null };
    });
    return c.json({ ok: true, version: SERVER_INFO.version, index_available: deps.index.available(), index });
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
  app.use('/mcp', limited(mcpLimiter));
  app.all('/mcp', (c) => mcp(c.req.raw));

  // ---------- errors ----------

  app.onError((err, c) => {
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
