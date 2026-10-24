import { describe, it, expect } from 'vitest';
import { buildVatStatus } from '../src/domain/vat.js';
import type { VatRows } from '../src/clients/dataset-index.js';

const rows = (over: Partial<VatRows> = {}): VatRows => ({
  payer: { ico: '77777777', ic_dph: 'SK7077777777', name: 'Firma Sedem s. r. o.', kind: '§4', registered_on: '2020-10-11', payer_since: '2020-10-11' },
  erased: null, risky: null,
  asOf: { payers: '2026-07-12', erased: '2026-07-12', risky: '2026-07-12' },
  ...over,
});

describe('buildVatStatus', () => {
  it('§4 = registrovaný platiteľ', () => {
    const v = buildVatStatus({ ico: '77777777' }, rows());
    expect(v).toMatchObject({ registered: true, is_payer: true, ic_dph: 'SK7077777777', registration_kind: '§4', as_of: '2026-07-12' });
  });
  it('§7a = registrovaný, NIE platiteľ (S3 nuansa)', () => {
    const v = buildVatStatus({ ico: '88888888' }, rows({ payer: { ico: '88888888', ic_dph: 'SK7088888888', name: 'Firma Osem a. s.', kind: '§7a', registered_on: '2023-03-05', payer_since: null } }));
    expect(v.registered).toBe(true);
    expect(v.is_payer).toBe(false);
  });
  it('nenájdený → registered false', () => {
    const v = buildVatStatus({ ico: '99999999' }, rows({ payer: null }));
    expect(v).toMatchObject({ registered: false, is_payer: false, ic_dph: null });
  });
  it('vymazaný a rizikový sa hlásia aj bez payer záznamu', () => {
    const v = buildVatStatus({ ico: '99999999' }, rows({
      payer: null,
      erased: { ico: '99999999', ic_dph: 'SK7099999999', name: 'Firma Deväť s. r. o.', violation_year: '2024', published_on: '2024-05-01', erased_on: '2024-06-01' },
      risky: { ico: '99999999', ic_dph: 'SK7099999999', name: 'Firma Deväť s. r. o.', violation_year: '2023', published_on: '2023-02-25' },
    }));
    expect(v.erased).toEqual({ published_on: '2024-05-01', erased_on: '2024-06-01', violation_year: '2024' });
    expect(v.risky).toEqual({ published_on: '2023-02-25', violation_year: '2023' });
  });
  it('as_of spadne na erased/risky meta keď payers meta chýba', () => {
    const v = buildVatStatus({ ico: '99999999' }, rows({
      payer: null,
      erased: { ico: '99999999', ic_dph: 'SK7099999999', name: 'Firma Deväť s. r. o.', violation_year: '2024', published_on: '2024-05-01', erased_on: '2024-06-01' },
      asOf: { payers: null, erased: '2026-07-12', risky: '2026-07-10' },
    }));
    expect(v.as_of).toBe('2026-07-12');
  });
});
