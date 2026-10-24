import { useState } from 'react';
import type { CheckReportJson, CreditorDebt, Verdict } from '@skfirma/core';
import { fmtDate, fmtEur, fmtPct } from './format';

const VERDICT: Record<Verdict, { label: string; icon: string; hint: string }> = {
  green: { label: 'Bez zistení', icon: '🟢', hint: 'Žiadne z kontrolovaných rizikových pravidiel sa nespustilo.' },
  orange: { label: 'Zvýšené riziko', icon: '🟠', hint: 'Niečo stojí za pozornosť — pozri dôvody nižšie.' },
  red: { label: 'Vysoké riziko', icon: '🔴', hint: 'Aspoň jedno závažné zistenie.' },
};

const STATUS_LABEL: Record<string, string> = {
  active: 'aktívna',
  in_liquidation: 'v likvidácii',
  in_bankruptcy: 'v konkurze',
  in_restructuring: 'v reštrukturalizácii',
  terminated: 'zaniknutá',
};

const FIN_UNAVAILABLE: Record<string, string> = {
  ifrs_pdf_only: 'Závierka je len v PDF (IFRS) — metriky nevieme strojovo vyčítať.',
  unsupported_template: 'Nepodporovaný typ výkazu.',
  no_statements: 'Firma nemá v RÚZ žiadne závierky.',
  not_found: 'Firmu sme v RÚZ nenašli.',
};

const CREDITORS: { key: keyof NonNullable<CheckReportJson['debts']>['creditors']; label: string }[] = [
  { key: 'fs', label: 'Finančná správa' },
  { key: 'sp', label: 'Sociálna poisťovňa' },
  { key: 'vszp', label: 'VšZP' },
  { key: 'dovera', label: 'Dôvera' },
  { key: 'union', label: 'Union' },
];

const SECTION_LABEL: Record<string, string> = { profile: 'Identita (RPO)', financials: 'Financie (RÚZ)', debts: 'Dlhy', vat: 'DPH' };

function creditorCell(c: CreditorDebt) {
  switch (c.status) {
    case 'debtor':
      return <span className="pill red">dlžník · {fmtEur(c.amount_eur)}{c.match_confidence === 'high' ? ' · zhoda podľa názvu a adresy' : ''}</span>;
    case 'not_found':
      return <span className="pill green">nie je v zozname</span>;
    case 'unverifiable':
      return <span className="pill orange" title={c.note}>nedá sa overiť</span>;
    default:
      return <span className="pill grey" title={c.note}>zdroj nedostupný</span>;
  }
}

export function CheckResult({ report, markdown }: { report: CheckReportJson; markdown: string }) {
  const [tab, setTab] = useState<'overview' | 'ai'>('overview');
  const v = VERDICT[report.verdict];
  const p = report.profile;
  const name = p?.name ?? report.debts?.name ?? report.vat?.name ?? 'Neznámy subjekt';

  return (
    <article className="card result">
      <header className={`verdict ${report.verdict}`}>
        <div>
          <div className="verdict-label"><span aria-hidden>{v.icon}</span> {v.label}</div>
          <h2>{name}</h2>
          <div className="muted">IČO {report.ico}{p?.legal_form ? ` · ${p.legal_form}` : ''}</div>
        </div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>Prehľad</button>
          <button role="tab" aria-selected={tab === 'ai'} onClick={() => setTab('ai')}>Ako to vidí AI</button>
        </div>
      </header>

      {tab === 'ai' ? (
        <div className="body">
          <p className="muted small">
            Presne tento text dostane Claude z nástroja <code>skfirma_check</code> cez MCP konektor (~{Math.ceil(markdown.length / 3)} tokenov).
          </p>
          <pre className="md">{markdown}</pre>
        </div>
      ) : (
        <div className="body">
          {report.flags.length > 0 ? (
            <section>
              <h3>Dôvody</h3>
              <ul className="flags">
                {report.flags.map((f) => (
                  <li key={f.code + f.detail}>
                    {f.detail} <span className="src">{f.source}{f.as_of ? `, k ${fmtDate(f.as_of)}` : ''}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="muted">{v.hint}</p>
          )}

          {(report.notes.length > 0 || report.failed_sections.length > 0) && (
            <div className="notice">
              {report.failed_sections.map((s) => <div key={s}>⚠ {SECTION_LABEL[s] ?? s}: zdroj momentálne nedostupný.</div>)}
              {report.notes.map((n) => <div key={n}>{n}</div>)}
            </div>
          )}

          {p && (
            <section>
              <h3>Identita</h3>
              <dl className="facts">
                <dt>Stav</dt>
                <dd>
                  {p.status_text ?? STATUS_LABEL[p.status] ?? p.status}
                  {p.status_since ? ` od ${fmtDate(p.status_since)}` : ''}
                  {p.terminated_on ? ` (zánik ${fmtDate(p.terminated_on)})` : ''}
                </dd>
                <dt>Sídlo</dt><dd>{p.address ?? '—'}</dd>
                <dt>Vznik</dt><dd>{fmtDate(p.established_on)}</dd>
                {p.main_activity && (<><dt>Činnosť</dt><dd>{p.main_activity.code} {p.main_activity.name}</dd></>)}
                {p.executives.length > 0 && (
                  <><dt>Štatutári</dt><dd>{p.executives.map((e) => `${e.name}${e.since ? ` (od ${e.since.slice(0, 4)})` : ''}`).join(', ')}</dd></>
                )}
                {p.shareholders.length > 0 && (<><dt>Spoločníci</dt><dd>{p.shareholders.map((s) => s.name).join(', ')}</dd></>)}
              </dl>
              <p className="src">RPO, ŠÚ SR{p.as_of ? `, k ${fmtDate(p.as_of)}` : ''}</p>
            </section>
          )}

          <section>
            <h3>Financie</h3>
            {report.financials.length > 0 ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>Rok</th><th>Tržby</th><th>Medziročne</th><th>Výsledok</th><th>Vlastné imanie</th><th>Zadlženosť</th></tr>
                  </thead>
                  <tbody>
                    {report.financials.map((y) => (
                      <tr key={y.period_label}>
                        <td>{y.period_label}</td>
                        <td>{fmtEur(y.revenue)}</td>
                        <td className={y.revenue_yoy != null && y.revenue_yoy < -0.3 ? 'neg' : ''}>{fmtPct(y.revenue_yoy, true)}</td>
                        <td className={y.profit != null && y.profit < 0 ? 'neg' : ''}>{fmtEur(y.profit)}</td>
                        <td className={y.negative_equity ? 'neg' : ''}>{fmtEur(y.equity)}</td>
                        <td className={y.liabilities_ratio != null && y.liabilities_ratio > 0.9 ? 'neg' : ''}>{fmtPct(y.liabilities_ratio)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">
                {report.financials_unavailable_reason ? FIN_UNAVAILABLE[report.financials_unavailable_reason] : 'Údaje nie sú k dispozícii.'}
              </p>
            )}
          </section>

          {report.debts && (
            <section>
              <h3>Dlhy {report.debts.total_known_debt_eur > 0 && <span className="pill red">spolu {fmtEur(report.debts.total_known_debt_eur)}</span>}</h3>
              <table className="kv">
                <tbody>
                  {CREDITORS.map(({ key, label }) => {
                    const c = report.debts!.creditors[key];
                    return (
                      <tr key={key}>
                        <th>{label}</th>
                        <td>{creditorCell(c)}</td>
                        <td className="src">{c.as_of ? `k ${fmtDate(c.as_of)}` : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {report.vat && (
            <section>
              <h3>DPH</h3>
              <p>
                {report.vat.is_payer
                  ? <>Platiteľ DPH ({report.vat.registration_kind}{report.vat.payer_since ? `, od ${fmtDate(report.vat.payer_since)}` : ''})</>
                  : report.vat.registered
                    ? <>Registrovaný pre DPH ({report.vat.registration_kind}), nie platiteľ</>
                    : <>Nie je registrovaný pre DPH</>}
                {report.vat.ic_dph && <>, IČ DPH <code>{report.vat.ic_dph}</code></>}
              </p>
              {report.vat.erased && <p className="neg">Vymazaný platiteľ (§52 ods. 8){report.vat.erased.erased_on ? `, ${fmtDate(report.vat.erased.erased_on)}` : ''}</p>}
              {report.vat.risky && <p className="neg">V zozname rizikových platiteľov (§52 ods. 6){report.vat.risky.published_on ? `, zverejnený ${fmtDate(report.vat.risky.published_on)}` : ''}</p>}
              <p className="src">FS OpenData{report.vat.as_of ? `, k ${fmtDate(report.vat.as_of)}` : ''}</p>
            </section>
          )}

          <p className="disclaimer">{report.disclaimer}</p>
        </div>
      )}
    </article>
  );
}
