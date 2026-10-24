#!/usr/bin/env node
// Živý akceptačný smoke: spustí server cez stdio a zavolá skfirma_check
// na sade prípadov definovaných v lokálnom (gitignored) súbore s testovacími dátami.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, existsSync } from 'node:fs';

const CASES_PATH = process.env.SKFIRMA_SMOKE_CASES ?? 'docs/smoke-cases.json';

if (!existsSync(CASES_PATH)) {
  console.error(`Chýba súbor s testovacími prípadmi: ${CASES_PATH}

Smoke test potrebuje lokálny (negitovaný) zoznam IČO, na ktorých overí
live odpoveď skfirma_check. Vytvor súbor podľa tejto šablóny (hodnoty sú
len ilustračné, nahraď ich reálnymi IČO z prostredia, kde smoke spúšťaš):

[
  { "ico": "12345678", "name": "Firma Jeden s. r. o.", "expect": ["🟢", "🟠"] },
  { "ico": "87654321", "name": "Firma Dva s. r. o.", "expect": ["🔴"] }
]

Cestu k súboru môžeš zmeniť premennou prostredia SKFIRMA_SMOKE_CASES.`);
  process.exit(2);
}

const CASES = JSON.parse(readFileSync(CASES_PATH, 'utf8'));

const transport = new StdioClientTransport({ command: 'node', args: [new URL('../dist/bin/cli.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

let failed = 0;
for (const c of CASES) {
  const res = await client.callTool({ name: 'skfirma_check', arguments: { ico: c.ico } });
  const md = res.content?.[0]?.text ?? '';
  const verdictOk = c.expect.some((v) => md.includes(v));
  const tokens = Math.ceil(md.length / 3);
  const budgetOk = tokens <= 1500;
  console.log(`\n=== ${c.name} (${c.ico}) — verdikt ${verdictOk ? 'OK' : 'FAIL'}, ~${tokens} tokenov ${budgetOk ? 'OK' : 'FAIL'} ===`);
  console.log(md);
  if (!verdictOk || !budgetOk) failed++;

  if (c.expect_debtor) {
    const dres = await client.callTool({ name: 'skfirma_debts', arguments: { ico: c.ico } });
    const dmd = dres.content?.[0]?.text ?? '';
    const dok = dmd.includes('dlžník');
    console.log(`\n=== DEBTS ${c.name} — ${dok ? 'OK' : 'FAIL'} ===\n${dmd}`);
    if (!dok) failed++;
  }
  if (c.expect_vat_payer) {
    const vres = await client.callTool({ name: 'skfirma_vat_status', arguments: { ico: c.ico } });
    const vmd = vres.content?.[0]?.text ?? '';
    const vok = vmd.includes('platiteľ');
    console.log(`\n=== VAT ${c.name} — ${vok ? 'OK' : 'FAIL'} ===\n${vmd}`);
    if (!vok) failed++;
  }
}
await client.close();
console.log(failed === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
