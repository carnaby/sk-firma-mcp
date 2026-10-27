// Skladanie skfirma_debts odpovede z indexu + Dôvery + RPO adresy.
// Zásady: chýbajúci zdroj je viditeľný ('unavailable' + note), FS match
// nikdy false positive, total počíta len potvrdené dlhy.
import { matchTaxDebtor, normalizeName } from './name-match.js';
import type { DatasetIndex } from '../clients/dataset-index.js';
import type { DoveraClient } from '../clients/dovera.js';
import type { CreditorDebt, DebtsData, SearchCandidate } from '../types.js';

export interface DebtsDeps {
  index: Pick<DatasetIndex, 'spDebt' | 'vszpDebt' | 'taxDebtorCandidates' | 'available'>;
  dovera: Pick<DoveraClient, 'lookup'>;
  rpo: { searchByIco(ico: string): Promise<SearchCandidate | null> };
}

const INGEST_NOTE = 'Lokálny index neexistuje — spusti `pnpm ingest`.';
const unavailable = (note: string): CreditorDebt => ({ status: 'unavailable', amount_eur: null, as_of: null, note });

function fromDebtSum(result: { amount_eur: number; as_of: string } | null | undefined): CreditorDebt {
  if (result === undefined) return unavailable(INGEST_NOTE);
  if (result === null) return { status: 'not_found', amount_eur: null, as_of: null };
  return { status: 'debtor', amount_eur: result.amount_eur, as_of: result.as_of };
}

export async function fetchDebts(ico: string, deps: DebtsDeps): Promise<DebtsData> {
  const notes: string[] = [];

  let candidate: SearchCandidate | null = null;
  try {
    candidate = await deps.rpo.searchByIco(ico);
  } catch (e) {
    console.error('[debts] RPO lookup zlyhal:', e);
  }

  let fs: CreditorDebt;
  if (!deps.index.available()) {
    fs = unavailable(INGEST_NOTE);
  } else if (!candidate) {
    fs = { status: 'unverifiable', amount_eur: null, as_of: null, note: 'Bez názvu firmy z RPO sa FS zoznam dlžníkov (bez IČO) nedá preveriť.' };
  } else {
    const tax = deps.index.taxDebtorCandidates(normalizeName(candidate.name));
    if (tax === undefined) {
      fs = unavailable(INGEST_NOTE);
    } else {
      const match = matchTaxDebtor(tax.candidates, { psc: candidate.psc, municipality: candidate.municipality });
      if (match.status === 'debtor') {
        fs = { status: 'debtor', amount_eur: match.amount_eur, as_of: tax.as_of, match_confidence: match.confidence };
      } else if (match.status === 'unverifiable') {
        fs = { status: 'unverifiable', amount_eur: null, as_of: tax.as_of, note: match.note };
        notes.push(`FS: ${match.note}`);
      } else {
        fs = { status: 'not_found', amount_eur: null, as_of: tax.as_of };
      }
    }
  }

  const sp = fromDebtSum(deps.index.spDebt(ico));
  const vszp = fromDebtSum(deps.index.vszpDebt(ico));

  const doveraResult = await deps.dovera.lookup(ico);
  const dovera: CreditorDebt =
    doveraResult.status === 'debtor'
      ? { status: 'debtor', amount_eur: doveraResult.amount_eur, as_of: doveraResult.as_of }
      : doveraResult.status === 'not_found'
        ? { status: 'not_found', amount_eur: null, as_of: doveraResult.as_of }
        : unavailable(doveraResult.note);

  const union = unavailable('Union nemá verejný export (v1.1).');

  const creditors = { fs, sp, vszp, dovera, union };
  const total = Object.values(creditors)
    .filter((c) => c.status === 'debtor' && c.amount_eur !== null)
    .reduce((sum, c) => sum + (c.amount_eur as number), 0);

  return {
    ico,
    name: candidate?.name ?? null,
    creditors,
    total_known_debt_eur: Math.round(total * 100) / 100,
    notes,
  };
}
