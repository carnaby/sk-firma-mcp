import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { DoveraClient, parseDoveraHtml } from '../src/clients/dovera.js';
import { LruCache } from '../src/cache.js';

// Fixtures sú anonymizované výrezy reálnej štruktúry dovera.sk. Keď Dôvera zmení
// HTML, treba ich obnoviť — testy parsera potom ukážu, čo sa rozbilo.
const debtorHtml = readFileSync(new URL('./fixtures/ingest/dovera.html', import.meta.url), 'utf8');
const notFoundHtml = readFileSync(new URL('./fixtures/ingest/dovera-not-found.html', import.meta.url), 'utf8');
let mockAgent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

describe('parseDoveraHtml', () => {
  it('dlžník: suma z item-sum (&nbsp;/&euro; entity), dátum v nominatíve („12. júl")', () => {
    expect(parseDoveraHtml(debtorHtml, '77777777')).toEqual({ status: 'debtor', amount_eur: 54_441.19, as_of: '2026-07-12' });
  });

  it('nenašli: IČO je na stránke len ako ozvena formulára → not_found, nie chyba', () => {
    expect(parseDoveraHtml(notFoundHtml, '88888888')).toEqual({ status: 'not_found', as_of: null });
  });

  it('dátum v genitíve („12. júla") sa tiež prečíta', () => {
    const html = debtorHtml.replace('12. júl 2026', '12. júla 2026');
    expect(parseDoveraHtml(html, '77777777')).toMatchObject({ as_of: '2026-07-12' });
  });

  it('položka s IČO bez čitateľnej sumy → parse_error (nie „nedostupné")', () => {
    const html = debtorHtml.replace(/<div class="item-sum">[^<]*<\/div>/, '<div class="item-sum">—</div>');
    expect(parseDoveraHtml(html, '77777777')).toMatchObject({ status: 'parse_error' });
  });

  it('úplne iný formát stránky s IČO → parse_error', () => {
    expect(parseDoveraHtml('<html><body><p>IČO 77777777</p></body></html>', '77777777')).toMatchObject({ status: 'parse_error' });
  });

  it('Cloudflare challenge (obsahuje IČO v URL) → unavailable, retryable', () => {
    const html = `<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cUPMDTk:"/overenia/dlznici/zoznam-dlznikov?q=77777777"}</script></body></html>`;
    expect(parseDoveraHtml(html, '77777777')).toMatchObject({ status: 'unavailable', retryable: true });
  });

  it('IČO len ako substring dlhšieho čísla v položke → not_found (žiadny false positive)', () => {
    const html = debtorHtml.replace('IČO: 77777777', 'IČO: 977777777');
    expect(parseDoveraHtml(html, '77777777').status).toBe('not_found');
  });
});

describe('DoveraClient', () => {
  it('nájde dlžníka', async () => {
    intercept('77777777', debtorHtml);
    const r = await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777');
    expect(r).toEqual({ status: 'debtor', amount_eur: 54_441.19, as_of: '2026-07-12' });
  });

  it('not_found sa cachuje — druhé volanie ide z cache (jednorazový intercept)', async () => {
    intercept('88888888', notFoundHtml);
    const client = new DoveraClient(new LruCache({ maxSize: 10 }));
    expect((await client.lookup('88888888')).status).toBe('not_found');
    expect((await client.lookup('88888888')).status).toBe('not_found');
  });

  it('HTTP 503 → unavailable, retryable; bez cache', async () => {
    intercept('77777777', 'err', 503);
    intercept('77777777', debtorHtml);
    const client = new DoveraClient(new LruCache({ maxSize: 10 }));
    expect(await client.lookup('77777777')).toMatchObject({ status: 'unavailable', retryable: true });
    expect((await client.lookup('77777777')).status).toBe('debtor'); // chyba sa necachovala
  });

  it('HTTP 429 → unavailable, retryable', async () => {
    intercept('77777777', 'slow down', 429);
    expect(await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777')).toMatchObject({ status: 'unavailable', retryable: true });
  });

  it('parse_error sa necachuje a zaloguje úryvok HTML', async () => {
    const broken = debtorHtml.replace(/<div class="item-sum">[^<]*<\/div>/, '');
    intercept('77777777', broken);
    const r = await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777');
    expect(r.status).toBe('parse_error');
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes('parse_error'))).toBe(true);
  });

  it('flag vypnutý → unavailable (nie retryable) bez requestu', async () => {
    process.env.SKFIRMA_DOVERA = '0';
    try {
      const r = await new DoveraClient(new LruCache({ maxSize: 10 })).lookup('77777777');
      expect(r).toMatchObject({ status: 'unavailable', retryable: false });
      expect((r as { note: string }).note).toMatch(/SKFIRMA_DOVERA/);
    } finally {
      delete process.env.SKFIRMA_DOVERA;
    }
  });
});
