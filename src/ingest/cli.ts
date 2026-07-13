#!/usr/bin/env node
// Ingest CLI: stiahne zoznamy (FS/SP/VšZP), rozparsuje, postaví SQLite index.
// Per-dataset izolácia: pád jedného zdroja nezhodí ostatné; nedodané datasety
// sa prenesú z predchádzajúcej DB (buildDatabase carry-over). Logy len stderr.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG } from '../config.js';
import { DatasetIndex } from '../clients/dataset-index.js';
import { buildDatabase, type BuildInput } from './db-build.js';
import { fetchFsZip, fetchSpZip, fetchVszpSql, unzipSingle } from './download.js';
import { mapDphs, mapDphv, mapDphz, mapDsdd, parseFsXml } from './parse-fs-xml.js';
import { parseSpCsv, spAsOfFromFilename } from './parse-sp-csv.js';
import { parseVszpSqlDump } from './parse-vszp-sql.js';
import type { DatasetName, MetaRow } from './rows.js';

export interface IngestSummaryRow {
  dataset: DatasetName;
  status: 'fresh' | 'not_modified' | 'carried' | 'failed';
  records: number | null;
  as_of: string | null;
  error?: string;
}

const FS_DATASETS: { dataset: DatasetName; url: string; map: (item: Record<string, string>) => unknown | null }[] = [
  { dataset: 'vat_payers', url: CONFIG.ingest.fs.dphs, map: mapDphs },
  { dataset: 'vat_erased', url: CONFIG.ingest.fs.dphv, map: mapDphv },
  { dataset: 'vat_risky', url: CONFIG.ingest.fs.dphz, map: mapDphz },
  { dataset: 'tax_debtors', url: CONFIG.ingest.fs.dsdd, map: mapDsdd },
];

export async function runIngest(opts: { indexPath?: string; now?: () => Date } = {}): Promise<IngestSummaryRow[]> {
  const indexPath = opts.indexPath ?? CONFIG.index.path;
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(indexPath), { recursive: true });

  const previous = new DatasetIndex(indexPath);
  const fresh: BuildInput = {};
  const summary: IngestSummaryRow[] = [];
  const fetchedAt = now().toISOString();
  const makeMeta = (dataset: DatasetName, asOf: string | null, url: string, etag: string | null): MetaRow =>
    ({ dataset, as_of: asOf ?? fetchedAt.slice(0, 10), fetched_at: fetchedAt, source_url: url, record_count: 0, etag });

  for (const { dataset, url, map } of FS_DATASETS) {
    try {
      const prevEtag = previous.meta(dataset)?.etag ?? null;
      const result = await fetchFsZip(url, prevEtag);
      if (result.status === 'not_modified') {
        summary.push({ dataset, status: 'not_modified', records: previous.meta(dataset)?.record_count ?? null, as_of: previous.meta(dataset)?.as_of ?? null });
        continue;
      }
      const { text } = unzipSingle(result.body, '.xml');
      const parsed = parseFsXml(text);
      const rows = parsed.items.map(map).filter((r): r is NonNullable<typeof r> => r !== null);
      // typovo bezpečné priradenie per dataset:
      (fresh as Record<string, unknown>)[dataset] = { rows, meta: makeMeta(dataset, parsed.asOf, url, result.etag) };
      summary.push({ dataset, status: 'fresh', records: rows.length, as_of: parsed.asOf });
    } catch (e) {
      summary.push({ dataset, status: 'failed', records: null, as_of: null, error: String(e) });
    }
  }

  try {
    const { zip } = await fetchSpZip(CONFIG.ingest.spPageUrl);
    const { name, text } = unzipSingle(zip, '.csv');
    const { rows } = parseSpCsv(text);
    const asOf = spAsOfFromFilename(name);
    fresh.sp_debtors = { rows, meta: makeMeta('sp_debtors', asOf, CONFIG.ingest.spPageUrl, null) };
    summary.push({ dataset: 'sp_debtors', status: 'fresh', records: rows.length, as_of: asOf });
  } catch (e) {
    summary.push({ dataset: 'sp_debtors', status: 'failed', records: null, as_of: null, error: String(e) });
  }

  try {
    const sql = await fetchVszpSql(CONFIG.ingest.vszpDumpUrl);
    const { rows, asOf } = parseVszpSqlDump(sql);
    fresh.vszp_debtors = { rows, meta: makeMeta('vszp_debtors', asOf, CONFIG.ingest.vszpDumpUrl, null) };
    summary.push({ dataset: 'vszp_debtors', status: 'fresh', records: rows.length, as_of: asOf });
  } catch (e) {
    summary.push({ dataset: 'vszp_debtors', status: 'failed', records: null, as_of: null, error: String(e) });
  }

  const anyFresh = Object.keys(fresh).length > 0;
  const anyNotModified = summary.some((s) => s.status === 'not_modified');
  if (!anyFresh && !anyNotModified) {
    throw new Error(`Všetky zdroje zlyhali:\n${summary.map((s) => `  ${s.dataset}: ${s.error}`).join('\n')}`);
  }
  // previous drží readonly handle na indexPath — buildDatabase o chvíľu ten
  // istý súbor atomicky nahradí (rename); zatvoriť skôr, než sa o to pokúsi.
  previous.close();
  const { carried } = buildDatabase(indexPath, fresh, indexPath);
  for (const dataset of carried) {
    const s = summary.find((x) => x.dataset === dataset);
    if (s && s.status === 'failed') s.status = 'carried';
  }
  return summary;
}

function printSummary(summary: IngestSummaryRow[]): void {
  console.error('\ndataset          | stav          | záznamov | as_of');
  console.error('-----------------|---------------|----------|-----------');
  for (const s of summary) {
    console.error(
      `${s.dataset.padEnd(16)} | ${s.status.padEnd(13)} | ${String(s.records ?? '—').padStart(8)} | ${s.as_of ?? '—'}${s.error ? `\n  ↳ ${s.error}` : ''}`,
    );
  }
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/cli.js');
if (isMain) {
  runIngest()
    .then((summary) => { printSummary(summary); process.exit(0); })
    .catch((e) => { console.error(`Ingest zlyhal: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
