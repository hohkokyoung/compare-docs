'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ComparisonReport, Extracted, FieldResult, Verdict } from '../lib/types';

const VERDICT_LABEL: Record<Verdict, string> = {
  match: 'Match',
  equivalent: 'Same value',
  mismatch: 'Mismatch',
  missing_on_b: 'Missing on B',
  missing_on_a: 'Missing on A',
  not_specified: 'Not stated on A',
  absent_both: 'Not stated',
};

/** Verdicts a documentation clerk has to act on. */
const ACTIONABLE: Verdict[] = ['mismatch', 'missing_on_b', 'missing_on_a'];

const ACCEPT = '.docx,.pdf,.xlsx,.xlsm,.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,.heic';
const ICON: Record<string, string> = {
  pdf: 'PDF', docx: 'DOC', xlsx: 'XLS', xlsm: 'XLS',
  jpg: 'IMG', jpeg: 'IMG', png: 'IMG', webp: 'IMG', bmp: 'IMG', tif: 'IMG', tiff: 'IMG', heic: 'IMG',
};

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function Drop({
  role, files, onAdd, onRemove,
}: {
  role: string;
  files: File[];
  onAdd: (f: File[]) => void;
  onRemove: (index: number) => void;
}) {
  const [over, setOver] = useState(false);

  return (
    <div className={`drop${over ? ' over' : ''}${files.length ? ' filled' : ''}`}>
      <label
        className="dropzone"
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onAdd([...e.dataTransfer.files]);
        }}
      >
        <div className="role">{role}</div>
        <div className="hint">
          Drop Word, PDF, Excel or a photo here — as many as belong on this side
        </div>
        <input
          type="file"
          accept={ACCEPT}
          multiple
          onChange={(e) => { onAdd([...(e.target.files ?? [])]); e.target.value = ''; }}
        />
      </label>
      {files.length > 0 && (
        <ul className="filelist">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="ext">{ICON[extOf(f.name)] ?? extOf(f.name).toUpperCase()}</span>
              <span className="fname">{f.name}</span>
              <button type="button" className="remove" onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Value({ field }: { field: Extracted | null | undefined }) {
  if (!field) return <td className="val empty">— not stated —</td>;
  return (
    <td className="val">
      {field.raw}
      {field.file && <span className="src-file">{field.file}</span>}
      {field.source === 'llm' && <span className="tag llm" title={field.where}>read by model</span>}
      {field.source === 'ocr' && <span className="tag ocr" title={field.where}>read from image</span>}
    </td>
  );
}

function AssistNote({ report }: { report: ComparisonReport }) {
  const { assist } = report;
  if (!assist.used) {
    return (
      <p className="note assist-note">
        <strong>Nothing left this machine.</strong> {assist.reasons.join(' ')}
      </p>
    );
  }
  return (
    <div className="finding warn">
      <h3>A language model was consulted</h3>
      <p>
        {assist.docs.join(', ')} {assist.docs.length > 1 ? 'were' : 'was'} sent to{' '}
        <code>{assist.provider}</code> because the rules could not read{' '}
        {assist.docs.length > 1 ? 'them' : 'it'} fully.
      </p>
      <p className="note">{assist.reasons.join(' ')}</p>
      {assist.filled.length > 0 && (
        <p className="note">
          Values supplied by the model, marked <span className="tag llm">read by model</span> below:{' '}
          {assist.filled.map((f) => `${f.file} → ${f.key}`).join(', ')}. Check these against the document.
        </p>
      )}
    </div>
  );
}

function Findings({ report }: { report: ComparisonReport }) {
  const problems = report.fields.filter((f) => ACTIONABLE.includes(f.verdict));
  const violations = report.directives.filter((d) => d.verdict !== 'ok');
  const conflicts = [...report.sideA.conflicts.map((c) => ({ side: report.sideA.label, c })),
                     ...report.sideB.conflicts.map((c) => ({ side: report.sideB.label, c }))];
  const total = problems.length + violations.length + report.internal.length + conflicts.length;

  if (total === 0) {
    return (
      <div className="verdict-banner clean">
        No inconsistencies found. Every value {report.sideA.label} specifies is reflected on{' '}
        {report.sideB.label}, and all documents agree once formatting differences are set aside.
      </div>
    );
  }

  return (
    <>
      <div className="verdict-banner dirty">
        {total} item{total === 1 ? '' : 's'} need checking before the B/L is released.
      </div>

      {conflicts.map(({ side, c }, i) => (
        <div key={`c${i}`} className="finding">
          <h3>{c.label} — documents on {side} disagree with each other</h3>
          <dl className="pair">
            {c.values.map((v, j) => (
              <div key={j} className="pairrow">
                <dt>{v.file}</dt><dd>{v.raw}</dd>
              </div>
            ))}
          </dl>
          <p className="note">Resolve this before comparing sides — the value used below is the first one.</p>
        </div>
      ))}

      {problems.map((f) => (
        <div key={f.key} className={`finding${f.verdict === 'missing_on_a' ? ' warn' : ''}`}>
          <h3>{f.label} — {VERDICT_LABEL[f.verdict]}</h3>
          <dl className="pair">
            <div className="pairrow"><dt>{report.sideA.label}</dt><dd>{f.a?.raw ?? '— not stated —'}</dd></div>
            <div className="pairrow"><dt>{report.sideB.label}</dt><dd>{f.b?.raw ?? '— not stated —'}</dd></div>
          </dl>
          {f.note && <p className="note">{f.note}</p>}
        </div>
      ))}

      {violations.map((d) => (
        <div key={d.directive.id + (d.directive.file ?? '')} className={`finding${d.verdict === 'unchecked' ? ' warn' : ''}`}>
          <h3>Instruction {d.verdict === 'violated' ? 'not followed' : 'not understood'}</h3>
          <p><strong>{d.directive.raw}</strong> — {d.directive.meaning}</p>
          <p className="note">{d.detail}</p>
        </div>
      ))}

      {report.internal.map((issue, i) => (
        <div key={`i${i}`} className="finding">
          <h3>{issue.label} — {issue.file} disagrees with itself</h3>
          <p className="note">{issue.detail}</p>
        </div>
      ))}
    </>
  );
}

function FieldTable({ report }: { report: ComparisonReport }) {
  const [showAll, setShowAll] = useState(false);
  const rows: FieldResult[] = showAll
    ? report.fields
    : report.fields.filter((f) => f.verdict !== 'absent_both');

  return (
    <>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>All fields</h2>
        <label className="toggle">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Include fields no document states
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>{report.sideA.label}</th>
            <th>{report.sideB.label}</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.key}>
              <td className="label">{f.label}</td>
              <Value field={f.a} />
              <Value field={f.b} />
              <td>
                <span className={`tag ${f.verdict}`}>{VERDICT_LABEL[f.verdict]}</span>
                {f.note && <div className="note">{f.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default function Page() {
  const [a, setA] = useState<File[]>([]);
  const [b, setB] = useState<File[]>([]);
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const LABEL_A = 'Instructions';
  const LABEL_B = 'Draft B/L';

  const compare = useCallback(async () => {
    if (!a.length || !b.length) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const body = new FormData();
      for (const f of a) body.append('a', f);
      for (const f of b) body.append('b', f);
      body.append('labelA', LABEL_A);
      body.append('labelB', LABEL_B);
      const res = await fetch('/api/compare', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Comparison failed.');
      else setReport(data as ComparisonReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comparison failed.');
    } finally {
      setBusy(false);
    }
  }, [a, b]);

  const warnings = useMemo(
    () => (report ? [...report.sideA.warnings, ...report.sideB.warnings] : []),
    [report],
  );

  return (
    <div className="wrap">
      <header className="top">
        <h1>SI / B-L Checker</h1>
        <p>
          Put the instructions on one side and the draft bill of lading on the other — any number of
          Word, PDF, Excel files or photographs on each. Every field is compared after normalising the things that
          differ harmlessly — trailing zeros, <code>CTNS</code> vs <code>CARTONS</code>,{' '}
          <code>NORTH PORT</code> vs <code>PORT KELANG(N)</code> — so what is left is a real
          discrepancy. Documents are read on this machine; a model is consulted only when the rules
          cannot read one, and each result says whether that happened.
        </p>
      </header>

      <section className="panel no-print">
        <h2>Documents</h2>
        <div className="drops">
          <Drop
            role={LABEL_A}
            files={a}
            onAdd={(f) => setA((prev) => [...prev, ...f])}
            onRemove={(i) => setA((prev) => prev.filter((_, j) => j !== i))}
          />
          <Drop
            role={LABEL_B}
            files={b}
            onAdd={(f) => setB((prev) => [...prev, ...f])}
            onRemove={(i) => setB((prev) => prev.filter((_, j) => j !== i))}
          />
        </div>
        <div className="actions">
          <button onClick={compare} disabled={!a.length || !b.length || busy}>
            {busy ? 'Comparing…' : 'Compare'}
          </button>
          {(a.length || b.length || report) && (
            <button
              className="ghost"
              onClick={() => { setA([]); setB([]); setReport(null); setError(null); }}
              disabled={busy}
            >
              Clear
            </button>
          )}
          {report && <button className="ghost" onClick={() => window.print()}>Print / save as PDF</button>}
        </div>
        {error && <div className="error">{error}</div>}
      </section>

      {report && (
        <>
          <section className="panel">
            <h2>Result</h2>
            <Findings report={report} />
            <AssistNote report={report} />
            <div className="scores" style={{ marginTop: 16 }}>
              <div className={`score ${report.summary.mismatches ? 'alert' : 'good'}`}>
                <div className="n">{report.summary.mismatches}</div><div className="k">mismatched</div>
              </div>
              <div className={`score ${report.summary.missing ? 'alert' : 'good'}`}>
                <div className="n">{report.summary.missing}</div><div className="k">missing</div>
              </div>
              <div className={`score ${report.summary.violations ? 'alert' : 'good'}`}>
                <div className="n">{report.summary.violations}</div><div className="k">conflicts &amp; breaches</div>
              </div>
              <div className="score warn">
                <div className="n">{report.summary.equivalent}</div>
                <div className="k">same value, written differently</div>
              </div>
              <div className="score good">
                <div className="n">{report.summary.matches}</div><div className="k">identical</div>
              </div>
            </div>
          </section>

          {report.directives.length > 0 && (
            <section className="panel">
              <h2>Instructions found in the documents</h2>
              <table>
                <thead><tr><th>Instruction</th><th>Means</th><th>On the other side</th></tr></thead>
                <tbody>
                  {report.directives.map((d, i) => (
                    <tr key={i}>
                      <td className="val">
                        {d.directive.raw}
                        {d.directive.file && <span className="src-file">{d.directive.file}</span>}
                      </td>
                      <td>{d.directive.meaning}</td>
                      <td>
                        <span className={`tag ${d.verdict}`}>
                          {d.verdict === 'ok' ? 'Followed' : d.verdict === 'violated' ? 'Not followed' : 'Check by hand'}
                        </span>
                        <div className="note">{d.detail}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="panel"><FieldTable report={report} /></section>

          {report.discovered.length > 0 && (
            <section className="panel">
              <div className="toolbar">
                <h2 style={{ margin: 0 }}>Additional fields found</h2>
                <span className="note" style={{ margin: 0 }}>
                  Not part of the checked set — matched by label only, so verify anything that matters.
                </span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>{report.sideA.label}</th>
                    <th>{report.sideB.label}</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {report.discovered.map((d, i) => (
                    <tr key={i}>
                      <td className="label">{d.label}</td>
                      <td className="val">{d.a?.value ?? <span className="empty">— not stated —</span>}</td>
                      <td className="val">{d.b?.value ?? <span className="empty">— not stated —</span>}</td>
                      <td>
                        <span className={`tag discovered ${d.verdict}`}>
                          {d.verdict === 'match' ? 'Same' : d.verdict === 'mismatch' ? 'Differs'
                            : d.verdict === 'a_only' ? `Only on ${report.sideA.label}` : `Only on ${report.sideB.label}`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {warnings.length > 0 && (
            <section className="panel">
              <h2>Extraction warnings</h2>
              <ul className="warnings">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </section>
          )}

          <section className="panel no-print">
            <h2>What was read from each file</h2>
            {[report.sideA, report.sideB].map((side) =>
              side.docs.map((doc) => (
                <details className="src" key={side.label + doc.fileName}>
                  <summary>{side.label} — {doc.fileName} <span className="ext">{doc.format.toUpperCase()}</span></summary>
                  <pre>{doc.text}</pre>
                </details>
              )),
            )}
          </section>
        </>
      )}

      <footer className="foot">
        Checks are rule-based. They catch what they are told to look for — read the B/L before you release it.
      </footer>
    </div>
  );
}
