# SK Firma — Slovak company check (web + MCP)

**English** · [Slovensky](README.sk.md)

**Try it:** [firma.carnaby.sk](https://firma.carnaby.sk) · MCP connector `https://firma.carnaby.sk/mcp`

Check a Slovak company by its IČO (company ID) or name before you sign a
contract or send an invoice: registry identity, financial statements, debts
to the tax office and insurers, VAT status — and a deterministic risk verdict
🟢 / 🟠 / 🔴 with the reasons, sources and dates behind it.

It runs as a website with a live check and as an **MCP server**, so Claude
and other AI clients can call it as a tool ("Check company XY before I sign
the contract").

- **Official public sources only.** Live calls to the official APIs of the
  Slovak business register (RPO) and the register of financial statements
  (RÚZ), plus a local index built from published lists of debtors and VAT
  payers. No scraping of the business register, no paid data.
- **No ML scoring.** The verdict is a worst-of over transparent rules; every
  flag states its source and the date the data is valid for.
- **Built for LLMs.** Compact markdown output (≈ 1,500 tokens max for a full
  check), or JSON with all fields.

The user-facing texts (web and tool output) are in Slovak — the data and its
audience are Slovak.

## Connect the MCP server

### Remote (public instance or your own server)

The public instance runs at `https://firma.carnaby.sk/mcp` — no sign-up,
rate-limited per IP. For a self-hosted server, use your own domain.

- **Claude (web / desktop):** Settings → Connectors → Add custom connector → `https://firma.carnaby.sk/mcp`
- **Claude Code:** `claude mcp add --transport http skfirma https://firma.carnaby.sk/mcp`

The endpoint is stateless Streamable HTTP without authentication.

### Local (stdio)

```bash
pnpm install && pnpm build
claude mcp add skfirma -- node /path/to/repo/packages/mcp/dist/bin/cli.js
```

`skfirma_debts` and `skfirma_vat_status` need the local index — run
`pnpm ingest` first (see [Data index](#data-index)). The npm package
`sk-firma-mcp-server` is not published yet.

## Tools

Every tool is read-only and accepts `response_format`: `markdown` (default)
or `json`.

| Tool | What it returns |
|---|---|
| `skfirma_check` | **Main tool.** Full check in one call: identity, 3 years of financials, debts, VAT status and the verdict with reasons. Takes `ico` or `name`; an ambiguous name returns candidates instead of guessing. |
| `skfirma_search` | Find a company by name or IČO (disambiguation). |
| `skfirma_profile` | Legal form, address, status (active / in liquidation / bankrupt / dissolved), statutory bodies, shareholders, main activity (SK NACE). |
| `skfirma_financials` | Revenue, profit, equity, debt ratio and YoY revenue change from financial statements — derived metrics, not raw statements. |
| `skfirma_debts` | Debtor status and amounts: Financial Administration (tax), Social Insurance Agency, health insurers VšZP and Dôvera. |
| `skfirma_vat_status` | VAT registration, deregistered VAT payers (§52/8) and risky VAT payers (§52/6). Accepts `ico` or `ic_dph`. |

Example output of `skfirma_check` (fictitious company):

```
## Firma Jeden s. r. o. (IČO 11111111) — verdikt: 🟠 ZVÝŠENÉ RIZIKO

**Dôvody:** zadlženosť 92 % (2025) [registeruz.sk, k 2026-07-12].

**Identita:** Spoločnosť s ručením obmedzeným, Vzorová 123/4, 81101 Bratislava, vznik 2018-01-02.
Štatutári: Ing. Ján Vzorový (od 2018). Stav: aktívna. [RPO, ŠÚ SR, CC-BY 4.0, k 2026-06-30]

**Financie (RÚZ, mikro UJ, k 2026-07-12):**
| Rok | Tržby | VH | Vlastné imanie | Zadlženosť |
|---|---|---|---|---|
| 2025 | 1 234 567 € | 12 345 € | 80 000 € | 92 % |
...
```

The Slovak README has three worked examples per tool.

## Risk verdict

Worst-of over the flags below; no weights, no score. Thresholds live in
[`packages/core/src/config.ts`](packages/core/src/config.ts).

| Flag | Condition | Verdict |
|---|---|---|
| `terminated` | company dissolved | 🔴 |
| `insolvency` | bankruptcy, restructuring or liquidation (registry legal status) | 🔴 |
| `vat_erased_52_8` | deregistered VAT payer (§52 (8)) | 🔴 |
| `vat_risky_52_6` | on the list of risky VAT payers (§52 (6)) | 🔴 |
| `debtor_major` | debts to tax office + insurers > €1,000 | 🔴 |
| `negative_equity` | equity < 0 in the latest statement | 🔴 |
| `debtor_minor` | debt > €0 and ≤ €1,000 | 🟠 |
| `no_recent_statements` | no statement for the last 2 closed periods | 🟠 |
| `revenue_drop` | revenue YoY < −30 % | 🟠 |
| `young_company` | younger than 24 months | 🟠 |
| `high_leverage` | liabilities / assets > 90 % | 🟠 |
| — | no flag | 🟢 |

A missing source never counts as green: if debts or VAT can't be verified,
the verdict is at most 🟠 with a note.

## Data sources

| Source | Provider | License | Used for | Access |
|---|---|---|---|---|
| RPO — register of legal entities | Statistical Office of the SR | CC-BY 4.0 | identity, status, people, NACE | live API |
| RÚZ — register of financial statements | Ministry of Finance of the SR | public data | revenue, profit, equity, assets | live API |
| FS OpenData | Financial Administration of the SR | public data | VAT payers / deregistered / risky, tax debtors | local index |
| Debtors list | Social Insurance Agency | public data | social insurance debtors | local index |
| VšZP debtors | Slovensko.Digital Datahub dump | public data | health insurance debtors | local index |
| Dôvera debtors | dovera.sk public search | public data | health insurance debtors | live lookup |

Thanks to **Slovensko.Digital** and their **Datahub** for the regularly
updated VšZP dump. Union (third health insurer) publishes no export and is
always reported as unavailable.

## Limitations

- **Bankruptcy details** (proceedings, creditors) are not covered — only the
  legal status from RPO. The insolvency register (REPLIK) is planned.
- **IFRS reporters** — the register only has PDFs, so structured metrics are
  reported as unavailable, never as zero.
- **Sole traders with single-entry bookkeeping** use different statements and
  are not mapped yet.
- **Tax debtors list has no IČO** — matching is by normalized name and
  address; ambiguous matches are reported as unverifiable, never assigned.
- **Publication thresholds and delays:** the tax office publishes debts
  over €170 with a lag of weeks, Social Insurance from €5, health insurers
  over €100. Every value carries its `as_of` date.

## Self-hosting

Requirements: **Node 24+** (SQLite via built-in `node:sqlite`, no native
build) and **pnpm** (`corepack enable`).

```
packages/core   @skfirma/core — RPO/RÚZ/Dôvera clients, ingest, risk engine, use-case services
packages/mcp    sk-firma-mcp-server — MCP tools, stdio CLI, HTTP handler
apps/server     one Node process (Hono): web + /api + /mcp + scheduled ingest
apps/web        React + Vite: landing page, live check, connector guide
```

All logic lives in `packages/core/src/services.ts`; the MCP tools and the web
API are thin wrappers, so the verdict is the same everywhere.

**Docker** (multi-arch image built on every push to `main`):

```bash
docker run -d -p 8080:8080 -v skfirma-data:/data ghcr.io/carnaby/sk-firma-mcp:latest
```

The container builds the data index on first start and refreshes it every
24 h. It needs a persistent volume on `/data` and a long-running process, so
serverless platforms won't work. A Synology NAS setup behind the DSM reverse
proxy (with Watchtower auto-updates) is described in
[README.sk.md](README.sk.md#nasadenie-na-synology-dsm-reverse-proxy) and
[`deploy/compose.yaml`](deploy/compose.yaml).

The public endpoints are protected by per-IP limits, a per-source queue,
a daily request budget per source and a single-flight cache, so the server
can't be used to flood the government APIs. All limits are configurable
via environment variables (table in the Slovak README).

| Endpoint | |
|---|---|
| `GET /` | website |
| `GET /api/check?q=<IČO or name>` | full check (JSON + markdown) |
| `GET /api/search?q=…` | registry search |
| `GET /api/health` | server and index status |
| `POST /mcp` | MCP, stateless Streamable HTTP |

### Data index

```bash
pnpm build && pnpm ingest   # from the repo root → ./data/skfirma-index.sqlite
```

Downloads six public datasets (tens of MB), uses conditional GET where the
source supports it and swaps the index atomically. A dataset that fails to
download keeps its last good snapshot.

## Development

```bash
pnpm install
pnpm dev         # server :8787 + Vite :5173
pnpm test        # all tests, offline (fixtures, mocked HTTP)
pnpm typecheck
pnpm smoke       # live acceptance test against the real registries (needs docs/smoke-cases.json, not in git)
```

Test data uses fictitious companies only (Firma Jeden … Firma Šesť).

## Disclaimer

Informational output from public registers — not a credit rating, legal
assessment or recommendation. The data may be incomplete or out of date;
decisions are yours.

## License

MIT. RPO data © Statistical Office of the Slovak Republic, CC-BY 4.0.
