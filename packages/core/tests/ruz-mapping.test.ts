import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractMetrics, MAPPING } from '../src/clients/ruz-mapping.js';

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const sablona687 = fx('sablona-687.json');
const sablona699 = fx('sablona-699.json');

describe('extractMetrics — golden fixtures (syntetické hodnoty, S2)', () => {
  it('Firma Jeden 2025 (mikro, šablóna 687)', () => {
    const m = extractMetrics(fx('firma1-2025-vykaz-mikro687.json'), sablona687);
    expect(m).toEqual({
      aktiva_spolu: 677_705,
      vlastne_imanie: 50_460,
      zavazky_celkom: 627_245,
      vynosy_hosp: 885_495,
      trzby: 864_109,
      vh_po_zdaneni: 4_979,
    });
    // syntetické hodnoty (sumy škálované, digesty a veľkosti príloh fiktívne)
  });

  it('Firma Dva FY2024/25 (veľká UJ, šablóna 699, hospodársky rok)', () => {
    const m = extractMetrics(fx('firma2-2025-vykaz-pod699.json'), sablona699);
    expect(m?.trzby).toBe(30_831_648);
    expect(m?.vh_po_zdaneni).toBe(390_221);
    expect(m?.vlastne_imanie).toBe(2_372_856);
    expect(m?.aktiva_spolu).toBe(5_712_582);
  });

  it('IFRS výkaz (Firma Tri) — prázdne tabuľky ⇒ všetky metriky null', () => {
    const vykaz = fx('firma3-2025-vykaz-ifrs.json');
    // IFRS výkazy majú iné idSablony bez mapovania → extractMetrics vráti null
    expect(MAPPING[vykaz.idSablony]).toBeUndefined();
  });

  it('neznáma šablóna ⇒ null (nikdy nie tiché nuly)', () => {
    const vykaz = { ...fx('firma1-2025-vykaz-mikro687.json'), idSablony: 99999 };
    expect(extractMetrics(vykaz, sablona687)).toBeNull();
  });
});
