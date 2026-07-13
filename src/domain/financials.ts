import type { Metrics } from '../clients/ruz-mapping.js';
import type { FinancialYear } from '../types.js';

export interface YearInput {
  period_from: string; // "yyyy-MM"
  period_to: string;
  template: string;
  statement_id: number;
  metrics: Metrics;
}

function periodLabel(from: string, to: string): string {
  const [fy, fm] = from.split('-');
  const [ty, tm] = to.split('-');
  if (fy === ty && fm === '01' && tm === '12') return fy;
  return `${from}..${to}`;
}

export function buildYears(inputs: YearInput[]): FinancialYear[] {
  const asc = [...inputs].sort((a, b) => a.period_to.localeCompare(b.period_to));
  const out: FinancialYear[] = asc.map((y, i) => {
    const prev = i > 0 ? asc[i - 1].metrics : null;
    const { trzby, vh_po_zdaneni, vlastne_imanie, aktiva_spolu, zavazky_celkom } = y.metrics;
    const revenue_yoy =
      trzby !== null && prev?.trzby != null && prev.trzby !== 0
        ? trzby / prev.trzby - 1
        : null;
    const liabilities_ratio =
      aktiva_spolu !== null && aktiva_spolu !== 0 && vlastne_imanie !== null
        ? (aktiva_spolu - vlastne_imanie) / aktiva_spolu
        : null;
    return {
      period_from: y.period_from,
      period_to: y.period_to,
      period_label: periodLabel(y.period_from, y.period_to),
      template: y.template,
      statement_id: y.statement_id,
      revenue: trzby,
      profit: vh_po_zdaneni,
      equity: vlastne_imanie,
      assets: aktiva_spolu,
      liabilities: zavazky_celkom,
      liabilities_ratio,
      revenue_yoy,
      negative_equity: vlastne_imanie !== null && vlastne_imanie < 0,
    };
  });
  return out.reverse(); // najnovší prvý
}
