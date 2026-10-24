// Remote MCP (Streamable HTTP) v bezstavovom režime: každý request dostane
// vlastný server + transport. Nástroje sú read-only a idempotentné, takže
// session state netreba — a server sa dá škálovať bez sticky sessions.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer, type Deps } from './server.js';

export function createMcpHttpHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') {
      // Bez session nie je čo streamovať cez GET ani čo mazať cez DELETE.
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server, use POST).' }, id: null },
        { status: 405, headers: { Allow: 'POST' } },
      );
    }
    const server = buildServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(req);
    } finally {
      // enableJsonResponse = odpoveď je hotová až po spracovaní, takže zatvoriť je bezpečné
      void transport.close();
      void server.close();
    }
  };
}
