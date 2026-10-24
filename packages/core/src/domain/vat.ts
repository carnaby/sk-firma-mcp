import type { VatRows } from '../clients/dataset-index.js';
import type { VatStatusData } from '../types.js';

const PAYER_KINDS = new Set(['§4', '§4b', '§5']); // §7/§7a sú len registrované osoby, nie platitelia (S3)

export function buildVatStatus(query: { ico?: string; icDph?: string }, rows: VatRows): VatStatusData {
  const { payer, erased, risky, asOf } = rows;
  return {
    query: query.icDph ?? query.ico ?? '',
    name: payer?.name ?? erased?.name ?? risky?.name ?? null,
    registered: payer !== null,
    is_payer: payer !== null && PAYER_KINDS.has(payer.kind),
    ic_dph: payer?.ic_dph ?? erased?.ic_dph ?? risky?.ic_dph ?? null,
    registration_kind: payer?.kind ?? null,
    registered_on: payer?.registered_on ?? null,
    payer_since: payer?.payer_since ?? null,
    erased: erased ? { published_on: erased.published_on, erased_on: erased.erased_on, violation_year: erased.violation_year } : null,
    risky: risky ? { published_on: risky.published_on, violation_year: risky.violation_year } : null,
    as_of: asOf.payers ?? asOf.erased ?? asOf.risky,
  };
}
