// Stavba SQLite indexu: vždy nový súbor <out>.new + atomický swap.
// Datasety, ktoré tento beh nepriniesol (zlyhaný download / 304), sa
// prenesú z predchádzajúcej DB — posledný úspešný snapshot sa nikdy nemaže.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { normalizeName, normalizeObec } from '../domain/name-match.js';
import type {
  DatasetName, MetaRow, SpDebtorRow, TaxDebtorRow, VatErasedRow, VatPayerRow, VatRiskyRow, VszpDebtorRow,
} from './rows.js';

const SCHEMA = `
CREATE TABLE meta (
  dataset TEXT PRIMARY KEY, as_of TEXT NOT NULL, fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL, record_count INTEGER NOT NULL, etag TEXT
);
CREATE TABLE vat_payers (ico TEXT, ic_dph TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, registered_on TEXT, payer_since TEXT);
CREATE INDEX idx_vat_payers_ico ON vat_payers(ico); CREATE INDEX idx_vat_payers_icdph ON vat_payers(ic_dph);
CREATE TABLE vat_erased (ico TEXT, ic_dph TEXT NOT NULL, name TEXT, violation_year TEXT, published_on TEXT, erased_on TEXT);
CREATE INDEX idx_vat_erased_ico ON vat_erased(ico); CREATE INDEX idx_vat_erased_icdph ON vat_erased(ic_dph);
CREATE TABLE vat_risky (ico TEXT, ic_dph TEXT NOT NULL, name TEXT, violation_year TEXT, published_on TEXT);
CREATE INDEX idx_vat_risky_ico ON vat_risky(ico); CREATE INDEX idx_vat_risky_icdph ON vat_risky(ic_dph);
CREATE TABLE tax_debtors (name TEXT NOT NULL, name_norm TEXT NOT NULL, street TEXT, psc TEXT, obec TEXT, obec_norm TEXT, amount_eur REAL NOT NULL);
CREATE INDEX idx_tax_debtors_norm ON tax_debtors(name_norm);
CREATE TABLE sp_debtors (ico TEXT NOT NULL, name TEXT, address TEXT, city TEXT, amount_eur REAL NOT NULL);
CREATE INDEX idx_sp_debtors_ico ON sp_debtors(ico);
CREATE TABLE vszp_debtors (ico TEXT NOT NULL, name TEXT, city TEXT, psc TEXT, amount_eur REAL NOT NULL, payer_type TEXT, published_on TEXT);
CREATE INDEX idx_vszp_debtors_ico ON vszp_debtors(ico);
`;

export interface FreshDataset<T> { rows: T[]; meta: MetaRow }
export interface BuildInput {
  vat_payers?: FreshDataset<VatPayerRow>;
  vat_erased?: FreshDataset<VatErasedRow>;
  vat_risky?: FreshDataset<VatRiskyRow>;
  tax_debtors?: FreshDataset<Omit<TaxDebtorRow, 'name_norm' | 'obec_norm'>>;
  sp_debtors?: FreshDataset<SpDebtorRow>;
  vszp_debtors?: FreshDataset<VszpDebtorRow>;
}

// node:sqlite (na rozdiel od better-sqlite3) chýbajúci pomenovaný parameter
// ticho naviaže ako NULL. Chyba parsera by tak potichu vyrobila prázdne
// stĺpce — preto kontrolujeme, že riadok nesie každý parameter (null je OK).
type SqlValue = string | number | bigint | null | Uint8Array;
const paramNames = (sql: string): string[] => [...sql.matchAll(/@(\w+)/g)].map((m) => m[1]!);
function bindRow(row: Record<string, unknown>, params: string[], table: string): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const p of params) {
    const v = row[p];
    if (v === undefined) throw new Error(`Chýba hodnota '${p}' pre tabuľku ${table}.`);
    out[p] = v as SqlValue;
  }
  return out;
}

const ALL_DATASETS: DatasetName[] = ['vat_payers', 'vat_erased', 'vat_risky', 'tax_debtors', 'sp_debtors', 'vszp_debtors'];

const INSERTS: Record<DatasetName, string> = {
  vat_payers: 'INSERT INTO vat_payers (ico, ic_dph, name, kind, registered_on, payer_since) VALUES (@ico, @ic_dph, @name, @kind, @registered_on, @payer_since)',
  vat_erased: 'INSERT INTO vat_erased (ico, ic_dph, name, violation_year, published_on, erased_on) VALUES (@ico, @ic_dph, @name, @violation_year, @published_on, @erased_on)',
  vat_risky: 'INSERT INTO vat_risky (ico, ic_dph, name, violation_year, published_on) VALUES (@ico, @ic_dph, @name, @violation_year, @published_on)',
  tax_debtors: 'INSERT INTO tax_debtors (name, name_norm, street, psc, obec, obec_norm, amount_eur) VALUES (@name, @name_norm, @street, @psc, @obec, @obec_norm, @amount_eur)',
  sp_debtors: 'INSERT INTO sp_debtors (ico, name, address, city, amount_eur) VALUES (@ico, @name, @address, @city, @amount_eur)',
  vszp_debtors: 'INSERT INTO vszp_debtors (ico, name, city, psc, amount_eur, payer_type, published_on) VALUES (@ico, @name, @city, @psc, @amount_eur, @payer_type, @published_on)',
};

const META_INSERT = 'INSERT INTO meta (dataset, as_of, fetched_at, source_url, record_count, etag) VALUES (@dataset, @as_of, @fetched_at, @source_url, @record_count, @etag)';
const META_PARAMS = paramNames(META_INSERT);

export function buildDatabase(
  outPath: string,
  fresh: BuildInput,
  carryFromPath?: string,
): { written: DatasetName[]; carried: DatasetName[] } {
  const newPath = `${outPath}.new`;
  if (existsSync(newPath)) rmSync(newPath);
  const db = new DatabaseSync(newPath);
  const written: DatasetName[] = [];
  const carried: DatasetName[] = [];
  try {
    db.exec(SCHEMA);
    const insertMeta = db.prepare(META_INSERT);

    for (const dataset of ALL_DATASETS) {
      const freshSet = fresh[dataset];
      if (freshSet) {
        const stmt = db.prepare(INSERTS[dataset]);
        const params = paramNames(INSERTS[dataset]);
        db.exec('BEGIN');
        try {
          for (const row of freshSet.rows) {
            const r = dataset === 'tax_debtors'
              ? { ...row as Omit<TaxDebtorRow, 'name_norm' | 'obec_norm'>,
                  name_norm: normalizeName((row as { name: string }).name),
                  obec_norm: (row as { obec: string | null }).obec ? normalizeObec((row as { obec: string }).obec) : null }
              : row;
            stmt.run(bindRow(r as Record<string, unknown>, params, dataset));
          }
          insertMeta.run(bindRow({ ...freshSet.meta, record_count: freshSet.rows.length }, META_PARAMS, 'meta'));
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        written.push(dataset);
      }
    }

    if (carryFromPath && existsSync(carryFromPath)) {
      db.exec(`ATTACH DATABASE '${carryFromPath.replace(/'/g, "''")}' AS old`);
      for (const dataset of ALL_DATASETS) {
        if (fresh[dataset]) continue;
        const inOld = db.prepare("SELECT 1 FROM old.meta WHERE dataset = ?").get(dataset);
        if (!inOld) continue;
        db.exec(`INSERT INTO ${dataset} SELECT * FROM old.${dataset}`);
        db.exec(`INSERT INTO meta SELECT * FROM old.meta WHERE dataset = '${dataset}'`);
        carried.push(dataset);
      }
      db.exec('DETACH DATABASE old');
    }
  } finally {
    db.close();
  }

  try {
    if (existsSync(outPath)) rmSync(outPath);
    renameSync(newPath, outPath);
  } catch (e) {
    throw new Error(`Nepodarilo sa nahradiť ${outPath} — zavri MCP server/klienta a spusti ingest znova. (${String(e)})`);
  }
  return { written, carried };
}
