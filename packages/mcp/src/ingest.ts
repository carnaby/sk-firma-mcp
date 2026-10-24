#!/usr/bin/env node
// Postaví lokálny SQLite index dlžníkov a DPH zoznamov (SKFIRMA_INDEX_PATH).
import { runIngest, printSummary } from '@skfirma/core';

try {
  printSummary(await runIngest());
  process.exit(0); // undici keep-alive by inak držal proces
} catch (e) {
  console.error(`Ingest zlyhal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
