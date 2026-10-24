// Datahub free dump (pg_dump): dáta sú v COPY ... FROM stdin; bloku ako TSV,
// \N = NULL. Stĺpce mapujeme podľa mena z hlavičky COPY — poradie v dumpe
// nie je zmluva. Filter: len firmy/SZČO s IČO (GDPR §9 — žiadni samoplatitelia).
import type { VszpDebtorRow } from './rows.js';

export function parseVszpSqlDump(sqlRaw: string): { rows: VszpDebtorRow[]; skipped: number; asOf: string | null } {
  // Tolerancia CRLF: dump aj fixture môžu prísť s \r\n (Windows checkout, proxy) — parser pracuje s \n
  const sql = sqlRaw.replace(/\r\n/g, '\n');
  const copyMatch = /COPY\s+(?:\S+\.)?debtors\s*\(([^)]+)\)\s+FROM\s+stdin;\n([\s\S]*?)\n\\\./.exec(sql);
  if (!copyMatch) return { rows: [], skipped: 0, asOf: null };

  const columns = copyMatch[1].split(',').map((c) => c.trim());
  const col = (name: string) => {
    const i = columns.indexOf(name);
    if (i < 0) throw new Error(`VšZP dump: chýba stĺpec ${name} v COPY hlavičke — zmena schémy?`);
    return i;
  };
  const iName = col('name'); const iCity = col('city'); const iPsc = col('postal_code');
  const iAmount = col('amount'); const iType = col('payer_type');
  const iPublished = col('published_on'); const iCin = col('cin');

  const rows: VszpDebtorRow[] = [];
  let skipped = 0;
  let asOf: string | null = null;
  for (const line of copyMatch[2].split('\n')) {
    if (line.length === 0) continue;
    const v = line.split('\t').map((x) => (x === '\\N' ? null : x));
    const ico = (v[iCin] ?? '').replace(/\s+/g, '');
    const payerType = v[iType];
    if (payerType === 'Samoplatiteľ' || !/^\d{8}$/.test(ico)) { skipped++; continue; }
    const amountRaw = v[iAmount];
    if (amountRaw === null) { skipped++; continue; } // \N suma: Number(null) by dalo 0 €
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) { skipped++; continue; }
    const published = v[iPublished]?.slice(0, 10) ?? null;
    if (published && (asOf === null || published > asOf)) asOf = published;
    rows.push({
      ico,
      name: v[iName],
      city: v[iCity],
      psc: v[iPsc],
      amount_eur: amount,
      payer_type: payerType,
      published_on: published,
    });
  }
  return { rows, skipped, asOf };
}
