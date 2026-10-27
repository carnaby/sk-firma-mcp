// Mapovanie riadkov RÚZ výkazov na metriky — šablóny 687 (Úč MUJ, mikro)
// a 699 (Úč POD, malá+veľká UJ). Zdroj pravdy: docs/spikes/S2-ruz.md §4.
// Dátový model: obsah.tabulky[].data je plochý row-major zoznam; počet
// stĺpcov = data.length / počet riadkov šablóny. Úč POD aktíva: 4 stĺpce
// [brutto, korekcia, netto, nettoMinulé] → netto = index 2; ostatné
// tabuľky: [bežné, minulé] → bežné = index 0.

export interface RuzTabulka {
  nazov?: { sk?: string };
  data?: (string | null)[];
}
export interface RuzVykaz {
  id?: number;
  idSablony: number;
  pristupnostDat?: string;
  prilohy?: { id?: number; meno?: string; velkostPrilohy?: number; mimeType?: string; digest?: string }[];
  obsah?: {
    titulnaStrana?: {
      ico?: string;
      nazovUctovnejJednotky?: string;
      obdobieOd?: string;
      obdobieDo?: string;
      typUctovnejJednotky?: string;
    };
    tabulky?: RuzTabulka[];
  };
}
export interface RuzSablona {
  id?: number;
  nazov?: { sk?: string };
  tabulky?: { nazov?: { sk?: string }; riadky?: { cisloRiadku: number }[] }[];
}

export type MetricKey =
  | 'aktiva_spolu'
  | 'vlastne_imanie'
  | 'zavazky_celkom'
  | 'vynosy_hosp'
  | 'trzby'
  | 'vh_po_zdaneni';

export type Metrics = Record<MetricKey, number | null>;

interface MetricSpec {
  tab: string;
  r: number | number[];
  col: 'bezne' | 'netto';
}

export const MAPPING: Record<number, Record<MetricKey, MetricSpec>> = {
  687: {
    aktiva_spolu: { tab: 'Strana aktív', r: 1, col: 'bezne' },
    vlastne_imanie: { tab: 'Strana pasív', r: 25, col: 'bezne' },
    zavazky_celkom: { tab: 'Strana pasív', r: 34, col: 'bezne' },
    vynosy_hosp: { tab: 'Výkaz ziskov a strát', r: 1, col: 'bezne' },
    trzby: { tab: 'Výkaz ziskov a strát', r: [2, 3], col: 'bezne' },
    vh_po_zdaneni: { tab: 'Výkaz ziskov a strát', r: 38, col: 'bezne' },
  },
  699: {
    aktiva_spolu: { tab: 'Strana aktív', r: 1, col: 'netto' },
    vlastne_imanie: { tab: 'Strana pasív', r: 80, col: 'bezne' },
    zavazky_celkom: { tab: 'Strana pasív', r: 101, col: 'bezne' },
    vynosy_hosp: { tab: 'Výkaz ziskov a strát', r: 2, col: 'bezne' },
    trzby: { tab: 'Výkaz ziskov a strát', r: [3, 4, 5], col: 'bezne' },
    vh_po_zdaneni: { tab: 'Výkaz ziskov a strát', r: 61, col: 'bezne' },
  },
};

export function extractMetrics(vykaz: RuzVykaz, sablona: RuzSablona): Metrics | null {
  const mapping = MAPPING[vykaz.idSablony];
  if (!mapping) return null; // nepodporovaná šablóna — volajúci rieši fallback

  const out = {} as Metrics;
  for (const [metrika, spec] of Object.entries(mapping) as [MetricKey, MetricSpec][]) {
    const tab = (vykaz.obsah?.tabulky ?? []).find((t) => (t.nazov?.sk ?? '') === spec.tab);
    const sTab = (sablona.tabulky ?? []).find((t) => (t.nazov?.sk ?? '') === spec.tab);
    const riadky = sTab?.riadky ?? [];
    if (!tab?.data?.length || riadky.length === 0) {
      out[metrika] = null;
      continue;
    }
    const nCols = tab.data.length / riadky.length;
    if (!Number.isInteger(nCols)) {
      throw new Error(
        `RÚZ výkaz ${vykaz.id ?? '?'}: tabuľka „${spec.tab}" má ${tab.data.length} hodnôt, nedeliteľné ${riadky.length} riadkami šablóny ${vykaz.idSablony}`,
      );
    }
    const colIdx = spec.col === 'netto' && nCols === 4 ? 2 : 0;
    const rs = Array.isArray(spec.r) ? spec.r : [spec.r];
    let sum = 0;
    let found = false;
    for (const rNum of rs) {
      const idx = riadky.findIndex((r) => r.cisloRiadku === rNum);
      if (idx < 0) continue;
      const raw = tab.data[idx * nCols + colIdx];
      if (raw != null && raw !== '') {
        sum += Number(raw);
        found = true;
      }
    }
    out[metrika] = found ? sum : null;
  }
  return out;
}
