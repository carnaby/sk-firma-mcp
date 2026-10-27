import { z } from 'zod';
import { CONFIG } from '../config.js';
import { fetchJson } from '../http.js';
import type { LruCache } from '../cache.js';
import { extractMetrics, MAPPING, type RuzSablona, type RuzVykaz } from './ruz-mapping.js';
import { buildYears, type YearInput } from '../domain/financials.js';
import type { AttachmentKind, FinancialsResult, FinancialsUnavailable, StatementAttachment } from '../types.js';

// Zod schémy tolerantné: RÚZ vynecháva null atribúty a čísla vracia ako reťazce (S2 §2).
const UnitLookup = z.object({ id: z.array(z.number()).default([]) });
const Unit = z.object({
  id: z.number(),
  nazovUJ: z.string().optional(),
  idUctovnychZavierok: z.array(z.number()).default([]),
}).passthrough();
const Zavierka = z.object({
  id: z.number(),
  obdobieOd: z.string().optional(),
  obdobieDo: z.string().optional(),
  typ: z.string().optional(),
  konsolidovana: z.boolean().optional(),
  idUctovnychVykazov: z.array(z.number()).default([]),
}).passthrough();

function templateLabel(vykaz: RuzVykaz): string {
  const t = (vykaz.obsah?.titulnaStrana?.typUctovnejJednotky ?? '').toLowerCase();
  if (t.includes('mikro')) return 'mikro UJ';
  if (t.includes('mal')) return 'malá UJ';
  if (t.includes('velk') || t.includes('veľk')) return 'veľká UJ';
  return vykaz.idSablony === 687 ? 'mikro UJ' : 'malá/veľká UJ';
}

// Typ prílohy: najprv podľa názvu šablóny výkazu v RÚZ (autoritatívny), potom podľa
// mena súboru (to si volí firma — napr. oznámenie o schválení sa volá „IFRS_OS_….pdf").
const KINDS: { kind: AttachmentKind; label: string; re: RegExp }[] = [
  { kind: 'auditor_report', label: 'Správa audítora', re: /spr[áa]va\s+(nez[áa]visl[ée]ho\s+)?aud[íi]tora/i },
  { kind: 'annual_report', label: 'Výročná správa', re: /v[ýy]ro[čc]n[áa]\s+spr[áa]va/i },
  { kind: 'selected_data', label: 'Vybrané údaje', re: /vybran[ée]\s+[úu]daje/i },
  { kind: 'approval_notice', label: 'Oznámenie o schválení závierky', re: /ozn[áa]menie\s+o\s+d[áa]tume\s+schv[áa]lenia/i },
  { kind: 'notes', label: 'Poznámky', re: /pozn[áa]mky/i },
  { kind: 'financial_statements', label: 'Účtovná závierka', re: /[úu][čc]tovn[áa]\s+z[áa]vierka/i },
];

// Poradie v rámci roka: najprv samotná závierka, formality na koniec.
const KIND_ORDER: AttachmentKind[] = ['financial_statements', 'auditor_report', 'annual_report', 'notes', 'selected_data', 'approval_notice', 'other'];
const byYearAndKind = (a: StatementAttachment, b: StatementAttachment): number =>
  b.year.localeCompare(a.year) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);

export function classifyAttachment(name: string, templateName: string | null): { kind: AttachmentKind; label: string } {
  for (const text of [templateName ?? '', name]) {
    const hit = KINDS.find((k) => k.re.test(text));
    if (hit) return { kind: hit.kind, label: hit.label };
  }
  return { kind: 'other', label: templateName ?? 'Iný dokument' };
}

export class RuzClient {
  constructor(private cache: LruCache<unknown>) {}

  private async api(path: string, ttlMs = CONFIG.ruz.cacheTtlMs): Promise<unknown> {
    const url = `${CONFIG.ruz.baseUrl}${path}`;
    return this.cache.getOrLoad(`ruz:${url}`, ttlMs, () => fetchJson(url, { timeoutMs: CONFIG.ruz.timeoutMs }));
  }

  async financials(ico: string, years: number): Promise<FinancialsResult> {
    const asOf = new Date().toISOString().slice(0, 10);
    const empty = (reason: FinancialsUnavailable, name: string | null = null): FinancialsResult =>
      ({ ico, name, years: [], unavailable_reason: reason, pdf_attachments: [], as_of: asOf });

    const lookup = UnitLookup.parse(await this.api(`/uctovne-jednotky?zmenene-od=2000-01-01&ico=${ico}`));
    if (lookup.id.length === 0) return empty('not_found');

    let unit: z.infer<typeof Unit> | null = null;
    for (const id of lookup.id) {
      const u = Unit.parse(await this.api(`/uctovna-jednotka?id=${id}`));
      if (u.idUctovnychZavierok.length > 0) { unit = u; break; }
    }
    if (!unit) return empty('no_statements');
    const name = unit.nazovUJ ?? null;

    const zavierky = [];
    for (const zid of unit.idUctovnychZavierok) {
      zavierky.push(Zavierka.parse(await this.api(`/uctovna-zavierka?id=${zid}`)));
    }
    const kandidati = zavierky
      .filter((zav) => zav.konsolidovana !== true && (zav.typ === 'Riadna' || zav.typ === 'Mimoriadna'))
      .sort((a, b) => (b.obdobieDo ?? '').localeCompare(a.obdobieDo ?? ''));
    const vybrane: typeof kandidati = [];
    for (const zav of kandidati) {
      if (vybrane.length >= years) break;
      if (vybrane.some((v) => v.obdobieDo === zav.obdobieDo)) continue;
      vybrane.push(zav);
    }
    if (vybrane.length === 0) return empty('no_statements', name);

    const yearInputs: YearInput[] = [];
    const attachments: StatementAttachment[] = [];
    let sawPdfOnly = false;
    for (const zav of vybrane) {
      let structured: RuzVykaz | null = null;
      const pdfVykazy: RuzVykaz[] = [];
      for (const vid of zav.idUctovnychVykazov) {
        const vykaz = (await this.api(`/uctovny-vykaz?id=${vid}`)) as RuzVykaz;
        if (MAPPING[vykaz.idSablony] && (vykaz.obsah?.tabulky ?? []).some((t) => (t.data ?? []).length > 0)) {
          structured = { ...vykaz, id: vykaz.id ?? vid };
          break;
        }
        if ((vykaz.prilohy ?? []).length > 0) pdfVykazy.push(vykaz);
      }
      if (!structured) {
        if (pdfVykazy.length > 0) sawPdfOnly = true;
        const periodTo = zav.obdobieDo ?? '';
        for (const vykaz of pdfVykazy) {
          for (const p of vykaz.prilohy ?? []) {
            if (typeof p.id !== 'number') continue;
            const name = p.meno ?? `príloha ${p.id}`;
            const kind = classifyAttachment(name, await this.templateName(vykaz.idSablony));
            attachments.push({
              year: periodTo.slice(0, 4), period_to: periodTo, kind: kind.kind, label: kind.label, name,
              size_bytes: typeof p.velkostPrilohy === 'number' ? p.velkostPrilohy : null,
              attachment_id: p.id, url: `${CONFIG.ruz.attachmentUrl}/${p.id}`,
            });
          }
        }
        continue;
      }
      const sablona = (await this.api(`/sablona?id=${structured.idSablony}`, 7 * 24 * 3600_000)) as RuzSablona;
      const metrics = extractMetrics(structured, sablona);
      if (!metrics) continue; // nemalo by nastať (MAPPING overený vyššie), ale nikdy tiché nuly
      yearInputs.push({
        period_from: zav.obdobieOd ?? structured.obsah?.titulnaStrana?.obdobieOd ?? '',
        period_to: zav.obdobieDo ?? structured.obsah?.titulnaStrana?.obdobieDo ?? '',
        template: templateLabel(structured),
        statement_id: structured.id!,
        metrics,
      });
    }

    attachments.sort(byYearAndKind);
    if (yearInputs.length === 0) {
      return { ico, name, years: [], unavailable_reason: sawPdfOnly ? 'ifrs_pdf_only' : 'unsupported_template', pdf_attachments: attachments, as_of: asOf };
    }
    return { ico, name, years: buildYears(yearInputs), unavailable_reason: null, pdf_attachments: attachments, as_of: asOf };
  }

  /** Názov šablóny výkazu (napr. „Správa audítora") — fallback pri type prílohy. Zlyhanie nie je chyba. */
  private async templateName(idSablony: number): Promise<string | null> {
    try {
      const t = (await this.api(`/sablona?id=${idSablony}`, 7 * 24 * 3600_000)) as { nazov?: string };
      return t.nazov ?? null;
    } catch {
      return null;
    }
  }
}
