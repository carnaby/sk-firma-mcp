// Chyby tool vrstvy: hláška je určená LLM klientovi — musí byť akčná
// (čo je zle + aký tool/parameter použiť namiesto toho). Interné detaily
// zdrojov (stack, URL) do hlášky nepatria.
export class ToolError extends Error {}

/** Náš server odmieta dopyt, aby nezahltil zdrojové API (fronta plná / denný limit). */
export class BusyError extends ToolError {
  constructor(message: string, public retryAfterSec: number) {
    super(message);
  }
}

export function validateIco(input: string): string {
  const ico = input.replace(/\s+/g, '');
  if (/^\d{8}$/.test(ico)) return ico;
  if (/^\d+$/.test(ico)) {
    throw new ToolError(
      `IČO ${ico} má ${ico.length} číslic, očakávam 8. Skús skfirma_search, ak nepoznáš presné IČO.`,
    );
  }
  throw new ToolError(
    `„${input}" nie je IČO (očakávam 8 číslic). Na hľadanie podľa názvu použi skfirma_search s parametrom query.`,
  );
}
