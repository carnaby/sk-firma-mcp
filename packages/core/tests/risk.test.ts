import { describe, it, expect } from 'vitest';
import { assessCompleteness, evaluateRisk, type RiskInput } from '../src/domain/risk.js';
import type { FinancialYear, FinancialsResult, ProfileData } from '../src/types.js';
import type { DebtsData, VatStatusData } from '../src/types.js';

const NOW = new Date('2026-07-12');

const profile = (over: Partial<ProfileData> = {}): ProfileData => ({
  ico: '12345678', name: 'Firma s.r.o.', legal_form: 's.r.o.', legal_form_code: '112',
  address: 'Bratislava', established_on: '2019-03-01', terminated_on: null,
  status: 'active', status_text: null, status_since: null,
  executives: [], shareholders: [], main_activity: null,
  source_register: 'Obchodný register', as_of: '2026-07-12', record_modified_on: '2026-07-01', ...over,
});

const year = (over: Partial<FinancialYear> = {}): FinancialYear => ({
  period_from: '2024-01', period_to: '2024-12', period_label: '2024',
  template: 'malá UJ', statement_id: 1,
  revenue: 100_000, profit: 5_000, equity: 20_000, assets: 100_000, liabilities: 70_000,
  liabilities_ratio: 0.8, revenue_yoy: 0.05, negative_equity: false, ...over,
});

const fin = (years: FinancialYear[], over: Partial<FinancialsResult> = {}): FinancialsResult => ({
  ico: '12345678', name: 'Firma s.r.o.', years, unavailable_reason: null,
  pdf_attachments: [], as_of: '2026-07-12', ...over,
});


type Data = Omit<RiskInput, 'completeness' | 'now'>;
const ALL = { profile: true, financials: true, debts: true, vat: true };
/** evaluateRisk s úplnosťou odvodenou z dát (všetky sekcie vyžiadané; null = zlyhaná sekcia). */
function risk(input: Data & { now?: Date; requested?: Partial<typeof ALL> }) {
  const { requested, now, ...data } = input;
  const completeness = assessCompleteness({ requested: { ...ALL, ...requested }, ...data });
  return evaluateRisk({ ...data, completeness, now: now ?? NOW });
}

describe('evaluateRisk', () => {
  it('zdravá firma → green bez flagov', () => {
    const r = risk({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat(), now: NOW });
    expect(r.verdict).toBe('green');
    expect(r.flags).toEqual([]);
    expect(r.incomplete).toEqual([]);
  });

  it('likvidácia → red s flagom insolvency', () => {
    const r = risk({
      profile: profile({ status: 'in_liquidation', status_text: 'V likvidácii', status_since: '2005-06-07' }),
      financials: fin([year()]), debts: debts(), vat: vat(), now: NOW,
    });
    expect(r.verdict).toBe('red');
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'insolvency', source: 'RPO, ŠÚ SR' }));
  });

  it('záporné imanie → red; revenue_drop a high_leverage → orange flagy tiež prítomné', () => {
    const r = risk({
      profile: profile(),
      financials: fin([year({ equity: -18_400, negative_equity: true, revenue_yoy: -0.42, liabilities_ratio: 1.18 })]),
      debts: debts(), vat: vat(), now: NOW,
    });
    expect(r.verdict).toBe('red');
    const codes = r.flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['negative_equity', 'revenue_drop', 'high_leverage']));
  });

  it('mladá firma → orange', () => {
    const r = risk({
      profile: profile({ established_on: '2025-01-15' }),
      financials: fin([year()]), debts: debts(), vat: vat(), now: NOW,
    });
    expect(r.verdict).toBe('orange');
    expect(r.flags.map((f) => f.code)).toContain('young_company');
  });

  it('presne 24 mesiacov od vzniku → NIE je young_company (green)', () => {
    const r = risk({
      profile: profile({ established_on: '2024-07-12' }), // presne 24 kalendárnych mesiacov pred NOW
      financials: fin([year()]), debts: debts(), vat: vat(), now: NOW,
    });
    expect(r.flags.map((f) => f.code)).not.toContain('young_company');
    expect(r.verdict).toBe('green');
  });

  it('23 celých mesiacov od vzniku → young_company (orange)', () => {
    const r = risk({
      profile: profile({ established_on: '2024-07-13' }), // deň po hranici → 23 celých mesiacov
      financials: fin([year()]), debts: debts(), vat: vat(), now: NOW,
    });
    expect(r.flags.map((f) => f.code)).toContain('young_company');
    expect(r.verdict).toBe('orange');
  });

  it('stará posledná závierka → no_recent_statements (orange)', () => {
    const r = risk({
      profile: profile(),
      financials: fin([year({ period_to: '2023-12', period_label: '2023' })]),
      debts: debts(), vat: vat(), now: NOW, // 2023 < 2026-2
    });
    expect(r.flags.map((f) => f.code)).toContain('no_recent_statements');
  });

  it('chýbajúci zdroj ≠ zelená, ale ani riziko: pád RÚZ bez signálu → ⚪ s dôvodom', () => {
    const r = risk({ profile: profile(), financials: null, debts: debts(), vat: vat() });
    expect(r.verdict).toBe('incomplete');
    expect(r.completeness.financials).toBe('missing');
    expect(r.incomplete.join(' ')).toMatch(/účtovných závierok neodpovedal/);
  });

  it('IFRS bez dát a bez signálu → ⚪ s dôvodom o PDF, žiadny finančný flag', () => {
    const r = risk({ profile: profile(), financials: fin([], { unavailable_reason: 'ifrs_pdf_only' }), debts: debts(), vat: vat() });
    expect(r.verdict).toBe('incomplete');
    expect(r.flags).toEqual([]);
    expect(r.completeness.financials).toBe('pdf_only');
    expect(r.incomplete).toEqual(['financie len v PDF (IFRS) — štruktúrované dáta nie sú k dispozícii']);
  });
});

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

describe('evaluateRisk — debts a vat flagy (Fáza 2a)', () => {
  it('čisté debts+vat nič nepridajú (green)', () => {
    const r = risk({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat(), now: NOW });
    expect(r.verdict).toBe('green');
  });
  it('dlh nad prah → debtor_major (red) s vymenovanými veriteľmi', () => {
    const d = debts({
      creditors: { ...debts().creditors,
        sp: { status: 'debtor', amount_eur: 4812, as_of: '2026-07-06' },
        fs: { status: 'debtor', amount_eur: 780, as_of: '2026-05-31', match_confidence: 'exact' } },
      total_known_debt_eur: 5592,
    });
    const r = risk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat(), now: NOW });
    expect(r.verdict).toBe('red');
    const flag = r.flags.find((f) => f.code === 'debtor_major')!;
    expect(flag.detail).toMatch(/SP.*4 812|4812/);
    expect(flag.detail).toMatch(/FS/);
  });
  it('dlh do prahu vrátane → debtor_minor (orange)', () => {
    const d = debts({ creditors: { ...debts().creditors, vszp: { status: 'debtor', amount_eur: 250.5, as_of: '2026-07-12' } }, total_known_debt_eur: 250.5 });
    const r = risk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat(), now: NOW });
    expect(r.verdict).toBe('orange');
    expect(r.flags.map((f) => f.code)).toContain('debtor_minor');
  });
  it('dlh presne na prahu (1000) → debtor_minor, nie major', () => {
    const d = debts({ creditors: { ...debts().creditors, sp: { status: 'debtor', amount_eur: 1000, as_of: '2026-07-12' } }, total_known_debt_eur: 1000 });
    const r = risk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat(), now: NOW });
    expect(r.flags.map((f) => f.code)).toContain('debtor_minor');
    expect(r.flags.map((f) => f.code)).not.toContain('debtor_major');
    expect(r.verdict).toBe('orange');
  });
  it('vymazaný platiteľ §52/8 → red', () => {
    const r = risk({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat({ erased: { published_on: '2024-05-01', erased_on: '2024-06-01', violation_year: '2024' } }), now: NOW });
    expect(r.verdict).toBe('red');
    expect(r.flags.map((f) => f.code)).toContain('vat_erased_52_8');
  });
  it('rizikový platiteľ §52/6 → red', () => {
    const r = risk({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat({ risky: { published_on: '2023-02-25', violation_year: '2023' } }), now: NOW });
    expect(r.flags.map((f) => f.code)).toContain('vat_risky_52_6');
  });
  it('FS unverifiable bez signálu → ⚪ (neúplnosť, nie riziko), nie flag', () => {
    const d = debts({ creditors: { ...debts().creditors, fs: { status: 'unverifiable', amount_eur: null, as_of: '2026-05-31', note: 'nejednoznačné' } }, notes: ['FS: nejednoznačné'] });
    const r = risk({ profile: profile(), financials: fin([year()]), debts: d, vat: vat() });
    expect(r.flags).toEqual([]);
    expect(r.verdict).toBe('incomplete');
    expect(r.incomplete.join(' ')).toContain('Finančná správa: nejednoznačné');
  });
});

describe('evaluateRisk — dve osi: riziko × úplnosť dát', () => {
  const clean = () => ({ profile: profile(), financials: fin([year()]), debts: debts(), vat: vat() });

  it('všetky štyri stavy', () => {
    expect(risk(clean()).verdict).toBe('green');
    expect(risk({ ...clean(), financials: fin([], { unavailable_reason: 'ifrs_pdf_only' }) }).verdict).toBe('incomplete');
    expect(risk({ ...clean(), financials: fin([year({ liabilities_ratio: 0.93 })]) }).verdict).toBe('orange');
    expect(risk({ ...clean(), profile: profile({ status: 'in_bankruptcy', status_text: 'V konkurze' }) }).verdict).toBe('red');
  });

  it('signál + neúplné dáta → verdikt podľa signálu, neúplnosť len ako poznámka', () => {
    const r = risk({ ...clean(), profile: profile({ established_on: '2025-06-01' }), financials: null });
    expect(r.verdict).toBe('orange'); // young_company, nie horšie kvôli chýbajúcim financiám
    expect(r.flags.map((f) => f.code)).toEqual(['young_company']);
    expect(r.incomplete.join(' ')).toMatch(/financie chýbajú/);
  });

  it('nedostupná Dôvera, Dôvera parse_error ani Union verdikt nemenia', () => {
    const d = debts({ creditors: { ...debts().creditors,
      dovera: { status: 'unavailable', amount_eur: null, as_of: null, retryable: true, note: 'HTTP 429' } } });
    expect(risk({ ...clean(), debts: d }).verdict).toBe('green');
    const p = debts({ creditors: { ...debts().creditors,
      dovera: { status: 'parse_error', amount_eur: null, as_of: null, retryable: false, note: 'zmena HTML' } } });
    const r = risk({ ...clean(), debts: p });
    expect(r.verdict).toBe('green');
    expect(r.completeness.debts).toMatchObject({ dovera: 'parse_error', union: 'not_supported', fs: 'ok' });
  });

  it('chýbajúci lokálny index (FS+SP+VšZP + DPH) bez signálu → ⚪ so súhrnnými dôvodmi', () => {
    const na = { status: 'unavailable' as const, amount_eur: null, as_of: null, retryable: false, note: 'index' };
    const d = debts({ creditors: { ...debts().creditors, fs: na, sp: na, vszp: na } });
    const r = risk({ ...clean(), debts: d, vat: null });
    expect(r.verdict).toBe('incomplete');
    expect(r.incomplete).toEqual([
      'zoznamy dlžníkov FS, SP a VšZP nie sú dostupné (chýba lokálny index)',
      'DPH status nie je dostupný (lokálny index)',
    ]);
  });

  it('nevyžiadaná sekcia nie je zelená: sections=[profile] bez signálu → ⚪', () => {
    const r = risk({ profile: profile(), financials: null, debts: null, vat: null, requested: { financials: false, debts: false, vat: false } });
    expect(r.verdict).toBe('incomplete');
    expect(r.completeness).toMatchObject({ profile: 'ok', financials: 'not_requested', debts: 'not_requested', vat: 'not_requested' });
  });

  it('invariant: žiadny verdikt okrem 🟢 bez dôvodu (všetky kombinácie fixture dát)', () => {
    const profiles = [profile(), profile({ status: 'terminated', terminated_on: '2020-01-01' }), profile({ established_on: '2026-01-01' }), null];
    const fins = [fin([year()]), fin([year({ equity: -1, negative_equity: true })]), fin([], { unavailable_reason: 'ifrs_pdf_only' }), fin([], { unavailable_reason: 'no_statements' }), null];
    const debtsList = [debts(), debts({ creditors: { ...debts().creditors, sp: { status: 'debtor', amount_eur: 50, as_of: '2026-07-01' } }, total_known_debt_eur: 50 }), null];
    const vats = [vat(), vat({ risky: { published_on: '2024-01-01', violation_year: '2023' } }), null];
    let n = 0;
    for (const p of profiles) for (const f of fins) for (const d of debtsList) for (const v of vats) {
      const r = risk({ profile: p, financials: f, debts: d, vat: v });
      n++;
      if (r.verdict !== 'green') expect(r.flags.length + r.incomplete.length).toBeGreaterThan(0);
      else expect(r.incomplete).toEqual([]);
    }
    expect(n).toBe(180);
  });
});
