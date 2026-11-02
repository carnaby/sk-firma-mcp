# sk-firma-mcp

Checks Slovak companies (register, financial statements, debtor lists, VAT status) and returns a
rule-based verdict 🟢/🟠/🔴/⚪ — as a web app and as an MCP server for Claude. Guide for contributors
and coding agents; user docs are in [README.md](README.md) / [README.sk.md](README.sk.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | domain logic: source clients (RPO, RÚZ, Dôvera), local index, verdict rules (`domain/risk.ts`), markdown rendering, ingest of debtor/VAT lists |
| `packages/mcp` | MCP server (stdio + Streamable HTTP handler), tool definitions in `src/server.ts`, live smoke test |
| `apps/server` | Hono server: static web, `/api/*`, `/mcp`, rate limits, scheduled ingest |
| `apps/web` | React + Vite single page app |
| `deploy/` | Docker Compose files (NAS, Cloudflare Tunnel variant) |

One service layer (`packages/core/src/services.ts`) produces the same verdict for the web and MCP.
Thresholds live in `packages/core/src/config.ts`.

## Commands

```sh
pnpm install
pnpm dev          # server :8787 + web :5173
pnpm test         # vitest, offline (mocked HTTP)
pnpm typecheck    # packages + tests
pnpm build
pnpm ingest       # download debtor/VAT lists into data/skfirma-index.sqlite
pnpm smoke        # live check against real registers; needs a local, untracked cases file
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build; the Docker image is pushed to GHCR
only after that, and the production host pulls `:latest` automatically.

## Rules that matter

- **Never a false positive.** A debt or risk flag must be certain. Ambiguous name matches are
  `unverifiable`, never `debtor`. Outside the Business Register names are not unique (sole traders),
  so FS debtor matching also needs postal code and house number.
- **Never a silent zero.** A missing or failed source is reported as unavailable and makes the
  verdict ⚪ at most; it never makes the verdict worse and never becomes "not a debtor". An empty or
  suspiciously small downloaded list keeps the previous index.
- **Every non-🟢 verdict has a reason**, every fact carries its source and date (`as_of`).
- **Test data is fictional** (Firma Jeden, Firma Dva, … and made-up IČO). No real companies, IČO,
  people or real financial figures in tracked files.
- **Respect the upstream registers:** throttling, caching and the daily budget in `upstream.ts`
  protect public state APIs; don't bypass them.
- Code comments and user-facing texts are in Slovak.
- Lines marked `infra-admin (services)` are managed by the owner's infrastructure project; don't
  change them here.

## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `sk-firma-mcp`; `.tabula.json` says which untracked files are synced.
- At session start call `recall` for `sk-firma-mcp` with `include_state: false` and follow the global rules. The project state is on disk (restored by the SessionStart hook).
- At handoff run `tabula push` after writing the state file.
- Never write project memories. Add a global rule only when the user explicitly asks.
