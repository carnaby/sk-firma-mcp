import { CONFIG } from '../config.js';
import type { CreditorDebt, DebtsData, FinancialsResult, IndexFreshness, ProfileData, SearchCandidate, StatementAttachment, VatStatusData } from '../types.js';
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

const VERDICT_LABEL = { red: '🔴 VYSOKÉ RIZIKO', orange: '🟠 ZVÝŠENÉ RIZIKO', green: '🟢 BEZ ZISTENÍ', incomplete: '⚪ NEDÁ SA POSÚDIŤ (neúplné dáta)' } as const;
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
    `Stav: ${stav}. [RPO, ŠÚ SR, CC-BY 4.0; živý dopyt ${p.as_of}${p.record_modified_on ? `, posledná zmena záznamu v registri ${p.record_modified_on}` : ''}]`,
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

export function fmtSize(bytes: number | null): string {
  if (bytes === null) return '';
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} kB` : `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/** PDF prílohy zoskupené podľa roku, najnovšie maxYears rokov (staršie cez parameter years). */
function attachmentLines(atts: StatementAttachment[], maxYears: number): string[] {
  const years = [...new Set(atts.map((a) => a.year))].sort().reverse();
  const shown = years.slice(0, maxYears);
  const lines = shown.map((y) => `- ${y}: ${atts.filter((a) => a.year === y)
    .map((a) => `${a.label}${a.size_bytes !== null ? ` (${fmtSize(a.size_bytes)})` : ''} ${a.url}`).join(' · ')}`);
  if (years.length > shown.length) lines.push(`- staršie roky (${years.slice(shown.length).join(', ')}) vynechané`);
  return lines;
}

export function renderFinancials(f: FinancialsResult, opts: { maxAttachmentYears?: number } = {}): string {
  const maxYears = opts.maxAttachmentYears ?? 2;
  if (f.years.length === 0) {
    const reason = {
      ifrs_pdf_only: 'štruktúrované dáta nie sú k dispozícii — závierka je len v PDF (IFRS). Čísla sú v prílohách:',
      unsupported_template: 'výkazy sú v nepodporovanej sústave šablón (neziskovka/banka/JÚ) — štruktúrované metriky nedostupné.',
      no_statements: 'register neobsahuje žiadnu použiteľnú závierku.',
      not_found: 'IČO nie je v Registri účtovných závierok.',
    }[f.unavailable_reason ?? 'no_statements'];
    const lines = [`**Financie (RÚZ, živý dopyt ${f.as_of}):** ${reason}`];
    if (f.pdf_attachments.length) lines.push(...attachmentLines(f.pdf_attachments, maxYears));
    return lines.join('\n');
  }
  const tpl = f.years[0].template;
  const lines = [`**Financie (RÚZ, ${tpl}, živý dopyt ${f.as_of}):**`, financialsTable(f)];
  if (f.pdf_attachments.length) lines.push('PDF prílohy rokov bez štruktúrovaných dát:', ...attachmentLines(f.pdf_attachments, maxYears));
  return lines.join('\n');
}

const CREDITOR_LABELS: Record<keyof DebtsData['creditors'], string> = {
  fs: 'Finančná správa', sp: 'Sociálna poisťovňa', vszp: 'VšZP', dovera: 'Dôvera', union: 'Union',
};

function creditorWarning(label: string, c: CreditorDebt): string | null {
  const note = c.note ? ` ${c.note}` : '';
  switch (c.status) {
    case 'unavailable': return `⚠ ${label}: ${c.retryable ? 'dočasne nedostupné (skús neskôr).' : 'nedostupné.'}${note}`;
    case 'parse_error': return `⚠ ${label}: chyba spracovania odpovede zdroja (nie dočasný výpadok, opakovanie nepomôže).${note}`;
    case 'unverifiable': return `⚠ ${label}: nepodarilo sa jednoznačne overiť.${note}`;
    case 'not_supported': return `${label}: nesledované.${note}`;
    default: return null;
  }
}

export function renderDebts(d: DebtsData): string {
  const entries = Object.entries(d.creditors) as [keyof DebtsData['creditors'], CreditorDebt][];
  const anyDebtor = entries.some(([, c]) => c.status === 'debtor');
  const warnings = entries.map(([k, c]) => creditorWarning(CREDITOR_LABELS[k], c)).filter((w): w is string => w !== null);

  if (!anyDebtor) {
    const zeros = entries.filter(([, c]) => c.status === 'not_found')
      .map(([k, c]) => `${CREDITOR_LABELS[k]} 0 €${c.as_of ? ` (zoznam k ${c.as_of})` : ''}`).join(', ');
    return [`**Dlhy:** ${zeros || 'žiadny zoznam dlžníkov nie je dostupný'}.`, ...warnings].join('\n');
  }

  const rows = entries.map(([k, c]) => {
    const stav = {
      debtor: 'dlžník', not_found: 'bez dlhu', unverifiable: '⚠ neoverené',
      unavailable: c.retryable ? '⚠ dočasne nedostupné' : '⚠ nedostupné',
      parse_error: '⚠ chyba spracovania', not_supported: 'nesledované',
    }[c.status];
    const conf = c.match_confidence ? ` (${c.match_confidence === 'exact' ? 'zhoda adresy' : 'zhoda obce'})` : '';
    return `| ${CREDITOR_LABELS[k]} | ${stav}${conf} | ${fmtEur(c.amount_eur)} | ${c.as_of ?? '—'} |`;
  });
  return [
    `**Dlhy (spolu potvrdených ${fmtEur(d.total_known_debt_eur)}):**`,
    '| Veriteľ | Stav | Suma | Zoznam k |', '|---|---|---|---|', ...rows,
    ...warnings.filter((w) => w.startsWith('⚠')),
    '_Prahy zverejnenia: FS > 170 €, SP ≥ 5 €, ZP > 100 €. Zoznamy nie sú realtime — pozri „Zoznam k"._',
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
  lines.push(`[FS OpenData, zoznam k ${v.as_of ?? '?'}]`);
  return lines.join('\n');
}

export function renderIndexFreshness(f: IndexFreshness | null): string | null {
  if (!f?.updated_at) return null;
  const date = f.updated_at.slice(0, 10);
  return f.stale
    ? `⚠ **Lokálny index dlžníkov a DPH je starý ${f.age_days} dní** (naposledy aktualizovaný ${date}) — dlhy a DPH nemusia zodpovedať súčasnosti.`
    : `_Lokálny index dlžníkov a DPH aktualizovaný ${date}._`;
}

export function renderCheck(input: {
  ico?: string;
  profile: ProfileData | null;
  financials: FinancialsResult | null;
  debts: DebtsData | null;
  vat: VatStatusData | null;
  risk: RiskResult;
  failed_sections: string[];
  index_freshness?: IndexFreshness | null;
}): string {
  const { profile, financials, debts, vat, risk, failed_sections } = input;
  const name = profile?.name ?? financials?.name ?? 'Neznámy subjekt';
  const ico = input.ico ?? profile?.ico ?? financials?.ico ?? '?';
  const parts: string[] = [`## ${name} (IČO ${ico}) — verdikt: ${VERDICT_LABEL[risk.verdict]}`];
  if (risk.flags.length) {
    parts.push(`**Dôvody:** ${risk.flags.map((f) => `${f.detail} [${f.source}${f.as_of ? `, k ${f.as_of}` : ''}]`).join('; ')}.`);
    if (risk.incomplete.length) parts.push(`**Neúplné dáta** (verdikt nezhoršujú): ${risk.incomplete.join('; ')}.`);
  } else if (risk.incomplete.length) {
    parts.push(`**Dôvody:** ${risk.incomplete.join('; ')}. Žiadny rizikový signál sme nezistili, ale bez týchto dát sa firma nedá posúdiť.`);
  }
  const freshness = renderIndexFreshness(input.index_freshness ?? null);
  if (freshness?.startsWith('⚠')) parts.push(freshness);
  if (profile) parts.push(identityLines(profile));
  if (financials) parts.push(renderFinancials(financials));
  if (debts) parts.push(renderDebts(debts));
  if (vat) parts.push(renderVatStatus(vat));
  if (freshness && !freshness.startsWith('⚠')) parts.push(freshness);
  for (const s of failed_sections) parts.push(`⚠ Sekcia ${s}: zdroj nedostupný.`);
  parts.push(`_${CONFIG.disclaimer}_`);
  return parts.join('\n\n');
}
