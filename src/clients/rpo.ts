import { z } from 'zod';
import { CONFIG } from '../config.js';
import { fetchJson } from '../http.js';
import type { LruCache } from '../cache.js';
import type { SearchCandidate } from '../types.js';
import { current, formatRpoAddress } from '../domain/rpo-common.js';

const Versioned = z.object({ value: z.string().optional(), validFrom: z.string().optional(), validTo: z.string().optional() }).passthrough();
const SearchResult = z.object({
  id: z.number(),
  identifiers: z.array(Versioned).optional(),
  fullNames: z.array(Versioned).optional(),
  addresses: z.array(z.object({
    street: z.string().optional(),
    buildingNumber: z.string().optional(),
    postalCodes: z.array(z.string()).optional(),
    municipality: z.object({ value: z.string().optional() }).passthrough().optional(),
    validTo: z.string().optional(),
  }).passthrough()).optional(),
  establishment: z.string().optional(),
  termination: z.string().optional(),
}).passthrough();
const SearchResponse = z.object({ results: z.array(SearchResult).default([]) }).passthrough();

function toCandidate(r: z.infer<typeof SearchResult>): SearchCandidate {
  const a = current(r.addresses);
  const address = formatRpoAddress(a);
  return {
    ico: current(r.identifiers)?.value ?? null,
    name: current(r.fullNames)?.value ?? '',
    address,
    psc: a?.postalCodes?.[0] ?? null,
    municipality: a?.municipality?.value ?? null,
    status: r.termination ? 'terminated' : 'active',
    established_on: r.establishment ?? null,
    terminated_on: r.termination ?? null,
    rpo_id: r.id,
  };
}

export class RpoClient {
  constructor(private cache: LruCache<unknown>) {}

  private async api(pathAndQuery: string, timeoutMs: number): Promise<unknown> {
    const url = `${CONFIG.rpo.baseUrl}${pathAndQuery}`;
    const hit = this.cache.get(`rpo:${url}`);
    if (hit !== undefined) return hit;
    const data = (await fetchJson(url, { timeoutMs })) as Record<string, unknown>;
    delete data.license; // ~1 kB CC-BY textu v každej odpovedi (S1) — atribúciu robí render vrstva
    this.cache.set(`rpo:${url}`, data, CONFIG.rpo.cacheTtlMs);
    return data;
  }

  async searchByIco(ico: string): Promise<SearchCandidate | null> {
    const res = SearchResponse.parse(await this.api(`/search?identifier=${encodeURIComponent(ico)}`, CONFIG.rpo.timeoutMs));
    if (res.results.length === 0) return null;
    const candidates = res.results.map(toCandidate);
    // identifier matchuje aj historické IČO (S1) — preferuj presnú zhodu aktuálneho IČO
    return candidates.find((c) => c.ico === ico) ?? candidates[0];
  }

  async searchByName(query: string, onlyActive: boolean): Promise<SearchCandidate[]> {
    const res = SearchResponse.parse(
      await this.api(`/search?fullName=${encodeURIComponent(query)}&onlyActive=${onlyActive}`, CONFIG.rpo.fulltextTimeoutMs),
    );
    return res.results.map(toCandidate);
  }

  async getEntity(rpoId: number, includeHistory = false): Promise<unknown> {
    const suffix = includeHistory ? '?showHistoricalData=true' : '';
    return this.api(`/entity/${rpoId}${suffix}`, CONFIG.rpo.timeoutMs);
  }

  async profileByIco(ico: string): Promise<unknown | null> {
    const candidate = await this.searchByIco(ico);
    if (!candidate) return null;
    return this.getEntity(candidate.rpo_id);
  }
}
