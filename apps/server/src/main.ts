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

const stopIngest = ingestHours > 0 ? scheduleIngest({ indexPath, intervalHours: ingestHours }) : () => {};

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.error(`${SERVER_INFO.name} ${SERVER_INFO.version} — http://localhost:${info.port} (web), /api, /mcp`);
});

// Node ako PID 1 v kontajneri nemá predvolené spracovanie signálov — bez
// tohto by `docker stop` (aj Watchtower pri update) čakal 10 s na SIGKILL.
// Bežiace dopyty dostanú max. SHUTDOWN_GRACE_MS, potom končíme natvrdo.
const SHUTDOWN_GRACE_MS = 5_000;
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[server] ${signal} — končím`);
  stopIngest();
  server.close(() => process.exit(0));
  if ('closeIdleConnections' in server) server.closeIdleConnections(); // keep-alive spojenia by close() blokovali
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
