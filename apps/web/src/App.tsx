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

const EXAMPLES = ['Slovenská pošta', 'Slovnaft'];

function readQuery(): string {
  return new URLSearchParams(window.location.search).get('q') ?? '';
}

export function App() {
  const [input, setInput] = useState(readQuery);
  const [state, setState] = useState<State>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

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
              onSubmit={(e) => { e.preventDefault(); void run(input); }}
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
              />
              <button type="submit" disabled={busy || !input.trim()}>
                {busy ? 'Overujem…' : 'Preveriť'}
              </button>
            </form>
            <p className="examples">
              Skús napr.{' '}
              {EXAMPLES.map((ex, i) => (
                <span key={ex}>
                  {i > 0 && ' alebo '}
                  <button type="button" className="link" onClick={() => void run(ex)}>{ex}</button>
                </span>
              ))}
            </p>
          </div>
        </section>

        <section className="wrap results" aria-live="polite">
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
                <li><strong>Finančná správa</strong> — daňoví dlžníci, platitelia / vymazaní / rizikoví platitelia DPH.</li>
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
                <li><span className="dot red" /> <strong>Vysoké riziko:</strong> zánik, likvidácia/konkurz/reštrukturalizácia, záporné vlastné imanie, vymazaný alebo rizikový platiteľ DPH, dlhy nad 1 000 €.</li>
                <li><span className="dot orange" /> <strong>Zvýšené riziko:</strong> pokles tržieb o viac ako 30 %, zadlženosť nad 90 %, firma mladšia ako 2 roky, chýbajúce závierky, menšie dlhy, nedostupný zdroj.</li>
                <li><span className="dot green" /> <strong>Bez zistení:</strong> nič z uvedeného — čo neznamená garanciu.</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap">
          Informatívny výstup z verejných registrov, nie úverový rating ani právne posúdenie.
          Dáta RPO © ŠÚ SR (CC-BY 4.0). Open source (MIT) na{' '}
          <a href="https://github.com/carnaby/sk-firma-mcp" target="_blank" rel="noreferrer">GitHube</a>.
        </div>
      </footer>
    </>
  );
}
