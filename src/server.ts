import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CONFIG } from './config.js';
import { ToolError, validateIco } from './errors.js';
import { mapEntityToProfile } from './domain/profile.js';
import { evaluateRisk } from './domain/risk.js';
import { fetchDebts } from './domain/debts.js';
import { buildVatStatus } from './domain/vat.js';
import { renderCheck, renderDebts, renderFinancials, renderProfile, renderSearch, renderVatStatus } from './render/markdown.js';
import type { RpoClient } from './clients/rpo.js';
import type { RuzClient } from './clients/ruz.js';
import type { DatasetIndex } from './clients/dataset-index.js';
import type { DoveraClient } from './clients/dovera.js';
import type { DebtsData, ProfileData, VatStatusData } from './types.js';

export interface Deps {
  rpo: Pick<RpoClient, 'searchByIco' | 'searchByName' | 'getEntity'>;
  ruz: Pick<RuzClient, 'financials'>;
  index: Pick<DatasetIndex, 'available' | 'vatStatus' | 'spDebt' | 'vszpDebt' | 'taxDebtorCandidates' | 'meta'>;
  dovera: Pick<DoveraClient, 'lookup'>;
  now?: () => Date;
}

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true };
const responseFormat = z.enum(['markdown', 'json']).default('markdown')
  .describe('markdown = kompaktný čitateľný výstup (default); json = všetky polia pre programatické spracovanie');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

// GDPR (zadanie §9): statutoryBodies[].address a stakeholders[].address sú
// bydliská fyzických osôb — z raw výstupu ich vždy odstrániť.
function stripPersonAddresses(entity: unknown): unknown {
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

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError) return { isError: true, ...text(e.message) };
    console.error('[skfirma] interná chyba:', e); // stderr only — do odpovede nejde (§5.8)
    return { isError: true, ...text('Zdroj je momentálne nedostupný alebo odpovedal neočakávane. Skús o chvíľu.') };
  }
}

export function buildServer(deps: Deps): McpServer {
  const now = deps.now ?? (() => new Date());
  const server = new McpServer({ name: 'sk-firma-mcp-server', version: '0.1.0' });

  server.registerTool('skfirma_search', {
    title: 'Vyhľadanie slovenskej firmy',
    description: 'Nájde subjekt podľa názvu (fulltext) alebo 8-miestneho IČO v RPO. Použi na disambiguáciu pred skfirma_profile/skfirma_check. Príklad: query="Firma Jeden" alebo query="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: {
      query: z.string().describe('Názov firmy alebo 8-miestne IČO'),
      only_active: z.boolean().default(true).describe('Vynechať zaniknuté subjekty'),
      limit: z.number().int().min(1).max(CONFIG.search.maxLimit).default(CONFIG.search.defaultLimit),
      offset: z.number().int().min(0).default(0),
      response_format: responseFormat,
    },
  }, async ({ query, only_active, limit, offset, response_format }) => run(async () => {
    const q = query.trim();
    const isIco = /^\d{8}$/.test(q.replace(/\s+/g, ''));
    let all;
    if (isIco) {
      const c = await deps.rpo.searchByIco(q.replace(/\s+/g, ''));
      all = c ? [c] : [];
    } else {
      if (q.length < CONFIG.search.minQueryLength) {
        throw new ToolError(`Dopyt „${q}" je prikrátky — zadaj aspoň ${CONFIG.search.minQueryLength} znaky názvu, alebo 8-miestne IČO.`);
      }
      all = await deps.rpo.searchByName(q, only_active);
    }
    const page = all.slice(offset, offset + limit);
    const hasMore = offset + limit < all.length;
    if (response_format === 'json') {
      return text(JSON.stringify({ candidates: page, total_count: all.length, has_more: hasMore, next_offset: hasMore ? offset + limit : null }));
    }
    return text(renderSearch(page, all.length, hasMore, offset));
  }));

  server.registerTool('skfirma_profile', {
    title: 'Profil firmy podľa IČO',
    description: 'Identita subjektu z RPO: názov, právna forma, adresa, právny stav (likvidácia/konkurz), štatutári, spoločníci, SK NACE. Príklad: ico="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: {
      ico: z.string().describe('8-miestne IČO'),
      include_history: z.boolean().default(false).describe('Pri JSON formáte priloží kompletnú históriu záznamu'),
      response_format: responseFormat,
    },
  }, async ({ ico, include_history, response_format }) => run(async () => {
    const icoNorm = validateIco(ico);
    const candidate = await deps.rpo.searchByIco(icoNorm);
    if (!candidate) throw new ToolError(`IČO ${icoNorm} som v RPO nenašiel. Over ho, alebo hľadaj podľa názvu cez skfirma_search.`);
    const entity = await deps.rpo.getEntity(candidate.rpo_id, include_history);
    const profile = mapEntityToProfile(entity);
    if (response_format === 'json') {
      // GDPR: raw entita obsahuje bydliská FO — pred výstupom ich odstrániť
      return text(JSON.stringify(include_history ? { ...profile, raw: stripPersonAddresses(entity) } : profile));
    }
    return text(renderProfile(profile));
  }));

  server.registerTool('skfirma_financials', {
    title: 'Finančné metriky z účtovných závierok',
    description: 'Tržby, VH, vlastné imanie, aktíva, zadlženosť a YoY z RÚZ za posledné roky. Nevracia surové výkazy. Príklad: ico="12345678", years=3.',
    annotations: ANNOTATIONS,
    inputSchema: {
      ico: z.string().describe('8-miestne IČO'),
      years: z.number().int().min(1).max(10).default(3),
      include_statement_ids: z.boolean().default(false).describe('Priloží id výkazov (pre detail/PDF)'),
      response_format: responseFormat,
    },
  }, async ({ ico, years, include_statement_ids, response_format }) => run(async () => {
    const icoNorm = validateIco(ico);
    const fin = await deps.ruz.financials(icoNorm, years);
    if (response_format === 'json') {
      const out = include_statement_ids
        ? fin
        : { ...fin, years: fin.years.map(({ statement_id: _omit, ...rest }) => rest) };
      return text(JSON.stringify(out));
    }
    let md = renderFinancials(fin);
    if (include_statement_ids && fin.years.length) {
      md += `\nStatement IDs: ${fin.years.map((y) => `${y.statement_id} (${y.period_label})`).join(', ')}`;
    }
    return text(md);
  }));

  server.registerTool('skfirma_vat_status', {
    title: 'DPH status firmy',
    description: 'Registrácia pre DPH z FS zoznamov: platiteľ/registrovaný (§4/§4b/§5 vs §7/§7a), vymazaný (§52/8), rizikový (§52/6). Vyžaduje lokálny index (npm run ingest). Príklad: ico="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: {
      ico: z.string().optional().describe('8-miestne IČO'),
      ic_dph: z.string().optional().describe('IČ DPH v tvare SK + 10 číslic'),
      response_format: responseFormat,
    },
  }, async ({ ico, ic_dph, response_format }) => run(async () => {
    if ((ico && ic_dph) || (!ico && !ic_dph)) throw new ToolError('Zadaj presne jedno: ico alebo ic_dph.');
    let query: { ico?: string; icDph?: string };
    if (ico) {
      query = { ico: validateIco(ico) };
    } else {
      const icdph = ic_dph!.replace(/\s+/g, '').toUpperCase();
      if (!/^SK\d{10}$/.test(icdph)) throw new ToolError(`„${ic_dph}" nie je IČ DPH (očakávam SK + 10 číslic, napr. SK7012345678).`);
      query = { icDph: icdph };
    }
    const rows = deps.index.vatStatus(query);
    if (!rows) throw new ToolError('Lokálny index neexistuje — spusti `npm run ingest` a skús znova.');
    const status = buildVatStatus(query, rows);
    return text(response_format === 'json' ? JSON.stringify(status) : renderVatStatus(status));
  }));

  server.registerTool('skfirma_debts', {
    title: 'Dlhy voči štátu a poisťovniam',
    description: 'FS (daňoví dlžníci), Sociálna poisťovňa, VšZP, Dôvera per IČO; Union nedostupný. FS bez IČO — párované podľa názvu s match_confidence. Vyžaduje lokálny index. Príklad: ico="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: { ico: z.string().describe('8-miestne IČO'), response_format: responseFormat },
  }, async ({ ico, response_format }) => run(async () => {
    const icoNorm = validateIco(ico);
    const debtsData = await fetchDebts(icoNorm, { index: deps.index, dovera: deps.dovera, rpo: deps.rpo });
    if (response_format === 'json') return text(JSON.stringify(debtsData));
    return text([`## ${debtsData.name ?? 'Subjekt'} (IČO ${icoNorm})`, '', renderDebts(debtsData)].join('\n'));
  }));

  registerCheckTool(server, deps, now); // Task 13
  return server;
}

function registerCheckTool(server: McpServer, deps: Deps, now: () => Date): void {
  server.registerTool('skfirma_check', {
    title: 'Kompletná previerka firmy (verdikt + flagy)',
    description: 'Jedno volanie: identita (RPO) + financie (RÚZ) + deterministický rizikový verdikt 🟢/🟠/🔴 s dôvodmi a zdrojmi. Zadaj ico ALEBO name (pri viacznačnom mene vráti kandidátov). Príklad: ico="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: {
      ico: z.string().optional().describe('8-miestne IČO'),
      name: z.string().optional().describe('Názov firmy — použije sa, len ak nie je zadané ico'),
      years: z.number().int().min(1).max(10).default(3),
      sections: z.array(z.enum(['profile', 'financials', 'debts', 'vat'])).min(1)
        .default(['profile', 'financials', 'debts', 'vat'])
        .describe('Ktoré sekcie zahrnúť'),
      response_format: responseFormat,
    },
  }, async ({ ico, name, years, sections, response_format }) => run(async () => {
    if ((ico && name) || (!ico && !name)) {
      throw new ToolError('Zadaj presne jedno: ico (8 číslic) alebo name (názov firmy).');
    }

    let icoNorm: string;
    if (ico) {
      icoNorm = validateIco(ico);
    } else {
      const candidates = await deps.rpo.searchByName(name!.trim(), true);
      if (candidates.length === 0) {
        throw new ToolError(`Firmu „${name}" som v RPO nenašiel. Skús iný zápis názvu alebo skfirma_search.`);
      }
      if (candidates.length > 1) {
        const top = candidates.slice(0, CONFIG.check.maxSearchCandidates);
        return text([
          `Názov „${name}" je viacznačný (${candidates.length >= 500 ? '500+' : candidates.length} kandidátov). Uveď presné IČO a zavolaj skfirma_check znova.`,
          renderSearch(top, candidates.length, candidates.length > top.length, 0),
        ].join('\n\n'));
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

    // Nenájdené IČO je chyba celého toolu, nie zlyhaná sekcia:
    if (profileRes.status === 'rejected' && profileRes.reason instanceof ToolError) throw profileRes.reason;

    const profile = profileRes.status === 'fulfilled' ? profileRes.value : null;
    const financials = finRes.status === 'fulfilled' ? finRes.value : null;
    const debts: DebtsData | null = debtsRes.status === 'fulfilled' ? debtsRes.value : null;
    const vat: VatStatusData | null = vatRes.status === 'fulfilled' ? vatRes.value : null;
    const failed_sections: string[] = [];
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

    if (response_format === 'json') {
      return text(JSON.stringify({
        ico: icoNorm,
        verdict: risk.verdict,
        flags: risk.flags,
        profile,
        financials: financials?.years ?? [],
        financials_unavailable_reason: financials?.unavailable_reason ?? null,
        debts,
        vat,
        notes: risk.notes,
        failed_sections,
        sources: ['RPO (CC-BY 4.0, ŠÚ SR)', 'RÚZ (MF SR)', 'FS OpenData', 'Sociálna poisťovňa', 'VšZP (Datahub)', 'Dôvera'],
        disclaimer: CONFIG.disclaimer,
      }));
    }
    return text(renderCheck({ profile, financials, debts, vat, risk, failed_sections }));
  }));
}
