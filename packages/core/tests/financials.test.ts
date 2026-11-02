import { describe, it, expect } from 'vitest';
import { buildYears } from '../src/domain/financials.js';
import type { Metrics } from '../src/clients/ruz-mapping.js';

const m = (over: Partial<Metrics>): Metrics => ({
  aktiva_spolu: null, vlastne_imanie: null, zavazky_celkom: null,
  vynosy_hosp: null, trzby: null, vh_po_zdaneni: null, ...over,
});

describe('buildYears', () => {
  it('zoradí zostupne, YoY počíta voči predchádzajúcemu roku', () => {
    const years = buildYears([
      { period_from: '2023-01', period_to: '2023-12', template: 'malá UJ', statement_id: 2, metrics: m({ trzby: 165_000 }) },
      { period_from: '2024-01', period_to: '2024-12', template: 'malá UJ', statement_id: 1, metrics: m({ trzby: 96_000, vlastne_imanie: -18_400, aktiva_spolu: 210_000 }) },
    ]);
    expect(years[0].period_label).toBe('2024');
    expect(years[0].revenue_yoy).toBeCloseTo(-0.4182, 3); // 96000/165000 - 1
    expect(years[0].negative_equity).toBe(true);
    expect(years[0].liabilities_ratio).toBeCloseTo((210_000 - -18_400) / 210_000, 4);
    expect(years[1].revenue_yoy).toBeNull(); // najstarší rok nemá predchodcu
  });

  it('hospodársky rok dostane label od..do', () => {
    const years = buildYears([
      { period_from: '2024-04', period_to: '2025-03', template: 'veľká UJ', statement_id: 3, metrics: m({}) },
    ]);
    expect(years[0].period_label).toBe('2024-04..2025-03');
  });

  it('YoY je null, keď predchádzajúce tržby sú 0 alebo null', () => {
    const years = buildYears([
      { period_from: '2023-01', period_to: '2023-12', template: 'mikro UJ', statement_id: 5, metrics: m({ trzby: 0 }) },
      { period_from: '2024-01', period_to: '2024-12', template: 'mikro UJ', statement_id: 4, metrics: m({ trzby: 50_000 }) },
    ]);
    expect(years[0].revenue_yoy).toBeNull();
  });

  it('YoY je null, keď predchádzajúce obdobie nenadväzuje (medziročná medzera, napr. rok len v PDF)', () => {
    const years = buildYears([
      { period_from: '2022-01', period_to: '2022-12', template: 'mikro UJ', statement_id: 7, metrics: m({ trzby: 200_000 }) },
      { period_from: '2024-01', period_to: '2024-12', template: 'mikro UJ', statement_id: 6, metrics: m({ trzby: 50_000 }) },
    ]);
    expect(years[0].revenue_yoy).toBeNull();
  });

  it('YoY je null pri kratšom období (mimoriadna závierka, zmena hospodárskeho roka)', () => {
    const years = buildYears([
      { period_from: '2023-01', period_to: '2023-12', template: 'mikro UJ', statement_id: 9, metrics: m({ trzby: 200_000 }) },
      { period_from: '2024-01', period_to: '2024-06', template: 'mikro UJ', statement_id: 8, metrics: m({ trzby: 90_000 }) },
      { period_from: '2024-07', period_to: '2025-06', template: 'mikro UJ', statement_id: 10, metrics: m({ trzby: 210_000 }) },
    ]);
    expect(years.map((y) => y.revenue_yoy)).toEqual([null, null, null]);
  });

  it('nadväzujúci hospodársky rok YoY počíta', () => {
    const years = buildYears([
      { period_from: '2023-04', period_to: '2024-03', template: 'veľká UJ', statement_id: 12, metrics: m({ trzby: 100_000 }) },
      { period_from: '2024-04', period_to: '2025-03', template: 'veľká UJ', statement_id: 11, metrics: m({ trzby: 120_000 }) },
    ]);
    expect(years[0].revenue_yoy).toBeCloseTo(0.2, 6);
  });
});
