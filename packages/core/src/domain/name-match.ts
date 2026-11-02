// FS zoznam daňových dlžníkov nemá IČO (S3) — priraďujeme normalizovaným
// názvom + adresou. Zásada: NIKDY false positive; nejednoznačnosť je
// 'unverifiable' a prezentuje sa ako "nepodarilo sa jednoznačne overiť".

const stripDiacritics = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

const INSOLVENCY_SUFFIX = /\s+v\s+(likvidacii|konkurze|restrukturalizacii)\s*$/;

// Spoločná základná normalizácia pre názvy aj obce: lowercase → bez
// diakritiky → interpunkcia/úvodzovky na medzery → zrazený whitespace.
const baseNormalize = (s: string): string =>
  stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

export function normalizeName(name: string): string {
  return baseNormalize(name).replace(INSOLVENCY_SUFFIX, '').trim();
}

export function normalizeObec(obec: string): string {
  // Najprv orež " - mestská časť ..." chvost (na texte bez diakritiky,
  // tolerantne k interpunkcii okolo pomlčky), až potom spoločná normalizácia.
  const o = stripDiacritics(obec.toLowerCase()).replace(/[\s,-]*mestska cast.*$/, '');
  return baseNormalize(o);
}

export interface TaxDebtorCandidate {
  name: string;
  psc: string | null;
  obec_norm: string | null;
  street: string | null; // FS: ulica vrátane čísla domu, napr. "Nám. Sv. Trojice 1953/7"
  amount_eur: number;
}

export type TaxMatch =
  | { status: 'debtor'; amount_eur: number; confidence: 'exact' | 'high' }
  | { status: 'unverifiable'; note: string }
  | { status: 'not_found' };

const normPsc = (psc: string | null): string | null => (psc ? psc.replace(/\s+/g, '') : null);

/**
 * FS má ulicu aj číslo v jednom poli ("Nám. Sv. Trojice 1953/7", v obciach bez ulíc len "141"), RPO zvlášť.
 * Zhoda = rovnaký názov ulice (aj prázdny pri obci bez ulíc) a rovnaké celé číslo domu. Skratky („Nám." vs
 * „Námestie") zhodu nedajú — to je bezpečný smer (unverifiable, nie cudzí dlh).
 */
function sameAddress(fsStreet: string | null, street: string | null | undefined, buildingNumber: string | null | undefined): boolean {
  if (!fsStreet || !buildingNumber) return false;
  const tokens = baseNormalize(fsStreet).split(' ');
  const firstNum = tokens.findIndex((t) => /\d/.test(t));
  if (firstNum < 0) return false;
  const num = baseNormalize(buildingNumber);
  return num !== ''
    && tokens.slice(firstNum).join(' ') === num
    && tokens.slice(0, firstNum).join(' ') === baseNormalize(street ?? '');
}

export function matchTaxDebtor(
  candidates: TaxDebtorCandidate[],
  company: {
    psc: string | null;
    municipality: string | null;
    street?: string | null;
    building_number: string | null | undefined;
    /** Obchodné meno v obchodnom registri je zo zákona jedinečné; meno živnostníka či združenia nie. */
    unique_name: boolean;
  },
): TaxMatch {
  if (candidates.length === 0) return { status: 'not_found' };
  if (candidates.length > 1) {
    return { status: 'unverifiable', note: `V zozname FS je ${candidates.length} subjektov s rovnakým názvom — nepodarilo sa jednoznačne priradiť.` };
  }
  const cand = candidates[0];
  const psc = normPsc(company.psc);
  if (!company.unique_name) {
    // rovnaké meno môžu mať dvaja rôzni ľudia — dlžník len pri zhode PSČ, ulice aj čísla domu
    if (psc && normPsc(cand.psc) === psc && sameAddress(cand.street, company.street, company.building_number)) {
      return { status: 'debtor', amount_eur: cand.amount_eur, confidence: 'exact' };
    }
    return { status: 'unverifiable', note: 'Subjekt s rovnakým menom je v zozname FS, ale mimo obchodného registra meno nie je jedinečné a adresa sa presne nezhoduje — nepodarilo sa jednoznačne overiť.' };
  }
  if (psc && normPsc(cand.psc) === psc) {
    return { status: 'debtor', amount_eur: cand.amount_eur, confidence: 'exact' };
  }
  const obec = company.municipality ? normalizeObec(company.municipality) : null;
  if (obec && cand.obec_norm === obec) {
    return { status: 'debtor', amount_eur: cand.amount_eur, confidence: 'high' };
  }
  return { status: 'unverifiable', note: 'Subjekt s rovnakým názvom je v zozname FS, ale adresa nesedí — nepodarilo sa jednoznačne overiť.' };
}
