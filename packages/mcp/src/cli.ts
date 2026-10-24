#!/usr/bin/env node
// stdio vstup pre Claude Code / Claude Desktop (npx sk-firma-mcp-server).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDefaultDeps } from '@skfirma/core';
import { buildServer, SERVER_INFO } from './server.js';

const server = buildServer(createDefaultDeps());
await server.connect(new StdioServerTransport());
console.error(`${SERVER_INFO.name} ${SERVER_INFO.version} beží (stdio)`); // logy VÝHRADNE na stderr
