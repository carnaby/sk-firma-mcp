import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFsXml, mapDphs, mapDsdd } from '../src/ingest/parse-fs-xml.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/ingest/${name}`, import.meta.url), 'utf8');

describe('parseFsXml', () => {
  it('extrahuje asOf a ploché ITEM polia s dekódovanými entitami', () => {
    const r = parseFsXml(fx('fs-dsdd.xml'));
    expect(r.asOf).toBe('2026-05-31');
    expect(r.items).toHaveLength(2);
    expect(r.items[0].NAZOV_SUBJEKTU).toBe('"Firma Sedem s. r. o."');
    expect(r.items[1].PSC).toBe('04001');
  });
});

describe('mapDphs', () => {
  const items = parseFsXml(fx('fs-dphs.xml')).items;
  it('§4 platiteľ má payer_since', () => {
    expect(mapDphs(items[0])).toEqual({
      ico: '77777777', ic_dph: 'SK7077777777', name: 'Firma Sedem s. r. o.',
      kind: '§4', registered_on: '2020-10-11', payer_since: '2020-10-11',
    });
  });
  it('§7a registrovaný bez PLAT_DPH_OD má payer_since null', () => {
    expect(mapDphs(items[1])).toMatchObject({ kind: '§7a', payer_since: null });
  });
  it('chýbajúce IC_DPH → null', () => {
    expect(mapDphs({ ICO: '77777777' })).toBeNull();
  });
});

describe('mapDsdd', () => {
  const items = parseFsXml(fx('fs-dsdd.xml')).items;
  it('mapuje názov, sumu (bodkový aj SK formát) a adresu', () => {
    expect(mapDsdd(items[0])).toEqual({
      name: '"Firma Sedem s. r. o."', amount_eur: 780,
      street: 'Vzorová 123/4', psc: '82101', obec: 'Bratislava - mestská časť Ružinov',
    });
    expect(mapDsdd(items[1])).toMatchObject({ amount_eur: 12_345.67, street: null });
  });
  it('bez sumy → null', () => {
    expect(mapDsdd({ NAZOV_SUBJEKTU: 'X', CIASTKA: '-' })).toBeNull();
  });
});
