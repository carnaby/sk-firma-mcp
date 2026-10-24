// FS OpenData XML: rigidný plochý formát (S3) — <ITEM> bloky s jednoduchými
// elementmi bez atribútov a vnorenia. Zámerne bez XML knižnice; pri zmene
// štruktúry padnú testy/počty, nie tiché nuly.
import { decodeXmlEntities, ddmmyyyyToIso, dmyToIso, parseAmountEur } from './parse-common.js';
import type { TaxDebtorRow, VatErasedRow, VatPayerRow, VatRiskyRow } from './rows.js';

export interface FsParseResult {
  asOf: string | null;
  items: Record<string, string>[];
}

export function parseFsXml(xml: string): FsParseResult {
  const asOfMatch = /<DatumAktualizacieZoznamu>(\d{8})<\/DatumAktualizacieZoznamu>/.exec(xml);
  const items: Record<string, string>[] = [];
  const itemRe = /<ITEM>([\s\S]*?)<\/ITEM>/g;
  const fieldRe = /<([A-Z_0-9]+)>([\s\S]*?)<\/\1>/g;
  for (let im = itemRe.exec(xml); im !== null; im = itemRe.exec(xml)) {
    const fields: Record<string, string> = {};
    for (let fm = fieldRe.exec(im[1]); fm !== null; fm = fieldRe.exec(im[1])) {
      fields[fm[1]] = decodeXmlEntities(fm[2].trim());
    }
    items.push(fields);
  }
  return { asOf: ddmmyyyyToIso(asOfMatch?.[1]), items };
}

function normIco(raw: string | undefined): string | null {
  const ico = (raw ?? '').replace(/\s+/g, '');
  return /^\d{8}$/.test(ico) ? ico : null;
}

const emptyToNull = (s: string | undefined): string | null => (s && s.length > 0 ? s : null);

export function mapDphs(item: Record<string, string>): VatPayerRow | null {
  if (!item.IC_DPH) return null;
  return {
    ico: normIco(item.ICO),
    ic_dph: item.IC_DPH,
    name: item.NAZOV_DS ?? '',
    kind: item.DRUH_REG_DPH ?? '',
    registered_on: dmyToIso(item.DATUM_REG),
    payer_since: dmyToIso(item.PLAT_DPH_OD),
  };
}

export function mapDphv(item: Record<string, string>): VatErasedRow | null {
  if (!item.IC_DPH) return null;
  return {
    ico: normIco(item.ICO),
    ic_dph: item.IC_DPH,
    name: emptyToNull(item.NAZOV),
    violation_year: emptyToNull(item.ROK_PORUSENIA),
    published_on: dmyToIso(item.DAT_ZVEREJNENIA),
    erased_on: dmyToIso(item.DAT_VYMAZU),
  };
}

export function mapDphz(item: Record<string, string>): VatRiskyRow | null {
  if (!item.IC_DPH) return null;
  return {
    ico: normIco(item.ICO),
    ic_dph: item.IC_DPH,
    name: emptyToNull(item.NAZOV),
    violation_year: emptyToNull(item.ROK_PORUSENIA),
    published_on: dmyToIso(item.DAT_ZVEREJNENIA),
  };
}

export function mapDsdd(item: Record<string, string>): Omit<TaxDebtorRow, 'name_norm' | 'obec_norm'> | null {
  const amount = parseAmountEur(item.CIASTKA);
  if (!item.NAZOV_SUBJEKTU || amount === null) return null;
  return {
    name: item.NAZOV_SUBJEKTU,
    amount_eur: amount,
    street: emptyToNull(item.ULICA_CISLO),
    psc: emptyToNull(item.PSC),
    obec: emptyToNull(item.OBEC),
  };
}
