import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // živé testy proti reálnym API sa púšťajú len explicitne: vitest run --project live
    exclude: ['tests/live/**', 'node_modules/**'],
  },
});
