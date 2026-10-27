// incomplete (⚪) = žiadny rizikový signál, ale kľúčová sekcia chýba alebo je len v PDF.
// Neúplnosť dát nie je riziko — nikdy nezhorší verdikt na 🟠/🔴.
export type Verdict = 'green' | 'orange' | 'red' | 'incomplete';

export interface Flag {
  code: string;
  detail: string;
  as_of: string | null;
  source: string;
}

export type EntityStatus =
  | 'active'
  | 'in_liquidation'
  | 'in_bankruptcy'
  | 'in_restructuring'
  | 'terminated';

export interface ProfileData {
  ico: string;
  name: string;
  legal_form: string | null;      // text, napr. "Spoločnosť s ručením obmedzeným"
  legal_form_code: string | null; // číselník CL000056, napr. "112"
  address: string | null;         // "Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto"
  established_on: string | null;  // ISO dátum
  terminated_on: string | null;
  status: EntityStatus;
  status_text: string | null;     // text z číselníka CL010108, napr. "V likvidácii" (null pri active/terminated bez stavu)
  status_since: string | null;    // validFrom právneho stavu
  executives: { name: string; role: string; since: string | null }[];
  shareholders: { name: string }[];
  main_activity: { code: string; name: string } | null; // SK NACE (CL010579)
  source_register: string | null; // napr. "Obchodný register"
  as_of: string;                  // dátum živého dopytu do RPO (ISO) — údaje platia k tomuto dňu
  record_modified_on: string | null; // RPO dbModificationDate — posledná zmena záznamu v registri
}

export interface SearchCandidate {
  ico: string | null;
  name: string;
  address: string | null;
  psc: string | null;          // PSČ aktuálnej adresy (pre FS match dlžníkov)
  municipality: string | null; // obec aktuálnej adresy
  status: 'active' | 'terminated'; // search nevracia legalStatuses (S1) — len zánik
  established_on: string | null;
  terminated_on: string | null;
  rpo_id: number;
}

export interface FinancialYear {
  period_from: string;  // "2024-01"
  period_to: string;    // "2024-12"
  period_label: string; // "2024" alebo "2024-04..2025-03" (hospodársky rok)
  template: string;     // "mikro UJ" | "malá UJ" | "veľká UJ" | "malá/veľká UJ"
  statement_id: number; // id účtovného výkazu v RÚZ (nie príloha — PDF je v pdf_attachments)
  revenue: number | null;
  profit: number | null;
  equity: number | null;
  assets: number | null;
  liabilities: number | null;
  liabilities_ratio: number | null; // (assets - equity) / assets, per S2 §4
  revenue_yoy: number | null;       // -0.42 = -42 %
  negative_equity: boolean;
}

export type FinancialsUnavailable =
  | 'ifrs_pdf_only'
  | 'unsupported_template'
  | 'no_statements'
  | 'not_found';

export interface FinancialsResult {
  ico: string;
  name: string | null;
  years: FinancialYear[];
  unavailable_reason: FinancialsUnavailable | null; // null = OK; nastavené, keď years je prázdne
  pdf_attachments: StatementAttachment[]; // PDF prílohy závierok bez štruktúrovaných dát (IFRS a pod.)
  as_of: string; // dátum dopytu (ISO)
}

export type AttachmentKind =
  | 'financial_statements' // účtovná závierka
  | 'auditor_report'       // správa audítora
  | 'selected_data'        // vybrané údaje
  | 'annual_report'        // výročná správa
  | 'notes'                // poznámky
  | 'approval_notice'      // oznámenie o dátume schválenia
  | 'other';

export interface StatementAttachment {
  year: string;            // rok podľa konca obdobia závierky, napr. "2025"
  period_to: string;       // "2025-12"
  kind: AttachmentKind;
  label: string;           // čitateľný typ, napr. "Účtovná závierka" (pri other názov šablóny RÚZ)
  name: string;            // meno súboru v RÚZ
  size_bytes: number | null;
  attachment_id: number;
  url: string;             // https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/<id>
}

// --- Fáza 2a: dlhy a DPH ---

// unavailable  = zdroj neodpovedal / chýba index (retryable podľa príčiny)
// parse_error  = odpoveď prišla, ale nevieme ju prečítať (zmena formátu) — opakovanie nepomôže
// not_supported = zdroj nemá verejné dáta (Union)
// unverifiable = dáta sú, ale dlh sa nedá jednoznačne priradiť (FS bez IČO)
export type CreditorStatus = 'debtor' | 'not_found' | 'unverifiable' | 'unavailable' | 'parse_error' | 'not_supported';

export interface CreditorDebt {
  status: CreditorStatus;
  amount_eur: number | null;   // len pri status='debtor'
  as_of: string | null;        // dátum stavu dát zdroja (k akému dňu zdroj zoznam zverejnil)
  match_confidence?: 'exact' | 'high'; // len FS pri status='debtor'
  retryable?: boolean;         // pri unavailable/parse_error/not_supported: má zmysel skúsiť znova?
  note?: string;               // ľudský popis dôvodu
}

export interface DebtsData {
  ico: string;
  name: string | null;
  creditors: {
    fs: CreditorDebt;
    sp: CreditorDebt;
    vszp: CreditorDebt;
    dovera: CreditorDebt;
    union: CreditorDebt; // v 2a vždy unavailable
  };
  total_known_debt_eur: number; // súčet amount_eur položiek so status='debtor'
  notes: string[];
}

export interface VatStatusData {
  query: string;               // dopytované IČO alebo IČ DPH
  name: string | null;
  registered: boolean;         // akýkoľvek záznam v zozname registrovaných
  is_payer: boolean;           // len §4/§4b/§5 (S3: §7/§7a nie sú platitelia)
  ic_dph: string | null;
  registration_kind: string | null; // '§4' | '§4b' | '§5' | '§7' | '§7a' | null
  registered_on: string | null;
  payer_since: string | null;
  erased: { published_on: string | null; erased_on: string | null; violation_year: string | null } | null;
  risky: { published_on: string | null; violation_year: string | null } | null;
  as_of: string | null;        // as_of datasetu vat_payers (resp. erased/risky pri zhode)
}

// --- úplnosť dát previerky (os nezávislá od rizika) ---

export type SectionCompleteness = 'ok' | 'missing' | 'not_requested';
export type FinancialsCompleteness = 'structured' | 'pdf_only' | 'unsupported' | 'no_statements' | 'missing' | 'not_requested';
export type CreditorCompleteness = 'ok' | 'unavailable' | 'unverifiable' | 'parse_error' | 'not_supported';

export interface Completeness {
  profile: SectionCompleteness;
  financials: FinancialsCompleteness;
  debts: Record<keyof DebtsData['creditors'], CreditorCompleteness> | 'missing' | 'not_requested';
  vat: SectionCompleteness;
}

/** Čerstvosť lokálneho indexu (dlhy, DPH). updated_at = najstaršie úspešné overenie datasetu. */
export interface IndexFreshness {
  updated_at: string | null; // ISO timestamp
  age_days: number | null;
  stale: boolean;            // starší ako CONFIG.index.staleDays
}
