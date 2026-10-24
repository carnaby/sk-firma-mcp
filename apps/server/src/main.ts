import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { CONFIG, createDefaultDeps } from '@skfirma/core';
import { SERVER_INFO } from 'sk-firma-mcp-server';
import { createApp, DEFAULT_LIMITS, type TrustProxy } from './app.js';

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseTrustProxy(v: string | undefined): TrustProxy {
  if (v === 'cloudflare') return 'cloudflare';
  if (v === 'xff' || v === '1') return 'xff';
  return 'none';
}
import { scheduleIngest } from './scheduler.js';

const env = process.env;
const port = Number(env.PORT ?? 8787);
const indexPath = CONFIG.index.path; // SKFIRMA_INDEX_PATH
const webDir = env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const ingestHours = Number(env.SKFIRMA_INGEST_INTERVAL_HOURS ?? 24);

const app = createApp({
  deps: createDefaultDeps({ indexPath }),
  webDir,
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  limits: {
    apiPerMinute: num(env.RATE_LIMIT_API_PER_MINUTE, DEFAULT_LIMITS.apiPerMinute),
    apiPerDay: num(env.RATE_LIMIT_API_PER_DAY, DEFAULT_LIMITS.apiPerDay),
    mcpPerMinute: num(env.RATE_LIMIT_MCP_PER_MINUTE, DEFAULT_LIMITS.mcpPerMinute),
    mcpPerDay: num(env.RATE_LIMIT_MCP_PER_DAY, DEFAULT_LIMITS.mcpPerDay),
  },
});

if (ingestHours > 0) scheduleIngest({ indexPath, intervalHours: ingestHours });

serve({ fetch: app.fetch, port }, (info) => {
  console.error(`${SERVER_INFO.name} ${SERVER_INFO.version} — http://localhost:${info.port} (web), /api, /mcp`);
});
