import { describe, it, expect } from 'vitest';
import { fmtEur, fmtPct, renderCheck, renderDebts, renderFinancials, renderVatStatus, estimateTokens } from '../src/render/markdown.js';
import type { DebtsData, FinancialsResult, ProfileData, VatStatusData } from '../src/types.js';

const debts = (over: Partial<DebtsData> = {}): DebtsData => ({
  ico: '12345678', name: 'Firma s.r.o.',
  creditors: {
    fs: { status: 'not_found', amount_eur: null, as_of: '2026-05-31' },
    sp: { status: 'not_found', amount_eur: null, as_of: null },
    vszp: { status: 'not_found', amount_eur: null, as_of: null },
    dovera: { status: 'not_found', amount_eur: null, as_of: '2026-07-13' },
    union: { status: 'unavailable', amount_eur: null, as_of: null, note: 'v1.1' },
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
  source_register: 'Obchodný register', as_of: '2026-07-07',
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
  unavailable_reason: null, pdf_statement_ids: [], as_of: '2026-07-12',
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
    risk: {
      verdict: 'red',
      flags: [
        { code: 'negative_equity', detail: '-18400 EUR (2024)', as_of: '2026-07-12', source: 'registeruz.sk' },
        { code: 'revenue_drop', detail: 'tržby -42 % YoY (2024)', as_of: '2026-07-12', source: 'registeruz.sk' },
      ],
      notes: [],
    },
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
    const md2 = renderCheck({ profile, financials: null, debts: null, vat: null, risk: { verdict: 'orange', flags: [], notes: ['Zdroj RÚZ nedostupný — sekcia chýba, verdikt je preto najviac 🟠.'] }, failed_sections: ['financials'] });
    expect(md2).toContain('⚠');
    expect(md2).toContain('🟠');
  });

  it('green verdikt: bez Dôvody a bez ⚠, s disclaimerom', () => {
    const md3 = renderCheck({ profile, financials, debts: null, vat: null, risk: { verdict: 'green', flags: [], notes: [] }, failed_sections: [] });
    expect(md3).toContain('🟢 BEZ ZISTENÍ');
    expect(md3).not.toContain('**Dôvody:**');
    expect(md3).not.toContain('⚠');
    expect(md3).toMatch(/_Informatívny výstup z verejných registrov, nie úverový rating.*_/);
  });

  it('null profil: hlavička z financials, bez Identity, ⚠ sekcia profile', () => {
    const md4 = renderCheck({ profile: null, financials, debts: null, vat: null, risk: { verdict: 'orange', flags: [], notes: ['Zdroj RPO nedostupný — sekcia chýba, verdikt je preto najviac 🟠.'] }, failed_sections: ['profile'] });
    expect(md4).toContain('## Firma s.r.o. (IČO 12345678)');
    expect(md4).not.toContain('**Identita:**');
    expect(md4).toContain('⚠ Sekcia profile');
  });
});

describe('renderFinancials — IFRS fallback', () => {
  it('vysvetlí nedostupnosť a odkáže na PDF', () => {
    const md = renderFinancials({ ...financials, years: [], unavailable_reason: 'ifrs_pdf_only', pdf_statement_ids: [123] });
    expect(md).toMatch(/IFRS/);
    expect(md).toMatch(/PDF/);
  });
});

describe('renderDebts', () => {
  it('bez dlhov → jednoriadkový súhrn (šetrí tokeny)', () => {
    const md = renderDebts(debts());
    expect(md).toContain('**Dlhy:**');
    expect(md).not.toContain('| Veriteľ |');
    expect(md).toMatch(/Union.*nedostup/i);
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
      risk: { verdict: 'red', flags: [{ code: 'debtor_major', detail: 'SP 4812.37 €', as_of: '2026-07-06', source: 'socpoist.sk' }], notes: [] },
      failed_sections: [],
    });
    expect(md).toContain('| Veriteľ |');
    expect(md).toContain('**DPH:**');
    expect(estimateTokens(md)).toBeLessThanOrEqual(1500);
  });
});
