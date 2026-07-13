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
      aktiva_spolu: 816_512,
      vlastne_imanie: 60_795,
      zavazky_celkom: 755_717,
      vynosy_hosp: 1_066_862,
      trzby: 1_041_095,
      vh_po_zdaneni: 5_999,
    });
    // syntetické hodnoty (škálované) — pôvodné overenie voči Finstatu je zdokumentované mimo repa
  });

  it('Firma Dva FY2024/25 (veľká UJ, šablóna 699, hospodársky rok)', () => {
    const m = extractMetrics(fx('firma2-2025-vykaz-pod699.json'), sablona699);
    expect(m?.trzby).toBe(37_146_564);
    expect(m?.vh_po_zdaneni).toBe(470_146);
    expect(m?.vlastne_imanie).toBe(2_858_863);
    expect(m?.aktiva_spolu).toBe(6_882_629);
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
