import { describe, it, expect } from 'vitest';
import { fetchDebts, type DebtsDeps } from '../src/domain/debts.js';
import type { SearchCandidate } from '../src/types.js';

const candidate: SearchCandidate = {
  ico: '77777777', name: 'Firma Sedem s. r. o.', address: 'Vzorová 123/4, 82101 Bratislava',
  psc: '82101', municipality: 'Bratislava - mestská časť Ružinov',
  status: 'active', established_on: '2019-01-01', terminated_on: null, rpo_id: 1,
};

const deps = (over: Partial<DebtsDeps> = {}): DebtsDeps => ({
  index: {
    available: () => true,
    spDebt: () => ({ amount_eur: 47.71, as_of: '2026-07-06' }),
    vszpDebt: () => null,
    taxDebtorCandidates: () => ({ candidates: [{ name: 'Firma Sedem s. r. o.', psc: '82101', obec_norm: 'bratislava', amount_eur: 780 }], as_of: '2026-05-31' }),
  },
  dovera: { lookup: async () => ({ status: 'not_found', as_of: '2026-07-13' }) },
  rpo: { searchByIco: async () => candidate },
  ...over,
});

describe('fetchDebts', () => {
  it('skladá všetkých veriteľov: FS exact match, SP dlžník, VšZP čistý, Union unavailable', async () => {
    const d = await fetchDebts('77777777', deps());
    expect(d.creditors.fs).toMatchObject({ status: 'debtor', amount_eur: 780, match_confidence: 'exact', as_of: '2026-05-31' });
    expect(d.creditors.sp).toMatchObject({ status: 'debtor', amount_eur: 47.71 });
    expect(d.creditors.vszp.status).toBe('not_found');
    expect(d.creditors.dovera.status).toBe('not_found');
    expect(d.creditors.union.status).toBe('unavailable');
    expect(d.total_known_debt_eur).toBe(827.71);
    expect(d.name).toBe('Firma Sedem s. r. o.');
  });

  it('index chýba → fs/sp/vszp unavailable s pokynom na ingest, dovera beží', async () => {
    const d = await fetchDebts('77777777', deps({
      index: { available: () => false, spDebt: () => undefined, vszpDebt: () => undefined, taxDebtorCandidates: () => undefined },
    }));
    expect(d.creditors.sp.status).toBe('unavailable');
    expect(d.creditors.sp.note).toMatch(/ingest/);
    expect(d.creditors.dovera.status).toBe('not_found');
  });

  it('RPO nenašlo firmu → FS unverifiable (bez mena sa match nedá), ostatné bežia', async () => {
    const d = await fetchDebts('77777777', deps({ rpo: { searchByIco: async () => null } }));
    expect(d.creditors.fs.status).toBe('unverifiable');
    expect(d.creditors.sp.status).toBe('debtor');
    expect(d.name).toBeNull();
  });

  it('viac FS kandidátov → unverifiable, nepočíta sa do súčtu', async () => {
    const d = await fetchDebts('77777777', deps({
      index: {
        available: () => true, spDebt: () => null, vszpDebt: () => null,
        taxDebtorCandidates: () => ({ candidates: [
          { name: 'Firma Sedem s. r. o.', psc: '82101', obec_norm: 'bratislava', amount_eur: 780 },
          { name: 'Firma Sedem s. r. o.', psc: '04001', obec_norm: 'kosice', amount_eur: 100 },
        ], as_of: '2026-05-31' }),
      },
    }));
    expect(d.creditors.fs.status).toBe('unverifiable');
    expect(d.total_known_debt_eur).toBe(0);
    expect(d.notes.join(' ')).toMatch(/jednoznačne/);
  });
});
