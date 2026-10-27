import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { buildServer, type Deps } from '../src/server.js';
import type { SearchCandidate, FinancialsResult } from '@skfirma/core';

const firma1Entity = JSON.parse(readFileSync(new URL('../../core/tests/fixtures/rpo-firma1.json', import.meta.url), 'utf8'));

const firma1Candidate: SearchCandidate = {
  ico: '11111111', name: 'Firma Jeden s. r. o.', address: 'Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto',
  psc: '81101', municipality: 'Bratislava - mestská časť Staré Mesto',
  status: 'active', established_on: '2018-01-02', terminated_on: null, rpo_id: 1000001,
};
const emptyFin: FinancialsResult = {
  ico: '11111111', name: 'Firma Jeden s. r. o.', years: [], unavailable_reason: 'no_statements',
  pdf_attachments: [], as_of: '2026-07-12',
};

function deps(over: Partial<Deps> = {}): Deps {
  return {
    rpo: {
      searchByIco: async (ico) => (ico === '11111111' ? firma1Candidate : null),
      searchByName: async () => [firma1Candidate],
      getEntity: async () => firma1Entity,
    },
    ruz: { financials: async () => emptyFin },
    index: {
      available: () => false, vatStatus: () => null, spDebt: () => undefined,
      vszpDebt: () => undefined, taxDebtorCandidates: () => undefined, meta: () => null,
    },
    dovera: { lookup: async () => ({ status: 'unavailable', note: 'test' }) },
    now: () => new Date('2026-07-12'),
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

describe('MCP tooly', () => {
  it('server registruje očakávané tooly s anotáciami', async () => {
    const server = buildServer(deps());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(ct);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining(['skfirma_search', 'skfirma_profile', 'skfirma_financials']));
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
    await client.close();
  });

  it('skfirma_search: IČO dopyt vráti 1 kandidáta v markdowne', async () => {
    const res = await callTool(deps(), 'skfirma_search', { query: '11111111' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Firma Jeden s. r. o.');
  });

  it('skfirma_search: prikrátky fulltext → akčná chyba v result objekte', async () => {
    const res = await callTool(deps(), 'skfirma_search', { query: 'ab' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/aspoň 3 znaky/);
  });

  it('skfirma_profile: zlé IČO → akčná chyba', async () => {
    const res = await callTool(deps(), 'skfirma_profile', { ico: '1234567' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/7 číslic, očakávam 8/);
  });

  it('skfirma_profile: happy path markdown', async () => {
    const res = await callTool(deps(), 'skfirma_profile', { ico: '11111111' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Firma Jeden s. r. o.');
    expect(res.content[0].text).toContain('CC-BY 4.0');
  });

  it('skfirma_financials: json formát vráti parsovateľný JSON', async () => {
    const res = await callTool(deps(), 'skfirma_financials', { ico: '11111111', response_format: 'json' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ico).toBe('11111111');
    expect(parsed.unavailable_reason).toBe('no_statements');
  });

  it('skfirma_profile include_history: raw bez bydlísk FO (GDPR)', async () => {
    const res = await callTool(deps(), 'skfirma_profile', { ico: '11111111', include_history: true, response_format: 'json' });
    expect(res.content[0].text).not.toContain('BYDLISKO'); // marker z fixture rpo-firma1.json
    expect(JSON.parse(res.content[0].text).raw).toBeDefined();
  });

  it('pád zdroja → generická hláška bez interných detailov', async () => {
    const d = deps({ rpo: { searchByIco: async () => { throw new Error('ECONNRESET super-secret-internal'); }, searchByName: async () => [], getEntity: async () => ({}) } });
    const res = await callTool(d, 'skfirma_profile', { ico: '11111111' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain('super-secret-internal');
    expect(res.content[0].text).toMatch(/nedostupný|neočakávane/);
  });
});
