import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildDatabase } from '../src/ingest/db-build.js';
import type { MetaRow } from '../src/ingest/rows.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skfirma-db-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const meta = (dataset: MetaRow['dataset'], asOf = '2026-07-12'): MetaRow =>
  ({ dataset, as_of: asOf, fetched_at: '2026-07-13T05:00:00Z', source_url: 'https://example.test/x', record_count: 1, etag: null });

describe('buildDatabase', () => {
  it('postaví DB so schémou, dátami a meta; tax_debtors dostanú name_norm/obec_norm', () => {
    const out = join(dir, 'index.sqlite');
    const res = buildDatabase(out, {
      sp_debtors: { rows: [{ ico: '77777777', name: 'Firma Sedem s. r. o.', address: null, city: 'Bratislava', amount_eur: 47.71 }], meta: meta('sp_debtors', '2026-07-06') },
      tax_debtors: { rows: [{ name: '"Firma Sedem s. r. o."', amount_eur: 780, street: null, psc: '82101', obec: 'Bratislava - mestská časť Ružinov' }], meta: meta('tax_debtors', '2026-05-31') },
    });
    expect(res.written.sort()).toEqual(['sp_debtors', 'tax_debtors']);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(out + '.new')).toBe(false);
    const db = new DatabaseSync(out, { readOnly: true });
    expect(db.prepare('SELECT amount_eur FROM sp_debtors WHERE ico = ?').get('77777777')).toEqual({ amount_eur: 47.71 });
    expect(db.prepare('SELECT name_norm, obec_norm FROM tax_debtors').get()).toEqual({ name_norm: 'firma sedem s r o', obec_norm: 'bratislava' });
    expect(db.prepare("SELECT as_of FROM meta WHERE dataset = 'tax_debtors'").get()).toEqual({ as_of: '2026-05-31' });
    db.close();
  });

  it('carry-over: dataset chýbajúci vo fresh sa prenesie zo starej DB aj s meta', () => {
    const v1 = join(dir, 'v1.sqlite');
    buildDatabase(v1, {
      sp_debtors: { rows: [{ ico: '88888888', name: 'Firma Osem a. s.', address: null, city: 'Košice', amount_eur: 100 }], meta: meta('sp_debtors', '2026-06-29') },
      vszp_debtors: { rows: [{ ico: '88888888', name: 'Firma Osem a. s.', city: 'Košice', psc: '04001', amount_eur: 55, payer_type: 'Zamestnávateľ', published_on: '2026-07-01' }], meta: meta('vszp_debtors', '2026-07-01') },
    });
    const v2 = join(dir, 'v2.sqlite');
    const res = buildDatabase(v2, {
      sp_debtors: { rows: [{ ico: '88888888', name: 'Firma Osem a. s.', address: null, city: 'Košice', amount_eur: 120 }], meta: meta('sp_debtors', '2026-07-06') },
    }, v1);
    expect(res.written).toEqual(['sp_debtors']);
    expect(res.carried).toEqual(['vszp_debtors']);
    const db = new DatabaseSync(v2, { readOnly: true });
    expect(db.prepare('SELECT amount_eur FROM sp_debtors WHERE ico = ?').get('88888888')).toEqual({ amount_eur: 120 });
    expect(db.prepare('SELECT amount_eur FROM vszp_debtors WHERE ico = ?').get('88888888')).toEqual({ amount_eur: 55 });
    expect(db.prepare("SELECT as_of FROM meta WHERE dataset = 'vszp_debtors'").get()).toEqual({ as_of: '2026-07-01' });
    db.close();
  });

  it('riadok bez povinného stĺpca zhodí build (žiadne tiché NULL) a index nenahradí', () => {
    const out = join(dir, 'bad.sqlite');
    const row = { ico: '77777777', name: 'Firma Sedem s. r. o.', city: 'Bratislava', amount_eur: 1 } as never;
    expect(() => buildDatabase(out, { sp_debtors: { rows: [row], meta: meta('sp_debtors') } })).toThrow(/address/);
    expect(existsSync(out)).toBe(false);
  });
});
