import { z } from 'zod';
import type { EntityStatus, ProfileData } from '../types.js';
import { current, formatRpoAddress } from './rpo-common.js';

// Tolerantné schémy: tvar RPO sa líši per typ subjektu (S1 §Odporúčanie 5) —
// všetko optional, neznáme polia prepúšťame.
const Versioned = z.object({ value: z.string().optional(), validFrom: z.string().optional(), validTo: z.string().optional() }).passthrough();
const CodeValue = z.object({ value: z.string().optional(), code: z.string().optional() }).passthrough();
const VersionedCode = z.object({ value: CodeValue.optional(), validFrom: z.string().optional(), validTo: z.string().optional() }).passthrough();
const Address = z.object({
  street: z.string().optional(),
  buildingNumber: z.string().optional(),
  postalCodes: z.array(z.string()).optional(),
  municipality: z.object({ value: z.string().optional() }).passthrough().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
}).passthrough();
const Person = z.object({
  stakeholderType: CodeValue.optional(),
  personName: z.object({ formatedName: z.string().optional() }).passthrough().optional(),
  fullName: z.string().optional(), // PO ako štatutár/spoločník
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  // address sa VEDOME neparsuje — bydlisko FO (GDPR)
}).passthrough();

export const RpoEntity = z.object({
  id: z.number(),
  dbModificationDate: z.string().optional(),
  identifiers: z.array(Versioned).optional(),
  fullNames: z.array(Versioned).optional(),
  legalForms: z.array(VersionedCode).optional(),
  addresses: z.array(Address).optional(),
  establishment: z.string().optional(),
  termination: z.string().optional(),
  legalStatuses: z.array(VersionedCode).optional(),
  statutoryBodies: z.array(Person).optional(),
  stakeholders: z.array(Person).optional(),
  statisticalCodes: z.object({ mainActivity: CodeValue.optional() }).passthrough().optional(),
  sourceRegister: z.object({ value: CodeValue.optional() }).passthrough().optional(),
}).passthrough();
export type RpoEntityLike = z.infer<typeof RpoEntity>;

const STATUS_BY_CODE: Record<string, EntityStatus> = {
  '2': 'in_liquidation',
  '3': 'in_bankruptcy',
  '4': 'in_restructuring',
  '16': 'terminated',
  '17': 'terminated',
};

export function deriveStatus(e: RpoEntityLike): {
  status: EntityStatus; status_text: string | null; status_since: string | null;
} {
  const ls = current(e.legalStatuses ?? []);
  if (ls?.value?.code) {
    const mapped = STATUS_BY_CODE[ls.value.code];
    return {
      status: mapped ?? (e.termination ? 'terminated' : 'active'),
      status_text: ls.value.value ?? null,
      status_since: ls.validFrom ?? null,
    };
  }
  if (e.termination) return { status: 'terminated', status_text: null, status_since: e.termination };
  return { status: 'active', status_text: null, status_since: null };
}

const personName = (p: z.infer<typeof Person>): string =>
  p.personName?.formatedName ?? p.fullName ?? 'neznáme meno';

export function mapEntityToProfile(entityRaw: unknown): ProfileData {
  const e = RpoEntity.parse(entityRaw);
  const { status, status_text, status_since } = deriveStatus(e);
  return {
    ico: current(e.identifiers)?.value ?? '',
    name: current(e.fullNames)?.value ?? '',
    legal_form: current(e.legalForms)?.value?.value ?? null,
    legal_form_code: current(e.legalForms)?.value?.code ?? null,
    address: formatRpoAddress(current(e.addresses)),
    established_on: e.establishment ?? null,
    terminated_on: e.termination ?? null,
    status,
    status_text,
    status_since,
    executives: (e.statutoryBodies ?? [])
      .filter((p) => p.validTo === undefined)
      .map((p) => ({ name: personName(p), role: p.stakeholderType?.value ?? 'štatutár', since: p.validFrom ?? null })),
    shareholders: (e.stakeholders ?? [])
      .filter((p) => p.validTo === undefined)
      .map((p) => ({ name: personName(p) })),
    main_activity: e.statisticalCodes?.mainActivity?.code
      ? { code: e.statisticalCodes.mainActivity.code, name: e.statisticalCodes.mainActivity.value ?? '' }
      : null,
    source_register: e.sourceRegister?.value?.value ?? null,
    as_of: e.dbModificationDate ?? null,
  };
}
