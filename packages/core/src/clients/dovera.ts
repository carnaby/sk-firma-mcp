// Dôvera nemá export ani API — server-rendered HTML vyhľadávanie per IČO (S4).
// Vedome krehké, preto rozlišujeme príčinu zlyhania:
// - unavailable (retryable) = výpadok, timeout, 429/5xx alebo Cloudflare challenge → skús neskôr
// - parse_error (nie retryable) = odpoveď prišla, ale nevieme ju prečítať → treba opraviť parser
// Žiadne zlyhanie nikdy nie je výnimka smerom k toolu ani tichá nula.
import { fetch } from 'undici';
import { CONFIG } from '../config.js';
import type { LruCache } from '../cache.js';
import { acquireUpstreamSlot } from '../upstream.js';

export type DoveraResult =
  | { status: 'debtor'; amount_eur: number; as_of: string | null }
  | { status: 'not_found'; as_of: string | null }
  | { status: 'unavailable'; retryable: boolean; note: string }
  | { status: 'parse_error'; note: string };

// Dôvera píše dátum raz v genitíve („27. októbra"), raz v nominatíve („27. október").
const MONTHS: Record<string, string> = {
  'január': '01', 'januára': '01', 'február': '02', 'februára': '02', 'marec': '03', 'marca': '03',
  'apríl': '04', 'apríla': '04', 'máj': '05', 'mája': '05', 'jún': '06', 'júna': '06',
  'júl': '07', 'júla': '07', 'august': '08', 'augusta': '08', 'september': '09', 'septembra': '09',
  'október': '10', 'októbra': '10', 'november': '11', 'novembra': '11', 'december': '12', 'decembra': '12',
};

const decode = (s: string): string => s
  .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
  .replace(/&euro;|&#8364;|&#x20ac;/gi, '€')
  .replace(/&amp;/gi, '&')
  .replace(/\u00a0/g, ' ');

function parseAsOf(html: string): string | null {
  const m = /k dátumu\s+(\d{1,2})\.\s*([a-záäéíóôúýčďľĺňŕšťž]+)\s+(\d{4})/i.exec(decode(html));
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  return m && month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
}

function parseAmount(text: string): number | null {
  const m = /(\d[\d ]*,\d{2})\s*€/.exec(decode(text));
  return m ? Number(m[1].replace(/ /g, '').replace(',', '.')) : null;
}

// Cloudflare „managed challenge" — stránka obsahuje aj hľadané IČO (v URL), takže
// ju treba rozpoznať skôr, než ju parser vyhodnotí ako výsledok. Pozor: skript
// /cdn-cgi/challenge-platform/ Cloudflare vkladá aj do bežných stránok — nie je to znak.
const isChallenge = (html: string): boolean => /_cf_chl_opt|<title>\s*Just a moment/i.test(html);

export function parseDoveraHtml(html: string, ico: string): DoveraResult {
  if (isChallenge(html)) {
    return { status: 'unavailable', retryable: true, note: 'Dôvera dočasne blokuje automatické dopyty (ochrana proti botom) — skús neskôr.' };
  }
  const asOf = parseAsOf(html);
  // Výsledky sú položky <li class="dlznici__item"> s „IČO: …" a <div class="item-sum">.
  // Samotný výskyt IČO nestačí: stránka ho opakuje vo formulári aj v hláške „nenašli".
  const items = html.split(/class="dlznici__item"/).slice(1);
  for (const item of items) {
    const icoMatch = /IČO:\s*(\d{8})(?!\d)/.exec(decode(item));
    if (icoMatch?.[1] !== ico) continue;
    const sum = /class="item-sum"[^>]*>([^<]*)</.exec(item);
    const amount = sum ? parseAmount(sum[1]) : null;
    if (amount === null) {
      return { status: 'parse_error', note: 'Dôvera: subjekt je v zozname dlžníkov, ale sumu sa nepodarilo prečítať (zmena formátu stránky).' };
    }
    return { status: 'debtor', amount_eur: amount, as_of: asOf };
  }
  if (/nenašli\s+žiadne\s+výsledky/i.test(decode(html)) || items.length > 0) return { status: 'not_found', as_of: asOf };
  return { status: 'parse_error', note: 'Dôvera: neznámy formát odpovede — nevieme rozhodnúť, či je subjekt v zozname.' };
}

export class DoveraClient {
  constructor(private cache: LruCache<unknown>) {}

  async lookup(ico: string): Promise<DoveraResult> {
    if (!CONFIG.dovera.enabled) {
      return { status: 'unavailable', retryable: false, note: 'Dôvera lookup je vypnutý (SKFIRMA_DOVERA=0).' };
    }
    const url = `${CONFIG.dovera.searchUrl}${encodeURIComponent(ico)}`;
    return (await this.cache.getOrLoad(`dovera:${ico}`, CONFIG.dovera.cacheTtlMs, async () => {
      let html: string;
      try {
        await acquireUpstreamSlot(new URL(url).host);
        const res = await fetch(url, {
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sk-firma-mcp' },
          signal: AbortSignal.timeout(CONFIG.dovera.timeoutMs),
        });
        html = await res.text();
        if (!res.ok) {
          // 429/403 od Cloudflare a 5xx sú dočasné; iné 4xx skôr znamenajú zmenu na strane Dôvery
          const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
          console.error(`[dovera] HTTP ${res.status}`);
          return { status: 'unavailable', retryable, note: `Dôvera odpovedala HTTP ${res.status}${retryable ? ' — skús neskôr' : ''}.` } satisfies DoveraResult;
        }
      } catch (e) {
        // timeout, sieť, vyťažený upstream (vlastný limit) — doplnkový zdroj previerku nezhodí
        console.error('[dovera] lookup zlyhal:', e instanceof Error ? e.message : e);
        return { status: 'unavailable', retryable: true, note: 'Dôvera vyhľadávanie momentálne nedostupné — skús neskôr.' } satisfies DoveraResult;
      }
      const result = parseDoveraHtml(html, ico);
      if (result.status === 'parse_error') {
        const i = html.indexOf('main-content');
        console.error(`[dovera] parse_error (${result.note}) — úryvok HTML:`, html.slice(Math.max(0, i), Math.max(0, i) + 600).replace(/\s+/g, ' '));
      }
      return result;
      // cachujeme len definitívne odpovede; chyby sa majú dať zopakovať hneď po oprave
    }, (r) => (r as DoveraResult).status === 'debtor' || (r as DoveraResult).status === 'not_found')) as DoveraResult;
  }
}
