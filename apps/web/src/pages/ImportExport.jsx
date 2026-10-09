import React, { useRef, useState } from 'react';
import { api, download } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { Badge, Segmented } from '../ui/kit.jsx';
import { Drawer, Notice } from '../ui/forms.jsx';
import { fmtDate, inr } from '../ui/format.js';

// Import invoices or bills from Excel or CSV, and export the register. The server reads and checks the file; nothing is saved until
// "Import" is pressed, and a document with an error is never saved. Shared by the Invoices and Purchases screens.

const MAX_BYTES = 5 * 1024 * 1024;
const iso = (d) => d.toISOString().slice(0, 10);
const u = (y, m, d) => iso(new Date(Date.UTC(y, m, d)));

/** Date ranges for the export: the Indian financial year starts in April. */
function ranges() {
  const n = new Date(), y = n.getUTCFullYear(), m = n.getUTCMonth(), s0 = m >= 3 ? y : y - 1;
  return {
    fy: { label: `This financial year (${s0}-${String(s0 + 1).slice(2)})`, from: u(s0, 3, 1), to: u(s0 + 1, 2, 31) },
    lastfy: { label: `Last financial year (${s0 - 1}-${String(s0).slice(2)})`, from: u(s0 - 1, 3, 1), to: u(s0, 2, 31) },
    month: { label: 'This month', from: u(y, m, 1), to: u(y, m + 1, 0) },
    last: { label: 'Last month', from: u(y, m - 1, 1), to: u(y, m, 0) },
    all: { label: 'Everything', from: '', to: '' },
    custom: { label: 'Choose dates…', from: '', to: '' },
  };
}

/** Send a file as it is (raw bytes) and read the JSON answer. */
async function upload(path, file) {
  const token = localStorage.getItem('ibmp_token');
  let r;
  try {
    r = await fetch('/v1' + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: file });
  } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 413) throw new Error('This file is too large. The limit is 5 MB: split it and import it in parts.');
  if (!r.ok) throw new Error(r.status >= 500 ? 'Something went wrong on our side. Try again in a moment.' : data.error || `Upload failed (${r.status})`);
  return data;
}

export default function ImportExport({ kind = 'sales', onClose, onImported }) {
  const sales = kind === 'sales';
  const type = sales ? 'sales' : 'purchases';
  const noun = sales ? 'invoice' : 'bill';
  const nouns = sales ? 'invoices' : 'bills';
  const [tab, setTab] = useState('import');
  const [stage, setStage] = useState('start');          // start | reading | preview | importing | done
  const [err, setErr] = useState('');
  const [pv, setPv] = useState(null);                   // the preview from the server
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(() => new Set());
  const [limit, setLimit] = useState(100);
  const [drag, setDrag] = useState(false);
  const input = useRef(null);
  const [busyDl, setBusyDl] = useState('');

  const close = () => { if (result?.created) onImported?.(); onClose(); };
  const pickFile = () => input.current?.click();

  async function read(file) {
    if (!file) return;
    setErr(''); setResult(null);
    if (/\.xls$/i.test(file.name)) return setErr('This is an old Excel (.xls) file. Open it in Excel, save it as .xlsx or .csv, and choose that.');
    if (!/\.(xlsx|csv)$/i.test(file.name)) return setErr('Choose an Excel (.xlsx) or CSV (.csv) file.');
    if (file.size > MAX_BYTES) return setErr('This file is larger than 5 MB. Split it and import it in parts.');
    setStage('reading');
    try {
      const p = await upload(`/import/preview?type=${type}`, file);
      setPv(p); setFilter('all'); setOpen(new Set()); setLimit(100); setStage('preview');
    } catch (e) { setErr(e.message); setStage('start'); }
  }

  async function commit() {
    setErr(''); setStage('importing');
    try {
      setResult(await api('POST', '/import/commit', { token: pv.token, skipErrors: true }));
      setStage('done');
    } catch (e) { setErr(e.message); setStage('preview'); }
  }

  async function get(path, name, key) {
    setErr(''); setBusyDl(key);
    try { await download(path, name); } catch (e) { setErr(e.message); } finally { setBusyDl(''); }
  }

  const startOver = () => { setStage('start'); setPv(null); setResult(null); setErr(''); };
  const S = pv?.summary;
  const importable = S ? S.ok + S.warnings : 0;
  const shown = pv ? pv.documents.filter((d) => filter === 'all' || (filter === 'error' ? d.status === 'error' : d.status !== 'ok')) : [];
  const toggle = (i) => setOpen((o) => { const n = new Set(o); n.has(i) ? n.delete(i) : n.add(i); return n; });

  return (
    <Drawer open wide title={`Import and export ${nouns}`} subtitle={sales ? 'Bring invoices in from Excel, or take your sales register out' : 'Bring vendor bills in from Excel, or take your purchase register out'} onClose={close}
      footer={tab === 'import' && stage === 'preview' ? (
        <>
          {S.errors > 0 && <button type="button" onClick={() => get(`/import/error-report?token=${pv.token}&format=csv`, `ibmp-${type}-import-errors.csv`, 'report')} disabled={busyDl === 'report'}><Icon name="download" size={14} /> Error report</button>}
          <button type="button" onClick={startOver}>Choose another file</button>
          <button type="button" className="primary" onClick={commit} disabled={!importable}>{importable ? `Import ${importable} ${importable === 1 ? noun : nouns}` : 'Nothing to import'}</button>
        </>
      ) : stage === 'done' ? (
        <><button type="button" onClick={startOver}>Import another file</button><button type="button" className="primary" onClick={close}>View {nouns}</button></>
      ) : <button type="button" onClick={close}>Close</button>}>
      <div className="ie">
        <Segmented label="Import or export" value={tab} onChange={(t) => { setTab(t); setErr(''); }} options={[['import', 'Import'], ['export', 'Export']]} />
        <Notice>{err}</Notice>

        {tab === 'import' && (stage === 'start' || stage === 'reading') && (
          <>
            <section className="ie-step">
              <h3><span className="ie-n">1</span> Get the template</h3>
              <p className="muted">One row for each item on a {noun}. Repeat the {noun} number, date and {sales ? 'customer' : 'vendor'} on every row of the same {noun}. Tax and totals are worked out for you.</p>
              <div className="ie-actions">
                <button type="button" onClick={() => get(`/import/template?type=${type}&format=xlsx`, `ibmp-${type}-import-template.xlsx`, 'tx')} disabled={!!busyDl}><Icon name="download" size={14} /> Excel template</button>
                <button type="button" onClick={() => get(`/import/template?type=${type}&format=csv`, `ibmp-${type}-import-template.csv`, 'tc')} disabled={!!busyDl}><Icon name="download" size={14} /> CSV template</button>
              </div>
              <p className="ie-hint">The Excel template has an Instructions sheet that explains every column. Columns marked * are required. A {sales ? 'customer' : 'vendor'} or item that is not in your books yet is added for you.</p>
            </section>
            <section className="ie-step">
              <h3><span className="ie-n">2</span> Choose your file</h3>
              <div className={`ie-drop${drag ? ' over' : ''}${stage === 'reading' ? ' busy' : ''}`} role="button" tabIndex={0} aria-label="Choose a file to import"
                onClick={pickFile} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pickFile())}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files[0]); }}>
                <Icon name="upload" size={26} />
                <strong>{stage === 'reading' ? 'Reading and checking your file…' : 'Choose a file, or drop it here'}</strong>
                <span>Excel (.xlsx) or CSV, up to 5 MB. Nothing is saved until you have seen the preview.</span>
                <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={(e) => { read(e.target.files[0]); e.target.value = ''; }} />
              </div>
            </section>
          </>
        )}

        {tab === 'import' && (stage === 'preview' || stage === 'importing') && pv && (
          <section>
            <p className="muted ie-file">{pv.fileName || 'Your file'} · {S.documents} {S.documents === 1 ? noun : nouns} found</p>
            <div className="ie-chips" aria-label="Summary">
              <Badge tone="ok">{S.ok} ready</Badge>
              {S.warnings > 0 && <Badge tone="warn">{S.warnings} with warnings</Badge>}
              {S.errors > 0 && <Badge tone="bad">{S.errors} with errors</Badge>}
              <Badge>{S.lines} lines</Badge>
              <Badge tone="info">Total {inr(S.total)}</Badge>
            </div>
            {S.errors > 0 && <Notice tone="warn">{S.errors} {S.errors === 1 ? noun : nouns} with errors will not be imported. Fix them in your file and upload it again, or import the rest now. The error report lists every problem with its row number.</Notice>}
            {S.warnings > 0 && S.errors === 0 && <Notice tone="info">Warnings do not stop an import. Open the details to see them, for example new {sales ? 'customers' : 'vendors'} or items that will be added.</Notice>}
            {pv.documents.length > 1 && (
              <div className="ie-filter" role="group" aria-label="Show">
                {[['all', `All (${S.documents})`], ['attention', `With messages (${S.warnings + S.errors})`], ['error', `Errors (${S.errors})`]].map(([v, l]) => (
                  <button key={v} type="button" className={`chip${filter === v ? ' on' : ''}`} aria-pressed={filter === v} onClick={() => { setFilter(v); setLimit(100); }}>{l}</button>))}
              </div>
            )}
            <div className="ie-scroll">
              <table className="ie-table">
                <thead><tr><th>{sales ? 'Invoice' : 'Bill'}</th><th>Date</th><th>{sales ? 'Customer' : 'Vendor'}</th><th className="num">Lines</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th><th>Status</th></tr></thead>
                <tbody>
                  {shown.slice(0, limit).map((d) => {
                    const i = pv.documents.indexOf(d), msgs = d.errors.length + d.warnings.length, isOpen = open.has(i);
                    return (
                      <React.Fragment key={i}>
                        <tr className={d.status === 'error' ? 'ie-bad' : undefined}>
                          <td><b>{d.no || '(no number)'}</b></td><td>{d.date ? fmtDate(d.date) : '—'}</td><td>{d.party || '—'}</td>
                          <td className="num">{d.lines}</td><td className="num">{inr(d.taxable)}</td><td className="num">{inr(d.gst)}</td><td className="num"><b>{inr(d.total)}</b></td>
                          <td>
                            {msgs === 0 ? <Badge tone="ok">Ready</Badge>
                              : <button type="button" className="ie-more" aria-expanded={isOpen} onClick={() => toggle(i)}>
                                <Badge tone={d.status === 'error' ? 'bad' : 'warn'}>{d.status === 'error' ? `${d.errors.length} ${d.errors.length === 1 ? 'error' : 'errors'}` : `${d.warnings.length} ${d.warnings.length === 1 ? 'warning' : 'warnings'}`}</Badge>
                                <span>{isOpen ? 'Hide' : 'Details'}</span></button>}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="ie-detail"><td colSpan={8}>
                            <ul>
                              {d.errors.map((m, k) => <li key={`e${k}`} className="e"><b>Error</b> {m}</li>)}
                              {d.warnings.map((m, k) => <li key={`w${k}`} className="w"><b>Warning</b> {m}</li>)}
                            </ul>
                            <small className="muted">File rows: {d.rows.join(', ')}</small>
                          </td></tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {!shown.length && <tr><td colSpan={8} className="table-empty">Nothing to show here.</td></tr>}
                </tbody>
              </table>
            </div>
            {shown.length > limit && <button type="button" className="ie-showmore" onClick={() => setLimit(limit + 200)}>Show more ({shown.length - limit} left)</button>}
            <p className="ie-hint">Each {noun} is saved with its journal entry, {sales ? 'and stock goes down' : 'and stock goes up'}, as if you had entered it by hand. {sales ? 'The invoice numbers from your file are used as they are.' : 'Each bill also gets the next BILL number, and keeps the vendor’s own number.'}</p>
            {stage === 'importing' && <Notice tone="info">Importing {importable} {importable === 1 ? noun : nouns}… this can take a moment.</Notice>}
          </section>
        )}

        {tab === 'import' && stage === 'done' && result && (
          <section className="ie-done">
            <Notice tone={result.created ? 'ok' : 'warn'}>
              {result.alreadyImported ? 'This file was already imported.' : `${result.created} ${result.created === 1 ? noun : nouns} imported.`}
              {result.createdParties > 0 && ` ${result.createdParties} new ${sales ? 'customer' : 'vendor'}${result.createdParties === 1 ? '' : 's'} added.`}
              {result.createdItems > 0 && ` ${result.createdItems} new item${result.createdItems === 1 ? '' : 's'} added.`}
            </Notice>
            {result.failed.length > 0 && <>
              <Notice>{result.failed.length} could not be saved:</Notice>
              <ul className="ie-list">{result.failed.map((f, i) => <li key={i}><b>{f.no}</b> {f.reason}</li>)}</ul></>}
            {result.skipped.length > 0 && <p className="muted">{result.skipped.length} with errors {result.skipped.length === 1 ? 'was' : 'were'} left out. Fix {result.skipped.length === 1 ? 'it' : 'them'} in your file and import again; the ones already saved will be reported as duplicates.</p>}
            {result.created > 0 && <p className="muted">New {sales ? 'customers' : 'vendors'} and items were created from your file. You can add their address, opening stock and other details from the Parties and Items screens.</p>}
          </section>
        )}

        {tab === 'export' && <ExportPane type={type} sales={sales} nouns={nouns} get={get} busyDl={busyDl} />}
      </div>
    </Drawer>
  );
}

function ExportPane({ type, sales, nouns, get, busyDl }) {
  const R = ranges();
  const [range, setRange] = useState('fy');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [layout, setLayout] = useState('register');
  const [format, setFormat] = useState('xlsx');
  const f = range === 'custom' ? from : R[range].from, t = range === 'custom' ? to : R[range].to;
  const bad = f && t && f > t;
  const qs = new URLSearchParams({ format, layout, ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) });
  const name = `ibmp-${type}-${layout === 'lines' ? 'lines' : 'register'}-${f || 'start'}-to-${t || 'today'}.${format}`;
  return (
    <section className="ie-export">
      <label className="field"><span className="field-label">Period</span>
        <select value={range} onChange={(e) => setRange(e.target.value)}>{Object.entries(R).map(([v, r]) => <option key={v} value={v}>{r.label}</option>)}</select>
      </label>
      {range === 'custom' && (
        <div className="ie-dates">
          <label className="field"><span className="field-label">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span className="field-label">To</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      {range !== 'custom' && f && <p className="ie-hint">{fmtDate(f)} to {fmtDate(t)}</p>}
      <div className="field"><span className="field-label">What to include</span>
        <Segmented label="Layout" value={layout} onChange={setLayout} options={[['register', `One row per ${sales ? 'invoice' : 'bill'}`], ['lines', 'One row per item']]} />
        <span className="field-hint">{layout === 'register'
          ? `A register with number, date, ${sales ? 'customer' : 'vendor'}, GSTIN, place of supply, taxable value, CGST, SGST, IGST, total, ${sales ? 'received' : 'paid'}, balance and status.`
          : `Every item line in the same columns as the import template, so the file can be imported into another set of books.`}</span>
      </div>
      <div className="field"><span className="field-label">File type</span>
        <Segmented label="File type" value={format} onChange={setFormat} options={[['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV']]} />
      </div>
      {bad && <Notice>The start date is after the end date.</Notice>}
      <div className="ie-actions"><button type="button" className="primary" disabled={!!bad || !!busyDl} onClick={() => get(`/export/${type}?${qs}`, name, 'exp')}><Icon name="download" size={15} /> {busyDl === 'exp' ? 'Preparing…' : `Download ${nouns}`}</button></div>
    </section>
  );
}
