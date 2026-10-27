// Read-only pohľad na lokálny SQLite index. Lazy open + reopen pri zmene
// mtime (ingest atomicky swapuje súbor — server nepotrebuje reštart).
// Chýbajúca DB nie je chyba: sekcie to prezentujú ako ⚠ + pokyn na ingest.
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import type { TaxDebtorCandidate } from '../domain/name-match.js';
import type { DatasetName, MetaRow, VatErasedRow, VatPayerRow, VatRiskyRow } from '../ingest/rows.js';

export interface VatRows {
  payer: VatPayerRow | null;
  erased: VatErasedRow | null;
  risky: VatRiskyRow | null;
  asOf: { payers: string | null; erased: string | null; risky: string | null };
}

export class DatasetIndex {
  private db: DatabaseSync | null = null;
  private openedMtime = 0;

  constructor(private dbPath: string) {}

  private open(): DatabaseSync | null {
    let mtime: number;
    try {
      mtime = statSync(this.dbPath).mtimeMs;
    } catch {
      this.db?.close();
      this.db = null;
      return null;
    }
    if (this.db && mtime === this.openedMtime) return this.db;
    this.db?.close();
    try {
      // readOnly bez CREATE → chýbajúci súbor je chyba, nie prázdna DB
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.openedMtime = mtime;
      return this.db;
    } catch {
      this.db = null;
      return null;
    }
  }

  available(): boolean {
    return this.open() !== null;
  }

  // Explicitné zatvorenie handle. Server (dlhožijúca inštancia) ho nepoužíva —
  // spolieha sa na lazy reopen pri zmene mtime. Ingest CLI ho potrebuje: číta
  // predchádzajúce etagy z tej istej cesty, ktorú vzápätí buildDatabase
  // atomicky nahrádza (rename); na Windowse otvorený readonly handle bez
  // FILE_SHARE_DELETE by rename zablokoval (EPERM/EBUSY).
  close(): void {
    this.db?.close();
    this.db = null;
    this.openedMtime = 0;
  }

  /** Najstarší čas úspešného overenia datasetu (fetched_at) — podľa neho sa hodnotí, či je index starý. */
  oldestFetchedAt(): string | null {
    const db = this.open();
    if (!db) return null;
    const row = db.prepare('SELECT MIN(fetched_at) AS t FROM meta').get() as unknown as { t: string | null } | undefined;
    return row?.t ?? null;
  }

  meta(dataset: DatasetName): MetaRow | null {
    const db = this.open();
    if (!db) return null;
    return (db.prepare('SELECT * FROM meta WHERE dataset = ?').get(dataset) as MetaRow | undefined) ?? null;
  }

  vatStatus(query: { ico?: string; icDph?: string }): VatRows | null {
    const db = this.open();
    if (!db) return null;
    const lookup = <T>(table: string): T | null => {
      if (query.icDph) {
        const byDph = db.prepare(`SELECT * FROM ${table} WHERE ic_dph = ?`).get(query.icDph) as T | undefined;
        if (byDph) return byDph;
      }
      if (query.ico) {
        return (db.prepare(`SELECT * FROM ${table} WHERE ico = ?`).get(query.ico) as T | undefined) ?? null;
      }
      return null;
    };
    return {
      payer: lookup<VatPayerRow>('vat_payers'),
      erased: lookup<VatErasedRow>('vat_erased'),
      risky: lookup<VatRiskyRow>('vat_risky'),
      asOf: {
        payers: this.meta('vat_payers')?.as_of ?? null,
        erased: this.meta('vat_erased')?.as_of ?? null,
        risky: this.meta('vat_risky')?.as_of ?? null,
      },
    };
  }

  private debtSum(table: 'sp_debtors' | 'vszp_debtors', ico: string): { amount_eur: number; as_of: string } | null | undefined {
    const db = this.open();
    if (!db) return undefined;
    const m = this.meta(table);
    if (!m) return undefined;
    const row = db.prepare(`SELECT SUM(amount_eur) AS total FROM ${table} WHERE ico = ?`).get(ico) as unknown as { total: number | null };
    if (row.total === null) return null;
    return { amount_eur: Math.round(row.total * 100) / 100, as_of: m.as_of };
  }

  spDebt(ico: string) { return this.debtSum('sp_debtors', ico); }
  vszpDebt(ico: string) { return this.debtSum('vszp_debtors', ico); }

  taxDebtorCandidates(nameNorm: string): { candidates: TaxDebtorCandidate[]; as_of: string } | undefined {
    const db = this.open();
    if (!db) return undefined;
    const m = this.meta('tax_debtors');
    if (!m) return undefined;
    const candidates = db
      .prepare('SELECT name, psc, obec_norm, amount_eur FROM tax_debtors WHERE name_norm = ?')
      .all(nameNorm) as unknown as TaxDebtorCandidate[];
    return { candidates, as_of: m.as_of };
  }
}
