import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { buildServer, type Deps } from '../src/server.js';
import type { FinancialsResult, SearchCandidate } from '@skfirma/core';

const likvidaciaEntity = JSON.parse(readFileSync(new URL('../../core/tests/fixtures/rpo-likvidacia.json', import.meta.url), 'utf8'));
const firma1Entity = JSON.parse(readFileSync(new URL('../../core/tests/fixtures/rpo-firma1.json', import.meta.url), 'utf8'));

const candidate = (ico: string, name: string, rpo_id: number): SearchCandidate =>
  ({ ico, name, address: 'Bratislava', psc: null, municipality: null, status: 'active', established_on: '2018-01-02', terminated_on: null, rpo_id });

const unavailableIndex = {
  available: () => false, vatStatus: () => null, spDebt: () => undefined,
  vszpDebt: () => undefined, taxDebtorCandidates: () => undefined, meta: () => null,
};
const unavailableDovera = { lookup: async () => ({ status: 'unavailable' as const, note: 'test' }) };

const healthyFin: FinancialsResult = {
  ico: '11111111', name: 'Firma Jeden s. r. o.',
  years: [{ period_from: '2024-01', period_to: '2024-12', period_label: '2024', template: 'mikro UJ', statement_id: 1,
    revenue: 1_388_372, profit: 7_791, equity: 78_955, assets: 1_060_405, liabilities: 981_450,
    liabilities_ratio: 0.9255, revenue_yoy: 0.05, negative_equity: false }],
  unavailable_reason: null, pdf_attachments: [], as_of: '2026-07-12',
};

async function call(d: Deps, args: Record<string, unknown>) {
  const server = buildServer(d);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  const res = await client.callTool({ name: 'skfirma_check', arguments: args });
  await client.close();
  return res as { isError?: boolean; content: { type: string; text: string }[] };
}

describe('skfirma_check', () => {
  it('firma v likvidácii → 🔴 verdikt s insolvency flagom a disclaimermi', async () => {
    const d: Deps = {
      rpo: { searchByIco: async () => candidate('55555555', 'Firma Päť s. r. o. v likvidácii', 100),
             searchByName: async () => [], getEntity: async () => likvidaciaEntity },
      ruz: { financials: async () => ({ ...healthyFin, ico: '55555555' }) },
      index: unavailableIndex,
      dovera: unavailableDovera,
      now: () => new Date('2026-07-12'),
    };
    const res = await call(d, { ico: '55555555' });
    const md = res.content[0].text;
    expect(md).toContain('🔴');
    expect(md).toContain('V likvidácii');
    expect(md).toMatch(/_Informatívny výstup/);
  });

  it('viacznačné meno → kandidáti, žiadny verdikt, nie je to error', async () => {
    const d: Deps = {
      rpo: { searchByIco: async () => null, getEntity: async () => firma1Entity,
             searchByName: async () => [candidate('33333330', 'STAV s.r.o.', 1), candidate('33333331', 'STAV plus s.r.o.', 2)] },
      ruz: { financials: async () => healthyFin },
      index: unavailableIndex,
      dovera: unavailableDovera,
      now: () => new Date('2026-07-12'),
    };
    const res = await call(d, { name: 'STAV' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('33333330');
    expect(res.content[0].text).toContain('33333331');
    expect(res.content[0].text).not.toContain('verdikt:');
    expect(res.content[0].text).toMatch(/presné IČO/);
  });

  it('pád RÚZ bez signálu → sekcia označená ⚠, verdikt ⚪ s dôvodom (nie 🟠), ostatné sekcie prítomné', async () => {
    const d: Deps = {
      rpo: { searchByIco: async () => candidate('11111111', 'Firma Jeden s. r. o.', 1000001),
             searchByName: async () => [], getEntity: async () => firma1Entity },
      ruz: { financials: async () => { throw new Error('RÚZ down'); } },
      index: unavailableIndex,
      dovera: unavailableDovera,
      now: () => new Date('2026-07-12'),
    };
    const res = await call(d, { ico: '11111111', sections: ['profile', 'financials'] });
    const md = res.content[0].text;
    expect(md).toContain('⚠ Sekcia financials');
    expect(md).toContain('⚪ NEDÁ SA POSÚDIŤ');
    expect(md).not.toContain('🟠');
    expect(md).toContain('**Dôvody:** Register účtovných závierok neodpovedal');
    expect(md).toContain('Firma Jeden s. r. o.');
  });

  it('ico aj name súčasne → akčná chyba', async () => {
    const d: Deps = {
      rpo: { searchByIco: async () => null, searchByName: async () => [], getEntity: async () => ({}) },
      ruz: { financials: async () => healthyFin },
      index: unavailableIndex,
      dovera: unavailableDovera,
    };
    const res = await call(d, { ico: '11111111', name: 'Firma Jeden' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/presne jedno/);
  });

  it('sections: [] nesmie vrátiť zelený verdikt bez dát (chýbajúci zdroj ≠ zelená)', async () => {
    const d: Deps = {
      rpo: { searchByIco: async () => candidate('11111111', 'Firma Jeden s. r. o.', 1000001),
             searchByName: async () => [], getEntity: async () => firma1Entity },
      ruz: { financials: async () => healthyFin },
      index: unavailableIndex,
      dovera: unavailableDovera,
      now: () => new Date('2026-07-12'),
    };
    // SDK zod validácia (min(1)) odmietne prázdne sections skôr, než sa spustí handler:
    // vráti isError namiesto vyhodenia (McpError -32602), ale nikdy nie zelený verdikt.
    let res: { isError?: boolean; content: { type: string; text: string }[] } | undefined;
    let rejected = false;
    try {
      res = await call(d, { ico: '11111111', sections: [] });
    } catch {
      rejected = true;
    }
    if (rejected) return;
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).not.toContain('🟢');
  });

  it('json formát obsahuje flags, verdict a disclaimer (Príloha A)', async () => {
    const d: Deps = {
      rpo: { searchByIco: async () => candidate('11111111', 'Firma Jeden s. r. o.', 1000001),
             searchByName: async () => [], getEntity: async () => firma1Entity },
      ruz: { financials: async () => healthyFin },
      index: unavailableIndex,
      dovera: unavailableDovera,
      now: () => new Date('2026-07-12'),
    };
    const res = await call(d, { ico: '11111111', response_format: 'json', sections: ['profile', 'financials'] });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ico).toBe('11111111');
    expect(['green', 'orange', 'red']).toContain(parsed.verdict);
    expect(Array.isArray(parsed.flags)).toBe(true);
    expect(parsed.disclaimer).toMatch(/Informatívny/);
    expect(parsed.sources).toContain('RPO (CC-BY 4.0, ŠÚ SR)');
  });
});
