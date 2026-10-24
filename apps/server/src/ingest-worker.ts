// Spúšťa sa ako child process (fork) — parsovanie ~100 MB XML/CSV by inak
// blokovalo event loop servera a API by počas ingestu neodpovedalo.
import { runIngest, printSummary } from '@skfirma/core';

try {
  printSummary(await runIngest());
  process.exit(0);
} catch (e) {
  console.error(`Ingest zlyhal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
