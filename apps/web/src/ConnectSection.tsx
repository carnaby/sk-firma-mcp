import { useState } from 'react';

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? 'Skopírované' : 'Kopírovať'}
      </button>
    </div>
  );
}

const TOOLS: [string, string][] = [
  ['skfirma_check', 'kompletná previerka s verdiktom'],
  ['skfirma_search', 'hľadanie podľa názvu alebo IČO'],
  ['skfirma_profile', 'identita, štatutári, spoločníci'],
  ['skfirma_financials', 'tržby, výsledok, imanie, zadlženosť'],
  ['skfirma_debts', 'dlhy voči FS, SP a poisťovniam'],
  ['skfirma_vat_status', 'registrácia a riziká DPH'],
];

export function ConnectSection() {
  const url = `${window.location.origin}/mcp`;
  return (
    <section id="pripojit" className="wrap section">
      <h2>Pripoj to k svojej AI</h2>
      <p className="lead-sm">
        Rovnaké dáta ako vyššie, ako MCP konektor. Potom sa stačí Clauda opýtať
        „Prever mi firmu XY pred podpisom zmluvy" — sám si zavolá správne nástroje.
      </p>

      <div className="grid-3">
        <div className="card step">
          <h3>Claude (web a desktop)</h3>
          <ol>
            <li>Nastavenia → <strong>Connectors</strong> → <strong>Add custom connector</strong></li>
            <li>Názov <em>SK Firma</em>, URL:</li>
          </ol>
          <Copy text={url} />
        </div>
        <div className="card step">
          <h3>Claude Code</h3>
          <p>V termináli:</p>
          <Copy text={`claude mcp add --transport http skfirma ${url}`} />
        </div>
        <div className="card step">
          <h3>Iný MCP klient</h3>
          <p>Cursor, VS Code a pod. — Streamable HTTP, bez autentifikácie:</p>
          <Copy text={`{ "skfirma": { "url": "${url}" } }`} />
        </div>
      </div>

      <h3 className="tools-title">Nástroje</h3>
      <ul className="tools">
        {TOOLS.map(([name, desc]) => (
          <li key={name}><code>{name}</code> <span className="muted">— {desc}</span></li>
        ))}
      </ul>
    </section>
  );
}
