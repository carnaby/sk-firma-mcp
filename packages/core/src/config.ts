export const CONFIG = {
  rpo: {
    baseUrl: 'https://api.statistics.sk/rpo/v1',
    timeoutMs: 5_000,          // identifier / detail
    fulltextTimeoutMs: 15_000, // fullName search (S1: 3–13 s)
    cacheTtlMs: 7 * 24 * 3600_000,
  },
  ruz: {
    baseUrl: 'https://www.registeruz.sk/cruz-public/api',
    // PDF prílohy výkazov: /attachment/<id prílohy> (nie /pdf/<id výkazu> — to vracia 404)
    attachmentUrl: 'https://www.registeruz.sk/cruz-public/domain/financialreport/attachment',
    timeoutMs: 10_000,
    cacheTtlMs: 24 * 3600_000,
  },
  http: {
    minIntervalMs: 500, // ~2 req/s per host
    maxRetries: 2,      // len 5xx/429
    backoffBaseMs: 1_000,
    // Ochrana verejných API pred tým, aby ich niekto zahltil cez náš server.
    // Gettery, nie snapshot — env sa dá meniť v testoch aj bez reštartu modulu.
    /** Max. dopytov čakajúcich vo fronte na jeden host; ďalšie hneď dostanú „vyťažené". */
    get maxQueuePerHost() { return Number(process.env.SKFIRMA_UPSTREAM_MAX_QUEUE ?? 20); },
    /** Max. odchádzajúcich dopytov na jeden host za deň (UTC), vrátane retry. */
    get dailyBudgetPerHost() { return Number(process.env.SKFIRMA_UPSTREAM_DAILY_BUDGET ?? 20_000); },
  },
  cacheMaxSize: 5_000,
  risk: {
    revenueDropThreshold: -0.30, // tržby YoY < -30 %
    highLeverageThreshold: 0.90, // (aktíva - VI) / aktíva > 90 %
    youngCompanyMonths: 24,
    noRecentStatementsPeriods: 2, // žiadna závierka za posledné 2 uzavreté obdobia
    debtorMajorThresholdEur: 1_000, // dlh FS+SP+ZP spolu > 1 000 € = 🔴; ≤ = 🟠
  },
  check: {
    maxSearchCandidates: 5, // pri viacznačnom mene v skfirma_check
  },
  search: {
    minQueryLength: 3, // fulltext (S1: pomalé, strop 500)
    defaultLimit: 10,
    maxLimit: 25,
  },
  index: {
    path: process.env.SKFIRMA_INDEX_PATH ?? './data/skfirma-index.sqlite',
    /** Index starší ako toľko dní → viditeľné varovanie v previerke (overuje sa podľa fetched_at, nie as_of zdroja). */
    get staleDays() { return Number(process.env.SKFIRMA_INDEX_STALE_DAYS ?? 30); },
  },
  dovera: {
    // getter, nie snapshot — testy prepínajú cez process.env.SKFIRMA_DOVERA
    get enabled() { return process.env.SKFIRMA_DOVERA !== '0'; },
    searchUrl: 'https://www.dovera.sk/overenia/dlznici/zoznam-dlznikov?q=',
    timeoutMs: 10_000,
    cacheTtlMs: 24 * 3600_000,
  },
  ingest: {
    fs: {
      // report.financnasprava.sk — statické ZIP exporty bez auth, podmienený GET cez ETag (S3)
      dphs: 'https://report.financnasprava.sk/ds_dphs.zip',
      dphv: 'https://report.financnasprava.sk/ds_dphv.zip',
      dphz: 'https://report.financnasprava.sk/ds_dphz.zip',
      dsdd: 'https://report.financnasprava.sk/ds_dsdd.zip',
    },
    spPageUrl: 'https://www.socpoist.sk/nastroje-sluzby/zoznam-dlznikov',
    vszpDumpUrl: 'https://s3.eu-central-1.amazonaws.com/ekosystem-slovensko-digital-dumps/vszp.sql.gz',
    downloadTimeoutMs: 120_000, // najväčší súbor ~18 MB + pomalé linky
  },
  disclaimer: 'Informatívny výstup z verejných registrov, nie úverový rating ani právne posúdenie.',
} as const;
