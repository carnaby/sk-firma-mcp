#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { RpoClient } from './clients/rpo.js';
import { RuzClient } from './clients/ruz.js';
import { DatasetIndex } from './clients/dataset-index.js';
import { DoveraClient } from './clients/dovera.js';
import { LruCache } from './cache.js';
import { CONFIG } from './config.js';

const cache = new LruCache<unknown>({ maxSize: CONFIG.cacheMaxSize });
const server = buildServer({
  rpo: new RpoClient(cache),
  ruz: new RuzClient(cache),
  index: new DatasetIndex(CONFIG.index.path),
  dovera: new DoveraClient(cache),
});

await server.connect(new StdioServerTransport());
console.error('sk-firma-mcp-server 0.1.0 beží (stdio)'); // logy VÝHRADNE na stderr
