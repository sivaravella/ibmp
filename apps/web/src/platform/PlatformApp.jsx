import React, { useEffect, useState } from 'react';
import { hasPlatformToken, issueText, papi, setPlatformToken } from './platformApi.js';
import { Icon } from '../ui/icons.jsx';
import { COLORS, Donut, HBars, Legend, StackBar, TrendChart } from '../ui/charts.jsx';
import { Badge, DashboardSkeleton, ErrorBoundary, KpiCard, PageHeader, Panel } from '../ui/kit.jsx';
import { fmtDate as fmt, inr, inrCompact, initials, monthLabel, num } from '../ui/format.js';

const STATUS_COLOR = { active: '#15803d', trialing: '#1d4ed8', grace: '#92400e', expired: '#b91c1c', none: '#64748b' };

const NAV = [
  ['overview', 'Overview', 'dashboard'], ['consultants', 'Consultants', 'userCheck'], ['companies', 'Companies', 'building'],
  ['billing', 'Billing', 'card'], ['audit', 'Audit log', 'shield'], ['staff', 'Staff & account', 'users'],
];

export default function PlatformApp() {
  const [authed, setAuthed] = useState(hasPlatformToken());
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('overview');
  const [focus, setFocus] = useState(null);                 // company id to open in Companies
  const [menu, setMenu] = useState(false);
  useEffect(() => { if (authed) papi('GET', '/me').then(setMe).catch(() => {}); }, [authed]);
  useEffect(() => { document.title = `${(NAV.find(([id]) => id === tab) ?? [])[1] ?? 'Console'} · IBMP Platform`; }, [tab]);
  if (!authed) return <SignIn onDone={() => setAuthed(true)} />;
  const open = (id) => { setFocus(id); setTab('companies'); };
  const goTab = (id) => { setTab(id); setFocus(null); setMenu(false); window.scrollTo(0, 0); };

  return (
    <div className="shell platform">
      <div className={`scrim${menu ? ' open' : ''}`} onClick={() => setMenu(false)} />
      <aside className={menu ? 'open' : ''} aria-label="Console navigation">
        <div className="brand"><div className="brand-mark">I</div><div><strong>IBMP Platform</strong><span>Owner console</span></div></div>
        <nav>
          <div className="nav-label">Console</div>
          {NAV.map(([id, label, icon]) => <button key={id} className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => goTab(id)}><Icon name={icon} />{label}</button>)}
        </nav>
        <div className="who">
          {me && <><strong>{me.name}</strong><span>{me.email}</span><span className="plan-chip">{me.role === 'owner' ? 'Owner' : 'Read-only'}</span></>}
          <button onClick={() => { setPlatformToken(null); setAuthed(false); }}><Icon name="logout" size={15} />Sign out</button>
        </div>
      </aside>
      <div className="main-col">
        <div className="topbar">
          <button className="menu-btn" onClick={() => setMenu(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <div className="crumb"><span>Platform / </span>{(NAV.find(([id]) => id === tab) ?? [])[1]}</div>
          <div className="spacer" />
          {me?.role === 'support' && <span className="pill info">Read-only account</span>}
          {me && <div className="avatar" title={me.email}>{initials(me.name)}</div>}
        </div>
        <main>
          <ErrorBoundary resetKey={tab}>
            {tab === 'overview' && <Overview go={goTab} />}
            {tab === 'consultants' && <Consultants canEdit={me?.role === 'owner'} open={open} />}
            {tab === 'companies' && <Companies canEdit={me?.role === 'owner'} focus={focus} />}
            {tab === 'billing' && <Billing open={open} />}
            {tab === 'audit' && <Audit />}
            {tab === 'staff' && <Staff me={me} />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function SignIn({ onDone }) {
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await papi('POST', '/login', f); setPlatformToken(r.token); onDone(); } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <div className="auth-page platform">
      <section className="auth-hero">
        <div className="brand"><div className="brand-mark">I</div><div><strong>IBMP Platform</strong><span>Owner console</span></div></div>
        <div>
          <h1>Run the platform with confidence.</h1>
          <p>Accounts, subscriptions, consultant verification and an audit trail of every change.</p>
          <ul className="auth-points">
            {[['shield', 'Everything is audited', 'Each action needs a reason and is recorded with who did it.'], ['users', 'Your customers stay private', 'You see counts and plans, never their books, and nobody can sign in as a customer.']].map(([icon, t, x]) => <li key={t}><span className="ico"><Icon name={icon} size={18} /></span><div><b>{t}</b><span>{x}</span></div></li>)}
          </ul>
        </div>
        <small>For the people who run IBMP, not for customers.</small>
      </section>
      <div className="auth-side">
        <form className="auth" onSubmit={submit}>
          <h2>Console sign-in</h2>
          <p className="lead">Use your platform account.</p>
          <input type="email" placeholder="Email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <input type="password" placeholder="Password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</button>
          <p className="auth-switch"><a href="/">Go to the business portal</a></p>
        </form>
      </div>
    </div>
  );
}

const Tile = ({ label, value, sub, onClick }) => <div className="card tile" style={onClick ? { cursor: 'pointer' } : {}} onClick={onClick}><span className="muted">{label}</span><strong>{value}</strong>{sub && <span className="muted">{sub}</span>}</div>;
const Chip = ({ text, color }) => <span style={{ background: `${color}22`, color, padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{text}</span>;

function useLoad(path, deps = []) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => papi('GET', path).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); }, deps);
  return [d, load, err];
}

function Overview({ go }) {
  const [o, , err] = useLoad('/overview');
  if (err) return <p className="err">{err}</p>;
  if (!o) return <DashboardSkeleton />;
  const st = o.subscriptions.byStatus;
  const tr = o.trends.months.map((m, i) => ({ label: monthLabel(m), tipLabel: monthLabel(m, true), signups: o.trends.signups[i], revenue: o.trends.revenue[i] }));
  const last = o.trends.signups.length - 1;
  const change = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
  const subSeg = [['trialing', 'On trial', COLORS.sky], ['active', 'Paying', COLORS.green], ['grace', 'Grace period', COLORS.amber], ['expired', 'Expired', COLORS.rose]].map(([k, label, color]) => ({ label, color, value: st[k] ?? 0 }));
  const subTotal = subSeg.reduce((a, x) => a + x.value, 0);
  const paying = Object.entries(o.subscriptions.activeByPlan);
  const cons = o.consultants, consTotal = cons.pending + cons.verified + cons.rejected;
  const consSeg = [{ label: 'Pending', value: cons.pending, color: COLORS.amber }, { label: 'Verified', value: cons.verified, color: COLORS.green }, { label: 'Rejected', value: cons.rejected, color: COLORS.rose }];
  const needs = [
    cons.pending > 0 && { tone: 'warn', text: `${cons.pending} consultant(s) waiting for verification`, tab: 'consultants' },
    o.companies.suspended > 0 && { tone: 'bad', text: `${o.companies.suspended} suspended company(ies)`, tab: 'companies' },
    (st.grace ?? 0) > 0 && { tone: 'warn', text: `${st.grace} account(s) in the grace period`, tab: 'companies' },
  ].filter(Boolean);

  return (
    <>
      <PageHeader title="Platform overview" subtitle={`How IBMP is doing, as of ${fmt(o.asOf)}. Revenue excludes GST.`} />
      <div className="kpi-grid">
        <KpiCard label="Accounts" value={num(o.companies.accounts)} icon="building" tone="brand" hint={`${num(o.companies.clients)} client companies · ${num(o.users.total)} users`} spark={o.trends.signups} color={COLORS.brand} onClick={() => go('companies')} />
        <KpiCard label="New this month" value={num(o.trends.signups[last])} icon="trend" tone="teal" pct={change(o.trends.signups[last], o.trends.signups[last - 1])} suffix="vs last month" hint={`${o.companies.signupsLast7} in the last 7 days`} />
        <KpiCard label="Revenue, last 30 days" value={inrCompact(o.revenue.taxableLast30)} icon="wallet" tone="green" hint={`${o.revenue.invoicesLast30} invoices · ${inrCompact(o.revenue.grossLast30)} with GST`} spark={o.trends.revenue} color="#059669" onClick={() => go('billing')} />
        <KpiCard label="Monthly recurring (list price)" value={inrCompact(o.mrrEstimate)} icon="layers" tone="violet" hint={`${paying.reduce((x, [, n]) => x + n, 0)} paying accounts`} />
      </div>

      {needs.length > 0 && (
        <Panel title="Needs attention" className="mb"><ul className="list">{needs.map((n) => <li key={n.text}><span className="dot" style={{ background: n.tone === 'bad' ? COLORS.rose : COLORS.amber }} /><div className="grow"><b>{n.text}</b></div><button onClick={() => go(n.tab)}>Review</button></li>)}</ul></Panel>
      )}

      <div className="grid g-3-1">
        <Panel title="Revenue and sign-ups" hint="Last 12 months: paid subscription revenue, then new accounts">
          <TrendChart data={tr} height={250} ariaLabel="Monthly revenue" series={[{ key: 'revenue', label: 'Revenue', color: COLORS.green, type: 'area' }]} format={inrCompact} />
          <p className="muted" style={{ margin: '10px 0 4px' }}>New accounts per month</p>
          <TrendChart data={tr} height={140} ariaLabel="New accounts per month" format={(v) => String(Math.round(v))} integer series={[{ key: 'signups', label: 'New accounts', color: COLORS.brand, type: 'bar' }]} />
        </Panel>
        <Panel title="Subscriptions" hint={`${num(subTotal)} accounts`}>
          <div className="split" style={{ justifyContent: 'center' }}>
            <Donut size={150} thickness={18} centerValue={num(subTotal)} centerLabel="accounts" segments={subSeg} ariaLabel="Accounts by subscription status" />
          </div>
          <div style={{ marginTop: 16 }}><Legend items={subSeg} /></div>
          <hr />
          <span className="muted">Paying accounts by plan</span>
          <div style={{ marginTop: 10 }}><HBars rows={paying.map(([p, n]) => ({ label: p, value: n }))} format={(v) => String(v)} color={COLORS.green} empty="No paying accounts yet" /></div>
        </Panel>
      </div>

      <div className="grid g-2">
        <Panel title="Consultant verification" hint={`${consTotal} professional accounts`} action={<button onClick={() => go('consultants')}>Open</button>}>
          <StackBar segments={consSeg} />
          <div style={{ marginTop: 12 }}><Legend items={consSeg} /></div>
        </Panel>
        <Panel title="Latest sign-ups" hint="Newest companies" action={<button onClick={() => go('companies')}>All companies</button>}>
          <ul className="list">
            {o.recentCompanies.map((c) => <li key={c.id}><span className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{initials(c.name)}</span><div className="grow"><b>{c.name}</b><span>Registered {fmt(c.createdAt)}</span></div>{c.suspended && <Badge tone="bad">suspended</Badge>}</li>)}
          </ul>
        </Panel>
      </div>
    </>
  );
}

function Consultants({ canEdit, open }) {
  const [status, setStatus] = useState('pending');
  const [rows, load, err0] = useLoad(`/consultants?status=${status}`, [status]);
  const [err, setErr] = useState('');
  async function decide(c, s) {
    let note;
    if (s === 'rejected') { note = window.prompt(`Why are ${c.name}'s credentials rejected? The consultant will see this.`); if (!note) return; }
    else if (s === 'verified') { note = window.prompt('Note (optional): what did you check?', 'Checked against the professional body register') ?? undefined; }
    try { await papi('POST', `/consultants/${c.userId}/decision`, { status: s, ...(note ? { note } : {}) }); load(); } catch (e) { setErr(issueText(e)); }
  }
  return (
    <>
      <h2>Consultants</h2>
      <div className="row">{['pending', 'verified', 'rejected', 'all'].map((s) => <button key={s} className={status === s ? 'primary' : ''} onClick={() => setStatus(s === 'all' ? '' : s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div>
      <p className="muted">Check each claimed membership number against the ICAI, ICSI or ICMAI member register, then verify or reject. Verification is shown to the consultant; it does not block them from using the portal.</p>
      {(err || err0) && <p className="err">{err || err0}</p>}
      {!rows ? <p>Loading…</p> : <table>
        <thead><tr><th>Consultant</th><th>Body</th><th>Membership no.</th><th>Registered name</th><th>Clients</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.userId}>
            <td>{c.name}<br /><span className="muted">{c.email}</span></td><td>{c.body}</td><td>{c.membershipNo}</td>
            <td>{c.registeredName} {!c.nameMatches && <span title="Differs from the account holder's name" style={{ color: '#92400e' }}>⚠</span>}</td><td>{c.clientCompanies}</td>
            <td><Chip text={c.status} color={c.status === 'verified' ? '#15803d' : c.status === 'rejected' ? '#b91c1c' : '#92400e'} />{c.note && <div className="muted">{c.note}</div>}</td>
            <td className="row">
              <button onClick={() => open(c.homeCompanyId)}>Account</button>
              {canEdit && c.status !== 'verified' && <button className="primary" onClick={() => decide(c, 'verified')}>Verify</button>}
              {canEdit && c.status !== 'rejected' && <button onClick={() => decide(c, 'rejected')}>Reject</button>}
              {canEdit && c.status !== 'pending' && <button onClick={() => decide(c, 'pending')}>Reopen</button>}
            </td>
          </tr>))}
          {!rows.length && <tr><td colSpan={7} className="muted">None.</td></tr>}
        </tbody>
      </table>}
    </>
  );
}

function Companies({ canEdit, focus }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [d, , err] = useLoad(`/companies?q=${encodeURIComponent(q)}&page=${page}`, [q, page]);
  const [sel, setSel] = useState(focus);
  useEffect(() => { if (focus) setSel(focus); }, [focus]);
  if (sel) return <CompanyDetail id={sel} canEdit={canEdit} back={() => setSel(null)} openOther={setSel} />;
  return (
    <>
      <h2>Companies</h2>
      <div className="row"><input placeholder="Search name, GSTIN or owner email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ width: 320 }} /></div>
      {err && <p className="err">{err}</p>}
      {!d ? <p>Loading…</p> : <>
        <table>
          <thead><tr><th>Company</th><th>Owner</th><th>Plan</th><th>Subscription</th><th>Registered</th><th /></tr></thead>
          <tbody>{d.companies.map((c) => (
            <tr key={c.id}>
              <td>{c.name} {c.suspended && <Chip text="suspended" color="#b91c1c" />} {c.archived && <Chip text="archived" color="#64748b" />}<br /><span className="muted">{c.gstin ?? 'No GSTIN'}{c.clientOf ? ` · client of #${c.clientOf}` : ''}</span></td>
              <td>{c.owner ? <>{c.owner.name}<br /><span className="muted">{c.owner.email}{c.owner.accountType === 'consultant' ? ' · professional' : ''}</span></> : '—'}</td>
              <td>{c.plan ?? '—'}</td><td><Chip text={c.subscription === 'none' ? 'none' : `${c.subscription}${c.daysLeft != null ? ` · ${c.daysLeft}d` : ''}`} color={STATUS_COLOR[c.subscription]} /></td>
              <td>{fmt(c.createdAt)}</td><td><button onClick={() => setSel(c.id)}>Open</button></td>
            </tr>))}
            {!d.companies.length && <tr><td colSpan={6} className="muted">No companies match.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Previous</button>
          <span className="muted">Page {d.page} of {Math.max(1, Math.ceil(d.total / d.limit))} · {d.total} companies</span>
          <button disabled={page * d.limit >= d.total} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      </>}
    </>
  );
}

function CompanyDetail({ id, canEdit, back, openOther }) {
  const [c, load, err0] = useLoad(`/companies/${id}`, [id]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ reason: '', days: '14', plan: 'professional', grantDays: '30' });
  if (err0) return <><button onClick={back}>‹ Back</button><p className="err">{err0}</p></>;
  if (!c) return <p>Loading…</p>;
  const act = async (path, body, ok) => {
    setErr(''); setMsg('');
    try { await papi('POST', `/companies/${id}${path}`, body); setMsg(ok); setF({ ...f, reason: '' }); load(); } catch (e) { setErr(issueText(e)); }
  };
  const need = () => (f.reason.trim().length >= 3 ? true : (setErr('Give a reason (at least 3 characters): it goes in the audit log.'), false));
  const sub = c.subscription;
  const consultantAccount = c.members.some((m) => m.accountType === 'consultant');

  return (
    <>
      <div className="row"><button onClick={back}>‹ Back</button><h2 style={{ margin: 0 }}>{c.name}</h2>{c.suspended && <Chip text="suspended" color="#b91c1c" />}{c.archived && <Chip text="archived" color="#64748b" />}</div>
      <p className="muted">#{c.id} · {c.gstin ?? 'no GSTIN'} · state {c.stateCode} · {c.sector} · registered {fmt(c.createdAt)}</p>
      {c.suspended && <p className="card err">Suspended on {fmt(c.suspended.at)}: {c.suspended.reason}</p>}
      {err && <p className="err">{err}</p>}{msg && <p style={{ color: '#15803d' }}>{msg}</p>}

      <div className="tiles">
        <Tile label="Plan" value={sub?.planName ?? '—'} sub={sub ? `${sub.status}${sub.daysLeft != null ? ` · ${sub.daysLeft} days` : ''}` : 'no subscription'} />
        <Tile label={sub?.planCode === 'trial' ? 'Trial ends' : 'Paid until'} value={fmt(sub?.planCode === 'trial' ? sub?.trialEnds : sub?.periodEnd)} />
        <Tile label="Records held" value={c.activity.invoices + c.activity.purchases} sub={`${c.activity.invoices} invoices · ${c.activity.purchases} bills · ${c.activity.parties} parties · ${c.activity.employees} employees`} />
      </div>
      <p className="muted">Counts only: a company's own records are not shown here and nobody can sign in as a customer.</p>
      {c.billingCompanyId && <p className="card">This is a client company. Its subscription belongs to the consultant's account: <a href="#" onClick={(e) => { e.preventDefault(); openOther(c.billingCompanyId); }}>open account #{c.billingCompanyId}</a>.</p>}

      <h3>People</h3>
      <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Type</th></tr></thead><tbody>{c.members.map((m) => <tr key={m.id}><td>{m.name}</td><td>{m.email}</td><td>{m.role}</td><td>{m.accountType}</td></tr>)}</tbody></table>
      {c.clients.length > 0 && <><h3>Client companies</h3><p>{c.clients.map((x) => <a key={x.id} href="#" style={{ marginRight: 12 }} onClick={(e) => { e.preventDefault(); openOther(x.id); }}>{x.name}</a>)}</p></>}

      <h3>Invoices</h3>
      <table><thead><tr><th>Number</th><th>Plan</th><th>Months</th><th>Kind</th><th>Total</th><th>Status</th><th>Paid</th></tr></thead>
        <tbody>{c.invoices.map((i) => <tr key={i.id}><td>{i.number ?? '—'}</td><td>{i.plan}</td><td>{i.months}</td><td>{i.kind}</td><td>{inr(i.total)}</td><td>{i.status}</td><td>{fmt(i.paidOn)}</td></tr>)}
          {!c.invoices.length && <tr><td colSpan={7} className="muted">No invoices.</td></tr>}</tbody></table>

      {canEdit && <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Actions</h3>
        <p className="muted" style={{ marginTop: 0 }}>Every action needs a reason and is written to the audit log.</p>
        <div className="row"><input placeholder="Reason (required)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} style={{ width: 360 }} /></div>
        <div className="row">
          {!c.billingCompanyId && sub?.planCode === 'trial' && <>
            <input type="number" min="1" max="90" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} style={{ width: 80 }} />
            <button onClick={() => need() && act('/extend-trial', { days: Number(f.days), reason: f.reason }, 'Trial extended.')}>Extend trial (days)</button>
          </>}
          {!c.billingCompanyId && <>
            <select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
              {(consultantAccount ? ['consultant_5', 'consultant_10'] : ['starter', 'professional', 'enterprise']).map((p) => <option key={p}>{p}</option>)}
            </select>
            <input type="number" min="1" max="366" value={f.grantDays} onChange={(e) => setF({ ...f, grantDays: e.target.value })} style={{ width: 80 }} />
            <button onClick={() => need() && window.confirm('Give this plan free of charge? No invoice is raised.') && act('/grant', { planCode: f.plan, days: Number(f.grantDays), reason: f.reason }, 'Complimentary plan granted.')}>Grant plan (days, free)</button>
          </>}
          {c.suspended
            ? <button className="primary" onClick={() => need() && act('/unsuspend', { reason: f.reason }, 'Company reactivated.')}>Reactivate</button>
            : <button style={{ color: '#b91c1c' }} onClick={() => need() && window.confirm(`Suspend ${c.name}? Everyone in it is locked out at once.`) && act('/suspend', { reason: f.reason }, 'Company suspended.')}>Suspend</button>}
        </div>
      </div>}
    </>
  );
}

function Billing({ open }) {
  const [b, , err] = useLoad('/billing');
  if (err) return <p className="err">{err}</p>;
  if (!b) return <p>Loading…</p>;
  return (
    <>
      <h2>Billing</h2>
      <p className="muted">Paid subscription invoices across the platform. {b.pendingCheckouts} checkout(s) are waiting for payment. Complimentary grants raise no invoice.</p>
      <table>
        <thead><tr><th>Invoice</th><th>Company</th><th>Plan</th><th>Months</th><th>Excl. GST</th><th>GST</th><th>Total</th><th>Paid on</th><th>Via</th></tr></thead>
        <tbody>{b.invoices.map((i) => <tr key={i.id}><td>{i.number}</td><td><a href="#" onClick={(e) => { e.preventDefault(); open(i.companyId); }}>{i.company}</a></td><td>{i.plan}</td><td>{i.months}</td><td>{inr(i.taxable)}</td><td>{inr(i.gst)}</td><td>{inr(i.total)}</td><td>{fmt(i.paidOn)}</td><td>{i.provider ?? '—'}</td></tr>)}
          {!b.invoices.length && <tr><td colSpan={9} className="muted">No paid invoices yet.</td></tr>}</tbody>
      </table>
    </>
  );
}

function Audit() {
  const [logins, setLogins] = useState(false);
  const [rows, , err] = useLoad(`/audit?logins=${logins}`, [logins]);
  const brief = (d) => Object.entries(d).filter(([k]) => k !== 'ip').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
  return (
    <>
      <h2>Audit log</h2>
      <label><input type="checkbox" checked={logins} onChange={(e) => setLogins(e.target.checked)} /> Include sign-ins</label>
      {err && <p className="err">{err}</p>}
      {!rows ? <p>Loading…</p> : <table style={{ marginTop: 8 }}>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>{rows.map((a) => <tr key={a.id}><td>{fmt(a.at)} {String(a.at).slice(11, 16)}</td><td>{a.admin}</td><td>{a.action.replace(/_/g, ' ')}</td><td>{a.targetType ? `${a.targetType} ${a.targetId}` : '—'}</td><td className="muted">{brief(a.detail)}</td></tr>)}
          {!rows.length && <tr><td colSpan={5} className="muted">Nothing yet.</td></tr>}</tbody>
      </table>}
    </>
  );
}

function Staff({ me }) {
  const [rows, load, err0] = useLoad(me?.role === 'owner' ? '/admins' : '/me', [me?.role]);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  async function change(e) {
    e.preventDefault(); setErr(''); setMsg('');
    try { await papi('POST', '/password', pw); setPw({ current: '', next: '' }); setMsg('Password changed.'); } catch (e2) { setErr(issueText(e2)); }
  }
  async function toggle(a) { try { await papi('PUT', `/admins/${a.id}`, { active: !a.active }); load(); } catch (e) { setErr(e.message); } }
  return (
    <>
      <h2>Staff &amp; account</h2>
      <form className="card row" onSubmit={change}>
        <strong>Change your password</strong>
        <input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
        <input type="password" placeholder="New password (12+ characters)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required style={{ width: 240 }} />
        <button className="primary">Change</button>
      </form>
      {err && <p className="err">{err}</p>}{msg && <p style={{ color: '#15803d' }}>{msg}</p>}{err0 && <p className="err">{err0}</p>}
      {me?.role === 'owner' && Array.isArray(rows) && <>
        <h3>Platform staff</h3>
        <p className="muted">New staff are created by the operator with <code>npm run admin:create</code>; there is no sign-up.</p>
        <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.email}</td><td>{a.role}</td><td>{a.lastLoginAt ? fmt(a.lastLoginAt) : 'never'}</td><td>{a.active ? 'Active' : 'Switched off'}</td>
            <td>{a.email !== me.email && <button onClick={() => toggle(a)}>{a.active ? 'Switch off' : 'Switch on'}</button>}</td></tr>)}</tbody></table>
      </>}
    </>
  );
}
