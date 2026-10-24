import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { RpoClient } from '../src/clients/rpo.js';
import { LruCache } from '../src/cache.js';

let mockAgent: MockAgent;
let original: Dispatcher;
const HOST = 'https://api.statistics.sk';

const firma1Entity = JSON.parse(readFileSync(new URL('./fixtures/rpo-firma1.json', import.meta.url), 'utf8'));

const firma1SearchResult = {
  id: 1000001,
  dbModificationDate: '2025-07-07',
  identifiers: [{ value: '11111111', validFrom: '2018-01-02' }],
  fullNames: [{ value: 'Firma Jeden s. r. o.', validFrom: '2018-01-02' }],
  addresses: [{ validFrom: '2022-03-04', street: 'Vzorová', buildingNumber: '123/4', postalCodes: ['81101'], municipality: { value: 'Bratislava - mestská časť Staré Mesto' } }],
  establishment: '2018-01-02',
};

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

describe('RpoClient', () => {
  it('searchByIco vráti kandidáta s aktuálnym IČO', async () => {
    mockAgent.get(HOST)
      .intercept({ path: '/rpo/v1/search', query: { identifier: '11111111' } })
      .reply(200, { results: [firma1SearchResult], license: 'CC-BY 4.0 …' });
    const c = await new RpoClient(new LruCache({ maxSize: 100 })).searchByIco('11111111');
    expect(c).toMatchObject({
      ico: '11111111',
      name: 'Firma Jeden s. r. o.',
      status: 'active',
      established_on: '2018-01-02',
      rpo_id: 1000001,
      address: 'Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto',
    });
  });

  it('searchByIco vráti null pri prázdnych results', async () => {
    mockAgent.get(HOST)
      .intercept({ path: '/rpo/v1/search', query: { identifier: '99999999' } })
      .reply(200, { results: [], license: '…' });
    const c = await new RpoClient(new LruCache({ maxSize: 100 })).searchByIco('99999999');
    expect(c).toBeNull();
  });

  it('searchByName mapuje zoznam a zaniknutú firmu označí terminated', async () => {
    mockAgent.get(HOST)
      .intercept({ path: '/rpo/v1/search', query: { fullName: 'Firma Päť', onlyActive: 'false' } })
      .reply(200, { results: [{ ...firma1SearchResult, id: 1, termination: '2008-12-31' }], license: '…' });
    const list = await new RpoClient(new LruCache({ maxSize: 100 })).searchByName('Firma Päť', false);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('terminated');
    expect(list[0].terminated_on).toBe('2008-12-31');
  });

  it('profileByIco = search → entity (2 volania), cache pri opakovaní', async () => {
    const pool = mockAgent.get(HOST);
    pool.intercept({ path: '/rpo/v1/search', query: { identifier: '11111111' } })
      .reply(200, { results: [firma1SearchResult], license: '…' });
    pool.intercept({ path: '/rpo/v1/entity/1000001' })
      .reply(200, firma1Entity);
    const client = new RpoClient(new LruCache({ maxSize: 100 }));
    const e1 = await client.profileByIco('11111111');
    expect((e1 as { id: number }).id).toBe(1000001);
    // druhé volanie ide z cache — mock intercepty sú jednorazové, ak by šiel HTTP, spadne
    const e2 = await client.profileByIco('11111111');
    expect((e2 as { id: number }).id).toBe(1000001);
  });
});
