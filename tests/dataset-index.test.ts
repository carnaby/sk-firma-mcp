import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDatabase } from '../src/ingest/db-build.js';
import { DatasetIndex } from '../src/clients/dataset-index.js';
import type { MetaRow } from '../src/ingest/rows.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skfirma-idx-')); });
afterEach(() => {
  // DatasetIndex zámerne drží readonly handle otvorený (Task 8 dizajn).
  // Na Windowse to bez explicitného close() (mimo verejného API) bráni
  // zmazaniu tmp priečinka (EBUSY) — neškodný leftover v %TEMP%, OS ho
  // upratuje sám; na POSIX rmSync prejde bez problémov.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: file locked by open sqlite handle */ }
});

const meta = (dataset: MetaRow['dataset'], asOf: string): MetaRow =>
  ({ dataset, as_of: asOf, fetched_at: '2026-07-13T05:00:00Z', source_url: 'https://example.test', record_count: 0, etag: null });

function makeDb(path: string) {
  buildDatabase(path, {
    vat_payers: { rows: [{ ico: '77777777', ic_dph: 'SK7077777777', name: 'Firma Sedem s. r. o.', kind: '§4', registered_on: '2020-10-11', payer_since: '2020-10-11' }], meta: meta('vat_payers', '2026-07-12') },
    vat_risky: { rows: [{ ico: '77777777', ic_dph: 'SK7077777777', name: 'Firma Sedem s. r. o.', violation_year: '2025', published_on: '2025-02-25' }], meta: meta('vat_risky', '2026-07-12') },
    sp_debtors: { rows: [
      { ico: '77777777', name: 'Firma Sedem s. r. o.', address: null, city: 'Bratislava', amount_eur: 30 },
      { ico: '77777777', name: 'Firma Sedem s. r. o.', address: null, city: 'Bratislava', amount_eur: 17.71 },
    ], meta: meta('sp_debtors', '2026-07-06') },
    tax_debtors: { rows: [{ name: 'Firma Sedem s. r. o.', amount_eur: 780, street: null, psc: '82101', obec: 'Bratislava', }], meta: meta('tax_debtors', '2026-05-31') },
  });
}

describe('DatasetIndex', () => {
  it('available=false a null/undefined výsledky, keď DB neexistuje', () => {
    const idx = new DatasetIndex(join(dir, 'missing.sqlite'));
    expect(idx.available()).toBe(false);
    expect(idx.vatStatus({ ico: '77777777' })).toBeNull();
    expect(idx.spDebt('77777777')).toBeUndefined();
  });

  it('vatStatus nájde payer aj risky podľa IČO a nesie as_of', () => {
    const path = join(dir, 'index.sqlite');
    makeDb(path);
    const idx = new DatasetIndex(path);
    const v = idx.vatStatus({ ico: '77777777' })!;
    expect(v.payer?.ic_dph).toBe('SK7077777777');
    expect(v.risky?.violation_year).toBe('2025');
    expect(v.erased).toBeNull();
    expect(v.asOf.payers).toBe('2026-07-12');
  });

  it('spDebt SUMuje riadky; vszpDebt bez datasetu → undefined; neexistujúce IČO → null', () => {
    const path = join(dir, 'index.sqlite');
    makeDb(path);
    const idx = new DatasetIndex(path);
    expect(idx.spDebt('77777777')).toEqual({ amount_eur: 47.71, as_of: '2026-07-06' });
    expect(idx.spDebt('88888888')).toBeNull();
    expect(idx.vszpDebt('77777777')).toBeUndefined(); // dataset nebol ingestnutý
  });

  it('taxDebtorCandidates vracia kandidátov podľa name_norm', () => {
    const path = join(dir, 'index.sqlite');
    makeDb(path);
    const idx = new DatasetIndex(path);
    const r = idx.taxDebtorCandidates('firma sedem s r o')!;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].amount_eur).toBe(780);
    expect(r.as_of).toBe('2026-05-31');
  });

  // better-sqlite3 na Windowse otvára súbor bez FILE_SHARE_DELETE, takže
  // atomický rename cez otvorený readonly handle (ktorý drží DatasetIndex)
  // zlyhá s EBUSY/EPERM — presne scenár, na ktorý upozorňuje chybová
  // hláška v buildDatabase (Task 7). Na POSIX funguje rename cez otvorený
  // fd bez problémov, čo je cieľová produkčná platforma.
  it.skipIf(process.platform === 'win32')('reopen po zmene súboru (mtime) — bez reštartu vidí nové dáta', async () => {
    const path = join(dir, 'index.sqlite');
    makeDb(path);
    const idx = new DatasetIndex(path);
    expect(idx.spDebt('88888888')).toBeNull();
    await new Promise((r) => setTimeout(r, 30)); // istota rozdielneho mtime
    buildDatabase(path, {
      sp_debtors: { rows: [{ ico: '88888888', name: 'Firma Osem a. s.', address: null, city: 'Košice', amount_eur: 5 }], meta: meta('sp_debtors', '2026-07-13') },
    });
    expect(idx.spDebt('88888888')).toEqual({ amount_eur: 5, as_of: '2026-07-13' });
  });
});
