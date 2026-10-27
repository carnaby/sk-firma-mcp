// MCP vrstva: len schémy nástrojov + render. Logika je v @skfirma/core/services.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CONFIG, CHECK_SECTIONS, ToolError,
  searchCompanies, getProfile, getFinancials, getVatStatus, getDebts, checkCompany, checkReportToJson,
  renderSearch, renderProfile, renderFinancials, renderDebts, renderVatStatus, renderCheck,
  type CheckOutcome, type Deps,
} from '@skfirma/core';

export type { Deps } from '@skfirma/core';

export const SERVER_INFO = { name: 'sk-firma-mcp-server', version: '0.2.0' } as const;

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true };
const responseFormat = z.enum(['markdown', 'json']).default('markdown')
  .describe('markdown = kompaktný čitateľný výstup (default); json = všetky polia pre programatické spracovanie');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError) return { isError: true, ...text(e.message) };
    console.error('[skfirma] interná chyba:', e); // stderr only — do odpovede nejde
    return { isError: true, ...text('Zdroj je momentálne nedostupný alebo odpovedal neočakávane. Skús o chvíľu.') };
  }
}

/** Markdown výstup skfirma_check — zdieľaný s webom (záložka „Ako to vidí AI"). */
export function renderCheckOutcome(outcome: CheckOutcome): string {
  if (outcome.kind === 'ambiguous') {
    const { query, total_count, candidates } = outcome;
    return [
      `Názov „${query}" je viacznačný (${total_count >= 500 ? '500+' : total_count} kandidátov). Uveď presné IČO a zavolaj skfirma_check znova.`,
      renderSearch(candidates, total_count, total_count > candidates.length, 0),
    ].join('\n\n');
  }
  return renderCheck(outcome);
}

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer(SERVER_INFO);

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
    const r = await searchCompanies(deps, { query, onlyActive: only_active, limit, offset });
    if (response_format === 'json') {
      return text(JSON.stringify({ candidates: r.candidates, total_count: r.total_count, has_more: r.has_more, next_offset: r.next_offset }));
    }
    return text(renderSearch(r.candidates, r.total_count, r.has_more, offset));
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
    const { profile, raw } = await getProfile(deps, { ico, includeHistory: include_history });
    if (response_format === 'json') return text(JSON.stringify(include_history ? { ...profile, raw } : profile));
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
    const fin = await getFinancials(deps, { ico, years });
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
    description: 'Registrácia pre DPH z FS zoznamov: platiteľ/registrovaný (§4/§4b/§5 vs §7/§7a), vymazaný (§52/8), rizikový (§52/6). Vyžaduje lokálny index (pnpm ingest). Príklad: ico="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: {
      ico: z.string().optional().describe('8-miestne IČO'),
      ic_dph: z.string().optional().describe('IČ DPH v tvare SK + 10 číslic'),
      response_format: responseFormat,
    },
  }, async ({ ico, ic_dph, response_format }) => run(async () => {
    const status = getVatStatus(deps, { ico, icDph: ic_dph });
    return text(response_format === 'json' ? JSON.stringify(status) : renderVatStatus(status));
  }));

  server.registerTool('skfirma_debts', {
    title: 'Dlhy voči štátu a poisťovniam',
    description: 'FS (daňoví dlžníci), Sociálna poisťovňa, VšZP, Dôvera per IČO; Union nedostupný. FS bez IČO — párované podľa názvu s match_confidence. Vyžaduje lokálny index. Príklad: ico="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: { ico: z.string().describe('8-miestne IČO'), response_format: responseFormat },
  }, async ({ ico, response_format }) => run(async () => {
    const d = await getDebts(deps, { ico });
    if (response_format === 'json') return text(JSON.stringify(d));
    return text([`## ${d.name ?? 'Subjekt'} (IČO ${d.ico})`, '', renderDebts(d)].join('\n'));
  }));

  server.registerTool('skfirma_check', {
    title: 'Kompletná previerka firmy (verdikt + flagy)',
    description: 'Jedno volanie: identita (RPO) + financie (RÚZ) + deterministický rizikový verdikt 🟢/🟠/🔴 s dôvodmi a zdrojmi. Zadaj ico ALEBO name (pri viacznačnom mene vráti kandidátov). Príklad: ico="12345678".',
    annotations: ANNOTATIONS,
    inputSchema: {
      ico: z.string().optional().describe('8-miestne IČO'),
      name: z.string().optional().describe('Názov firmy — použije sa, len ak nie je zadané ico'),
      years: z.number().int().min(1).max(10).default(3),
      sections: z.array(z.enum(CHECK_SECTIONS)).min(1)
        .default([...CHECK_SECTIONS])
        .describe('Ktoré sekcie zahrnúť'),
      response_format: responseFormat,
    },
  }, async ({ ico, name, years, sections, response_format }) => run(async () => {
    const outcome = await checkCompany(deps, { ico, name, years, sections });
    if (response_format === 'json' && outcome.kind === 'report') return text(JSON.stringify(checkReportToJson(outcome)));
    return text(renderCheckOutcome(outcome));
  }));

  return server;
}
