import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { fetchJson, HttpError } from '../src/http.js';

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
});

describe('fetchJson', () => {
  it('vráti JSON pri 200', async () => {
    mockAgent.get('https://example.test').intercept({ path: '/ok' }).reply(200, { a: 1 });
    await expect(fetchJson('https://example.test/ok')).resolves.toEqual({ a: 1 });
  });

  it('hádže HttpError so statusom pri 404 bez retry', async () => {
    mockAgent.get('https://example.test').intercept({ path: '/missing' }).reply(404, 'not found');
    await expect(fetchJson('https://example.test/missing')).rejects.toMatchObject({ status: 404 });
  });

  it('retry na 503 a potom úspech', async () => {
    const pool = mockAgent.get('https://example.test');
    pool.intercept({ path: '/flaky' }).reply(503, 'busy');
    pool.intercept({ path: '/flaky' }).reply(200, { ok: true });
    await expect(fetchJson('https://example.test/flaky')).resolves.toEqual({ ok: true });
  });

  it('hádže HttpError pri 200 s neplatným JSON bez retry', async () => {
    // jediný, nepersistentný intercept — prípadný retry by narazil na
    // "no matching interceptor", takže pass zároveň dokazuje absenciu retry
    mockAgent
      .get('https://example.test')
      .intercept({ path: '/bad-json' })
      .reply(200, 'not-json', { headers: { 'content-type': 'text/plain' } });
    const p = fetchJson('https://example.test/bad-json');
    await expect(p).rejects.toBeInstanceOf(HttpError);
    await expect(p).rejects.toMatchObject({ status: 200 });
  });

  it('po vyčerpaní retry hádže HttpError', async () => {
    const pool = mockAgent.get('https://example.test');
    pool.intercept({ path: '/down' }).reply(503, 'x').times(3); // 1 pokus + 2 retry
    await expect(fetchJson('https://example.test/down')).rejects.toBeInstanceOf(HttpError);
  });
});
