// Downloadery ingestu. Jednorazové GETy (CLI beh sa dá zopakovať) — vedome
// bez retry/throttle vrstvy fetchJson (binárne telá, iná sémantika).
import { fetch } from 'undici';
import { gunzipSync, unzipSync } from 'fflate';
import { CONFIG } from '../config.js';

const UA = { 'user-agent': 'sk-firma-mcp-ingest/0.2' };
const timeout = () => AbortSignal.timeout(CONFIG.ingest.downloadTimeoutMs);

export type FsFetchResult =
  | { status: 'fresh'; body: Uint8Array; etag: string | null }
  | { status: 'not_modified' };

export async function fetchFsZip(url: string, previousEtag: string | null): Promise<FsFetchResult> {
  const headers: Record<string, string> = { ...UA };
  if (previousEtag) headers['if-none-match'] = previousEtag;
  const res = await fetch(url, { headers, signal: timeout() });
  if (res.status === 304) return { status: 'not_modified' };
  if (!res.ok) throw new Error(`HTTP ${res.status} pre ${url}`);
  return { status: 'fresh', body: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get('etag') };
}

export function unzipSingle(zipBytes: Uint8Array, extension: '.xml' | '.csv'): { name: string; text: string } {
  const entries = unzipSync(zipBytes);
  const name = Object.keys(entries).find((n) => n.toLowerCase().endsWith(extension));
  if (!name) throw new Error(`ZIP neobsahuje ${extension} súbor (${Object.keys(entries).join(', ')})`);
  return { name, text: new TextDecoder('utf-8').decode(entries[name]) };
}

export async function fetchSpZip(pageUrl: string): Promise<{ zip: Uint8Array }> {
  const page = await fetch(pageUrl, { headers: UA, signal: timeout() });
  if (!page.ok) throw new Error(`HTTP ${page.status} pre ${pageUrl}`);
  const html = await page.text();
  const link = /\/api\/idsp\/download\/[0-9a-fA-F-]{36}/.exec(html)?.[0];
  if (!link) throw new Error('Na stránke SP sa nenašiel download link (/api/idsp/download/<uuid>)');
  const zipRes = await fetch(new URL(link, pageUrl), { headers: UA, signal: timeout() });
  if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status} pre SP zip`);
  return { zip: new Uint8Array(await zipRes.arrayBuffer()) };
}

export async function fetchVszpSql(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: timeout() });
  if (!res.ok) throw new Error(`HTTP ${res.status} pre ${url}`);
  return new TextDecoder('utf-8').decode(gunzipSync(new Uint8Array(await res.arrayBuffer())));
}
