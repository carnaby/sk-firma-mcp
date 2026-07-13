# sk-firma-mcp-server

Prever si slovenskú firmu cez AI: MCP server nad verejnými registrami (RPO,
RÚZ, Finančná správa, Sociálna poisťovňa, VšZP, Dôvera) s deterministickým
rizikovým verdiktom 🟢/🟠/🔴.

Žiadny scraping RPO/RÚZ, žiadne ML skórovanie — live dopyty na oficiálne API
(Register právnických osôb ŠÚ SR, Register účtovných závierok MF SR) plus
lokálny index z pravidelne aktualizovaných verejných zoznamov dlžníkov a
platiteľov DPH (`npm run ingest`, pozri sekciu **Ingest**) a transparentné
pravidlá nad faktami. Výstup je navrhnutý pre LLM: kompaktný markdown do
~1 500 tokenov, so zdrojmi a dátumom platnosti pri každom údaji.

## Inštalácia

### Claude Code

```bash
claude mcp add skfirma -- npx -y sk-firma-mcp-server
```

Over: `claude mcp list` má obsahovať `skfirma`. Žiadne API kľúče netreba —
všetky zdroje sú verejné a bez autentifikácie. Pre `skfirma_debts`/
`skfirma_vat_status` treba navyše lokálny index, pozri sekciu **Ingest**.

### Claude Desktop

Pridaj do `claude_desktop_config.json` (Nastavenia → Developer → Edit Config):

```json
{
  "mcpServers": {
    "skfirma": {
      "command": "npx",
      "args": ["-y", "sk-firma-mcp-server"]
    }
  }
}
```

Po uložení reštartuj Claude Desktop. V zozname nástrojov by sa mali objaviť
`skfirma_search`, `skfirma_profile`, `skfirma_financials`, `skfirma_debts`,
`skfirma_vat_status`, `skfirma_check`.

## Ingest (lokálny index dlžníkov a platiteľov DPH)

`skfirma_debts` a `skfirma_vat_status` (a sekcie „Dlhy"/„DPH" v
`skfirma_check`) čerpajú z **lokálneho SQLite indexu**, nie z live API —
tieto registre live rozhranie nemajú. Index si postavíš príkazom:

```bash
npm run ingest
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
  nastav rovnako pre `npm run ingest` aj pre bežiaci server.
- `SKFIRMA_DOVERA` — `0` vypne live lookup na Dôveru v `skfirma_debts`/`skfirma_check`
  (napr. keď je zdroj dlhodobo nedostupný alebo blokovaný).

**Odporúčaná frekvencia:** denne až týždenne — FS/SP/VšZP zoznamy sa
aktualizujú v rádoch dní až týždňov, denný cron je bezpečná horná hranica.

Windows Task Scheduler (jeden riadok, denne o 3:00):

```powershell
schtasks /create /tn "skfirma-ingest" /tr "cmd /c cd /d C:\cesta\k\repu && npm run ingest >> ingest.log 2>&1" /sc daily /st 03:00
```

**Známe obmedzenie na Windows:** `better-sqlite3` drží súbor indexu otvorený
zamknutý, kým beží MCP server — pred spustením `npm run ingest` server
(Claude Desktop/Code, alebo `npm run smoke`) najprv **zastav**, inak ingest
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
index (`npm run ingest`).

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
  v `skfirma_check`) vyžaduje `npm run ingest` — bez neho tieto nástroje
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
idú cez lokálny index postavený `npm run ingest` (pozri sekciu **Ingest**),
Dôvera je live per-dopyt scraping. Každá odpoveď obsahuje `as_of` — dátum,
ku ktorému je údaj platný — aby bolo vždy jasné, aká čerstvá je informácia,
ktorú model dostal.

## Disclaimer

Informatívny výstup z verejných registrov, nie úverový rating ani právne
posúdenie. Rozhodnutia (napr. o uzavretí kontraktu) rob vždy na základe
vlastného úsudku a v prípade potreby s právnym/účtovným poradcom — server
agreguje verejné dáta, nenahrádza due diligence.

## Vývoj

```bash
npm install
npm run build     # tsc → dist/
npm test          # 141 unit/integration testov, všetko mockované (MockAgent/fixtures/tmp SQLite), beží aj bez internetu
npm run ingest    # postaví lokálny index (data/skfirma-index.sqlite) zo 6 živých datasetov — pozri sekciu Ingest
npm run smoke     # živý akceptačný smoke proti reálnym RPO/RÚZ/FS/SP/VšZP/Dôvera zdrojom (nie je súčasťou CI)
```

`npm run smoke` potrebuje lokálny (negitovaný) zoznam testovacích IČO v
`docs/smoke-cases.json` — pole objektov `{ ico, name, expect, expect_debtor?, expect_vat_payer? }`,
kde `expect` je zoznam verdiktových emoji, ktoré sa majú v odpovedi
`skfirma_check` objaviť (napr. `["🟢", "🟠"]`). Voliteľné `expect_debtor: true`
navyše zavolá `skfirma_debts` a overí výskyt slova „dlžník"; `expect_vat_payer:
true` zavolá `skfirma_vat_status` a overí výskyt slova „platiteľ" — na tieto
dva prípady treba v zozname reálny IČO platiteľa DPH a reálneho dlžníka
(napr. z lokálneho indexu po `npm run ingest`). Cestu k súboru je možné
zmeniť premennou prostredia `SKFIRMA_SMOKE_CASES`. Bez tohto súboru skript
vypíše návod a skončí s kódom 2 (dáta sú zámerne mimo repozitára, aby sa
doň nedostali reálne IČO). Pred spustením smoke buduj index cez `npm run
ingest` (viď poznámku o Windows uzamknutí v sekcii **Ingest** — najprv
zastav bežiaci server).

MCP Inspector (ručné overenie nástrojov, anotácií a chybových stavov):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
