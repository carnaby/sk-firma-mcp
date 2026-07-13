// Riadkové typy ingest -> SQLite. Názvy polí = stĺpce v DB (db-build.ts).
export interface VatPayerRow {
  ico: string | null;
  ic_dph: string;
  name: string;
  kind: string;                // DRUH_REG_DPH: §4 | §4b | §5 | §7 | §7a
  registered_on: string | null; // ISO
  payer_since: string | null;   // ISO; len skutoční platitelia (§4/§4b/§5)
}
export interface VatErasedRow {
  ico: string | null;
  ic_dph: string;
  name: string | null;
  violation_year: string | null;
  published_on: string | null;
  erased_on: string | null;
}
export interface VatRiskyRow {
  ico: string | null;
  ic_dph: string;
  name: string | null;
  violation_year: string | null;
  published_on: string | null;
}
export interface TaxDebtorRow {
  name: string;
  name_norm: string;
  street: string | null;
  psc: string | null;
  obec: string | null;
  obec_norm: string | null;
  amount_eur: number;
}
export interface SpDebtorRow {
  ico: string;
  name: string | null;
  address: string | null;
  city: string | null;
  amount_eur: number;
}
export interface VszpDebtorRow {
  ico: string;
  name: string | null;
  city: string | null;
  psc: string | null;
  amount_eur: number;
  payer_type: string | null;
  published_on: string | null;
}
export type DatasetName = 'vat_payers' | 'vat_erased' | 'vat_risky' | 'tax_debtors' | 'sp_debtors' | 'vszp_debtors';
export interface MetaRow {
  dataset: DatasetName;
  as_of: string;
  fetched_at: string;
  source_url: string;
  record_count: number;
  etag: string | null;
}
