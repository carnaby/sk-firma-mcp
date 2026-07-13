import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { DoveraClient } from '../src/clients/dovera.js';
import { LruCache } from '../src/cache.js';

const html = readFileSync(new URL('./fixtures/ingest/dovera.html', import.meta.url), 'utf8');
let mockAgent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});
afterEach(async () => {
  setGlobalDispatcher(original);
  await mockAgent.close();
  vi.restoreAllMocks();
});

const intercept = (query: string, body: string, status = 200) =>
  mockAgent.get('https://www.dovera.sk')
    .intercept({ path: `/overenia/dlznici/zoznam-dlznikov`, query: { q: query } })
    .reply(status, body);

describe('DoveraClient', () => {
  it('nájde dlžníka: suma + as_of z hlavičky', async () => {
    intercept('77777777', html);
    const r = await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777');
    expect(r).toEqual({ status: 'debtor', amount_eur: 54_441.19, as_of: '2026-07-12' });
  });

  it('IČO v odpovedi nie je → not_found; druhé volanie ide z cache (jednorazový intercept)', async () => {
    intercept('88888888', html);
    const client = new DoveraClient(new LruCache({ maxSize: 10 }));
    expect((await client.lookup('88888888')).status).toBe('not_found');
    expect((await client.lookup('88888888')).status).toBe('not_found'); // cache — HTTP by spadol
  });

  it('HTTP chyba → unavailable (bez cache)', async () => {
    intercept('77777777', 'err', 503);
    const r = await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777');
    expect(r.status).toBe('unavailable');
  });

  it('IČO len ako substring dlhšieho čísla → not_found (žiadny false positive)', async () => {
    const trap = '<html><body><h1>Zoznam dlžníkov k dátumu 12. júla 2026</h1><p>Ref: 977777777123</p><p>Suma: 99,99 €</p></body></html>';
    intercept('77777777', trap);
    const r = await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777');
    expect(r).toEqual({ status: 'not_found', as_of: '2026-07-12' });
  });

  it('flag vypnutý → unavailable bez requestu', async () => {
    process.env.SKFIRMA_DOVERA = '0';
    try {
      const r = await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777');
      expect(r.status).toBe('unavailable');
      expect((r as { note: string }).note).toMatch(/SKFIRMA_DOVERA/);
    } finally {
      delete process.env.SKFIRMA_DOVERA;
    }
  });
});
