import { CONFIG } from '../config.js';
import type { DebtsData, Flag, FinancialsResult, ProfileData, VatStatusData, Verdict } from '../types.js';

export interface RiskInput {
  profile: ProfileData | null;
  financials: FinancialsResult | null;
  debts: DebtsData | null;
  vat: VatStatusData | null;
  failed_sources: string[];
  now: Date;
}
export interface RiskResult {
  verdict: Verdict;
  flags: Flag[];
  notes: string[];
}

const RED = new Set(['terminated', 'insolvency', 'negative_equity', 'vat_erased_52_8', 'vat_risky_52_6', 'debtor_major']);

const monthsBetween = (fromIso: string, to: Date): number => {
  const from = new Date(fromIso);
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1; // neúplný bežiaci mesiac sa nepočíta
  return months;
};

export function evaluateRisk({ profile, financials, debts, vat, failed_sources, now }: RiskInput): RiskResult {
  const flags: Flag[] = [];
  const notes: string[] = [];

  if (profile) {
    const src = 'RPO, ŠÚ SR';
    if (profile.status === 'terminated') {
      flags.push({ code: 'terminated', detail: `subjekt zaniknutý${profile.terminated_on ? ` k ${profile.terminated_on}` : ''}`, as_of: profile.as_of, source: src });
    } else if (profile.status === 'in_liquidation' || profile.status === 'in_bankruptcy' || profile.status === 'in_restructuring') {
      flags.push({ code: 'insolvency', detail: `${profile.status_text ?? profile.status}${profile.status_since ? ` od ${profile.status_since}` : ''}`, as_of: profile.as_of, source: src });
    }
    if (profile.established_on && monthsBetween(profile.established_on, now) < CONFIG.risk.youngCompanyMonths) {
      flags.push({ code: 'young_company', detail: `vznik ${profile.established_on} (< ${CONFIG.risk.youngCompanyMonths} mesiacov)`, as_of: profile.as_of, source: src });
    }
  }

  if (financials) {
    const src = 'registeruz.sk';
    const latest = financials.years[0];
    if (latest) {
      if (latest.negative_equity && latest.equity !== null) {
        flags.push({ code: 'negative_equity', detail: `${latest.equity} EUR (${latest.period_label})`, as_of: financials.as_of, source: src });
      }
      if (latest.revenue_yoy !== null && latest.revenue_yoy < CONFIG.risk.revenueDropThreshold) {
        flags.push({ code: 'revenue_drop', detail: `tržby ${Math.round(latest.revenue_yoy * 100)} % YoY (${latest.period_label})`, as_of: financials.as_of, source: src });
      }
      if (latest.liabilities_ratio !== null && latest.liabilities_ratio > CONFIG.risk.highLeverageThreshold) {
        flags.push({ code: 'high_leverage', detail: `zadlženosť ${Math.round(latest.liabilities_ratio * 100)} % (${latest.period_label})`, as_of: financials.as_of, source: src });
      }
      const latestYear = Number(latest.period_to.slice(0, 4));
      if (latestYear < now.getFullYear() - CONFIG.risk.noRecentStatementsPeriods) {
        flags.push({ code: 'no_recent_statements', detail: `posledná závierka za ${latest.period_label}`, as_of: financials.as_of, source: src });
      }
    } else if (financials.unavailable_reason === 'ifrs_pdf_only') {
      notes.push('Financie: firma účtuje podľa IFRS — register poskytuje len PDF, štruktúrované dáta nedostupné.');
    } else if (financials.unavailable_reason) {
      notes.push('Financie: štruktúrované závierky nedostupné (nepodporovaný typ výkazov alebo žiadne závierky).');
    }
  }

  if (vat) {
    const src = 'financnasprava.sk';
    if (vat.erased) {
      flags.push({ code: 'vat_erased_52_8', detail: `vymazaný platiteľ DPH (§52 ods. 8)${vat.erased.erased_on ? `, vymazaný ${vat.erased.erased_on}` : ''}`, as_of: vat.as_of, source: src });
    }
    if (vat.risky) {
      flags.push({ code: 'vat_risky_52_6', detail: `v zozname rizikových platiteľov DPH (§52 ods. 6)${vat.risky.published_on ? `, zverejnený ${vat.risky.published_on}` : ''}`, as_of: vat.as_of, source: src });
    }
  }

  if (debts) {
    const LABELS: Record<string, string> = { fs: 'FS', sp: 'SP', vszp: 'VšZP', dovera: 'Dôvera', union: 'Union' };
    const SOURCES: Record<string, string> = { fs: 'financnasprava.sk', sp: 'socpoist.sk', vszp: 'vszp.sk (Datahub)', dovera: 'dovera.sk', union: 'union.sk' };
    const confirmed = Object.entries(debts.creditors).filter(([, c]) => c.status === 'debtor' && c.amount_eur !== null);
    const total = debts.total_known_debt_eur;
    if (confirmed.length > 0 && total > 0) {
      const detail = confirmed.map(([k, c]) => `${LABELS[k]} ${c.amount_eur} €`).join(' + ');
      const asOfs = confirmed.map(([, c]) => c.as_of).filter((a): a is string => a !== null).sort();
      const flagAsOf = asOfs[0] ?? null; // najstarší = konzervatívny
      const sources = confirmed.map(([k]) => SOURCES[k]).join(', ');
      if (total > CONFIG.risk.debtorMajorThresholdEur) {
        flags.push({ code: 'debtor_major', detail, as_of: flagAsOf, source: sources });
      } else {
        flags.push({ code: 'debtor_minor', detail, as_of: flagAsOf, source: sources });
      }
    }
    for (const [k, c] of Object.entries(debts.creditors)) {
      if (c.status === 'unverifiable') {
        notes.push(`${LABELS[k]}: dlh sa nepodarilo jednoznačne overiť${c.note ? ` (${c.note})` : ''} — verdikt je preto najviac 🟠.`);
      }
    }
  }

  for (const s of failed_sources) notes.push(`Zdroj ${s} nedostupný — sekcia chýba, verdikt je preto najviac 🟠.`);

  const hasRed = flags.some((f) => RED.has(f.code));
  const capped = notes.length > 0; // chýbajúci zdroj ≠ zelená (zadanie §6 zásada 2)
  const verdict: Verdict = hasRed ? 'red' : flags.length > 0 || capped ? 'orange' : 'green';
  return { verdict, flags, notes };
}
