import type { ApiCheckResponse } from '@skfirma/core';

export class ApiError extends Error {}

export async function fetchCheck(q: string, signal?: AbortSignal): Promise<ApiCheckResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/check?q=${encodeURIComponent(q)}`, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('Server je nedostupný. Skontroluj pripojenie a skús znova.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? `Chyba servera (${res.status}).`);
  return body as ApiCheckResponse;
}
