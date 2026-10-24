import { z } from 'zod';
import { CONFIG } from '../config.js';
import { fetchJson } from '../http.js';
import type { LruCache } from '../cache.js';
import { extractMetrics, MAPPING, type RuzSablona, type RuzVykaz } from './ruz-mapping.js';
import { buildYears, type YearInput } from '../domain/financials.js';
import type { FinancialsResult, FinancialsUnavailable } from '../types.js';

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

export class RuzClient {
  constructor(private cache: LruCache<unknown>) {}

  private async api(path: string, ttlMs = CONFIG.ruz.cacheTtlMs): Promise<unknown> {
    const url = `${CONFIG.ruz.baseUrl}${path}`;
    return this.cache.getOrLoad(`ruz:${url}`, ttlMs, () => fetchJson(url, { timeoutMs: CONFIG.ruz.timeoutMs }));
  }

  async financials(ico: string, years: number): Promise<FinancialsResult> {
    const asOf = new Date().toISOString().slice(0, 10);
    const empty = (reason: FinancialsUnavailable, name: string | null = null): FinancialsResult =>
      ({ ico, name, years: [], unavailable_reason: reason, pdf_statement_ids: [], as_of: asOf });

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
    const pdfIds: number[] = [];
    let sawPdfOnly = false;
    for (const zav of vybrane) {
      let structured: RuzVykaz | null = null;
      const zavPdfIds: number[] = [];
      for (const vid of zav.idUctovnychVykazov) {
        const vykaz = (await this.api(`/uctovny-vykaz?id=${vid}`)) as RuzVykaz;
        if (MAPPING[vykaz.idSablony] && (vykaz.obsah?.tabulky ?? []).some((t) => (t.data ?? []).length > 0)) {
          structured = { ...vykaz, id: vykaz.id ?? vid };
          break;
        }
        if ((vykaz.prilohy ?? []).length > 0) zavPdfIds.push(vykaz.id ?? vid);
      }
      if (!structured) {
        pdfIds.push(...zavPdfIds);
        if (zavPdfIds.length > 0) sawPdfOnly = true;
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

    if (yearInputs.length === 0) {
      return { ico, name, years: [], unavailable_reason: sawPdfOnly ? 'ifrs_pdf_only' : 'unsupported_template', pdf_statement_ids: pdfIds, as_of: asOf };
    }
    return { ico, name, years: buildYears(yearInputs), unavailable_reason: null, pdf_statement_ids: pdfIds, as_of: asOf };
  }
}
