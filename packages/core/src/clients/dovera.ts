// Dôvera nemá export ani API — server-rendered HTML vyhľadávanie per IČO (S4).
// Vedome krehké: parser je tolerantný a KAŽDÉ zlyhanie degraduje na
// 'unavailable' (⚠ v odpovedi), nikdy nie výnimka smerom k toolu.
import { fetch } from 'undici';
import { CONFIG } from '../config.js';
import type { LruCache } from '../cache.js';
import { acquireUpstreamSlot } from '../upstream.js';

export type DoveraResult =
  | { status: 'debtor'; amount_eur: number; as_of: string | null }
  | { status: 'not_found'; as_of: string | null }
  | { status: 'unavailable'; note: string };

const MONTHS: Record<string, string> = {
  'januára': '01', 'februára': '02', 'marca': '03', 'apríla': '04', 'mája': '05', 'júna': '06',
  'júla': '07', 'augusta': '08', 'septembra': '09', 'októbra': '10', 'novembra': '11', 'decembra': '12',
};

export function parseDoveraHtml(html: string, ico: string): DoveraResult {
  const asOfMatch = /k dátumu\s+(\d{1,2})\.\s*([a-záéíóúýčďľňšťž]+)\s+(\d{4})/i.exec(html);
  const asOf = asOfMatch && MONTHS[asOfMatch[2].toLowerCase()]
    ? `${asOfMatch[3]}-${MONTHS[asOfMatch[2].toLowerCase()]}-${asOfMatch[1].padStart(2, '0')}`
    : null;
  // Digit-boundary match — 8-miestne IČO sa nesmie nájsť vnútri dlhšieho
  // číselného behu (telefón, iný identifikátor) → žiadne false positives.
  const icoMatch = new RegExp(`(?<!\\d)${ico}(?!\\d)`).exec(html);
  if (!icoMatch) return { status: 'not_found', as_of: asOf };
  const window = html.slice(icoMatch.index, icoMatch.index + 500);
  const amountMatch = /([\d\s ]+,\d{2})\s*€/.exec(window);
  if (!amountMatch) return { status: 'unavailable', note: 'IČO je v odpovedi Dôvery, ale suma sa nedala prečítať (zmena HTML?).' };
  const amount = Number(amountMatch[1].replace(/[\s ]/g, '').replace(',', '.'));
  return { status: 'debtor', amount_eur: amount, as_of: asOf };
}

export class DoveraClient {
  constructor(private cache: LruCache<unknown>) {}

  async lookup(ico: string): Promise<DoveraResult> {
    if (!CONFIG.dovera.enabled) {
      return { status: 'unavailable', note: 'Dôvera lookup je vypnutý (SKFIRMA_DOVERA=0).' };
    }
    const url = `${CONFIG.dovera.searchUrl}${encodeURIComponent(ico)}`;
    return (await this.cache.getOrLoad(`dovera:${ico}`, CONFIG.dovera.cacheTtlMs, async () => {
      try {
        await acquireUpstreamSlot(new URL(url).host);
        const res = await fetch(url, {
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sk-firma-mcp' },
          signal: AbortSignal.timeout(CONFIG.dovera.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseDoveraHtml(await res.text(), ico);
      } catch (e) {
        // Dôvera je doplnkový zdroj — vyťaženie/výpadok degraduje na unavailable, nezhodí previerku
        console.error('[dovera] lookup zlyhal:', e instanceof Error ? e.message : e);
        return { status: 'unavailable', note: 'Dôvera vyhľadávanie momentálne nedostupné.' } satisfies DoveraResult;
      }
    }, (r) => (r as DoveraResult).status !== 'unavailable')) as DoveraResult;
  }
}
