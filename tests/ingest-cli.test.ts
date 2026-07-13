import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, gzipSync, strToU8 } from 'fflate';
import { runIngest } from '../src/ingest/cli.js';
import { DatasetIndex } from '../src/clients/dataset-index.js';

let mockAgent: MockAgent;
let original: Dispatcher;
let dir: string;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ingest/${name}`, import.meta.url));

beforeEach(() => {
  original = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  dir = mkdtempSync(join(tmpdir(), 'skfirma-ingest-'));
});
afterEach(async () => {
  setGlobalDispatcher(original);
  await mockAgent.close();
  // DatasetIndex inštancie vytvorené v teste držia readonly sqlite handle
  // otvorený (Task 8 dizajn, pozri tests/dataset-index.test.ts) — na
  // Windowse to bráni zmazaniu tmp priečinka (EBUSY); neškodný leftover,
  // OS ho upratuje sám. Na POSIX rmSync prejde bez problémov.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: file locked by open sqlite handle */ }
});

function mockAll() {
  const fs = mockAgent.get('https://report.financnasprava.sk');
  const dphsZip = zipSync({ 'ds_dphs.xml': new Uint8Array(fixture('fs-dphs.xml')) });
  fs.intercept({ path: '/ds_dphs.zip' }).reply(200, Buffer.from(dphsZip), { headers: { etag: '"v1"' } });
  const dsddZip = zipSync({ 'ds_dsdd.xml': new Uint8Array(fixture('fs-dsdd.xml')) });
  fs.intercept({ path: '/ds_dsdd.zip' }).reply(200, Buffer.from(dsddZip), { headers: { etag: '"v2"' } });
  // dphv/dphz: zlyhajú (503) — test per-dataset izolácie
  fs.intercept({ path: '/ds_dphv.zip' }).reply(503, 'down');
  fs.intercept({ path: '/ds_dphz.zip' }).reply(503, 'down');

  const sp = mockAgent.get('https://www.socpoist.sk');
  sp.intercept({ path: '/nastroje-sluzby/zoznam-dlznikov' })
    .reply(200, '<html><a href="/api/idsp/download/12345678-1111-2222-3333-444444444444">Stiahnuť</a></html>');
  const spZip = zipSync({ 'dlznici_28_2026.csv': new Uint8Array(fixture('sp.csv')) });
  sp.intercept({ path: '/api/idsp/download/12345678-1111-2222-3333-444444444444' }).reply(200, Buffer.from(spZip));

  mockAgent.get('https://s3.eu-central-1.amazonaws.com')
    .intercept({ path: '/ekosystem-slovensko-digital-dumps/vszp.sql.gz' })
    .reply(200, Buffer.from(gzipSync(strToU8(readFileSync(new URL('./fixtures/ingest/vszp.sql', import.meta.url), 'utf8')))));
}

describe('runIngest E2E', () => {
  it('stiahne, rozparsuje a postaví index; zlyhané datasety nezhodia beh', async () => {
    mockAll();
    const indexPath = join(dir, 'index.sqlite');
    const summary = await runIngest({ indexPath, now: () => new Date('2026-07-13T05:00:00Z') });

    const byDataset = Object.fromEntries(summary.map((s) => [s.dataset, s]));
    expect(byDataset.vat_payers.status).toBe('fresh');
    expect(byDataset.tax_debtors.status).toBe('fresh');
    expect(byDataset.vat_erased.status).toBe('failed');
    expect(byDataset.vat_risky.status).toBe('failed');
    expect(byDataset.sp_debtors.status).toBe('fresh');
    expect(byDataset.vszp_debtors.status).toBe('fresh');

    const idx = new DatasetIndex(indexPath);
    expect(idx.vatStatus({ ico: '77777777' })?.payer?.kind).toBe('§4');
    expect(idx.spDebt('77777777')).toEqual({ amount_eur: 47.71, as_of: '2026-07-06' });
    expect(idx.vszpDebt('77777777')).toEqual({ amount_eur: 6797.01, as_of: '2026-07-12' });
    expect(idx.taxDebtorCandidates('firma sedem s r o')?.candidates).toHaveLength(1);
    expect(idx.meta('vat_payers')?.etag).toBe('"v1"');
  });

  it('druhý beh s 304 → not_modified a carry-over dát', async () => {
    mockAll();
    const indexPath = join(dir, 'index.sqlite');
    await runIngest({ indexPath, now: () => new Date('2026-07-13T05:00:00Z') });

    // druhé kolo: dphs vráti 304 (etag sedí), ostatné nech zlyhajú — všetko sa má preniesť
    const fs2 = mockAgent.get('https://report.financnasprava.sk');
    fs2.intercept({ path: '/ds_dphs.zip', headers: { 'if-none-match': '"v1"' } }).reply(304);
    fs2.intercept({ path: '/ds_dsdd.zip' }).reply(503, 'down');
    fs2.intercept({ path: '/ds_dphv.zip' }).reply(503, 'down');
    fs2.intercept({ path: '/ds_dphz.zip' }).reply(503, 'down');
    mockAgent.get('https://www.socpoist.sk').intercept({ path: '/nastroje-sluzby/zoznam-dlznikov' }).reply(503, 'down');
    mockAgent.get('https://s3.eu-central-1.amazonaws.com')
      .intercept({ path: '/ekosystem-slovensko-digital-dumps/vszp.sql.gz' }).reply(503, 'down');

    const summary2 = await runIngest({ indexPath, now: () => new Date('2026-07-14T05:00:00Z') });
    const byDataset = Object.fromEntries(summary2.map((s) => [s.dataset, s]));
    expect(byDataset.vat_payers.status).toBe('not_modified');
    expect(byDataset.sp_debtors.status).toBe('carried'); // download zlyhal, ale dáta sa preniesli zo starej DB

    const idx = new DatasetIndex(indexPath);
    expect(idx.vatStatus({ ico: '77777777' })?.payer?.kind).toBe('§4'); // carry-over
    expect(idx.spDebt('77777777')).toEqual({ amount_eur: 47.71, as_of: '2026-07-06' }); // carry-over
  });
});
