import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseVszpSqlDump } from '../src/ingest/parse-vszp-sql.js';

const sql = readFileSync(new URL('./fixtures/ingest/vszp.sql', import.meta.url), 'utf8');

describe('parseVszpSqlDump', () => {
  const r = parseVszpSqlDump(sql);
  it('berie len záznamy s IČO a payer_type != Samoplatiteľ', () => {
    expect(r.rows).toHaveLength(2);
    expect(r.skipped).toBe(2); // Samoplatiteľ + Zamestnávateľ bez IČO
  });
  it('mapuje stĺpce podľa mena z COPY hlavičky', () => {
    expect(r.rows[0]).toEqual({
      ico: '77777777', name: 'Firma Sedem s. r. o.', city: 'Bratislava', psc: '82101',
      amount_eur: 6797.01, payer_type: 'Zamestnávateľ', published_on: '2026-07-12',
    });
  });
  it('asOf = najnovší published_on zahrnutých riadkov', () => {
    expect(r.asOf).toBe('2026-07-12');
  });
  it('chýbajúci COPY blok → prázdny výsledok', () => {
    expect(parseVszpSqlDump('SELECT 1;')).toEqual({ rows: [], skipped: 0, asOf: null });
  });
  it('ignoruje decoy blok (archived_debtors) pred skutočným debtors blokom', () => {
    const cols = 'id, name, address, city, postal_code, amount, payer_type, published_on, created_at, updated_at, cin, health_care_claim';
    const decoy = [
      `COPY vszp.archived_debtors (${cols}) FROM stdin;`,
      `9\tStará Firma\tArchívna 1\tKošice\t04001\t111.11\tZamestnávateľ\t2020-01-01\t2020-01-01 00:00:00\t2020-01-01 00:00:00\t11111111\tf`,
      '\\.',
      '',
      `COPY vszp.debtors (${cols}) FROM stdin;`,
      `1\tFirma Osem s. r. o.\tPravá 1\tŽilina\t01001\t42.00\tZamestnávateľ\t2026-07-12\t2026-01-01 00:00:00\t2026-07-12 04:00:00\t88888888\tf`,
      '\\.',
    ].join('\n');
    const res = parseVszpSqlDump(decoy);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].ico).toBe('88888888');
    expect(res.rows[0].name).toBe('Firma Osem s. r. o.');
  });
  it('mapovanie podľa mena funguje aj pri preusporiadanej hlavičke', () => {
    const reordered = [
      'COPY vszp.debtors (cin, published_on, payer_type, amount, postal_code, city, name, address, id, created_at, updated_at, health_care_claim) FROM stdin;',
      `77777777\t2026-07-12\tZamestnávateľ\t6797.01\t82101\tBratislava\tFirma Sedem s. r. o.\tVzorová 123/4\t1\t2026-01-01 00:00:00\t2026-07-12 04:00:00\tf`,
      '\\.',
    ].join('\n');
    const res = parseVszpSqlDump(reordered);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toEqual({
      ico: '77777777', name: 'Firma Sedem s. r. o.', city: 'Bratislava', psc: '82101',
      amount_eur: 6797.01, payer_type: 'Zamestnávateľ', published_on: '2026-07-12',
    });
  });
  it('riadok s \\N sumou → skipped, nie amount_eur 0', () => {
    const nullAmount = [
      'COPY vszp.debtors (id, name, address, city, postal_code, amount, payer_type, published_on, created_at, updated_at, cin, health_care_claim) FROM stdin;',
      `1\tFirma Deväť s. r. o.\tNulová 9\tPrešov\t08001\t\\N\tZamestnávateľ\t2026-07-12\t2026-01-01 00:00:00\t2026-07-12 04:00:00\t66666666\tf`,
      '\\.',
    ].join('\n');
    expect(parseVszpSqlDump(nullAmount)).toEqual({ rows: [], skipped: 1, asOf: null });
  });
});
