import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { RuzClient } from '../src/clients/ruz.js';
import { LruCache } from '../src/cache.js';

let mockAgent: MockAgent;
let original: Dispatcher;
const HOST = 'https://www.registeruz.sk';

beforeEach(() => {
  original = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});
afterEach(async () => {
  setGlobalDispatcher(original);
  await mockAgent.close();
});

// Syntetická šablóna 687 len s riadkami, ktoré MAPPING používa.
const sablona687 = {
  id: 687,
  nazov: { sk: 'Úč MUJ' },
  tabulky: [
    { nazov: { sk: 'Strana aktív' }, riadky: [{ cisloRiadku: 1 }] },
    { nazov: { sk: 'Strana pasív' }, riadky: [{ cisloRiadku: 25 }, { cisloRiadku: 34 }] },
    { nazov: { sk: 'Výkaz ziskov a strát' }, riadky: [{ cisloRiadku: 1 }, { cisloRiadku: 2 }, { cisloRiadku: 3 }, { cisloRiadku: 38 }] },
  ],
};
// data: aktíva [bežné, minulé]; pasíva 2 riadky × 2 stĺpce; VZaS 4 riadky × 2 stĺpce
const vykaz687 = {
  id: 555, idSablony: 687, pristupnostDat: 'Verejné',
  obsah: {
    titulnaStrana: { ico: '11111111', nazovUctovnejJednotky: 'Firma Jeden s. r. o.', obdobieOd: '2024-01', obdobieDo: '2024-12', typUctovnejJednotky: 'MIKRO_UCTOVNA_JEDNOTKA' },
    tabulky: [
      { nazov: { sk: 'Strana aktív' }, data: ['1000', '900'] },
      { nazov: { sk: 'Strana pasív' }, data: ['300', '250', '700', '650'] },
      { nazov: { sk: 'Výkaz ziskov a strát' }, data: ['500', '450', '400', '350', '80', '70', '25', '20'] },
    ],
  },
};

function mockApi(pool: ReturnType<MockAgent['get']>, path: string, query: Record<string, string>, body: unknown) {
  pool.intercept({ path: `/cruz-public/api${path}`, query }).reply(200, body).persist();
}

describe('RuzClient.financials', () => {
  it('happy path: 1 rok mikro UJ', async () => {
    const pool = mockAgent.get(HOST);
    mockApi(pool, '/uctovne-jednotky', { 'zmenene-od': '2000-01-01', ico: '11111111' }, { id: [100001] });
    mockApi(pool, '/uctovna-jednotka', { id: '100001' }, { id: 100001, ico: '11111111', nazovUJ: 'Firma Jeden s. r. o.', idUctovnychZavierok: [901] });
    mockApi(pool, '/uctovna-zavierka', { id: '901' }, { id: 901, obdobieOd: '2024-01', obdobieDo: '2024-12', typ: 'Riadna', idUctovnychVykazov: [555] });
    mockApi(pool, '/uctovny-vykaz', { id: '555' }, vykaz687);
    mockApi(pool, '/sablona', { id: '687' }, sablona687);

    const r = await new RuzClient(new LruCache({ maxSize: 100 })).financials('11111111', 3);
    expect(r.unavailable_reason).toBeNull();
    expect(r.name).toBe('Firma Jeden s. r. o.');
    expect(r.years).toHaveLength(1);
    expect(r.years[0]).toMatchObject({
      period_label: '2024',
      template: 'mikro UJ',
      statement_id: 555,
      assets: 1000,   // r.01 bežné
      equity: 300,    // r.25 bežné
      liabilities: 700, // r.34 bežné
      revenue: 480,   // r.02 + r.03 = 400 + 80
      profit: 25,     // r.38 bežné
      negative_equity: false,
    });
  });

  it('IFRS firma: prázdne tabuľky ⇒ ifrs_pdf_only + pdf_statement_ids', async () => {
    const pool = mockAgent.get(HOST);
    mockApi(pool, '/uctovne-jednotky', { 'zmenene-od': '2000-01-01', ico: '33333333' }, { id: [7] });
    mockApi(pool, '/uctovna-jednotka', { id: '7' }, { id: 7, ico: '33333333', nazovUJ: 'Firma Tri a. s.', idUctovnychZavierok: [11] });
    mockApi(pool, '/uctovna-zavierka', { id: '11' }, { id: 11, obdobieOd: '2025-01', obdobieDo: '2025-12', typ: 'Riadna', idUctovnychVykazov: [21] });
    mockApi(pool, '/uctovny-vykaz', { id: '21' }, { id: 21, idSablony: 709, pristupnostDat: 'Verejné prílohy', prilohy: [{ id: 1, meno: 'zavierka.pdf' }], obsah: { tabulky: [] } });

    const r = await new RuzClient(new LruCache({ maxSize: 100 })).financials('33333333', 3);
    expect(r.years).toHaveLength(0);
    expect(r.unavailable_reason).toBe('ifrs_pdf_only');
    expect(r.pdf_statement_ids).toEqual([21]);
  });

  it('neznáme IČO ⇒ not_found', async () => {
    const pool = mockAgent.get(HOST);
    mockApi(pool, '/uctovne-jednotky', { 'zmenene-od': '2000-01-01', ico: '00000001' }, { id: [] });
    const r = await new RuzClient(new LruCache({ maxSize: 100 })).financials('00000001', 3);
    expect(r.unavailable_reason).toBe('not_found');
    expect(r.years).toHaveLength(0);
  });
});
