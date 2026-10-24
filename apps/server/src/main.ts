import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { CONFIG, createDefaultDeps } from '@skfirma/core';
import { SERVER_INFO } from 'sk-firma-mcp-server';
import { createApp } from './app.js';
import { scheduleIngest } from './scheduler.js';

const env = process.env;
const port = Number(env.PORT ?? 8787);
const indexPath = CONFIG.index.path; // SKFIRMA_INDEX_PATH
const webDir = env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const ingestHours = Number(env.SKFIRMA_INGEST_INTERVAL_HOURS ?? 24);

const app = createApp({
  deps: createDefaultDeps({ indexPath }),
  webDir,
  trustProxy: env.TRUST_PROXY === '1',
  rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 30),
});

if (ingestHours > 0) scheduleIngest({ indexPath, intervalHours: ingestHours });

serve({ fetch: app.fetch, port }, (info) => {
  console.error(`${SERVER_INFO.name} ${SERVER_INFO.version} — http://localhost:${info.port} (web), /api, /mcp`);
});
