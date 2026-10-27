# SK Firma — previerka slovenskej firmy (web + MCP)

Prever si slovenskú firmu podľa IČO alebo názvu: identita z registra,
účtovné závierky, dlhy voči štátu a poisťovniam, DPH status a
deterministický rizikový verdikt 🟢/🟠/🔴. Na webe so živým testom aj ako
MCP konektor pre Claude a iné AI klientov.

Žiadny scraping RPO/RÚZ, žiadne ML skórovanie — live dopyty na oficiálne API
(Register právnických osôb ŠÚ SR, Register účtovných závierok MF SR) plus
lokálny index z pravidelne aktualizovaných verejných zoznamov dlžníkov a
platiteľov DPH a transparentné pravidlá nad faktami. Výstup pre LLM je
kompaktný markdown do ~1 500 tokenov, so zdrojmi a dátumom platnosti pri
každom údaji.

## Štruktúra (pnpm workspace)

Požiadavky: **Node 24+** (SQLite je vstavaný `node:sqlite`, žiadny natívny
balík na kompiláciu) a **pnpm** (`corepack enable` — verzia je v
`packageManager`).

```
packages/core   @skfirma/core — klienti RPO/RÚZ/Dôvera, ingest, risk engine,
                use-case služby (search/profile/…/check), markdown render
packages/mcp    sk-firma-mcp-server — MCP nástroje, stdio CLI, HTTP handler
apps/server     jeden Node proces (Hono): web + /api + /mcp + denný ingest
apps/web        React + Vite: landing, živý test previerky, návod na konektor
```

Logika žije len v `core/services.ts`. MCP nástroje aj webové API sú tenké
obaly nad ňou, takže verdikt na webe a v Claude je vždy rovnaký.

| Endpoint | Čo robí |
|---|---|
| `GET /` | web (SPA) |
| `GET /api/check?q=<IČO alebo názov>` | previerka → `{ kind: "report", report, markdown }` alebo `{ kind: "ambiguous", candidates }` |
| `GET /api/search?q=…` | vyhľadávanie v RPO |
| `GET /api/health` | stav servera a lokálneho indexu (dátum a počet záznamov po datasetoch) |
| `POST /mcp` | remote MCP, Streamable HTTP, bezstavový, bez autentifikácie |

## Pripojenie MCP konektora

### Remote (nasadený server)

- **Claude (web/desktop):** Nastavenia → Connectors → Add custom connector → URL `https://<tvoja-doména>/mcp`
- **Claude Code:** `claude mcp add --transport http skfirma https://<tvoja-doména>/mcp`

### Lokálne (stdio)

```bash
pnpm install && pnpm build
claude mcp add skfirma -- node /cesta/k/repu/packages/mcp/dist/bin/cli.js
```

Balík `sk-firma-mcp-server` zatiaľ nie je zverejnený na npm. Po
`pnpm --filter sk-firma-mcp-server publish` bude fungovať aj
`claude mcp add skfirma -- npx -y sk-firma-mcp-server`. Biny v `dist/bin`
sú zbundlované cez esbuild (privátny `@skfirma/core` je inlinovaný).

## Spustenie a nasadenie

### Lokálny vývoj

```bash
pnpm install
pnpm dev           # server na :8787 (bez ingestu) + Vite na :5173 s proxy na /api a /mcp
pnpm test          # všetky testy, bez internetu (fixtures, MockAgent, fake deps)
pnpm typecheck
```

### Produkcia (Docker, hocikde s perzistentným diskom)

Hotový image pre `linux/amd64` aj `linux/arm64` builduje GitHub Actions
pri každom pushi do `main` → `ghcr.io/carnaby/sk-firma-mcp:latest`.

```bash
docker run -d -p 8080:8080 -v skfirma-data:/data ghcr.io/carnaby/sk-firma-mcp:latest
# alebo lokálny build: docker build -t skfirma .
```

Kontajner pri štarte postaví index, ak chýba alebo je starší ako
interval, a potom ho obnovuje každých `SKFIRMA_INGEST_INTERVAL_HOURS`.
Ingest beží v child procese, aby parsovanie ~100 MB dát neblokovalo API.
Funguje to na NAS, VPS, Fly.io aj Railway, ak má služba **volume**
pripojený na `/data`. Serverless (Vercel, Netlify, Cloudflare) nepôjde:
SQLite index potrebuje disk a dlhožijúci proces.

### Nasadenie na Synology (DSM reverse proxy)

Konektor v claude.ai volajú servery Anthropicu, takže server musí byť
dostupný **z internetu cez HTTPS**. Na Synology to zvládne vstavaná
reverse proxy s certifikátom Let's Encrypt; kontajner je dostupný len na
localhoste NAS-u.

```
internet → router :443 → DSM reverse proxy (HTTPS) → localhost:8080 → kontajner
```

**Predpoklady:** DSM 7.2+ s Container Managerom, port 443 (a 80 pre
vydanie certifikátu) presmerovaný z routera na NAS, DNS záznam
subdomény (napr. `skfirma.tvojadomena.sk`, A/CNAME) mieri na tvoju
verejnú IP.

1. **Image na GHCR.** Po merge do `main` počkaj, kým dobehne workflow
   *Docker image* (GitHub → Actions). Potom Packages → `sk-firma-mcp` →
   Package settings → Change visibility → **Public**, aby si ho NAS
   stiahol bez prihlasovania. Stačí raz.
2. **Kontajner.** Container Manager → Projekt → Vytvoriť → názov
   `skfirma`, cesta napr. `/docker/skfirma` → Zdroj: „Vytvoriť
   docker-compose.yml" → vlož obsah [`deploy/compose.yaml`](deploy/compose.yaml)
   → Ďalej (Web Station portál nezapínaj) → Hotovo.
3. **Certifikát.** Ovládací panel → Zabezpečenie → Certifikát → Pridať
   → Získať certifikát od Let's Encrypt → doména `skfirma.tvojadomena.sk`.
   Ak už máš wildcard certifikát na doménu, tento krok preskoč.
4. **Reverse proxy.** Ovládací panel → Prihlasovací portál → Rozšírené
   → Reverzný server proxy → Vytvoriť:
   - Zdroj: HTTPS, názov hostiteľa `skfirma.tvojadomena.sk`, port 443,
     zapni HSTS
   - Cieľ: HTTP, `localhost`, port `8080`
   - Potom v Zabezpečenie → Certifikát → Nastavenia priraď tejto
     službe certifikát z kroku 3.
5. **Over.** `https://skfirma.tvojadomena.sk/api/health`. Prvý ingest
   štartuje ~5 s po spustení a trvá pár minút; potom `index_available: true`.
   Logy: Container Manager → Kontajner → `skfirma` → Denník.
   **Skontroluj `client_ip`** — musí to byť tvoja verejná IP. Ak je tam
   `172.x.x.x` (adresa proxy), limity by platili pre všetkých naraz: v
   pravidle reverse proxy → Vlastná hlavička → Vytvoriť pridaj
   `X-Forwarded-For` = `$proxy_add_x_forwarded_for`.
6. **Konektor.** claude.ai → Nastavenia → Connectors → Add custom
   connector → `https://skfirma.tvojadomena.sk/mcp`.

**Update:** po novom pushi do `main` v Container Manageri: Projekt →
`skfirma` → Akcia → Zostaviť (stiahne nový `latest` a reštartuje).
Cez SSH: `docker compose pull && docker compose up -d`. Index vo volume
ostáva.

**Varianty:**
- Za Cloudflare Tunnel (bez otvárania portov):
  [`deploy/compose.cloudflare.yaml`](deploy/compose.cloudflare.yaml),
  `TRUST_PROXY: cloudflare`, v tuneli Public hostname → `http://skfirma:8080`.
- Iný server s Dockerom: `docker run -d -p 8080:8080 -v skfirma-data:/data ghcr.io/carnaby/sk-firma-mcp:latest`
  a vlastná reverse proxy (Caddy, Traefik) s `TRUST_PROXY=xff`.

### Ochrana zdrojových API

Verejný web a `/mcp` znamenajú, že ktokoľvek môže cez tvoj server
posielať dopyty na RPO, RÚZ a Dôveru. Ochrana má dve úrovne:

| Vrstva | Chráni pred | Default |
|---|---|---|
| Limit na IP — minúta | jedným klientom, ktorý klikne 100× | API 20/min, MCP 60/min |
| Limit na IP — deň | crawlerom z jednej adresy | API 300/deň, MCP 1 500/deň |
| Cache + single-flight | opakovaným a súbežným dopytom na tú istú firmu | RPO 7 dní, RÚZ a Dôvera 1 deň |
| Throttle na host | nárazom | ~2 req/s na RPO, RÚZ, Dôveru |
| Max. fronta na host | zahlteniu (veľa IP naraz) | 20 čakajúcich, ďalší dostane hneď „vyťažené" (HTTP 503) |
| Denný rozpočet na host | súčtu všetkých klientov | 20 000 dopytov/deň na zdroj |

Aktuálne čísla (spotreba rozpočtu, fronta, odmietnuté) ukazuje
`/api/health` → `upstream`. Limity sú v pamäti procesu: reštart ich
vynuluje a pri viacerých inštanciách by ich bolo treba zdieľať (Redis).

| Premenná | Default | |
|---|---|---|
| `PORT` | `8080` (Docker), `8787` (lokálne) | |
| `SKFIRMA_INDEX_PATH` | `/data/skfirma-index.sqlite` (Docker) | cesta k SQLite indexu |
| `SKFIRMA_INGEST_INTERVAL_HOURS` | `24` | `0` = vypnutý plánovaný ingest |
| `TRUST_PROXY` | `none` | `cloudflare` = IP z `CF-Connecting-IP`; `xff` = posledná položka `X-Forwarded-For` (vlastná reverse proxy) |
| `RATE_LIMIT_API_PER_MINUTE` / `_PER_DAY` | `20` / `300` | na IP pre `/api/check` a `/api/search` |
| `RATE_LIMIT_MCP_PER_MINUTE` / `_PER_DAY` | `60` / `1500` | na IP pre `/mcp` (jedno použitie nástroja = 2–4 volania) |
| `SKFIRMA_UPSTREAM_MAX_QUEUE` | `20` | max. čakajúcich dopytov na jeden zdroj |
| `SKFIRMA_UPSTREAM_DAILY_BUDGET` | `20000` | max. dopytov na jeden zdroj za deň (UTC) |
| `WEB_DIR` | `apps/web/dist` | build webu |
| `SKFIRMA_DOVERA` | — | `0` vypne live lookup na Dôveru |

## Ingest (lokálny index dlžníkov a platiteľov DPH)

`skfirma_debts` a `skfirma_vat_status` (a sekcie „Dlhy"/„DPH" v
`skfirma_check`) čerpajú z **lokálneho SQLite indexu**, nie z live API —
tieto registre live rozhranie nemajú. Index si postavíš príkazom:

```bash
pnpm build && pnpm ingest   # z koreňa repa → ./data/skfirma-index.sqlite
```

Stiahne a spracuje 6 verejných datasetov (~50–100 MB spolu):

| Dataset | Zdroj |
|---|---|
| Platitelia DPH, vymazaní platitelia, rizikoví platitelia (§52 ods. 6) | Finančná správa SR, OpenData ZIP export (`report.financnasprava.sk`) |
| Daňoví dlžníci | Finančná správa SR, OpenData ZIP export |
| Dlžníci Sociálnej poisťovne | Sociálna poisťovňa, verejný zoznam dlžníkov |
| Dlžníci VšZP | Slovensko.Digital Datahub (SQL dump VšZP) |

Beh je idempotentný — FS datasety používajú podmienený GET (ETag), takže
opakovaný beh bez zmeny na strane zdroja vypíše `not_modified` a nesťahuje
dáta znova. Výstupom je súhrnná tabuľka na stderr (dataset/stav/počet
záznamov/`as_of`) a súbor `data/skfirma-index.sqlite` (atomický swap, server
ho pri zmene automaticky znovu otvorí bez reštartu).

Premenné prostredia:

- `SKFIRMA_INDEX_PATH` — cesta k SQLite indexu (default `./data/skfirma-index.sqlite`);
  nastav rovnako pre `pnpm ingest` aj pre bežiaci server.
- `SKFIRMA_DOVERA` — `0` vypne live lookup na Dôveru v `skfirma_debts`/`skfirma_check`
  (napr. keď je zdroj dlhodobo nedostupný alebo blokovaný).

**Odporúčaná frekvencia:** denne až týždenne — FS/SP/VšZP zoznamy sa
aktualizujú v rádoch dní až týždňov, denný cron je bezpečná horná hranica.

Windows Task Scheduler (jeden riadok, denne o 3:00):

```powershell
schtasks /create /tn "skfirma-ingest" /tr "cmd /c cd /d C:\cesta\k\repu && pnpm ingest >> ingest.log 2>&1" /sc daily /st 03:00
```

**Známe obmedzenie na Windows:** SQLite drží súbor indexu otvorený
zamknutý, kým beží MCP server — pred spustením `pnpm ingest` server
(Claude Desktop/Code, alebo `pnpm smoke`) najprv **zastav**, inak ingest
zlyhá na zápise (alebo ostane bežať proti starému súboru). Po dobehnutí
ingestu server znovu spusti.

## Nástroje

Každý nástroj podporuje `response_format`: `markdown` (default, čitateľné pre
človeka aj LLM) alebo `json` (všetky polia pre ďalšie spracovanie).

_Príklady sú ilustračné s anonymizovanými údajmi._

### `skfirma_search` — nájdi subjekt podľa názvu alebo IČO

Použi na disambiguáciu pred `skfirma_profile`/`skfirma_check`, keď nepoznáš
presné IČO alebo si nie si istý presným názvom.

**1. „Nájdi firmu Firma Jeden“**

```json
{ "name": "skfirma_search", "arguments": { "query": "Firma Jeden" } }
```
```
Nájdených: 1. [RPO, ŠÚ SR, CC-BY 4.0]

| IČO | Názov | Adresa | Stav | Vznik |
|---|---|---|---|---|
| 11111111 | Firma Jeden s. r. o. | Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto | aktívna | 2018-01-02 |
```

**2. „Existuje firma s IČO 11111111?“**

```json
{ "name": "skfirma_search", "arguments": { "query": "11111111" } }
```
```
Nájdených: 1. [RPO, ŠÚ SR, CC-BY 4.0]

| IČO | Názov | Adresa | Stav | Vznik |
|---|---|---|---|---|
| 11111111 | Firma Jeden s. r. o. | Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto | aktívna | 2018-01-02 |
```

**3. „Vyhľadaj Firma Jeden, len aktívne firmy, max 5 výsledkov“**

```json
{ "name": "skfirma_search", "arguments": { "query": "Firma Jeden", "only_active": true, "limit": 5 } }
```
```
Nájdených: 1. [RPO, ŠÚ SR, CC-BY 4.0]

| IČO | Názov | Adresa | Stav | Vznik |
|---|---|---|---|---|
| 11111111 | Firma Jeden s. r. o. | Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto | aktívna | 2018-01-02 |
```

### `skfirma_profile` — identita firmy podľa IČO

Právna forma, adresa, právny stav (aktívna/likvidácia/konkurz), štatutári,
spoločníci, SK NACE.

**1. „Kto je konateľ Firma Jeden s. r. o.?“**

```json
{ "name": "skfirma_profile", "arguments": { "ico": "11111111" } }
```
```
## Firma Jeden s. r. o. (IČO 11111111)

**Identita:** Spoločnosť s ručením obmedzeným, Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto, vznik 2018-01-02.
Štatutári: Ing. Ján Vzorový (od 2018), Mgr. Eva Vzorová (od 2021).
Hlavná činnosť: 6210 Počítačové programovanie.
Stav: aktívna. [RPO, ŠÚ SR, CC-BY 4.0, k 2026-06-30]
```

**2. „Je firma s IČO 55555555 stále aktívna?“**

```json
{ "name": "skfirma_profile", "arguments": { "ico": "55555555" } }
```
```
## Firma Päť s. r. o. v likvidácii (IČO 55555555)

**Identita:** Spoločnosť s ručením obmedzeným, Vzorová 45/6, 82101 Bratislava - mestská časť Ružinov, vznik 1993-04-05.
Štatutári: Ing. Peter Vzorový (od 1998).
Hlavná činnosť: 4683 Veľkoobchod s drevom, stavebným materiálom a sanitárnymi zariadeniami.
Stav: v likvidácii od 2005-06-07. [RPO, ŠÚ SR, CC-BY 4.0, k 2026-06-30]
```

**3. „Daj mi profil Firma Jeden ako JSON, nech si viem naprogramovať ďalšie spracovanie“**

```json
{ "name": "skfirma_profile", "arguments": { "ico": "11111111", "response_format": "json" } }
```
```json
{"ico":"11111111","name":"Firma Jeden s. r. o.","legal_form":"Spoločnosť s ručením obmedzeným","legal_form_code":"112","address":"Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto","established_on":"2018-01-02","terminated_on":null,"status":"active","status_text":null,"status_since":null,"executives":[{"name":"Ing. Ján Vzorový","role":"Konateľ","since":"2018-01-02"},{"name":"Mgr. Eva Vzorová","role":"Konateľ","since":"2021-02-03"}],"shareholders":[{"name":"Ing. Ján Vzorový"},{"name":"Mgr. Eva Vzorová"}],"main_activity":{"code":"6210","name":"Počítačové programovanie"},"source_register":"Obchodný register","as_of":"2026-06-30"}
```

(Parameter `include_history` pri `response_format=json` priloží aj kompletnú
históriu záznamu z RPO, s odstránenými bydliskami fyzických osôb — GDPR.)

### `skfirma_financials` — finančné metriky z účtovných závierok

Tržby, výsledok hospodárenia, vlastné imanie, zadlženosť a medziročná zmena
tržieb za posledné roky (RÚZ). Nevracia surové výkazy — len odvodené metriky.

**1. „Aké boli tržby Firma Jeden za posledné 3 roky?“**

```json
{ "name": "skfirma_financials", "arguments": { "ico": "11111111", "years": 3 } }
```
```
**Financie (RÚZ, mikro UJ, k 2026-07-12):**
| Rok | Tržby | VH | Vlastné imanie | Zadlženosť |
|---|---|---|---|---|
| 2025 | 1 234 567 € | 12 345 € | 80 000 € | 92 % |
| 2024 | 1 100 000 € | 11 000 € | 70 000 € | 85 % |
| 2023 | 1 000 000 € | 10 000 € | 60 000 € | 79 % |
```

**2. „Chcem históriu za 5 rokov, nie len 3“**

```json
{ "name": "skfirma_financials", "arguments": { "ico": "11111111", "years": 5 } }
```
```
**Financie (RÚZ, mikro UJ, k 2026-07-12):**
| Rok | Tržby | VH | Vlastné imanie | Zadlženosť |
|---|---|---|---|---|
| 2025 | 1 234 567 € | 12 345 € | 80 000 € | 92 % |
| 2024 | 1 100 000 € | 11 000 € | 70 000 € | 85 % |
| 2023 | 1 000 000 € | 10 000 € | 60 000 € | 79 % |
| 2022 | 900 000 € | 9 000 € | 55 000 € | 72 % |
| 2021 | 800 000 € | 8 000 € | 50 000 € | 69 % |
```

**3. „Potrebujem aj ID výkazov, chcem si dopočítať PDF odkaz“**

```json
{ "name": "skfirma_financials", "arguments": { "ico": "11111111", "include_statement_ids": true } }
```
```
**Financie (RÚZ, mikro UJ, k 2026-07-12):**
| Rok | Tržby | VH | Vlastné imanie | Zadlženosť |
|---|---|---|---|---|
| 2025 | 1 234 567 € | 12 345 € | 80 000 € | 92 % |
| 2024 | 1 100 000 € | 11 000 € | 70 000 € | 85 % |
| 2023 | 1 000 000 € | 10 000 € | 60 000 € | 79 % |
Statement IDs: 9000001 (2025), 9000002 (2024), 9000003 (2023)
```

### `skfirma_debts` — dlhy voči štátu a poisťovniam

Finančná správa (daňoví dlžníci), Sociálna poisťovňa, VšZP a Dôvera per
IČO; Union nemá verejný export, vždy vráti `unavailable`. Vyžaduje lokálny
index (`pnpm ingest`).

_Príklady sú ilustračné s anonymizovanými údajmi._

**1. „Má Firma Jeden nejaké dlhy voči štátu?“**

```json
{ "name": "skfirma_debts", "arguments": { "ico": "11111111" } }
```
```
## Firma Jeden s. r. o. (IČO 11111111)

**Dlhy:** Finančná správa 0 €, Sociálna poisťovňa 0 €, VšZP 0 €.
⚠ Dôvera: zdroj nedostupný (dočasne nedostupný, skús neskôr).
⚠ Union: zdroj nedostupný (Union nemá verejný export (v1.1)).
```

**2. „Prever dlhy firmy Firma Šesť, IČO 66666666“**

```json
{ "name": "skfirma_debts", "arguments": { "ico": "66666666" } }
```
```
## Firma Šesť a. s. (IČO 66666666)

**Dlhy (spolu potvrdených 128 000 €):**
| Veriteľ | Stav | Suma | K dátumu |
|---|---|---|---|
| Finančná správa | dlžník (zhoda adresy) | 13 000 € | 2026-05-31 |
| Sociálna poisťovňa | dlžník | 100 000 € | 2026-07-13 |
| VšZP | dlžník | 15 000 € | 2026-07-12 |
| Dôvera | ⚠ nedostupné | — | — |
| Union | ⚠ nedostupné | — | — |
_Prahy zverejnenia: FS > 170 €, SP ≥ 5 €, ZP > 100 €. Zoznamy nie sú realtime — pozri „K dátumu"._
```

**3. „Chcem strojovo spracovateľný výstup dlhov firmy Firma Jeden“**

```json
{ "name": "skfirma_debts", "arguments": { "ico": "11111111", "response_format": "json" } }
```
```json
{"ico":"11111111","name":"Firma Jeden s. r. o.","creditors":{"fs":{"status":"not_found","amount_eur":null,"as_of":"2026-05-31"},"sp":{"status":"not_found","amount_eur":null,"as_of":"2026-07-13"},"vszp":{"status":"not_found","amount_eur":null,"as_of":"2026-07-12"},"dovera":{"status":"unavailable","amount_eur":null,"as_of":null,"note":"..."},"union":{"status":"unavailable","amount_eur":null,"as_of":null,"note":"Union nemá verejný export (v1.1)."}},"total_known_debt_eur":0,"notes":[]}
```

### `skfirma_vat_status` — registrácia pre DPH

Platiteľ/registrovaný (§4/§4b/§5 vs §7/§7a), vymazaný (§52/8), rizikový
(§52/6) — z FS OpenData zoznamov. Zadaj `ico` alebo `ic_dph`. Vyžaduje
lokálny index.

_Príklady sú ilustračné s anonymizovanými údajmi._

**1. „Je Firma Jeden platiteľ DPH?“**

```json
{ "name": "skfirma_vat_status", "arguments": { "ico": "11111111" } }
```
```
**DPH:** platiteľ (§4, od 2020-01-01), IČ DPH SK1111111111.
[FS OpenData, k 2026-07-13]
```

**2. „Over DPH podľa IČ DPH SK6666666666“**

```json
{ "name": "skfirma_vat_status", "arguments": { "ic_dph": "SK6666666666" } }
```
```
**DPH:** platiteľ (§4, od 2005-01-01), IČ DPH SK6666666666.
🔴 V zozname rizikových platiteľov (§52 ods. 6), zverejnený 2024-05-01.
[FS OpenData, k 2026-07-13]
```

**3. „Chcem JSON výstup DPH statusu pre Firma Dva“**

```json
{ "name": "skfirma_vat_status", "arguments": { "ico": "22222222", "response_format": "json" } }
```
```json
{"query":"22222222","name":"Firma Dva s. r. o.","registered":false,"is_payer":false,"ic_dph":null,"registration_kind":null,"registered_on":null,"payer_since":null,"erased":{"published_on":"2024-02-01","erased_on":"2024-02-01","violation_year":"2023"},"risky":null,"as_of":"2026-07-13"}
```

### `skfirma_check` — kompletná previerka: identita + financie + verdikt

Hlavný nástroj. Jedno volanie skombinuje RPO, RÚZ, lokálny index dlžníkov a
DPH status a vráti deterministický verdikt 🟢 bez zistení / 🟠 zvýšené
riziko / 🔴 vysoké riziko s dôvodmi a zdrojmi. Zadaj `ico` alebo `name`
(nikdy oboje). Parametrom `sections` je možné vybrať len časť zo štyroch
sekcií (`profile`, `financials`, `debts`, `vat`), default sú všetky štyri.

**1. „Prever Firma Jeden pred podpisom kontraktu“**

```json
{ "name": "skfirma_check", "arguments": { "ico": "11111111" } }
```
```
## Firma Jeden s. r. o. (IČO 11111111) — verdikt: 🟠 ZVÝŠENÉ RIZIKO

**Dôvody:** zadlženosť 92 % (2025) [registeruz.sk, k 2026-07-12].

**Identita:** Spoločnosť s ručením obmedzeným, Vzorová 123/4, 81101 Bratislava - mestská časť Staré Mesto, vznik 2018-01-02.
Štatutári: Ing. Ján Vzorový (od 2018), Mgr. Eva Vzorová (od 2021).
Hlavná činnosť: 6210 Počítačové programovanie.
Stav: aktívna. [RPO, ŠÚ SR, CC-BY 4.0, k 2026-06-30]

**Financie (RÚZ, mikro UJ, k 2026-07-12):**
| Rok | Tržby | VH | Vlastné imanie | Zadlženosť |
|---|---|---|---|---|
| 2025 | 1 234 567 € | 12 345 € | 80 000 € | 92 % |
| 2024 | 1 100 000 € | 11 000 € | 70 000 € | 85 % |
| 2023 | 1 000 000 € | 10 000 € | 60 000 € | 79 % |

**Dlhy:** Finančná správa 0 €, Sociálna poisťovňa 0 €, VšZP 0 €.
⚠ Dôvera: zdroj nedostupný (dočasne nedostupný, skús neskôr).
⚠ Union: zdroj nedostupný (Union nemá verejný export (v1.1)).

**DPH:** platiteľ (§4, od 2020-01-01), IČ DPH SK1111111111.
[FS OpenData, k 2026-07-13]

_Informatívny výstup z verejných registrov, nie úverový rating ani právne posúdenie._
```

**2. „Skontroluj mi firmu Firma Jeden“ (previerka podľa mena — pri viacznačnom
mene vráti zoznam kandidátov namiesto verdiktu)**

```json
{ "name": "skfirma_check", "arguments": { "name": "Firma Jeden" } }
```
```
## Firma Jeden s. r. o. (IČO 11111111) — verdikt: 🟠 ZVÝŠENÉ RIZIKO

**Dôvody:** zadlženosť 92 % (2025) [registeruz.sk, k 2026-07-12].
... (rovnaký formát ako vyššie)
```

**3. „Potrebujem strojovo spracovateľný výstup previerky (napr. na uloženie
do CRM)“**

```json
{ "name": "skfirma_check", "arguments": { "ico": "11111111", "response_format": "json" } }
```
```json
{"ico":"11111111","verdict":"orange","flags":[{"code":"high_leverage","detail":"zadlženosť 92 % (2025)","as_of":"2026-07-12","source":"registeruz.sk"}],"profile":{"...": "..."},"financials":[{"...": "..."}],"financials_unavailable_reason":null,"debts":{"...": "..."},"vat":{"...": "..."},"notes":[],"failed_sections":[],"sources":["RPO (CC-BY 4.0, ŠÚ SR)","RÚZ (MF SR)","FS OpenData","Sociálna poisťovňa","VšZP (Datahub)","Dôvera"],"disclaimer":"Informatívny výstup z verejných registrov, nie úverový rating ani právne posúdenie."}
```

Ukážkové výstupy vyššie sú ilustračné, s anonymizovanými testovacími dátami
(fiktívna firma, fiktívne IČO) v tvare skutočnej odpovede servera; formát,
zdroje a logika verdiktu zodpovedajú live odpovediam z registrov, konkrétne
hodnoty (tržby, ID výkazov, dátum `as_of`) sa pri reálnom subjekte menia.

## Čo server NEvie (limitácie Fázy 2a)

- **Konkurz/reštrukturalizácia detailne** (priebeh konania, veritelia,
  termíny) — v MVP je viditeľný len právny stav z RPO (áno/nie + dátum
  od kedy), podrobný zdroj z Insolvenčného registra REPLIK je v pláne na
  v1.1.
- **Firmy účtujúce podľa IFRS** — register poskytuje len PDF verzie
  závierok, štruktúrované metriky (tržby/VH/vlastné imanie) pre ne nie sú
  dostupné; nástroj to vráti ako explicitný `unavailable_reason`, nikdy
  ako tichú nulu.
- **Živnostníci s jednoduchým účtovníctvom (JÚ)** — ich výkazy majú iné
  metriky (chýba vlastné imanie aj výsledok hospodárenia v porovnateľnej
  forme) a nie sú v MVP mapované; plánované na v1.1.
- Žiadne ML skórovanie ani predikcie — iba deterministické pravidlá nad
  overiteľnými faktami z registrov.
- **Union** — nemá verejný export dlžníkov, `skfirma_debts` ho vždy vráti ako
  `unavailable`; plán na v1.1 je nejasný (závisí od dostupnosti dát).
- **Dôvera** — nemá API, ide o krehký HTML scraping jednej stránky (S4);
  akékoľvek zlyhanie (zmena HTML, výpadok, rate-limit) degraduje na
  `unavailable`, nikdy nie na tichú nulu ani výnimku smerom k volajúcemu.
- **FS zoznam daňových dlžníkov nemá IČO** — párovanie na subjekt beží podľa
  normalizovaného názvu + adresy (`match_confidence: exact` = zhoda PSČ,
  `high` = zhoda len obce); pri nejednoznačnej zhode vráti `unverifiable`,
  nikdy neriskuje false positive priradenie dlhu cudziemu subjektu.
- **Prahy zverejnenia zoznamov dlžníkov** — FS zverejňuje dlh len nad 170 €,
  Sociálna poisťovňa od 5 €, zdravotné poisťovne nad 100 €; nižšie dlhy sa
  v zdrojových zoznamoch vôbec nenachádzajú (nie je to chyba nástroja).
- **Staleness FS zoznamu dlžníkov** — FS OpenData export daňových dlžníkov
  sa aktualizuje s oneskorením rádovo 2–7 týždňov oproti reálnemu stavu;
  pozri `as_of` pri každom zázname.
- Lokálny index (`skfirma_debts`, `skfirma_vat_status`, sekcie „Dlhy"/„DPH"
  v `skfirma_check`) vyžaduje `pnpm ingest` — bez neho tieto nástroje
  vrátia akčnú ⚠ hlášku (nie tichú nulu) a `skfirma_check` verdikt v takom
  prípade nikdy nepresiahne 🟠 na základe chýbajúcich dát z indexu.

## Zdroje dát, licencie, čerstvosť

| Zdroj | Poskytovateľ | Licencia | Čo prináša |
|---|---|---|---|
| **RPO** (Register právnických osôb) | Štatistický úrad SR, `api.statistics.sk/rpo/v1` | CC-BY 4.0 | identita, adresa, právny stav, štatutári, spoločníci, SK NACE |
| **RÚZ** (Register účtovných závierok) | Ministerstvo financií SR, `registeruz.sk/cruz-public/api` | verejné dáta (CC0) | tržby, výsledok hospodárenia, vlastné imanie, aktíva/pasíva |
| **FS OpenData** (Finančná správa SR) | `report.financnasprava.sk` (ZIP export) | verejné dáta | platitelia/vymazaní/rizikoví platitelia DPH, daňoví dlžníci |
| **Sociálna poisťovňa** | `socpoist.sk`, verejný zoznam dlžníkov | verejné dáta | dlžníci SP |
| **VšZP** | Slovensko.Digital **Datahub** (SQL dump), pôvodný zdroj VšZP | verejné dáta | dlžníci VšZP |
| **Dôvera** | `dovera.sk`, verejné vyhľadávanie dlžníkov (bez API) | verejné dáta | dlžníci Dôvera |

Ďakujeme **Slovensko.Digital** a ich projektu **Datahub** za sprístupnenie
pravidelne aktualizovaného dumpu dlžníkov VšZP — bez neho by tento zdroj
nebol strojovo spracovateľný.

RPO a RÚZ sú live — server pri každom dopyte volá reálne API (s krátkodobým
in-memory cache, aby sa neopakovali identické dopyty zbytočne). FS/SP/VšZP
idú cez lokálny index postavený `pnpm ingest` (pozri sekciu **Ingest**),
Dôvera je live per-dopyt scraping. Každá odpoveď obsahuje `as_of` — dátum,
ku ktorému je údaj platný — aby bolo vždy jasné, aká čerstvá je informácia,
ktorú model dostal.

## Disclaimer

Informatívny výstup z verejných registrov, nie úverový rating ani právne
posúdenie. Rozhodnutia (napr. o uzavretí kontraktu) rob vždy na základe
vlastného úsudku a v prípade potreby s právnym/účtovným poradcom — server
agreguje verejné dáta, nenahrádza due diligence.

## Vývoj

`pnpm smoke` (z koreňa repa, kde je `./data`) je živý akceptačný smoke cez stdio proti reálnym
RPO/RÚZ/FS/SP/VšZP/Dôvera zdrojom (nie je súčasťou CI). Potrebuje lokálny
(negitovaný) zoznam testovacích IČO v `docs/smoke-cases.json` — pole objektov
`{ ico, name, expect, expect_debtor?, expect_vat_payer? }`, kde `expect` je
zoznam verdiktových emoji, ktoré sa majú v odpovedi `skfirma_check` objaviť.
Cestu je možné zmeniť premennou `SKFIRMA_SMOKE_CASES`. Bez súboru skript
vypíše návod a skončí s kódom 2.

MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node packages/mcp/dist/bin/cli.js
# alebo proti bežiacemu serveru: Streamable HTTP, URL http://localhost:8787/mcp
```
