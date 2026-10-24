// Publikovateľné biny: @skfirma/core (privátny workspace) sa inlinuje,
// runtime závislosti z package.json ostávajú externé (better-sqlite3 je natívny).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: { cli: 'src/cli.ts', ingest: 'src/ingest.ts' },
  outdir: 'dist/bin',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]),
  logLevel: 'warning',
});
