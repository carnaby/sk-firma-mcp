import { fetch } from 'undici';
import { CONFIG } from './config.js';
import { acquireUpstreamSlot } from './upstream.js';

export class HttpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const host = new URL(url).host;
  let lastError: unknown;
  for (let attempt = 0; attempt <= CONFIG.http.maxRetries; attempt++) {
    if (attempt > 0) await sleep(CONFIG.http.backoffBaseMs * 2 ** (attempt - 1));
    await acquireUpstreamSlot(host); // BusyError sa neretryuje — letí rovno von
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'sk-firma-mcp-server/0.2 (+https://github.com/carnaby/sk-firma-mcp)' },
      });
    } catch (e) {
      lastError = e; // timeout / sieťová chyba → ďalší pokus (plánom vyžadované)
      continue;
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        // chybný payload sa retryom neopraví → non-retryable
        throw new HttpError(`Neplatná JSON odpoveď z ${host}`, res.status);
      }
    }
    await res.body?.cancel().catch(() => {});
    const retryable = res.status >= 500 || res.status === 429;
    const err = new HttpError(`HTTP ${res.status} pre ${host}`, res.status);
    if (!retryable) throw err;
    lastError = err;
  }
  if (lastError instanceof HttpError) throw lastError;
  const exhausted = new HttpError(`Zlyhanie po opakovaných pokusoch (${host}): ${String(lastError)}`);
  exhausted.cause = lastError;
  throw exhausted;
}
