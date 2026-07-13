import { describe, it, expect } from 'vitest';
import { parseAmountEur, decodeXmlEntities, ddmmyyyyToIso, dmyToIso, isoWeekMonday } from '../src/ingest/parse-common.js';

describe('parseAmountEur', () => {
  it('SK formát s medzerou a čiarkou', () => expect(parseAmountEur('2 723,67')).toBe(2723.67));
  it('SK formát s NBSP', () => expect(parseAmountEur('1 246,00')).toBe(1246));
  it('bodkový formát', () => expect(parseAmountEur('780.00')).toBe(780));
  it('celé číslo', () => expect(parseAmountEur('47')).toBe(47));
  it('nečíselné/prázdne → null', () => {
    expect(parseAmountEur('')).toBeNull();
    expect(parseAmountEur('-')).toBeNull();
    expect(parseAmountEur(undefined)).toBeNull();
  });
});

describe('decodeXmlEntities', () => {
  it('dekóduje bežné entity', () => {
    expect(decodeXmlEntities('&quot;Firma Sedem&quot; &amp; syn &lt;s.r.o.&gt;')).toBe('"Firma Sedem" & syn <s.r.o.>');
    expect(decodeXmlEntities('O&apos;Brien &#39;X&#39;')).toBe("O'Brien 'X'");
  });
});

describe('dátumy', () => {
  it('ddmmyyyyToIso', () => {
    expect(ddmmyyyyToIso('12072026')).toBe('2026-07-12');
    expect(ddmmyyyyToIso('bogus')).toBeNull();
  });
  it('dmyToIso', () => {
    expect(dmyToIso('25.02.2021')).toBe('2021-02-25');
    expect(dmyToIso('')).toBeNull();
  });
  it('isoWeekMonday — týždeň 28/2026 začína 6. júla', () => {
    expect(isoWeekMonday(28, 2026)).toBe('2026-07-06');
    expect(isoWeekMonday(1, 2026)).toBe('2025-12-29'); // ISO týždeň 1 môže začať v decembri
  });
});
