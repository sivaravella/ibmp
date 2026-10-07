import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { COLORS, Legend, TrendChart } from '../ui/charts.jsx';
import { Badge, EmptyState, KpiCard, PageHeader, Panel, Segmented, Skeleton } from '../ui/kit.jsx';
import { Cell, Drawer, Field, Notice, Pager, Toolbar, useTable } from '../ui/forms.jsx';
import { fmtDate as fmt, inr, inrCompact, monthLabel, num as count } from '../ui/format.js';

const monthNow = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const STATUS = { draft: ['neutral', 'Draft'], finalized: ['warn', 'Finalized'], paid: ['ok', 'Paid'] };
const RunBadge = ({ s }) => <Badge tone={STATUS[s][0]}>{STATUS[s][1]}</Badge>;
const N = (v) => Number(v) || 0;
const statutory = (r) => N(r.pfEmployee) + N(r.pfEmployer) + N(r.edli) + N(r.pfAdmin) + N(r.esiEmployee) + N(r.esiEmployer);

export default function Payroll() {
  const [tab, setTab] = useState('runs');
  const [openRun, setOpenRun] = useState(null);
  return (
    <>
      {!openRun && (
        <PageHeader title="Payroll" subtitle="Salaries, PF, ESI and TDS: run the month, pay it, and see what is owed to the government">
          <Segmented label="Section" value={tab} onChange={(v) => { setTab(v); setOpenRun(null); }} options={[['runs', 'Payroll runs'], ['employees', 'Employees']]} />
        </PageHeader>
      )}
      {tab === 'employees' ? <Employees /> : openRun ? <Run id={openRun} onBack={() => setOpenRun(null)} /> : <Runs onOpen={setOpenRun} />}
    </>
  );
}

// ---------- runs ----------
function Runs({ onOpen }) {
  const [rows, setRows] = useState(null);
  const [emps, setEmps] = useState([]);
  const [month, setMonth] = useState(monthNow());
  const [err, setErr] = useState('');
  const load = () => api('GET', '/payroll/runs').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); api('GET', '/payroll/employees').then(setEmps).catch(() => {}); }, []);

  async function start(e) {
    e.preventDefault(); setErr('');
    try { const r = await api('POST', '/payroll/runs', { month }); onOpen(r.id); } catch (e2) { setErr(e2.message); }
  }
  const asc = useMemo(() => [...(rows ?? [])].sort((a, b) => a.month.localeCompare(b.month)).slice(-12), [rows]);
  if (!rows) return <Skeleton rows={5} height={44} />;

  const active = emps.filter((e) => !e.exitDate);
  const last = rows[0];
  const fy = (() => { const d = new Date(); const s = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return rows.filter((r) => r.month >= `${s}-04` && r.status !== 'draft'); })();
  const ytd = (f) => fy.reduce((s, r) => s + f(r), 0);
  const chart = asc.map((r) => ({ label: monthLabel(r.month), tipLabel: monthName(r.month), gross: N(r.gross), net: N(r.net), statutory: statutory(r) + N(r.tds) }));

  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Active employees" value={count(active.length)} icon="users" tone="brand" hint={`${emps.length - active.length} have left`} />
        <KpiCard label={last ? `${monthLabel(last.month, true)} net pay` : 'Latest run'} value={last ? inrCompact(last.net) : '—'} icon="wallet" tone="green" hint={last ? `${last.employees} employees · gross ${inrCompact(last.gross)}` : 'No run yet'} spark={asc.map((r) => N(r.net))} color="#059669" />
        <KpiCard label="Net pay this financial year" value={inrCompact(ytd((r) => N(r.net)))} icon="briefcase" tone="teal" hint={`${fy.length} run(s) · gross ${inrCompact(ytd((r) => N(r.gross)))}`} />
        <KpiCard label="PF, ESI and TDS this year" value={inrCompact(ytd((r) => statutory(r) + N(r.tds)))} icon="landmark" tone="amber" hint={`TDS ${inrCompact(ytd((r) => N(r.tds)))}`} />
      </div>

      {err && <Notice>{err}</Notice>}
      <div className="g12">
        <Panel className="s8" title="Payroll over time" hint="Gross pay, net pay and the statutory amounts, by month" action={<Legend inline items={[{ label: 'Gross', color: COLORS.brand }, { label: 'Net pay', color: COLORS.teal }, { label: 'PF, ESI, TDS', color: COLORS.amber }]} />}>
          <TrendChart data={chart} height={230} ariaLabel="Payroll by month" series={[{ key: 'gross', label: 'Gross', color: COLORS.brand, type: 'bar' }, { key: 'net', label: 'Net pay', color: COLORS.teal, type: 'bar' }, { key: 'statutory', label: 'PF, ESI and TDS', color: COLORS.amber, type: 'line' }]} />
        </Panel>
        <Panel className="s4" title="Start a payroll run" hint="One run per month">
          <form onSubmit={start} className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Month"><input type="month" value={month} max={monthNow()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
            <button className="primary">Start payroll for {monthName(month)}</button>
            <p className="muted" style={{ fontSize: 12.5 }}>Salaries come from each employee's structure and the attendance register. You can review and edit before finalizing.</p>
          </form>
        </Panel>
      </div>

      {rows.length === 0 ? (
        <div className="panel"><EmptyState icon="briefcase" title="No payroll runs yet" text="Add your employees, then start the first run." /></div>
      ) : (
        <table>
          <thead><tr><th>Month</th><th>Status</th><th className="num">Employees</th><th className="num">Gross</th><th className="num">Net pay</th><th className="num">TDS</th><th className="num">PF + ESI</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><b>{monthName(r.month)}</b></td><td><RunBadge s={r.status} /></td><td className="num">{r.employees}</td><td className="num">{inr(r.gross)}</td><td className="num"><b>{inr(r.net)}</b></td>
              <td className="num">{inr(r.tds)}</td><td className="num">{inr(statutory(r))}</td>
              <td className="actions"><button className="row-btn" onClick={() => onOpen(r.id)}>Open</button></td>
            </tr>))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Run({ id, onBack }) {
  const [run, setRun] = useState(null);
  const [slip, setSlip] = useState(null);
  const [mode, setMode] = useState('bank');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => api('GET', `/payroll/runs/${id}`).then(setRun).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!run) return err ? <Notice>{err}</Notice> : <Skeleton rows={6} height={40} />;
  const draft = run.status === 'draft';

  const act = async (fn) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr(e.message); } };
  const post = (path, body = {}) => act(() => api('POST', `/payroll/runs/${id}/${path}`, body));
  const edit = (s, field, value) => act(() => api('PUT', `/payroll/runs/${id}/payslips/${s.id}`, { [field]: Number(value) }));
  const warnings = run.slips.flatMap((s) => s.warnings.map((w) => `${s.empName}: ${w}`));
  const pfDue = N(run.pfEmployee) + N(run.pfEmployer) + N(run.edli) + N(run.pfAdmin);
  const employerCost = N(run.gross) + N(run.pfEmployer) + N(run.edli) + N(run.pfAdmin) + N(run.esiEmployer);
  const heads = [
    ['pf', 'PF (incl. EDLI and admin)', pfDue, run.remittedPf, run.dueDates.pf],
    ['esi', 'ESI', N(run.esiEmployee) + N(run.esiEmployer), run.remittedEsi, run.dueDates.esi],
    ['tds', 'TDS on salary', N(run.tds), run.remittedTds, run.dueDates.tds],
    ['pt', 'Professional tax', N(run.professionalTax), run.remittedPt, null],
  ];
  const owed = heads.filter(([, , amt, done]) => !done && amt > 0).reduce((s, [, , amt]) => s + amt, 0);

  return (
    <>
      <PageHeader title={monthName(run.month)} subtitle={run.status === 'paid' ? `Salaries paid ${fmt(run.paidOn)} by ${run.payMode}` : draft ? 'Draft: review and edit, then finalize' : 'Finalized: pay the salaries and the statutory dues'}>
        <button onClick={onBack}>‹ All runs</button><RunBadge s={run.status} />
        {draft && <>
          <button onClick={() => post('recalculate')}>Recalculate</button>
          <button onClick={() => act(async () => { const r = await api('POST', `/payroll/runs/${id}/sync-attendance`, {}); setNotice(r.changed ? `Loss of pay updated for ${r.changed} employee(s) from the attendance register.` : 'Loss of pay already matches the attendance register.'); })}>Sync attendance</button>
          <button className="primary" onClick={() => post('finalize')}>Finalize payroll</button>
          <button onClick={() => window.confirm('Delete this draft run?') && act(async () => { await api('DELETE', `/payroll/runs/${id}`); onBack(); })}>Delete draft</button>
        </>}
        {run.status === 'finalized' && <>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Pay through"><option value="bank">Bank</option><option value="cash">Cash</option></select>
          <button className="primary" onClick={() => post('pay', { mode })}>Pay salaries</button>
          {!run.remittedPf && !run.remittedEsi && !run.remittedTds && !run.remittedPt && <button onClick={() => post('reopen')}>Reopen</button>}
        </>}
      </PageHeader>

      <div className="kpi-grid">
        <KpiCard label="Gross pay" value={inrCompact(run.gross)} icon="briefcase" tone="brand" hint={`${run.slips.length} employees`} />
        <KpiCard label="Net pay to employees" value={inrCompact(run.net)} icon="wallet" tone="green" hint={`After PF, ESI, PT and TDS (${inrCompact(N(run.gross) - N(run.net))})`} />
        <KpiCard label="Employer contributions" value={inrCompact(employerCost - N(run.gross))} icon="landmark" tone="teal" hint="PF, EDLI, admin and ESI, on top of gross" />
        <KpiCard label="Total cost to company" value={inrCompact(employerCost)} icon="layers" tone="violet" hint={!draft && owed > 0 ? `${inrCompact(owed)} of statutory dues unpaid` : undefined} />
      </div>

      <Notice>{err}</Notice>
      {notice && <Notice tone="info">{notice}</Notice>}
      {!run.taxTable.verified && <Notice tone="warn">Tax slabs for FY {run.taxTable.fy} are carried over from the previous year. Confirm them against the current Finance Act before relying on the TDS figures.</Notice>}
      {warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}

      <table>
        <thead><tr><th>Employee</th><th className="num">Paid days</th><th className="num">LOP</th><th className="num">Other earn.</th><th className="num">Other ded.</th><th className="num">Gross</th><th className="num">PF</th><th className="num">ESI</th><th className="num">PT</th><th className="num">TDS</th><th className="num">Net pay</th><th /></tr></thead>
        <tbody>
          {run.slips.map((s) => (
            <tr key={s.id}>
              <td><Cell main={s.empName} sub={s.empCode} /></td>
              <td className="num">{N(s.paidDays)}/{s.daysInMonth}</td>
              <td className="num">{draft ? <Num value={s.lopDays} onSave={(v) => edit(s, 'lopDays', v)} /> : N(s.lopDays)}
                {s.register.marked > 0 && N(s.lopDays) !== s.register.lop && <div style={{ fontSize: 11, color: 'var(--amber)' }}>register: {s.register.lop}</div>}</td>
              <td className="num">{draft ? <Num value={s.otherEarnings} onSave={(v) => edit(s, 'otherEarnings', v)} /> : inr(s.otherEarnings)}</td>
              <td className="num">{draft ? <Num value={s.otherDeductions} onSave={(v) => edit(s, 'otherDeductions', v)} /> : inr(s.otherDeductions)}</td>
              <td className="num">{inr(s.gross)}</td><td className="num">{inr(s.pfEmployee)}</td><td className="num">{inr(s.esiEmployee)}</td><td className="num">{inr(s.professionalTax)}</td>
              <td className="num">{inr(s.tds)}</td><td className="num"><b>{inr(s.net)}</b></td>
              <td className="actions"><button className="row-btn" onClick={() => setSlip(s)}>Payslip</button></td>
            </tr>
          ))}
          <tr style={{ background: 'var(--surface-2)', fontWeight: 650 }}><td colSpan={5}>Total</td><td className="num">{inr(run.gross)}</td><td className="num">{inr(run.pfEmployee)}</td><td className="num">{inr(run.esiEmployee)}</td>
            <td className="num">{inr(run.professionalTax)}</td><td className="num">{inr(run.tds)}</td><td className="num">{inr(run.net)}</td><td /></tr>
        </tbody>
      </table>

      {!draft && (
        <Panel title="Statutory payments" hint="What the government is owed for this month" pad={false}>
          <table style={{ border: 0, boxShadow: 'none', borderRadius: 0, marginBottom: 0 }}>
            <thead><tr><th>Head</th><th className="num">Amount</th><th>Due by</th><th>Status</th><th /></tr></thead>
            <tbody>{heads.map(([k, label, amt, done, due]) => (
              <tr key={k}>
                <td>{label}</td><td className="num">{inr(amt)}</td><td>{due ? fmt(due) : 'State-specific'}</td>
                <td>{done ? <Badge tone="ok">Paid {fmt(done)}</Badge> : amt > 0 ? <Badge tone="warn">Pending</Badge> : <span className="dim">—</span>}</td>
                <td className="actions">{!done && amt > 0 && <button className="row-btn" onClick={() => post('remit', { head: k, mode })}>Mark paid ({mode})</button>}</td>
              </tr>))}
            </tbody>
          </table>
        </Panel>
      )}
      <Drawer open={!!slip} wide title={slip ? `Payslip: ${slip.empName}` : ''} subtitle={slip ? `${monthName(run.month)} · ${slip.empCode}` : ''} onClose={() => setSlip(null)}
        footer={<><span className="total">Net pay <b>{slip ? inr(slip.net) : ''}</b></span><button onClick={() => window.print()}><Icon name="file" size={14} /> Print</button><button className="primary" onClick={() => setSlip(null)}>Close</button></>}>
        {slip && <Payslip run={run} s={slip} />}
      </Drawer>
    </>
  );
}

// Number input that saves on blur (so typing "1" then "5" doesn't fire two requests).
function Num({ value, onSave }) {
  const [v, setV] = useState(String(Number(value)));
  useEffect(() => setV(String(Number(value))), [value]);
  return <input type="number" min="0" step="any" style={{ width: 90, textAlign: 'right' }} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => Number(v) !== Number(value) && onSave(v)} />;
}

function Payslip({ run, s }) {
  const earn = [['Basic', s.earnedBasic], ['HRA', s.earnedHra], ['Special allowance', s.earnedSpecial], ['Travel allowance', s.earnedTravel], ['Medical allowance', s.earnedMedical], ['Other earnings', s.otherEarnings]];
  const ded = [['Provident fund', s.pfEmployee], ['ESI', s.esiEmployee], ['Professional tax', s.professionalTax], ['TDS (income tax)', s.tds], ['Other deductions', s.otherDeductions]];
  return (
    <>
      <div><strong style={{ fontSize: 17 }}>{run.company.name}</strong><div className="muted">Payslip for {monthName(run.month)}</div></div>
      <p className="muted">
        {s.empName} ({s.empCode}){s.designation ? ` · ${s.designation}` : ''}{s.department ? ` · ${s.department}` : ''}<br />
        PAN {s.pan || '—'} · UAN {s.uan || '—'} · Bank a/c {s.bankAccount ? `xxxx${s.bankAccount.slice(-4)}` : '—'} · Paid days {N(s.paidDays)} of {s.daysInMonth}
      </p>
      <div className="g12" style={{ marginBottom: 0 }}>
        <div className="s6"><table><thead><tr><th>Earnings</th><th className="num">₹</th></tr></thead><tbody>
          {earn.filter(([, v]) => N(v)).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{inr(v)}</td></tr>)}
          <tr><td><b>Gross earnings</b></td><td className="num"><b>{inr(s.gross)}</b></td></tr></tbody></table></div>
        <div className="s6"><table><thead><tr><th>Deductions</th><th className="num">₹</th></tr></thead><tbody>
          {ded.filter(([, v]) => N(v)).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{inr(v)}</td></tr>)}
          <tr><td><b>Total deductions</b></td><td className="num"><b>{inr(N(s.gross) - N(s.net))}</b></td></tr></tbody></table></div>
      </div>
      <div className="totals"><div className="grand"><span>Net pay</span><span>{inr(s.net)}</span></div></div>
      <p className="muted" style={{ fontSize: 12 }}>
        Employer contributions (not deducted from pay): PF {inr(N(s.pfEps) + N(s.pfEpf))}{N(s.esiEmployer) ? `, ESI ${inr(s.esiEmployer)}` : ''}. This is a computer-generated payslip.
      </p>
    </>
  );
}

// ---------- employees ----------
const BLANK = { name: '', code: '', designation: '', department: '', doj: today(), exitDate: '', pan: '', uan: '', esiNo: '', bankAccount: '', ifsc: '', mobile: '', email: '',
  basic: '', hra: '', special: '', travel: '', medical: '', pfApplicable: true, pfOnActual: false, esiApplicable: true, ptMonthly: '', taxRegime: 'new', declaredDeductions: '' };
const text = (v) => (v === '' ? null : v);
const num = (v) => Number(v || 0);

function toPayload(f, withCode) {
  const p = {
    name: f.name, designation: text(f.designation), department: text(f.department), doj: f.doj, exitDate: text(f.exitDate),
    pan: text(f.pan.toUpperCase()), uan: text(f.uan), esiNo: text(f.esiNo), bankAccount: text(f.bankAccount), ifsc: text(f.ifsc.toUpperCase()),
    mobile: text(f.mobile), email: text(f.email),
    basic: num(f.basic), hra: num(f.hra), special: num(f.special), travel: num(f.travel), medical: num(f.medical),
    pfApplicable: f.pfApplicable, pfOnActual: f.pfOnActual, esiApplicable: f.esiApplicable, ptMonthly: num(f.ptMonthly),
    taxRegime: f.taxRegime, declaredDeductions: num(f.declaredDeductions),
  };
  if (withCode && f.code) p.code = f.code;
  return p;
}
const fromEmployee = (e) => ({
  name: e.name, code: e.code, designation: e.designation ?? '', department: e.department ?? '', doj: e.doj, exitDate: e.exitDate ?? '', pan: e.pan ?? '', uan: e.uan ?? '',
  esiNo: e.esiNo ?? '', bankAccount: e.bankAccount ?? '', ifsc: e.ifsc ?? '', mobile: e.mobile ?? '', email: e.email ?? '',
  basic: String(Number(e.basic)), hra: String(Number(e.hra)), special: String(Number(e.special)), travel: String(Number(e.travel)), medical: String(Number(e.medical)),
  pfApplicable: e.pfApplicable, pfOnActual: e.pfOnActual, esiApplicable: e.esiApplicable, ptMonthly: String(Number(e.ptMonthly)),
  taxRegime: e.taxRegime, declaredDeductions: String(Number(e.declaredDeductions)),
});
const gross = (e) => ['basic', 'hra', 'special', 'travel', 'medical'].reduce((s, k) => s + Number(e[k]), 0);

function Employees() {
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState(null);       // null = closed
  const [editId, setEditId] = useState(null);
  const [flash, setFlash] = useState('');
  const load = () => api('GET', '/payroll/employees').then(setRows);
  useEffect(() => { load(); }, []);

  const table = useTable(rows ?? [], { filter: (e) => (e.exitDate ? 'left' : 'active'), match: (e, q) => [e.name, e.code, e.designation, e.department].some((x) => String(x ?? '').toLowerCase().includes(q)) });
  if (!rows) return <Skeleton rows={5} height={44} />;
  const active = rows.filter((e) => !e.exitDate);
  const payroll = active.reduce((s, e) => s + gross(e), 0);
  const open = (f, id) => { setFlash(''); setForm(f); setEditId(id); };

  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Active employees" value={count(active.length)} icon="users" tone="brand" hint={`${rows.length - active.length} have left`} />
        <KpiCard label="Monthly gross payroll" value={inrCompact(payroll)} icon="wallet" tone="green" hint="Active employees, before deductions" />
        <KpiCard label="Average monthly gross" value={inrCompact(active.length ? payroll / active.length : 0)} icon="chart" tone="teal" />
        <KpiCard label="Covered by PF / ESI" value={`${active.filter((e) => e.pfApplicable).length} / ${active.filter((e) => e.esiApplicable && gross(e) <= 21000).length}`} icon="landmark" tone="amber" hint="ESI applies up to ₹21,000 a month" />
      </div>
      {flash && <Notice tone="ok">{flash}</Notice>}
      <Toolbar search={table.q} onSearch={table.setQ} placeholder="Search name, code, department" active={table.active} onFilter={table.setActive}
        filters={[{ value: 'all', label: 'All', count: rows.length }, { value: 'active', label: 'Active', count: active.length }, { value: 'left', label: 'Left', count: rows.length - active.length }]}>
        <button className="primary" onClick={() => open({ ...BLANK }, null)}><Icon name="plus" size={15} /> Add employee</button>
      </Toolbar>
      {rows.length === 0 ? (
        <div className="panel"><EmptyState icon="users" title="No employees yet" text="Add your first employee with a salary structure, then start a payroll run."><button className="primary" onClick={() => open({ ...BLANK }, null)}>Add an employee</button></EmptyState></div>
      ) : (
        <>
          <table>
            <thead><tr><th>Employee</th><th>Joined</th><th className="num">Monthly gross</th><th>PF</th><th>ESI</th><th>Tax regime</th><th>Status</th><th /></tr></thead>
            <tbody>
              {table.visible.map((e) => (
                <tr key={e.id}>
                  <td><Cell main={e.name} sub={`${e.code}${e.designation ? ` · ${e.designation}` : ''}`} /></td>
                  <td>{fmt(e.doj)}</td><td className="num">{inr(gross(e))}</td>
                  <td>{e.pfApplicable ? <Badge tone="info">{e.pfOnActual ? 'Actual' : 'Capped'}</Badge> : <span className="dim">—</span>}</td>
                  <td>{e.esiApplicable && gross(e) <= 21000 ? <Badge tone="info">Yes</Badge> : <span className="dim">—</span>}</td>
                  <td>{e.taxRegime === 'old' ? 'Old' : 'New'}</td>
                  <td>{e.exitDate ? <Badge tone="neutral">Left {fmt(e.exitDate)}</Badge> : <Badge tone="ok">Active</Badge>}</td>
                  <td className="actions"><button className="row-btn" onClick={() => open(fromEmployee(e), e.id)}>Edit</button></td>
                </tr>))}
              {!table.visible.length && <tr><td colSpan={8} className="table-empty">Nothing matches your search or filter.</td></tr>}
            </tbody>
          </table>
          <Pager page={table.page} pages={table.pages} total={table.total} size={table.size} onPage={table.setPage} />
        </>
      )}
      {form && <EmployeeForm form={form} setForm={setForm} editId={editId} onClose={() => { setForm(null); setEditId(null); }} onSaved={(msg) => { setForm(null); setEditId(null); setFlash(msg); load(); }} />}
    </>
  );
}

function EmployeeForm({ form, setForm, editId, onClose, onSaved }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      if (editId) await api('PUT', `/payroll/employees/${editId}`, toPayload(form, false));
      else await api('POST', '/payroll/employees', toPayload(form, true));
      onSaved(`${form.name} ${editId ? 'updated' : 'added'}.`);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }
  const total = ['basic', 'hra', 'special', 'travel', 'medical'].reduce((s, k) => s + num(form[k]), 0);
  return (
    <Drawer open wide title={editId ? `Edit ${form.name}` : 'Add an employee'} subtitle={editId ? form.code : 'Details, salary structure and statutory settings'} onClose={onClose}
      footer={<><span className="total">Monthly gross <b>{inr(total)}</b></span><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="emp-form" disabled={busy}>{busy ? 'Saving…' : editId ? 'Save changes' : 'Add employee'}</button></>}>
      <form id="emp-form" onSubmit={save} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        <div className="form-section">Person</div>
        <div className="form-grid">
          <Field label="Full name"><input value={form.name} onChange={set('name')} required /></Field>
          {!editId && <Field label="Code" hint="Generated if left empty"><input value={form.code} onChange={set('code')} /></Field>}
          <Field label="Designation"><input value={form.designation} onChange={set('designation')} /></Field>
          <Field label="Department"><input value={form.department} onChange={set('department')} /></Field>
          <Field label="Date of joining"><input type="date" value={form.doj} onChange={set('doj')} required /></Field>
          <Field label="Left on" hint="Only if they have left"><input type="date" value={form.exitDate} onChange={set('exitDate')} /></Field>
          <Field label="Mobile"><input value={form.mobile} onChange={set('mobile')} /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={set('email')} /></Field>
        </div>
        <div className="form-section">Identity and bank</div>
        <div className="form-grid">
          <Field label="PAN"><input maxLength={10} value={form.pan} onChange={set('pan')} style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="UAN (PF)"><input value={form.uan} onChange={set('uan')} /></Field>
          <Field label="ESI number"><input value={form.esiNo} onChange={set('esiNo')} /></Field>
          <Field label="Bank account"><input value={form.bankAccount} onChange={set('bankAccount')} /></Field>
          <Field label="IFSC"><input maxLength={11} value={form.ifsc} onChange={set('ifsc')} style={{ textTransform: 'uppercase' }} /></Field>
        </div>
        <div className="form-section">Monthly salary structure (₹)</div>
        <div className="form-grid">
          {[['basic', 'Basic'], ['hra', 'HRA'], ['special', 'Special allowance'], ['travel', 'Travel allowance'], ['medical', 'Medical allowance']].map(([k, l]) => (
            <Field key={k} label={l}><input type="number" min="0" step="any" value={form[k]} onChange={set(k)} required={k === 'basic'} /></Field>))}
        </div>
        <div className="form-section">Statutory</div>
        <div className="form-grid">
          <label className="field"><span className="field-label"><input type="checkbox" checked={form.pfApplicable} onChange={set('pfApplicable')} /> Provident fund applies</span></label>
          <label className="field" title="Contribute on actual basic instead of the ₹15,000 ceiling"><span className="field-label"><input type="checkbox" checked={form.pfOnActual} onChange={set('pfOnActual')} disabled={!form.pfApplicable} /> PF on actual wages</span></label>
          <label className="field" title="Applies only while monthly gross is ₹21,000 or less"><span className="field-label"><input type="checkbox" checked={form.esiApplicable} onChange={set('esiApplicable')} /> ESI applies</span></label>
          <Field label="Professional tax per month"><input type="number" min="0" value={form.ptMonthly} onChange={set('ptMonthly')} /></Field>
          <Field label="Income tax regime"><select value={form.taxRegime} onChange={set('taxRegime')}><option value="new">New regime</option><option value="old">Old regime</option></select></Field>
          {form.taxRegime === 'old' && <Field label="Declared deductions per year" hint="Including PF"><input type="number" min="0" value={form.declaredDeductions} onChange={set('declaredDeductions')} /></Field>}
        </div>
      </form>
    </Drawer>
  );
}
