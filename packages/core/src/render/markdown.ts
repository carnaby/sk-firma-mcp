import { CONFIG } from '../config.js';
import type { CreditorDebt, DebtsData, FinancialsResult, ProfileData, SearchCandidate, VatStatusData } from '../types.js';
import type { RiskResult } from '../domain/risk.js';

export function fmtEur(n: number | null): string {
  if (n === null) return '—';
  const abs = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '−' : ''}${abs} €`;
}

export function fmtPct(ratio: number | null): string {
  if (ratio === null) return '—';
  const pct = Math.round(ratio * 100);
  return `${pct < 0 ? '−' : ''}${Math.abs(pct)} %`;
}

const VERDICT_LABEL = { red: '🔴 VYSOKÉ RIZIKO', orange: '🟠 ZVÝŠENÉ RIZIKO', green: '🟢 BEZ ZISTENÍ' } as const;
const STATUS_LABEL: Record<ProfileData['status'], string> = {
  active: 'aktívna', in_liquidation: 'v likvidácii', in_bankruptcy: 'v konkurze',
  in_restructuring: 'v reštrukturalizácii', terminated: 'zaniknutá',
};

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

export function renderSearch(candidates: SearchCandidate[], total: number, hasMore: boolean, offset: number): string {
  if (candidates.length === 0) return 'Žiadny subjekt nezodpovedá dopytu. Skús kratší názov alebo over IČO.';
  const rows = candidates.map((c) =>
    `| ${c.ico ?? '—'} | ${c.name} | ${c.address ?? '—'} | ${c.status === 'active' ? 'aktívna' : `zaniknutá ${c.terminated_on ?? ''}`.trim()} | ${c.established_on ?? '—'} |`);
  const totalLabel = total >= 500 ? '500+ (RPO strop)' : String(total);
  const footer = hasMore ? `\nĎalšie výsledky: offset=${offset + candidates.length}.` : '';
  return [
    `Nájdených: ${totalLabel}. [RPO, ŠÚ SR, CC-BY 4.0]`,
    '', '| IČO | Názov | Adresa | Stav | Vznik |', '|---|---|---|---|---|',
    ...rows, footer,
  ].join('\n');
}

function identityLines(p: ProfileData): string {
  const konatelia = p.executives.slice(0, 3).map((e) => `${e.name}${e.since ? ` (od ${e.since.slice(0, 4)})` : ''}`).join(', ');
  const extra = p.executives.length > 3 ? ` +${p.executives.length - 3} ďalší` : '';
  const stav = p.status === 'active' ? 'aktívna' : `${STATUS_LABEL[p.status]}${p.status_since ? ` od ${p.status_since}` : ''}`;
  return [
    `**Identita:** ${p.legal_form ?? '?'}, ${p.address ?? 'adresa neznáma'}, vznik ${p.established_on ?? '?'}.`,
    p.executives.length ? `Štatutári: ${konatelia}${extra}.` : '',
    p.main_activity ? `Hlavná činnosť: ${p.main_activity.code} ${p.main_activity.name}.` : '',
    `Stav: ${stav}. [RPO, ŠÚ SR, CC-BY 4.0, k ${p.as_of ?? '?'}]`,
  ].filter(Boolean).join('\n');
}

export function renderProfile(p: ProfileData): string {
  return [`## ${p.name} (IČO ${p.ico})`, '', identityLines(p)].join('\n');
}

function financialsTable(f: FinancialsResult): string {
  const rows = f.years.map((y) =>
    `| ${y.period_label} | ${fmtEur(y.revenue)} | ${fmtEur(y.profit)} | ${fmtEur(y.equity)} | ${fmtPct(y.liabilities_ratio)} |`);
  return ['| Rok | Tržby | VH | Vlastné imanie | Zadlženosť |', '|---|---|---|---|---|', ...rows].join('\n');
}

export function renderFinancials(f: FinancialsResult): string {
  if (f.years.length === 0) {
    const reason = {
      ifrs_pdf_only: `Firma účtuje podľa IFRS — register poskytuje len PDF závierky, štruktúrované dáta nie sú dostupné. PDF: ${f.pdf_statement_ids.map((id) => `${CONFIG.ruz.pdfUrl}/${id}`).join(', ') || 'bez príloh'}.`,
      unsupported_template: 'Výkazy sú v nepodporovanej sústave šablón (neziskovka/banka/JÚ) — štruktúrované metriky nedostupné.',
      no_statements: 'Register neobsahuje žiadnu použiteľnú závierku.',
      not_found: 'IČO nie je v Registri účtovných závierok.',
    }[f.unavailable_reason ?? 'no_statements'];
    return `**Financie (RÚZ):** ${reason} [k ${f.as_of}]`;
  }
  const tpl = f.years[0].template;
  return [`**Financie (RÚZ, ${tpl}, k ${f.as_of}):**`, financialsTable(f)].join('\n');
}

const CREDITOR_LABELS: Record<keyof DebtsData['creditors'], string> = {
  fs: 'Finančná správa', sp: 'Sociálna poisťovňa', vszp: 'VšZP', dovera: 'Dôvera', union: 'Union',
};

export function renderDebts(d: DebtsData): string {
  const entries = Object.entries(d.creditors) as [keyof DebtsData['creditors'], CreditorDebt][];
  const anyDebtor = entries.some(([, c]) => c.status === 'debtor');
  const warnings = entries
    .filter(([, c]) => c.status === 'unavailable' || c.status === 'unverifiable')
    .map(([k, c]) => `⚠ ${CREDITOR_LABELS[k]}: ${c.status === 'unavailable' ? 'zdroj nedostupný' : 'nepodarilo sa jednoznačne overiť'}${c.note ? ` (${c.note})` : ''}.`);

  if (!anyDebtor) {
    const zeros = entries.filter(([, c]) => c.status === 'not_found').map(([k]) => `${CREDITOR_LABELS[k]} 0 €`).join(', ');
    return [`**Dlhy:** ${zeros || 'žiadny zdroj nedostupný'}.`, ...warnings].join('\n');
  }

  const rows = entries.map(([k, c]) => {
    const stav = { debtor: 'dlžník', not_found: 'bez dlhu', unverifiable: '⚠ neoverené', unavailable: '⚠ nedostupné' }[c.status];
    const conf = c.match_confidence ? ` (${c.match_confidence === 'exact' ? 'zhoda adresy' : 'zhoda obce'})` : '';
    return `| ${CREDITOR_LABELS[k]} | ${stav}${conf} | ${fmtEur(c.amount_eur)} | ${c.as_of ?? '—'} |`;
  });
  return [
    `**Dlhy (spolu potvrdených ${fmtEur(d.total_known_debt_eur)}):**`,
    '| Veriteľ | Stav | Suma | K dátumu |', '|---|---|---|---|', ...rows,
    '_Prahy zverejnenia: FS > 170 €, SP ≥ 5 €, ZP > 100 €. Zoznamy nie sú realtime — pozri „K dátumu"._',
  ].join('\n');
}

export function renderVatStatus(v: VatStatusData): string {
  const lines: string[] = [];
  if (!v.registered) {
    lines.push(`**DPH:** nie je registrovaný pre DPH.`);
  } else if (v.is_payer) {
    lines.push(`**DPH:** platiteľ (${v.registration_kind}${v.payer_since ? `, od ${v.payer_since}` : ''}), IČ DPH ${v.ic_dph}.`);
  } else {
    lines.push(`**DPH:** registrovaný podľa ${v.registration_kind} — NIE JE platiteľ DPH. IČ DPH ${v.ic_dph}.`);
  }
  if (v.erased) lines.push(`🔴 Vymazaný platiteľ DPH (§52 ods. 8)${v.erased.erased_on ? `, vymazaný ${v.erased.erased_on}` : ''}.`);
  if (v.risky) lines.push(`🔴 V zozname rizikových platiteľov (§52 ods. 6)${v.risky.published_on ? `, zverejnený ${v.risky.published_on}` : ''}.`);
  lines.push(`[FS OpenData, k ${v.as_of ?? '?'}]`);
  return lines.join('\n');
}

export function renderCheck(input: {
  ico?: string;
  profile: ProfileData | null;
  financials: FinancialsResult | null;
  debts: DebtsData | null;
  vat: VatStatusData | null;
  risk: RiskResult;
  failed_sections: string[];
}): string {
  const { profile, financials, debts, vat, risk, failed_sections } = input;
  const name = profile?.name ?? financials?.name ?? 'Neznámy subjekt';
  const ico = input.ico ?? profile?.ico ?? financials?.ico ?? '?';
  const parts: string[] = [`## ${name} (IČO ${ico}) — verdikt: ${VERDICT_LABEL[risk.verdict]}`];
  if (risk.flags.length) parts.push(`**Dôvody:** ${risk.flags.map((f) => `${f.detail} [${f.source}${f.as_of ? `, k ${f.as_of}` : ''}]`).join('; ')}.`);
  if (profile) parts.push(identityLines(profile));
  if (financials) parts.push(renderFinancials(financials));
  if (debts) parts.push(renderDebts(debts));
  if (vat) parts.push(renderVatStatus(vat));
  for (const note of risk.notes) parts.push(note);
  for (const s of failed_sections) parts.push(`⚠ Sekcia ${s}: zdroj nedostupný.`);
  parts.push(`_${CONFIG.disclaimer}_`);
  return parts.join('\n\n');
}
