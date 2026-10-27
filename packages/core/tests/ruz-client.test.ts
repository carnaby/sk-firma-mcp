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

  it('IFRS firma: prázdne tabuľky ⇒ ifrs_pdf_only + PDF prílohy s rokom, typom a attachment URL', async () => {
    const pool = mockAgent.get(HOST);
    mockApi(pool, '/uctovne-jednotky', { 'zmenene-od': '2000-01-01', ico: '33333333' }, { id: [7] });
    mockApi(pool, '/uctovna-jednotka', { id: '7' }, { id: 7, ico: '33333333', nazovUJ: 'Firma Tri a. s.', idUctovnychZavierok: [11] });
    mockApi(pool, '/uctovna-zavierka', { id: '11' }, { id: 11, obdobieOd: '2025-01', obdobieDo: '2025-12', typ: 'Riadna', idUctovnychVykazov: [21, 22, 23, 24] });
    mockApi(pool, '/uctovny-vykaz', { id: '21' }, { id: 21, idSablony: 709, prilohy: [{ id: 101, meno: 'zavierka.pdf', velkostPrilohy: 2_749_694 }], obsah: { tabulky: [] } });
    mockApi(pool, '/uctovny-vykaz', { id: '22' }, { id: 22, idSablony: 742, prilohy: [{ id: 102, meno: 'scan_002.pdf', velkostPrilohy: 341_000 }], obsah: { tabulky: [] } });
    // meno súboru klame („IFRS…"), rozhoduje šablóna
    mockApi(pool, '/uctovny-vykaz', { id: '23' }, { id: 23, idSablony: 1166, prilohy: [{ id: 103, meno: 'IFRS_OS_2025.pdf', velkostPrilohy: 129_000 }], obsah: { tabulky: [] } });
    mockApi(pool, '/uctovny-vykaz', { id: '24' }, { id: 24, idSablony: 9999, prilohy: [{ id: 104, meno: 'Vybrané údaje - podnikatelia.PDF' }], obsah: { tabulky: [] } });
    mockApi(pool, '/sablona', { id: '709' }, { id: 709, nazov: 'IFRS účtovná závierka' });
    mockApi(pool, '/sablona', { id: '742' }, { id: 742, nazov: 'Správa audítora' });
    mockApi(pool, '/sablona', { id: '1166' }, { id: 1166, nazov: 'Oznámenie o dátume schválenia účtovnej závierky' });
    pool.intercept({ path: '/cruz-public/api/sablona', method: 'GET', query: { id: '9999' } }).reply(404, 'not found');

    const r = await new RuzClient(new LruCache({ maxSize: 100 })).financials('33333333', 3);
    expect(r.years).toHaveLength(0);
    expect(r.unavailable_reason).toBe('ifrs_pdf_only');
    expect(r.pdf_attachments.map((a) => [a.attachment_id, a.kind, a.year])).toEqual([
      [101, 'financial_statements', '2025'],
      [102, 'auditor_report', '2025'],
      [104, 'selected_data', '2025'], // šablóna nedostupná → fallback na meno súboru
      [103, 'approval_notice', '2025'], // formality na koniec
    ]);
    expect(r.pdf_attachments[0]).toMatchObject({
      label: 'Účtovná závierka', size_bytes: 2_749_694, period_to: '2025-12',
      url: 'https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/101',
    });
  }, 15_000); // 11 dopytov cez throttle ~2 req/s

  it('neznáme IČO ⇒ not_found', async () => {
    const pool = mockAgent.get(HOST);
    mockApi(pool, '/uctovne-jednotky', { 'zmenene-od': '2000-01-01', ico: '00000001' }, { id: [] });
    const r = await new RuzClient(new LruCache({ maxSize: 100 })).financials('00000001', 3);
    expect(r.unavailable_reason).toBe('not_found');
    expect(r.years).toHaveLength(0);
  });
});
