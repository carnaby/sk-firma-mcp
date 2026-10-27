import { describe, it, expect } from 'vitest';
import { fmtEur, fmtPct, renderCheck, renderDebts, renderFinancials, renderVatStatus, estimateTokens } from '../src/render/markdown.js';
import type { Completeness, DebtsData, FinancialsResult, Flag, ProfileData, StatementAttachment, VatStatusData, Verdict } from '../src/types.js';
import type { RiskResult } from '../src/domain/risk.js';

const FULL: Completeness = {
  profile: 'ok', financials: 'structured', vat: 'ok',
  debts: { fs: 'ok', sp: 'ok', vszp: 'ok', dovera: 'ok', union: 'not_supported' },
};
const risk = (verdict: Verdict, flags: Flag[] = [], incomplete: string[] = [], completeness: Completeness = FULL): RiskResult =>
  ({ verdict, flags, incomplete, completeness });

const debts = (over: Partial<DebtsData> = {}): DebtsData => ({
  ico: '12345678', name: 'Firma s.r.o.',
  creditors: {
    fs: { status: 'not_found', amount_eur: null, as_of: '2026-05-31' },
    sp: { status: 'not_found', amount_eur: null, as_of: null },
    vszp: { status: 'not_found', amount_eur: null, as_of: null },
    dovera: { status: 'not_found', amount_eur: null, as_of: '2026-07-13' },
    union: { status: 'not_supported', amount_eur: null, as_of: null, retryable: false, note: 'Union nemá verejný zoznam dlžníkov.' },
  },
  total_known_debt_eur: 0, notes: [], ...over,
});

const vat = (over: Partial<VatStatusData> = {}): VatStatusData => ({
  query: '12345678', name: 'Firma s.r.o.', registered: true, is_payer: true,
  ic_dph: 'SK7012345678', registration_kind: '§4', registered_on: '2020-01-01', payer_since: '2020-01-01',
  erased: null, risky: null, as_of: '2026-07-12', ...over,
});

const profile: ProfileData = {
  ico: '12345678', name: 'Firma s.r.o.', legal_form: 'Spoločnosť s ručením obmedzeným', legal_form_code: '112',
  address: 'Hlavná 1, 85101 Bratislava', established_on: '2019-03-01', terminated_on: null,
  status: 'active', status_text: null, status_since: null,
  executives: [{ name: 'Ján Novák', role: 'Konateľ', since: '2019-03-01' }],
  shareholders: [{ name: 'Ján Novák' }],
  main_activity: { code: '4120', name: 'Výstavba budov' },
  source_register: 'Obchodný register', as_of: '2026-07-12', record_modified_on: '2026-07-07',
};

const financials: FinancialsResult = {
  ico: '12345678', name: 'Firma s.r.o.',
  years: [
    { period_from: '2024-01', period_to: '2024-12', period_label: '2024', template: 'malá UJ', statement_id: 9,
      revenue: 96_000, profit: -21_000, equity: -18_400, assets: 210_000, liabilities: 248_000,
      liabilities_ratio: 1.0876, revenue_yoy: -0.4182, negative_equity: true },
    { period_from: '2023-01', period_to: '2023-12', period_label: '2023', template: 'malá UJ', statement_id: 8,
      revenue: 165_000, profit: 8_000, equity: 2_600, assets: 254_000, liabilities: 188_000,
      liabilities_ratio: 0.9898, revenue_yoy: null, negative_equity: false },
  ],
  unavailable_reason: null, pdf_attachments: [], as_of: '2026-07-12',
};

describe('formátovanie', () => {
  it('fmtEur', () => {
    expect(fmtEur(96_000)).toBe('96 000 €');
    expect(fmtEur(-18_400)).toBe('−18 400 €');
    expect(fmtEur(null)).toBe('—');
  });
  it('fmtPct', () => {
    expect(fmtPct(1.0876)).toBe('109 %');
    expect(fmtPct(-0.4182)).toBe('−42 %');
    expect(fmtPct(null)).toBe('—');
  });
});

describe('renderCheck', () => {
  const md = renderCheck({
    profile, financials, debts: null, vat: null,
    risk: risk('red', [
      { code: 'negative_equity', detail: '-18400 EUR (2024)', as_of: '2026-07-12', source: 'registeruz.sk' },
      { code: 'revenue_drop', detail: 'tržby -42 % YoY (2024)', as_of: '2026-07-12', source: 'registeruz.sk' },
    ]),
    failed_sections: [],
  });

  it('obsahuje povinné prvky §5.7', () => {
    expect(md).toContain('## Firma s.r.o. (IČO 12345678) — verdikt: 🔴 VYSOKÉ RIZIKO');
    expect(md).toContain('**Dôvody:**');
    expect(md).toContain('| 2024 | 96 000 € |');
    expect(md).toContain('RPO');
    expect(md).toContain('CC-BY 4.0');
    expect(md).toMatch(/_Informatívny výstup z verejných registrov, nie úverový rating.*_/);
  });

  it('zmestí sa do token budgetu ≤ 1500 (DoD)', () => {
    expect(estimateTokens(md)).toBeLessThanOrEqual(1500);
  });

  it('zlyhaná sekcia je viditeľná, nikdy ticho chýbajúca', () => {
    const md2 = renderCheck({ profile, financials: null, debts: null, vat: null, risk: risk('incomplete', [], ['Register účtovných závierok neodpovedal — financie chýbajú']), failed_sections: ['financials'] });
    expect(md2).toContain('⚠ Sekcia financials');
    expect(md2).toContain('⚪ NEDÁ SA POSÚDIŤ');
  });

  it('green verdikt: bez Dôvody a bez ⚠, s disclaimerom', () => {
    const md3 = renderCheck({ profile, financials, debts: null, vat: null, risk: risk('green'), failed_sections: [] });
    expect(md3).toContain('🟢 BEZ ZISTENÍ');
    expect(md3).not.toContain('**Dôvody:**');
    expect(md3).not.toContain('⚠');
    expect(md3).toMatch(/_Informatívny výstup z verejných registrov, nie úverový rating.*_/);
  });

  it('null profil: hlavička z financials, bez Identity, ⚠ sekcia profile', () => {
    const md4 = renderCheck({ profile: null, financials, debts: null, vat: null, risk: risk('incomplete', [], ['identita z RPO nie je dostupná (register neodpovedal)']), failed_sections: ['profile'] });
    expect(md4).toContain('## Firma s.r.o. (IČO 12345678)');
    expect(md4).not.toContain('**Identita:**');
    expect(md4).toContain('⚠ Sekcia profile');
  });
});

const att = (id: number, year: string, kind: StatementAttachment['kind'], label: string, size: number | null): StatementAttachment => ({
  year, period_to: `${year}-12`, kind, label, name: `${label}.pdf`, size_bytes: size, attachment_id: id,
  url: `https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/${id}`,
});
const ifrsAttachments = [
  att(1001, '2025', 'financial_statements', 'Účtovná závierka', 2_749_694),
  att(1002, '2025', 'auditor_report', 'Správa audítora', 341_000),
  att(1003, '2025', 'selected_data', 'Vybrané údaje', 1_900_000),
  att(1004, '2025', 'approval_notice', 'Oznámenie o schválení závierky', 129_000),
  att(1101, '2024', 'financial_statements', 'Účtovná závierka', 2_500_000),
  att(1201, '2023', 'financial_statements', 'Účtovná závierka', 2_400_000),
];
const ifrs: FinancialsResult = { ...financials, name: 'Firma Tri a. s.', ico: '33333333', years: [], unavailable_reason: 'ifrs_pdf_only', pdf_attachments: ifrsAttachments };

describe('renderFinancials — IFRS (len PDF)', () => {
  it('prílohy zoskupené podľa roku, najnovšie 2 roky, s typom, veľkosťou a attachment URL', () => {
    const md = renderFinancials(ifrs);
    expect(md).toContain('- 2025: Účtovná závierka (2,7 MB) https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/1001');
    expect(md).toContain('Správa audítora (341 kB)');
    expect(md).toContain('- 2024: Účtovná závierka (2,5 MB)');
    expect(md).toContain('- staršie roky (2023) vynechané');
    expect(md).not.toContain('/pdf/');
  });
  it('maxAttachmentYears=3 ukáže aj 2023', () => {
    expect(renderFinancials(ifrs, { maxAttachmentYears: 3 })).toContain('- 2023: Účtovná závierka');
  });
});

describe('renderCheck — IFRS firma bez signálu (snapshot)', () => {
  it('⚪ s dôvodom, veta o IFRS len raz, prílohy za 2 roky', () => {
    const md = renderCheck({
      profile: { ...profile, ico: '33333333', name: 'Firma Tri a. s.' }, financials: ifrs, debts: debts(), vat: vat(),
      risk: risk('incomplete', [], ['financie len v PDF (IFRS) — štruktúrované dáta nie sú k dispozícii'], { ...FULL, financials: 'pdf_only' }),
      failed_sections: [],
      index_freshness: { updated_at: '2026-07-12T03:00:00Z', age_days: 0, stale: false },
    });
    expect(md.match(/IFRS/g)).toHaveLength(2); // raz v Dôvodoch, raz vo Financiách
    expect(estimateTokens(md)).toBeLessThanOrEqual(1500);
    expect(md).toMatchInlineSnapshot(`
      "## Firma Tri a. s. (IČO 33333333) — verdikt: ⚪ NEDÁ SA POSÚDIŤ (neúplné dáta)

      **Dôvody:** financie len v PDF (IFRS) — štruktúrované dáta nie sú k dispozícii. Žiadny rizikový signál sme nezistili, ale bez týchto dát sa firma nedá posúdiť.

      **Identita:** Spoločnosť s ručením obmedzeným, Hlavná 1, 85101 Bratislava, vznik 2019-03-01.
      Štatutári: Ján Novák (od 2019).
      Hlavná činnosť: 4120 Výstavba budov.
      Stav: aktívna. [RPO, ŠÚ SR, CC-BY 4.0; živý dopyt 2026-07-12, posledná zmena záznamu v registri 2026-07-07]

      **Financie (RÚZ, živý dopyt 2026-07-12):** štruktúrované dáta nie sú k dispozícii — závierka je len v PDF (IFRS). Čísla sú v prílohách:
      - 2025: Účtovná závierka (2,7 MB) https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/1001 · Správa audítora (341 kB) https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/1002 · Vybrané údaje (1,9 MB) https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/1003 · Oznámenie o schválení závierky (129 kB) https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/1004
      - 2024: Účtovná závierka (2,5 MB) https://www.registeruz.sk/cruz-public/domain/financialreport/attachment/1101
      - staršie roky (2023) vynechané

      **Dlhy:** Finančná správa 0 € (zoznam k 2026-05-31), Sociálna poisťovňa 0 €, VšZP 0 €, Dôvera 0 € (zoznam k 2026-07-13).
      Union: nesledované. Union nemá verejný zoznam dlžníkov.

      **DPH:** platiteľ (§4, od 2020-01-01), IČ DPH SK7012345678.
      [FS OpenData, zoznam k 2026-07-12]

      _Lokálny index dlžníkov a DPH aktualizovaný 2026-07-12._

      _Informatívny výstup z verejných registrov, nie úverový rating ani právne posúdenie._"
    `);
  });
});

describe('renderDebts', () => {
  it('bez dlhov → jednoriadkový súhrn (šetrí tokeny)', () => {
    const md = renderDebts(debts());
    expect(md).toContain('**Dlhy:**');
    expect(md).not.toContain('| Veriteľ |');
    expect(md).toContain('Finančná správa 0 € (zoznam k 2026-05-31)');
    expect(md).toContain('Union: nesledované. Union nemá verejný zoznam dlžníkov.');
    expect(md).not.toMatch(/Union.*⚠|⚠.*Union/);
  });
  it('rozlišuje dočasnú nedostupnosť a chybu parsera', () => {
    const md = renderDebts(debts({ creditors: { ...debts().creditors,
      dovera: { status: 'unavailable', amount_eur: null, as_of: null, retryable: true, note: 'Dôvera odpovedala HTTP 429 — skús neskôr.' } } }));
    expect(md).toContain('⚠ Dôvera: dočasne nedostupné (skús neskôr).');
    const md2 = renderDebts(debts({ creditors: { ...debts().creditors,
      dovera: { status: 'parse_error', amount_eur: null, as_of: null, retryable: false, note: 'zmena formátu' } } }));
    expect(md2).toContain('⚠ Dôvera: chyba spracovania odpovede zdroja (nie dočasný výpadok, opakovanie nepomôže). zmena formátu');
  });
  it('s dlhom → tabuľka + prahy', () => {
    const d = debts({
      creditors: { ...debts().creditors, sp: { status: 'debtor', amount_eur: 4812.37, as_of: '2026-07-06' } },
      total_known_debt_eur: 4812.37,
    });
    const md = renderDebts(d);
    expect(md).toContain('| Veriteľ |');
    expect(md).toContain('4 812 €');
    expect(md).toMatch(/Prahy zverejnenia/);
  });
});

describe('renderVatStatus', () => {
  it('platiteľ §4', () => {
    expect(renderVatStatus(vat())).toMatch(/platiteľ.*§4/);
  });
  it('§7a nie je platiteľ', () => {
    const md = renderVatStatus(vat({ registration_kind: '§7a', is_payer: false }));
    expect(md).toMatch(/NIE JE platiteľ/);
  });
  it('vymazaný má 🔴 riadok', () => {
    const md = renderVatStatus(vat({ erased: { published_on: '2024-05-01', erased_on: '2024-06-01', violation_year: '2024' } }));
    expect(md).toContain('🔴');
    expect(md).toMatch(/§52 ods\. 8|vymazaný/);
  });
});

describe('renderCheck so 4 sekciami', () => {
  it('obsahuje dlhy aj DPH a zmestí sa do budgetu', () => {
    const md = renderCheck({
      profile, financials,
      debts: debts({ creditors: { ...debts().creditors, sp: { status: 'debtor', amount_eur: 4812.37, as_of: '2026-07-06' } }, total_known_debt_eur: 4812.37 }),
      vat: vat(),
      risk: risk('red', [{ code: 'debtor_major', detail: 'SP 4812.37 €', as_of: '2026-07-06', source: 'socpoist.sk' }]),
      failed_sections: [],
    });
    expect(md).toContain('| Veriteľ |');
    expect(md).toContain('**DPH:**');
    expect(estimateTokens(md)).toBeLessThanOrEqual(1500);
  });
});

describe('renderCheck — dátumy a čerstvosť (P1-2)', () => {
  const base = { profile, financials, debts: debts(), vat: vat(), risk: risk('green'), failed_sections: [] };
  it('RPO: živý dopyt vs. posledná zmena záznamu', () => {
    expect(renderCheck(base)).toContain('[RPO, ŠÚ SR, CC-BY 4.0; živý dopyt 2026-07-12, posledná zmena záznamu v registri 2026-07-07]');
  });
  it('čerstvý index → poznámka na konci, bez ⚠', () => {
    const md = renderCheck({ ...base, index_freshness: { updated_at: '2026-07-10T03:00:00Z', age_days: 2, stale: false } });
    expect(md).toContain('_Lokálny index dlžníkov a DPH aktualizovaný 2026-07-10._');
    expect(md).not.toContain('⚠');
  });
  it('starý index → viditeľné varovanie hneď pod verdiktom', () => {
    const md = renderCheck({ ...base, index_freshness: { updated_at: '2026-05-01T03:00:00Z', age_days: 72, stale: true } });
    const lines = md.split('\n\n');
    expect(lines[1]).toBe('⚠ **Lokálny index dlžníkov a DPH je starý 72 dní** (naposledy aktualizovaný 2026-05-01) — dlhy a DPH nemusia zodpovedať súčasnosti.');
  });
  it('signál + neúplné dáta → Dôvody z flagov a samostatný riadok o neúplnosti', () => {
    const md = renderCheck({ ...base, risk: risk('orange', [{ code: 'young_company', detail: 'vznik 2025-06-01 (< 24 mesiacov)', as_of: '2026-07-12', source: 'RPO, ŠÚ SR' }], ['financie chýbajú']) });
    expect(md).toContain('**Dôvody:** vznik 2025-06-01');
    expect(md).toContain('**Neúplné dáta** (verdikt nezhoršujú): financie chýbajú.');
  });
});
