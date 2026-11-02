// Zdieľané RPO helpery — dedupe medzi src/domain/profile.ts a src/clients/rpo.ts.

/** Aktuálny záznam = prvý bez validTo (RPO verzované polia). */
export const current = <T extends { validTo?: string }>(items: T[] | undefined): T | undefined =>
  (items ?? []).find((i) => i.validTo === undefined);

/**
 * Aktuálny záznam, inak posledný platný (najneskoršie validTo). Zaniknutý subjekt nemá v RPO „aktuálne"
 * meno ani adresu — bez fallbacku by mal prázdny názov a FS dlžník by sa hľadal podľa ''.
 */
export const latest = <T extends { validTo?: string }>(items: T[] | undefined): T | undefined =>
  current(items) ?? [...(items ?? [])].sort((a, b) => (b.validTo ?? '').localeCompare(a.validTo ?? ''))[0];

/** "Ulica číslo, PSČ obec" z RPO adresy; null, ak nič nie je vyplnené. */
export function formatRpoAddress(
  a: { street?: string; buildingNumber?: string; postalCodes?: string[]; municipality?: { value?: string } } | undefined,
): string | null {
  if (!a) return null;
  const streetPart = [a.street, a.buildingNumber].filter(Boolean).join(' ');
  const cityPart = [a.postalCodes?.[0], a.municipality?.value].filter(Boolean).join(' ');
  const parts = [streetPart, cityPart].filter((p) => p && p.length > 0);
  return parts.length ? parts.join(', ') : null;
}
