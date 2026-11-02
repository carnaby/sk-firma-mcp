import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiCheckResponse } from '@skfirma/core';
import { ApiError, fetchCheck } from './api';
import { CheckResult } from './CheckResult';
import { ConnectSection } from './ConnectSection';

type State =
  | { status: 'idle' }
  | { status: 'loading'; q: string }
  | { status: 'error'; q: string; message: string }
  | { status: 'done'; q: string; data: ApiCheckResponse };

function readQuery(): string {
  return new URLSearchParams(window.location.search).get('q') ?? '';
}

/** Posunie stránku k výsledkom, ak ich začiatok nie je na obrazovke (na mobile sú pod nápovedou). */
function revealResults(el: HTMLElement | null) {
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  if (top >= 0 && top <= window.innerHeight - 160) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

export function App() {
  const [input, setInput] = useState(readQuery);
  const [state, setState] = useState<State>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement | null>(null);

  const run = useCallback(async (raw: string, pushHistory = true) => {
    const q = raw.trim();
    if (!q) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setInput(q);
    setState({ status: 'loading', q });
    if (pushHistory) {
      const url = new URL(window.location.href);
      url.searchParams.set('q', q);
      window.history.pushState(null, '', url);
    }
    try {
      const data = await fetchCheck(q, ac.signal);
      setState({ status: 'done', q, data });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setState({ status: 'error', q, message: e instanceof ApiError ? e.message : 'Neočakávaná chyba.' });
    }
  }, []);

  // zdieľateľný odkaz ?q=… a späť/vpred v prehliadači
  useEffect(() => {
    const initial = readQuery();
    if (initial) void run(initial, false);
    const onPop = () => {
      const q = readQuery();
      if (q) void run(q, false);
      else { abortRef.current?.abort(); setInput(''); setState({ status: 'idle' }); }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [run]);

  // nový stav (načítanie, zoznam, výsledok, chyba) musí byť vidno aj na mobile
  useEffect(() => {
    if (state.status !== 'idle') revealResults(resultsRef.current);
  }, [state]);

  const busy = state.status === 'loading';

  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-inner">
          <a className="brand" href="/">
            <span className="brand-mark" aria-hidden>✓</span> SK Firma
          </a>
          <nav>
            <a href="#pripojit">MCP konektor</a>
            <a href="#ako-to-funguje">Ako to funguje</a>
            <a href="#sukromie">Ochrana údajov</a>
            <a href="https://github.com/carnaby/sk-firma-mcp" target="_blank" rel="noreferrer">GitHub</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="wrap">
            <h1>Prever slovenskú firmu skôr, než jej pošleš peniaze</h1>
            <p className="lead">
              Register, účtovné závierky, dlhy voči štátu a poisťovniam, DPH status — z oficiálnych verejných zdrojov,
              s transparentným verdiktom. Na webe aj ako MCP konektor pre Claude.
            </p>

            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                // na dotykových zariadeniach schovaj klávesnicu, inak zakrýva výsledky
                if (window.matchMedia('(pointer: coarse)').matches) (document.activeElement as HTMLElement | null)?.blur();
                void run(input);
              }}
              role="search"
            >
              <label htmlFor="q" className="sr-only">IČO alebo názov firmy</label>
              <input
                id="q"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="IČO (8 číslic) alebo názov firmy"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-describedby="q-hint"
              />
              <button type="submit" disabled={busy || !input.trim()} aria-busy={busy}>
                {busy && <span className="btn-spinner" aria-hidden />}
                {busy ? 'Overujem…' : 'Preveriť'}
              </button>
            </form>
            <p className="search-hint" id="q-hint">
              <strong>IČO</strong> (8 číslic) alebo <strong>názov firmy</strong> — stačí aj jeho časť, aspoň 3 znaky.
              Podľa názvu hľadáme len medzi aktívnymi subjektmi; pri viacerých zhodách si vyberieš zo zoznamu.
            </p>
            <p className="search-notice" role="note">
              <span aria-hidden className="notice-icon">i</span>
              <span>
                Údaje pochádzajú z verejne dostupných registrov štátu a poisťovní a nemusia byť úplné ani aktuálne.
                Výsledok je informatívny — nie je to úverový rating, právne posúdenie ani odporúčanie.
                Rozhodnutie je vždy na tebe.
              </span>
            </p>
          </div>
        </section>

        <section className="wrap results" aria-live="polite" ref={resultsRef}>
          {state.status === 'loading' && (
            <div className="card loading">
              <div className="spinner" aria-hidden />
              <div>
                <strong>Overujem „{state.q}"</strong>
                <p className="muted">Pýtam sa RPO, RÚZ a zoznamov dlžníkov. Vyhľadávanie podľa názvu môže trvať aj 10 s.</p>
              </div>
            </div>
          )}
          {state.status === 'error' && (
            <div className="card error" role="alert">
              <strong>Nepodarilo sa overiť „{state.q}"</strong>
              <p>{state.message}</p>
            </div>
          )}
          {state.status === 'done' && state.data.kind === 'ambiguous' && (
            <div className="card">
              <h2 className="card-title">Viac firiem s názvom „{state.data.query}"</h2>
              <p className="muted">
                Nájdených {state.data.total_count >= 500 ? '500+' : state.data.total_count}. Vyber tú správnu
                {state.data.total_count > state.data.candidates.length && ' alebo spresni názov'}:
              </p>
              <ul className="candidates">
                {state.data.candidates.map((c) => (
                  <li key={c.rpo_id}>
                    <button type="button" disabled={!c.ico} onClick={() => c.ico && void run(c.ico)}>
                      <span className="cand-name">{c.name}</span>
                      <span className="cand-meta">
                        {c.ico ? `IČO ${c.ico}` : 'bez IČO'}{c.address ? ` · ${c.address}` : ''}
                        {c.status === 'terminated' && ' · zaniknutá'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.status === 'done' && state.data.kind === 'report' && (
            <CheckResult report={state.data.report} markdown={state.data.markdown} />
          )}
        </section>

        <ConnectSection />

        <section id="ako-to-funguje" className="wrap section">
          <h2>Ako to funguje</h2>
          <div className="grid-2">
            <div>
              <h3>Zdroje</h3>
              <ul className="plain">
                <li><strong>RPO</strong> — Register právnických osôb (ŠÚ SR): identita, štatutári, právny stav. Živo.</li>
                <li><strong>RÚZ</strong> — Register účtovných závierok (MF SR): tržby, výsledok, imanie. Živo.</li>
                <li><strong>Finančná správa</strong> — daňoví dlžníci, platitelia DPH a zoznam rizikových platiteľov DPH.</li>
                <li><strong>Sociálna poisťovňa, VšZP, Dôvera</strong> — zoznamy dlžníkov.</li>
              </ul>
              <p className="muted small">
                Zoznamy dlžníkov a DPH nemajú živé API — server ich denne sťahuje do lokálneho indexu.
                Pri každom údaji je dátum, ku ktorému platí.
              </p>
            </div>
            <div>
              <h3>Verdikt</h3>
              <p>Žiadne ML ani „skóre" — pevné pravidlá nad faktami, každé s uvedeným zdrojom:</p>
              <ul className="plain">
                <li><span className="dot red" /> <strong>Vysoké riziko:</strong> zánik, likvidácia/konkurz/reštrukturalizácia, záporné vlastné imanie, rizikový platiteľ DPH, dlhy nad 1 000 €.</li>
                <li><span className="dot orange" /> <strong>Zvýšené riziko:</strong> pokles tržieb o viac ako 30 %, zadlženosť nad 90 %, firma mladšia ako 2 roky, chýbajúce závierky, menšie dlhy, výmaz zo zoznamu rizikových platiteľov DPH za posledný rok.</li>
                <li><span className="dot green" /> <strong>Bez zistení:</strong> nič z uvedeného a všetky kľúčové zdroje odpovedali — čo neznamená garanciu.</li>
                <li><span className="dot grey" /> <strong>Nedá sa posúdiť:</strong> žiadny rizikový signál, ale chýbajú kľúčové dáta (napr. závierka len v PDF, register neodpovedal). Neúplné dáta nie sú riziko — verdikt nikdy nezhoršia.</li>
              </ul>
            </div>
          </div>
        </section>
        <section id="sukromie" className="wrap section">
          <h2>Ochrana údajov a kontakt</h2>
          <div className="grid-2">
            <div>
              <h3>Čo zobrazujeme</h3>
              <p>
                Údaje z verejných registrov a zoznamov dlžníkov (RPO, RÚZ, Finančná správa, Sociálna poisťovňa, VšZP,
                Dôvera) — vrátane mien štatutárov, spoločníkov a podnikateľov, ktorí sú fyzické osoby. Účelom je pomôcť
                overiť si obchodného partnera; tieto údaje zverejňujú ich správcovia zo zákona.
              </p>
              <p className="muted small">
                Bydliská štatutárov nezobrazujeme. Zo zoznamov Sociálnej poisťovne a VšZP preberáme len subjekty s IČO.
              </p>
              <h3>Čo neukladáme</h3>
              <p>
                Tvoje hľadania neukladáme. IP adresu držíme len v pamäti servera, najviac 24 hodín, kvôli limitom proti
                zneužitiu. Návštevnosť meriame cez Umami bez cookies a bez textu hľadania.
              </p>
            </div>
            <div>
              <h3>Nesprávny údaj?</h3>
              <p>
                Ak je chyba priamo v registri alebo zozname dlžníkov, opraviť ju vie len jeho správca (ŠÚ SR, MF SR,
                Finančná správa, poisťovňa). Ak sme údaj priradili nesprávne — napríklad dlh iného subjektu s rovnakým
                menom — napíš nám, opravíme to.
              </p>
              <p>
                Prevádzkovateľ: Jozef Sokol, <a href="mailto:dodusik@gmail.com">dodusik@gmail.com</a>. Na rovnakej adrese
                uplatníš aj práva podľa GDPR (prístup, oprava, námietka). Sťažnosť môžeš podať na{' '}
                <a href="https://dataprotection.gov.sk" target="_blank" rel="noreferrer">Úrad na ochranu osobných údajov SR</a>.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap">
          Informatívny výstup z verejných registrov, nie úverový rating ani právne posúdenie.
          Dáta RPO © ŠÚ SR, licencia{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/deed.sk" target="_blank" rel="noreferrer">CC BY 4.0</a>{' '}
          (upravené: výber a preformátovanie údajov). Open source (MIT) na{' '}
          <a href="https://github.com/carnaby/sk-firma-mcp" target="_blank" rel="noreferrer">GitHube</a>
          {' · '}<a href="#sukromie">Ochrana údajov a kontakt</a>.
        </div>
      </footer>
    </>
  );
}
