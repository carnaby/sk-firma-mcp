// Aplikačná vrstva: každá funkcia = jeden use-case (search/profile/…/check).
// Vracia štruktúrované dáta, nerenderuje. Volá ju MCP server aj webové API,
// takže pravidlá (validácia, GDPR, verdikt) existujú na jednom mieste.
import { CONFIG } from './config.js';
import { ToolError, validateIco } from './errors.js';
import { mapEntityToProfile } from './domain/profile.js';
import { evaluateRisk, type RiskResult } from './domain/risk.js';
import { fetchDebts } from './domain/debts.js';
import { buildVatStatus } from './domain/vat.js';
import type { RpoClient } from './clients/rpo.js';
import type { RuzClient } from './clients/ruz.js';
import type { DatasetIndex } from './clients/dataset-index.js';
import type { DoveraClient } from './clients/dovera.js';
import type { DebtsData, FinancialsResult, ProfileData, SearchCandidate, VatStatusData } from './types.js';

export interface Deps {
  rpo: Pick<RpoClient, 'searchByIco' | 'searchByName' | 'getEntity'>;
  ruz: Pick<RuzClient, 'financials'>;
  index: Pick<DatasetIndex, 'available' | 'vatStatus' | 'spDebt' | 'vszpDebt' | 'taxDebtorCandidates' | 'meta'>;
  dovera: Pick<DoveraClient, 'lookup'>;
  now?: () => Date;
}

export const CHECK_SECTIONS = ['profile', 'financials', 'debts', 'vat'] as const;
export type CheckSection = (typeof CHECK_SECTIONS)[number];

export const CHECK_SOURCES = ['RPO (CC-BY 4.0, ŠÚ SR)', 'RÚZ (MF SR)', 'FS OpenData', 'Sociálna poisťovňa', 'VšZP (Datahub)', 'Dôvera'];

export const isIcoLike = (q: string): boolean => /^\d{8}$/.test(q.replace(/\s+/g, ''));

// GDPR: statutoryBodies[].address a stakeholders[].address sú bydliská
// fyzických osôb — z raw výstupu ich vždy odstrániť.
export function stripPersonAddresses(entity: unknown): unknown {
  const e = structuredClone(entity) as Record<string, unknown>;
  for (const key of ['statutoryBodies', 'stakeholders']) {
    const arr = e[key];
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (p && typeof p === 'object') delete (p as Record<string, unknown>).address;
      }
    }
  }
  return e;
}

// ---------- search ----------

export interface SearchResult {
  candidates: SearchCandidate[];
  total_count: number;
  has_more: boolean;
  next_offset: number | null;
  offset: number;
}

export async function searchCompanies(
  deps: Deps,
  input: { query: string; onlyActive?: boolean; limit?: number; offset?: number },
): Promise<SearchResult> {
  const q = input.query.trim();
  const limit = input.limit ?? CONFIG.search.defaultLimit;
  const offset = input.offset ?? 0;
  let all: SearchCandidate[];
  if (isIcoLike(q)) {
    const c = await deps.rpo.searchByIco(q.replace(/\s+/g, ''));
    all = c ? [c] : [];
  } else {
    if (q.length < CONFIG.search.minQueryLength) {
      throw new ToolError(`Dopyt „${q}" je prikrátky — zadaj aspoň ${CONFIG.search.minQueryLength} znaky názvu, alebo 8-miestne IČO.`);
    }
    all = await deps.rpo.searchByName(q, input.onlyActive ?? true);
  }
  const page = all.slice(offset, offset + limit);
  const hasMore = offset + limit < all.length;
  return { candidates: page, total_count: all.length, has_more: hasMore, next_offset: hasMore ? offset + limit : null, offset };
}

// ---------- profile ----------

export async function getProfile(
  deps: Deps,
  input: { ico: string; includeHistory?: boolean },
): Promise<{ profile: ProfileData; raw?: unknown }> {
  const icoNorm = validateIco(input.ico);
  const candidate = await deps.rpo.searchByIco(icoNorm);
  if (!candidate) throw new ToolError(`IČO ${icoNorm} som v RPO nenašiel. Over ho, alebo hľadaj podľa názvu cez skfirma_search.`);
  const entity = await deps.rpo.getEntity(candidate.rpo_id, input.includeHistory ?? false);
  const profile = mapEntityToProfile(entity);
  return input.includeHistory ? { profile, raw: stripPersonAddresses(entity) } : { profile };
}

// ---------- financials ----------

export async function getFinancials(deps: Deps, input: { ico: string; years?: number }): Promise<FinancialsResult> {
  return deps.ruz.financials(validateIco(input.ico), input.years ?? 3);
}

// ---------- VAT ----------

export function getVatStatus(deps: Deps, input: { ico?: string; icDph?: string }): VatStatusData {
  const { ico, icDph } = input;
  if ((ico && icDph) || (!ico && !icDph)) throw new ToolError('Zadaj presne jedno: ico alebo ic_dph.');
  let query: { ico?: string; icDph?: string };
  if (ico) {
    query = { ico: validateIco(ico) };
  } else {
    const norm = icDph!.replace(/\s+/g, '').toUpperCase();
    if (!/^SK\d{10}$/.test(norm)) throw new ToolError(`„${icDph}" nie je IČ DPH (očakávam SK + 10 číslic, napr. SK7012345678).`);
    query = { icDph: norm };
  }
  const rows = deps.index.vatStatus(query);
  if (!rows) throw new ToolError('Lokálny index neexistuje — spusti `npm run ingest` a skús znova.');
  return buildVatStatus(query, rows);
}

// ---------- debts ----------

export async function getDebts(deps: Deps, input: { ico: string }): Promise<DebtsData> {
  return fetchDebts(validateIco(input.ico), { index: deps.index, dovera: deps.dovera, rpo: deps.rpo });
}

// ---------- check ----------

export interface CheckReport {
  kind: 'report';
  ico: string;
  risk: RiskResult;
  profile: ProfileData | null;
  financials: FinancialsResult | null;
  debts: DebtsData | null;
  vat: VatStatusData | null;
  failed_sections: CheckSection[];
}

export interface CheckAmbiguous {
  kind: 'ambiguous';
  query: string;
  total_count: number;
  candidates: SearchCandidate[];
}

export type CheckOutcome = CheckReport | CheckAmbiguous;

export async function checkCompany(
  deps: Deps,
  input: { ico?: string; name?: string; years?: number; sections?: readonly CheckSection[] },
): Promise<CheckOutcome> {
  const { ico, name } = input;
  const years = input.years ?? 3;
  const sections = input.sections ?? CHECK_SECTIONS;
  const now = deps.now ?? (() => new Date());

  if ((ico && name) || (!ico && !name)) {
    throw new ToolError('Zadaj presne jedno: ico (8 číslic) alebo name (názov firmy).');
  }

  let icoNorm: string;
  if (ico) {
    icoNorm = validateIco(ico);
  } else {
    const q = name!.trim();
    if (q.length < CONFIG.search.minQueryLength) {
      throw new ToolError(`Názov „${q}" je prikrátky — zadaj aspoň ${CONFIG.search.minQueryLength} znaky, alebo 8-miestne IČO.`);
    }
    const candidates = await deps.rpo.searchByName(q, true);
    if (candidates.length === 0) {
      throw new ToolError(`Firmu „${name}" som v RPO nenašiel. Skús iný zápis názvu alebo skfirma_search.`);
    }
    if (candidates.length > 1) {
      return {
        kind: 'ambiguous',
        query: name!,
        total_count: candidates.length,
        candidates: candidates.slice(0, CONFIG.check.maxSearchCandidates),
      };
    }
    if (!candidates[0].ico) throw new ToolError(`Kandidát „${candidates[0].name}" nemá v RPO aktuálne IČO — over subjekt cez skfirma_search.`);
    icoNorm = candidates[0].ico;
  }

  const wantProfile = sections.includes('profile');
  const wantFin = sections.includes('financials');
  const wantDebts = sections.includes('debts');
  const wantVat = sections.includes('vat');
  const [profileRes, finRes, debtsRes, vatRes] = await Promise.allSettled([
    wantProfile
      ? (async (): Promise<ProfileData> => {
          const c = await deps.rpo.searchByIco(icoNorm);
          if (!c) throw new ToolError(`IČO ${icoNorm} som v RPO nenašiel. Over ho cez skfirma_search.`);
          return mapEntityToProfile(await deps.rpo.getEntity(c.rpo_id, false));
        })()
      : Promise.resolve(null),
    wantFin ? deps.ruz.financials(icoNorm, years) : Promise.resolve(null),
    wantDebts ? fetchDebts(icoNorm, { index: deps.index, dovera: deps.dovera, rpo: deps.rpo }) : Promise.resolve(null),
    wantVat
      ? (async (): Promise<VatStatusData> => {
          const rows = deps.index.vatStatus({ ico: icoNorm });
          if (!rows) throw new Error('index unavailable');
          return buildVatStatus({ ico: icoNorm }, rows);
        })()
      : Promise.resolve(null),
  ]);

  // Nenájdené IČO je chyba celého use-casu, nie zlyhaná sekcia:
  if (profileRes.status === 'rejected' && profileRes.reason instanceof ToolError) throw profileRes.reason;

  const profile = profileRes.status === 'fulfilled' ? profileRes.value : null;
  const financials = finRes.status === 'fulfilled' ? finRes.value : null;
  const debts = debtsRes.status === 'fulfilled' ? debtsRes.value : null;
  const vat = vatRes.status === 'fulfilled' ? vatRes.value : null;
  const failed_sections: CheckSection[] = [];
  const failed_sources: string[] = [];
  if (wantProfile && profileRes.status === 'rejected') { failed_sections.push('profile'); failed_sources.push('RPO'); console.error('[skfirma_check] profile zlyhal:', profileRes.reason); }
  if (wantFin && finRes.status === 'rejected') { failed_sections.push('financials'); failed_sources.push('RÚZ'); console.error('[skfirma_check] financials zlyhali:', finRes.reason); }
  if (wantDebts && debtsRes.status === 'rejected') { failed_sections.push('debts'); failed_sources.push('dlhové zoznamy'); console.error('[skfirma_check] debts zlyhali:', debtsRes.reason); }
  if (wantVat && vatRes.status === 'rejected') { failed_sections.push('vat'); failed_sources.push('FS DPH zoznamy'); console.error('[skfirma_check] vat zlyhal:', vatRes.reason); }
  // Chýbajúci lokálny index nezhodí fetchDebts (kredítori sú 'unavailable'),
  // ale nesmie prejsť ako 🟢 (zásada „chýbajúci zdroj ≠ zelená"). Zámerne bez
  // dovera/union — Union je trvale unavailable a verdikt kapovať nesmie.
  if (debts && (['fs', 'sp', 'vszp'] as const).every((k) => debts.creditors[k].status === 'unavailable')) {
    failed_sources.push('dlhové zoznamy (lokálny index)');
  }

  const risk = evaluateRisk({ profile, financials, debts, vat, failed_sources, now: now() });
  return { kind: 'report', ico: icoNorm, risk, profile, financials, debts, vat, failed_sections };
}

/** Stabilný JSON tvar previerky — rovnaký pre MCP (response_format=json) aj HTTP API. */
export function checkReportToJson(r: CheckReport) {
  return {
    ico: r.ico,
    verdict: r.risk.verdict,
    flags: r.risk.flags,
    profile: r.profile,
    financials: r.financials?.years ?? [],
    financials_unavailable_reason: r.financials?.unavailable_reason ?? null,
    debts: r.debts,
    vat: r.vat,
    notes: r.risk.notes,
    failed_sections: r.failed_sections,
    sources: CHECK_SOURCES,
    disclaimer: CONFIG.disclaimer,
  };
}
export type CheckReportJson = ReturnType<typeof checkReportToJson>;

/** Odpoveď HTTP API GET /api/check — kontrakt medzi apps/server a apps/web. */
export type ApiCheckResponse =
  | { kind: 'report'; report: CheckReportJson; markdown: string }
  | { kind: 'ambiguous'; query: string; total_count: number; candidates: SearchCandidate[]; markdown: string };
