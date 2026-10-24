import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // testy idú proti zdrojákom, netreba najprv buildiť core
    alias: {
      '@skfirma/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      'sk-firma-mcp-server': fileURLToPath(new URL('./packages/mcp/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/server/tests/**/*.test.ts'],
    // živé testy proti reálnym API sa púšťajú len explicitne
    exclude: ['**/tests/live/**', '**/node_modules/**'],
  },
});
