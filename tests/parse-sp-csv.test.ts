import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSpCsv, spAsOfFromFilename } from '../src/ingest/parse-sp-csv.js';

const csv = readFileSync(new URL('./fixtures/ingest/sp.csv', import.meta.url), 'utf8');

describe('parseSpCsv', () => {
  const r = parseSpCsv(csv);
  it('parsuje riadky s IČO, preskakuje bez IČO', () => {
    expect(r.rows).toHaveLength(3);
    expect(r.skippedNoIco).toBe(1);
  });
  it('mapuje polia a SK sumy', () => {
    expect(r.rows[0]).toEqual({
      ico: '77777777', name: 'Firma Sedem s. r. o.', address: 'Vzorová 123/4',
      city: 'Bratislava', amount_eur: 47.71,
    });
  });
  it('zvládne zdvojené úvodzovky v názve', () => {
    expect(r.rows[2].name).toBe('Firma "Osem" a. s.');
    expect(r.rows[2].amount_eur).toBe(1000);
  });
});

describe('spAsOfFromFilename', () => {
  it('odvodí ISO pondelok z názvu súboru', () => {
    expect(spAsOfFromFilename('dlznici_28_2026.csv')).toBe('2026-07-06');
    expect(spAsOfFromFilename('random.csv')).toBeNull();
  });
});
