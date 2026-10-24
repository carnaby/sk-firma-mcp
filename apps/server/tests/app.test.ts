import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BusyError, type ApiCheckResponse, type Deps, type FinancialsResult, type SearchCandidate } from '@skfirma/core';
import { createApp } from '../src/app.js';
import { RateLimiter } from '../src/rate-limit.js';

const firma1Entity = JSON.parse(readFileSync(new URL('../../../packages/core/tests/fixtures/rpo-firma1.json', import.meta.url), 'utf8'));

const candidate = (ico: string, name: string, rpo_id: number): SearchCandidate =>
  ({ ico, name, address: 'Bratislava', psc: null, municipality: null, status: 'active', established_on: '2018-01-02', terminated_on: null, rpo_id });

const fin: FinancialsResult = {
  ico: '11111111', name: 'Firma Jeden s. r. o.',
  years: [{ period_from: '2024-01', period_to: '2024-12', period_label: '2024', template: 'mikro UJ', statement_id: 1,
    revenue: 1_388_372, profit: 7_791, equity: 78_955, assets: 1_060_405, liabilities: 981_450,
    liabilities_ratio: 0.9255, revenue_yoy: 0.05, negative_equity: false }],
  unavailable_reason: null, pdf_statement_ids: [], as_of: '2026-07-12',
};

const deps = (over: Partial<Deps> = {}): Deps => ({
  rpo: {
    searchByIco: async (ico) => (ico === '11111111' ? candidate('11111111', 'Firma Jeden s. r. o.', 1) : null),
    searchByName: async (q) => (q === 'Firma'
      ? [candidate('11111111', 'Firma Jeden s. r. o.', 1), candidate('22222222', 'Firma Dva s. r. o.', 2)]
      : [candidate('11111111', 'Firma Jeden s. r. o.', 1)]),
    getEntity: async () => firma1Entity,
  },
  ruz: { financials: async () => fin },
  index: {
    available: () => false, vatStatus: () => null, spDebt: () => undefined,
    vszpDebt: () => undefined, taxDebtorCandidates: () => undefined, meta: () => null,
  },
  dovera: { lookup: async () => ({ status: 'unavailable' as const, note: 'test' }) },
  now: () => new Date('2026-07-12'),
  ...over,
});

const get = (app: ReturnType<typeof createApp>, path: string) => app.request(path);

describe('HTTP API', () => {
  it('GET /api/check?q=<IČO> → report + markdown pre AI', async () => {
    const res = await get(createApp({ deps: deps() }), '/api/check?q=11111111');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiCheckResponse;
    expect(body.kind).toBe('report');
    if (body.kind !== 'report') return;
    expect(body.report.ico).toBe('11111111');
    expect(body.report.financials).toHaveLength(1);
    // index chýba → nesmie to byť zelené
    expect(body.report.verdict).not.toBe('green');
    expect(body.markdown).toContain('verdikt');
  });

  it('GET /api/check?q=<viacznačný názov> → kandidáti', async () => {
    const body = (await (await get(createApp({ deps: deps() }), '/api/check?q=Firma')).json()) as ApiCheckResponse;
    expect(body.kind).toBe('ambiguous');
    if (body.kind === 'ambiguous') expect(body.candidates.map((c) => c.ico)).toEqual(['11111111', '22222222']);
  });

  it('neplatný vstup → 400 so slovenskou hláškou, nie 500', async () => {
    const app = createApp({ deps: deps() });
    expect((await get(app, '/api/check')).status).toBe(400);
    const res = await get(app, '/api/check?q=99999999');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/nenašiel/);
  });

  it('pád upstreamu → 502 bez detailov chyby', async () => {
    const app = createApp({ deps: deps({ rpo: { searchByIco: async () => { throw new Error('ECONNRESET secret'); }, searchByName: async () => [], getEntity: async () => ({}) } }) });
    const res = await get(app, '/api/search?q=11111111');
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret');
  });

  it('rate limit za minútu → 429 s Retry-After; health sa nelimituje', async () => {
    const app = createApp({ deps: deps(), limits: { apiPerMinute: 2 } });
    expect((await get(app, '/api/check?q=11111111')).status).toBe(200);
    expect((await get(app, '/api/check?q=11111111')).status).toBe(200);
    const res = await get(app, '/api/check?q=11111111');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect((await get(app, '/api/health')).status).toBe(200);
  });

  it('denný limit na IP → 429 s hláškou „zajtra"', async () => {
    const app = createApp({ deps: deps(), limits: { apiPerMinute: 100, apiPerDay: 1 } });
    await get(app, '/api/check?q=11111111');
    const res = await get(app, '/api/check?q=11111111');
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/denný limit/);
  });

  it('za proxy: X-Forwarded-For sa číta zprava — podvrhnutá prvá položka limit neobíde', async () => {
    const app = createApp({ deps: deps(), trustProxy: 'xff', limits: { apiPerMinute: 1 } });
    const req = (spoof: string) => app.request('/api/check?q=11111111', { headers: { 'x-forwarded-for': `${spoof}, 203.0.113.7` } });
    expect((await req('1.1.1.1')).status).toBe(200);
    expect((await req('2.2.2.2')).status).toBe(429); // iná podvrhnutá IP, rovnaký reálny klient
  });

  it('za Cloudflare: kľúčom je CF-Connecting-IP', async () => {
    const app = createApp({ deps: deps(), trustProxy: 'cloudflare', limits: { apiPerMinute: 1 } });
    const req = (ip: string) => app.request('/api/check?q=11111111', { headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': '9.9.9.9' } });
    expect((await req('198.51.100.1')).status).toBe(200);
    expect((await req('198.51.100.2')).status).toBe(200);
    expect((await req('198.51.100.1')).status).toBe(429);
  });

  it('vyťažený zdroj (BusyError) → 503 s Retry-After, nie zavádzajúci verdikt', async () => {
    const busy = new BusyError('Server je momentálne vyťažený', 30);
    const app = createApp({ deps: deps({ ruz: { financials: async () => { throw busy; } } }) });
    const res = await get(app, '/api/check?q=11111111');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('health ukazuje stav limitov a odchádzajúcich dopytov', async () => {
    const body = (await (await get(createApp({ deps: deps() }), '/api/health')).json()) as Record<string, unknown>;
    expect(body).toHaveProperty('upstream');
    expect(body).toHaveProperty('limits');
  });
});

describe('remote MCP (/mcp)', () => {
  it('Streamable HTTP klient: tools/list + skfirma_check', async () => {
    const app = createApp({ deps: deps() });
    const fetchViaApp: typeof fetch = async (input, init) => app.request(new Request(input, init));
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: fetchViaApp }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ['skfirma_check', 'skfirma_debts', 'skfirma_financials', 'skfirma_profile', 'skfirma_search', 'skfirma_vat_status'],
    );
    const res = (await client.callTool({ name: 'skfirma_check', arguments: { ico: '11111111' } })) as { content: { text: string }[] };
    expect(res.content[0].text).toContain('Firma Jeden');
    await client.close();
  });

  it('GET /mcp → 405 (bezstavový server)', async () => {
    const res = await get(createApp({ deps: deps() }), '/mcp');
    expect(res.status).toBe(405);
  });
});

describe('statický web', () => {
  it('servuje index.html a SPA fallback, API má prednosť', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skfirma-web-'));
    writeFileSync(join(dir, 'index.html'), '<html>APP</html>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
    const app = createApp({ deps: deps(), webDir: dir });
    expect(await (await get(app, '/')).text()).toContain('APP');
    expect(await (await get(app, '/nejaka/cesta')).text()).toContain('APP');
    const asset = await get(app, '/assets/a.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await get(app, '/api/nic')).status).toBe(404);
  });
});

describe('RateLimiter', () => {
  it('okno sa po uplynutí resetuje', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    expect(rl.hit('b').allowed).toBe(true);
    t = 1001;
    expect(rl.hit('a').allowed).toBe(true);
  });
});
