import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { buildServer, type Deps } from '../src/server.js';
import type { SearchCandidate } from '@skfirma/core';
import type { VatRows } from '@skfirma/core';

const firma1Entity = JSON.parse(readFileSync(new URL('../../core/tests/fixtures/rpo-firma1.json', import.meta.url), 'utf8'));

const candidate: SearchCandidate = {
  ico: '11111111', name: 'Firma Jeden s. r. o.', address: 'Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto',
  psc: '81101', municipality: 'Bratislava - mestská časť Staré Mesto',
  status: 'active', established_on: '2018-01-02', terminated_on: null, rpo_id: 1000001,
};

const vatRows: VatRows = {
  payer: { ico: '11111111', ic_dph: 'SK7011111111', name: 'Firma Jeden s. r. o.', kind: '§4', registered_on: '2020-01-01', payer_since: '2020-01-01' },
  erased: null, risky: null, asOf: { payers: '2026-07-12', erased: '2026-07-12', risky: '2026-07-12' },
};

function deps(over: Partial<Deps> = {}): Deps {
  return {
    rpo: { searchByIco: async () => candidate, searchByName: async () => [candidate], getEntity: async () => firma1Entity },
    ruz: { financials: async () => ({ ico: '11111111', name: 'Firma Jeden s. r. o.', years: [], unavailable_reason: 'no_statements', pdf_statement_ids: [], as_of: '2026-07-13' }) },
    index: {
      available: () => true,
      vatStatus: () => vatRows,
      spDebt: () => ({ amount_eur: 4812.37, as_of: '2026-07-06' }),
      vszpDebt: () => null,
      taxDebtorCandidates: () => ({ candidates: [], as_of: '2026-05-31' }),
      meta: () => null,
    },
    dovera: { lookup: async () => ({ status: 'not_found', as_of: '2026-07-13' }) },
    now: () => new Date('2026-07-13'),
    ...over,
  };
}

async function callTool(d: Deps, name: string, args: Record<string, unknown>) {
  const server = buildServer(d);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  return res as { isError?: boolean; content: { type: string; text: string }[] };
}

describe('skfirma_vat_status', () => {
  it('platiteľ §4 markdown', async () => {
    const res = await callTool(deps(), 'skfirma_vat_status', { ico: '11111111' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/platiteľ.*§4/);
  });
  it('index chýba → akčná hláška o ingeste', async () => {
    const d = deps({ index: { ...deps().index, available: () => false, vatStatus: () => null } });
    const res = await callTool(d, 'skfirma_vat_status', { ico: '11111111' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/ingest/);
  });
  it('ico aj ic_dph súčasne → chyba', async () => {
    const res = await callTool(deps(), 'skfirma_vat_status', { ico: '11111111', ic_dph: 'SK7011111111' });
    expect(res.isError).toBe(true);
  });
});

describe('skfirma_debts', () => {
  it('markdown s tabuľkou dlhov (SP dlžník)', async () => {
    const res = await callTool(deps(), 'skfirma_debts', { ico: '11111111' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('4 812 €');
    expect(res.content[0].text).toMatch(/Union.*nedostup|⚠ Union/i);
  });
  it('json vráti DebtsData tvar', async () => {
    const res = await callTool(deps(), 'skfirma_debts', { ico: '11111111', response_format: 'json' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.creditors.sp.status).toBe('debtor');
    expect(parsed.total_known_debt_eur).toBe(4812.37);
  });
});

describe('skfirma_check so 4 sekciami', () => {
  it('default sections obsahujú dlhy aj DPH; SP dlh 4812 → debtor_major → 🔴', async () => {
    const res = await callTool(deps(), 'skfirma_check', { ico: '11111111' });
    const md = res.content[0].text;
    expect(md).toContain('🔴');
    expect(md).toContain('**DPH:**');
    expect(md).toMatch(/Sociálna poisťovňa/);
  });
  it('json obsahuje debts, vat a rozšírené sources', async () => {
    const res = await callTool(deps(), 'skfirma_check', { ico: '11111111', response_format: 'json' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.debts.creditors.sp.status).toBe('debtor');
    expect(parsed.vat.is_payer).toBe(true);
    expect(parsed.sources).toEqual(expect.arrayContaining(['FS OpenData', 'Sociálna poisťovňa']));
    expect(parsed.flags.map((f: { code: string }) => f.code)).toContain('debtor_major');
  });
  it('index nedostupný → debts/vat sekcie ⚠, verdikt max 🟠, profil sa zobrazí', async () => {
    const d = deps({ index: { available: () => false, vatStatus: () => null, spDebt: () => undefined, vszpDebt: () => undefined, taxDebtorCandidates: () => undefined, meta: () => null } });
    const res = await callTool(d, 'skfirma_check', { ico: '11111111' });
    const md = res.content[0].text;
    expect(md).toContain('⚠');
    expect(md).toContain('🟠');
    expect(md).toContain('Firma Jeden s. r. o.');
  });
  it('sections=[debts] + index nedostupný → 🟠 s ⚠, nikdy 🟢 (chýbajúci zdroj ≠ zelená)', async () => {
    const d = deps({
      index: { available: () => false, vatStatus: () => null, spDebt: () => undefined, vszpDebt: () => undefined, taxDebtorCandidates: () => undefined, meta: () => null },
      dovera: { lookup: async () => ({ status: 'unavailable', note: 'test' }) },
    });
    const res = await callTool(d, 'skfirma_check', { ico: '11111111', sections: ['debts'] });
    const md = res.content[0].text;
    expect(md).not.toContain('🟢');
    expect(md).toContain('🟠');
    expect(md).toContain('⚠');
  });
});
