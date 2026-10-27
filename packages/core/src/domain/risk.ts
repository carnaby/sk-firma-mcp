import { CONFIG } from '../config.js';
import type { Completeness, CreditorCompleteness, CreditorDebt, DebtsData, Flag, FinancialsResult, ProfileData, VatStatusData, Verdict } from '../types.js';

export interface RiskInput {
  profile: ProfileData | null;
  financials: FinancialsResult | null;
  debts: DebtsData | null;
  vat: VatStatusData | null;
  completeness: Completeness;
  now: Date;
}
export interface RiskResult {
  verdict: Verdict;
  flags: Flag[];
  /** Dôvody neúplnosti dát. Pri ⚪ sú to „Dôvody" verdiktu, inak len poznámka — verdikt nezhoršujú. */
  incomplete: string[];
  completeness: Completeness;
}

const RED = new Set(['terminated', 'insolvency', 'negative_equity', 'vat_erased_52_8', 'vat_risky_52_6', 'debtor_major']);

const monthsBetween = (fromIso: string, to: Date): number => {
  const from = new Date(fromIso);
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1; // neúplný bežiaci mesiac sa nepočíta
  return months;
};

export function evaluateRisk({ profile, financials, debts, vat, completeness, now }: RiskInput): RiskResult {
  const flags: Flag[] = [];

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
  }

  const incomplete = incompleteReasons(completeness, debts);
  const hasRed = flags.some((f) => RED.has(f.code));
  // Riziko a úplnosť sú dve osi: signál rozhoduje o 🟠/🔴, neúplnosť bez signálu = ⚪.
  const verdict: Verdict = hasRed ? 'red' : flags.length > 0 ? 'orange' : incomplete.length > 0 ? 'incomplete' : 'green';
  // Invariant: každý verdikt okrem 🟢 musí mať aspoň jeden dôvod.
  if (verdict !== 'green' && flags.length === 0 && incomplete.length === 0) {
    throw new Error(`risk engine bug: verdikt ${verdict} bez dôvodu`);
  }
  return { verdict, flags, incomplete, completeness };
}

// ---------- úplnosť dát ----------

const KEY_CREDITORS = ['fs', 'sp', 'vszp'] as const; // štátne/verejné zoznamy; Dôvera a Union verdikt neovplyvňujú
const CREDITOR_LABEL: Record<keyof DebtsData['creditors'], string> = {
  fs: 'Finančná správa', sp: 'Sociálna poisťovňa', vszp: 'VšZP', dovera: 'Dôvera', union: 'Union',
};

export function creditorCompleteness(c: CreditorDebt): CreditorCompleteness {
  return c.status === 'debtor' || c.status === 'not_found' ? 'ok' : c.status;
}

export function assessCompleteness(input: {
  requested: { profile: boolean; financials: boolean; debts: boolean; vat: boolean };
  profile: ProfileData | null;
  financials: FinancialsResult | null;
  debts: DebtsData | null;
  vat: VatStatusData | null;
}): Completeness {
  const { requested: r, profile, financials, debts, vat } = input;
  const fin = (): Completeness['financials'] => {
    if (!r.financials) return 'not_requested';
    if (!financials) return 'missing';
    if (financials.years.length > 0) return 'structured';
    switch (financials.unavailable_reason) {
      case 'ifrs_pdf_only': return 'pdf_only';
      case 'unsupported_template': return 'unsupported';
      default: return 'no_statements';
    }
  };
  return {
    profile: !r.profile ? 'not_requested' : profile ? 'ok' : 'missing',
    financials: fin(),
    debts: !r.debts ? 'not_requested' : !debts ? 'missing' : {
      fs: creditorCompleteness(debts.creditors.fs),
      sp: creditorCompleteness(debts.creditors.sp),
      vszp: creditorCompleteness(debts.creditors.vszp),
      dovera: creditorCompleteness(debts.creditors.dovera),
      union: creditorCompleteness(debts.creditors.union),
    },
    vat: !r.vat ? 'not_requested' : vat ? 'ok' : 'missing',
  };
}

export function incompleteReasons(c: Completeness, debts: DebtsData | null): string[] {
  const out: string[] = [];
  if (c.profile === 'missing') out.push('identita z RPO nie je dostupná (register neodpovedal)');
  if (c.profile === 'not_requested') out.push('identita (RPO) nebola vyžiadaná');
  switch (c.financials) {
    case 'pdf_only': out.push('financie len v PDF (IFRS) — štruktúrované dáta nie sú k dispozícii'); break;
    case 'unsupported': out.push('výkazy v nepodporovanej šablóne (napr. jednoduché účtovníctvo, neziskovka) — štruktúrované financie nie sú k dispozícii'); break;
    case 'no_statements': out.push('v Registri účtovných závierok nie je použiteľná závierka'); break;
    case 'missing': out.push('Register účtovných závierok neodpovedal — financie chýbajú'); break;
    case 'not_requested': out.push('financie (RÚZ) neboli vyžiadané'); break;
  }
  if (c.debts === 'missing') out.push('zoznamy dlžníkov nie sú dostupné');
  else if (c.debts === 'not_requested') out.push('dlhy neboli vyžiadané');
  else {
    const d = c.debts;
    if (KEY_CREDITORS.every((k) => d[k] === 'unavailable')) {
      out.push('zoznamy dlžníkov FS, SP a VšZP nie sú dostupné (chýba lokálny index)');
    } else {
      for (const k of KEY_CREDITORS) {
        const note = debts?.creditors[k].note;
        if (d[k] === 'unverifiable') out.push(`${CREDITOR_LABEL[k]}: ${note ? note.replace(/\.$/, '') : 'dlh sa nedá jednoznačne priradiť'}`);
        else if (d[k] !== 'ok') out.push(`${CREDITOR_LABEL[k]}: zoznam dlžníkov nie je dostupný`);
      }
    }
  }
  if (c.vat === 'missing') out.push('DPH status nie je dostupný (lokálny index)');
  if (c.vat === 'not_requested') out.push('DPH status nebol vyžiadaný');
  return out;
}
