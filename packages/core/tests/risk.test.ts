import { describe, it, expect } from 'vitest';
import { evaluateRisk } from '../src/domain/risk.js';
import type { FinancialYear, FinancialsResult, ProfileData } from '../src/types.js';
import type { DebtsData, VatStatusData } from '../src/types.js';

const NOW = new Date('2026-07-12');

const profile = (over: Partial<ProfileData> = {}): ProfileData => ({
  ico: '12345678', name: 'Firma s.r.o.', legal_form: 's.r.o.', legal_form_code: '112',
  address: 'Bratislava', established_on: '2019-03-01', terminated_on: null,
  status: 'active', status_text: null, status_since: null,
  executives: [], shareholders: [], main_activity: null,
  source_register: 'Obchodný register', as_of: '2026-07-01', ...over,
});

const year = (over: Partial<FinancialYear> = {}): FinancialYear => ({
  period_from: '2024-01', period_to: '2024-12', period_label: '2024',
  template: 'malá UJ', statement_id: 1,
  revenue: 100_000, profit: 5_000, equity: 20_000, assets: 100_000, liabilities: 70_000,
  liabilities_ratio: 0.8, revenue_yoy: 0.05, negative_equity: false, ...over,
});

const fin = (years: FinancialYear[], over: Partial<FinancialsResult> = {}): FinancialsResult => ({
  ico: '12345678', name: 'Firma s.r.o.', years, unavailable_reason: null,
  pdf_statement_ids: [], as_of: '2026-07-12', ...over,
});

describe('evaluateRisk', () => {
  it('zdravá firma → green bez flagov', () => {
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: null, vat: null, failed_sources: [], now: NOW });
    expect(r).toEqual({ verdict: 'green', flags: [], notes: [] });
  });

  it('likvidácia → red s flagom insolvency', () => {
    const r = evaluateRisk({
      profile: profile({ status: 'in_liquidation', status_text: 'V likvidácii', status_since: '2005-06-07' }),
      financials: fin([year()]), debts: null, vat: null, failed_sources: [], now: NOW,
    });
    expect(r.verdict).toBe('red');
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'insolvency', source: 'RPO, ŠÚ SR' }));
  });

  it('záporné imanie → red; revenue_drop a high_leverage → orange flagy tiež prítomné', () => {
    const r = evaluateRisk({
      profile: profile(),
      financials: fin([year({ equity: -18_400, negative_equity: true, revenue_yoy: -0.42, liabilities_ratio: 1.18 })]),
      debts: null, vat: null, failed_sources: [], now: NOW,
    });
    expect(r.verdict).toBe('red');
    const codes = r.flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['negative_equity', 'revenue_drop', 'high_leverage']));
  });

  it('mladá firma → orange', () => {
    const r = evaluateRisk({
      profile: profile({ established_on: '2025-01-15' }),
      financials: fin([year()]), debts: null, vat: null, failed_sources: [], now: NOW,
    });
    expect(r.verdict).toBe('orange');
    expect(r.flags.map((f) => f.code)).toContain('young_company');
  });

  it('presne 24 mesiacov od vzniku → NIE je young_company (green)', () => {
    const r = evaluateRisk({
      profile: profile({ established_on: '2024-07-12' }), // presne 24 kalendárnych mesiacov pred NOW
      financials: fin([year()]), debts: null, vat: null, failed_sources: [], now: NOW,
    });
    expect(r.flags.map((f) => f.code)).not.toContain('young_company');
    expect(r.verdict).toBe('green');
  });

  it('23 celých mesiacov od vzniku → young_company (orange)', () => {
    const r = evaluateRisk({
      profile: profile({ established_on: '2024-07-13' }), // deň po hranici → 23 celých mesiacov
      financials: fin([year()]), debts: null, vat: null, failed_sources: [], now: NOW,
    });
    expect(r.flags.map((f) => f.code)).toContain('young_company');
    expect(r.verdict).toBe('orange');
  });

  it('stará posledná závierka → no_recent_statements (orange)', () => {
    const r = evaluateRisk({
      profile: profile(),
      financials: fin([year({ period_to: '2023-12', period_label: '2023' })]),
      debts: null, vat: null, failed_sources: [], now: NOW, // 2023 < 2026-2
    });
    expect(r.flags.map((f) => f.code)).toContain('no_recent_statements');
  });

  it('chýbajúci zdroj ≠ zelená: failed_sources drží min. orange s poznámkou', () => {
    const r = evaluateRisk({ profile: profile(), financials: null, debts: null, vat: null, failed_sources: ['RÚZ'], now: NOW });
    expect(r.verdict).toBe('orange');
    expect(r.notes.join(' ')).toMatch(/RÚZ/);
  });

  it('IFRS bez dát: unavailable_reason → orange s poznámkou, žiadny finančný flag', () => {
    const r = evaluateRisk({
      profile: profile(),
      financials: fin([], { unavailable_reason: 'ifrs_pdf_only' }),
      debts: null, vat: null, failed_sources: [], now: NOW,
    });
    expect(r.verdict).toBe('orange');
    expect(r.notes.join(' ')).toMatch(/IFRS|štruktúrované/i);
  });
});

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

describe('evaluateRisk — debts a vat flagy (Fáza 2a)', () => {
  it('čisté debts+vat nič nepridajú (green)', () => {
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat(), failed_sources: [], now: NOW });
    expect(r.verdict).toBe('green');
  });
  it('dlh nad prah → debtor_major (red) s vymenovanými veriteľmi', () => {
    const d = debts({
      creditors: { ...debts().creditors,
        sp: { status: 'debtor', amount_eur: 4812, as_of: '2026-07-06' },
        fs: { status: 'debtor', amount_eur: 780, as_of: '2026-05-31', match_confidence: 'exact' } },
      total_known_debt_eur: 5592,
    });
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat(), failed_sources: [], now: NOW });
    expect(r.verdict).toBe('red');
    const flag = r.flags.find((f) => f.code === 'debtor_major')!;
    expect(flag.detail).toMatch(/SP.*4 812|4812/);
    expect(flag.detail).toMatch(/FS/);
  });
  it('dlh do prahu vrátane → debtor_minor (orange)', () => {
    const d = debts({ creditors: { ...debts().creditors, vszp: { status: 'debtor', amount_eur: 250.5, as_of: '2026-07-12' } }, total_known_debt_eur: 250.5 });
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat(), failed_sources: [], now: NOW });
    expect(r.verdict).toBe('orange');
    expect(r.flags.map((f) => f.code)).toContain('debtor_minor');
  });
  it('dlh presne na prahu (1000) → debtor_minor, nie major', () => {
    const d = debts({ creditors: { ...debts().creditors, sp: { status: 'debtor', amount_eur: 1000, as_of: '2026-07-12' } }, total_known_debt_eur: 1000 });
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat(), failed_sources: [], now: NOW });
    expect(r.flags.map((f) => f.code)).toContain('debtor_minor');
    expect(r.flags.map((f) => f.code)).not.toContain('debtor_major');
    expect(r.verdict).toBe('orange');
  });
  it('vymazaný platiteľ §52/8 → red', () => {
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat({ erased: { published_on: '2024-05-01', erased_on: '2024-06-01', violation_year: '2024' } }), failed_sources: [], now: NOW });
    expect(r.verdict).toBe('red');
    expect(r.flags.map((f) => f.code)).toContain('vat_erased_52_8');
  });
  it('rizikový platiteľ §52/6 → red', () => {
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat({ risky: { published_on: '2023-02-25', violation_year: '2023' } }), failed_sources: [], now: NOW });
    expect(r.flags.map((f) => f.code)).toContain('vat_risky_52_6');
  });
  it('FS unverifiable → poznámka, nie flag; verdikt neklesá pod green kvôli nej… ale note drží orange cap', () => {
    const d = debts({ creditors: { ...debts().creditors, fs: { status: 'unverifiable', amount_eur: null, as_of: '2026-05-31', note: 'nejednoznačné' } }, notes: ['FS: nejednoznačné'] });
    const r = evaluateRisk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat(), failed_sources: [], now: NOW });
    expect(r.flags.map((f) => f.code)).not.toContain('debtor_minor');
    expect(r.verdict).toBe('orange'); // unverifiable = nevieme overiť dlhy → cap (zásada „chýbajúci zdroj ≠ zelená")
    expect(r.notes.join(' ')).toMatch(/jednoznačne|nejednoznačné/);
  });
});
