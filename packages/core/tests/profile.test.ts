import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapEntityToProfile } from '../src/domain/profile.js';

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('mapEntityToProfile', () => {
  it('aktívna firma — aktuálne hodnoty z historizovaných polí', () => {
    const p = mapEntityToProfile(fx('rpo-firma1.json'), new Date('2026-10-27T10:00:00Z'));
    expect(p).toMatchObject({
      ico: '11111111',
      name: 'Firma Jeden s. r. o.',
      legal_form: 'Spoločnosť s ručením obmedzeným',
      legal_form_code: '112',
      address: 'Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto', // NIE historická
      established_on: '2018-01-02',
      terminated_on: null,
      status: 'active',
      status_text: null,
      main_activity: { code: '6210', name: 'Počítačové programovanie' },
      source_register: 'Obchodný register',
      as_of: '2026-10-27', // deň živého dopytu, nie vek záznamu
      record_modified_on: '2025-07-07', // RPO dbModificationDate
    });
    expect(p.executives).toEqual([{ name: 'Ing. Ján Vzorový', role: 'Konateľ', since: '2018-01-02' }]);
    expect(p.shareholders).toEqual([{ name: 'Ing. Ján Vzorový' }]);
    // GDPR: bydlisko štatutára sa NIKDY nemapuje
    expect(JSON.stringify(p)).not.toContain('BYDLISKO');
  });

  it('firma v likvidácii — status z legalStatuses', () => {
    const p = mapEntityToProfile(fx('rpo-likvidacia.json'));
    expect(p.status).toBe('in_liquidation');
    expect(p.status_text).toBe('V likvidácii');
    expect(p.status_since).toBe('2005-06-07');
  });

  it('zaniknutá firma — termination bez legalStatuses', () => {
    const raw = fx('rpo-firma1.json');
    raw.termination = '2008-12-31';
    const p = mapEntityToProfile(raw);
    expect(p.status).toBe('terminated');
    expect(p.terminated_on).toBe('2008-12-31');
  });

  it('neznámy kód legalStatus — active + text (fallback, S1 riziko 4)', () => {
    const raw = fx('rpo-firma1.json');
    raw.legalStatuses = [{ value: { value: 'Nútená správa', code: '9' }, validFrom: '2026-01-01' }];
    const p = mapEntityToProfile(raw);
    expect(p.status).toBe('active');
    expect(p.status_text).toBe('Nútená správa');
  });
});
