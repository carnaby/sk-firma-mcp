// SP zoznam dlžníkov: quoted CSV (čiarka, UTF-8 s BOM), sumy v SK formáte (S4).
// Riadky bez 8-miestneho IČO (FO-občania) sa do indexu neukladajú (GDPR §9).
import { isoWeekMonday, parseAmountEur } from './parse-common.js';
import type { SpDebtorRow } from './rows.js';

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseSpCsv(csv: string): { rows: SpDebtorRow[]; skippedNoIco: number } {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: SpDebtorRow[] = [];
  let skippedNoIco = 0;
  for (const line of lines.slice(1)) { // [0] = hlavička
    const [name, icoRaw, address, city, amountRaw] = splitCsvLine(line);
    const ico = (icoRaw ?? '').replace(/\s+/g, '');
    if (!/^\d{8}$/.test(ico)) { skippedNoIco++; continue; }
    const amount = parseAmountEur(amountRaw);
    if (amount === null) { skippedNoIco++; continue; }
    rows.push({
      ico,
      name: name || null,
      address: address || null,
      city: city || null,
      amount_eur: amount,
    });
  }
  return { rows, skippedNoIco };
}

export function spAsOfFromFilename(name: string): string | null {
  const m = /dlznici_(\d{1,2})_(\d{4})/.exec(name);
  return m ? isoWeekMonday(Number(m[1]), Number(m[2])) : null;
}
