import React, { useEffect, useState } from 'react';
import { COLORS, StackBar } from '../ui/charts.jsx';
import { Badge, KpiCard, PageHeader, Panel } from '../ui/kit.jsx';
import { api, setToken } from '../api.js';

import { SECTOR_LIST } from '../ui/sectors.js';
const VERIFY = { pending: ['Awaiting verification', '#92400e', '#fef3c7'], verified: ['Verified', '#15803d', '#dcfce7'], rejected: ['Not verified', '#b91c1c', '#fee2e2'] };

/** Make another of the user's companies the active one. A fresh token is issued, so reload to reset all page state. */
export async function switchCompany(id) {
  const { token } = await api('POST', '/auth/switch', { companyId: id });
  setToken(token);
  location.reload();
}

export default function Companies({ go, refreshMe }) {
  const [data, setData] = useState(null);
  const [profile, setProfile] = useState(undefined);
  const [overview, setOverview] = useState(null);
  const [err, setErr] = useState('');
  const [limitHit, setLimitHit] = useState(false);

  const load = async () => {
    const d = await api('GET', '/companies');
    setData(d);
    api('GET', '/account/consultant').then((p) => setProfile(p.profile));
    if (d.accountType === 'consultant') api('GET', '/consultant/overview').then(setOverview).catch(() => {});
  };
  useEffect(() => { load().catch((e) => setErr(e.message)); }, []);
  if (!data) return <p>{err || 'Loading…'}</p>;
  const consultant = data.accountType === 'consultant';

  return (
    <>
      <PageHeader title="Companies" subtitle={consultant ? 'Every client you look after, and what needs doing for each' : 'Your company, and options for professionals who manage several'} />
      {err && <p className="err">{err} {limitHit && <button onClick={() => go('billing')}>View plans</button>}</p>}

      {consultant ? <Practice data={data} profile={profile} /> : <BecomeConsultant onDone={() => { load(); refreshMe?.(); }} />}

      {consultant && overview && <Overview o={overview} />}

      {consultant && <AddCompany onAdded={() => { setErr(''); setLimitHit(false); load(); refreshMe?.(); }}
        onError={(e) => { setErr(e.message); setLimitHit(e.code === 'COMPANY_LIMIT'); }} />}

      <table>
        <thead><tr><th>Company</th><th>GSTIN</th><th>State</th><th /></tr></thead>
        <tbody>{data.companies.map((c) => (
          <tr key={c.id} style={c.archived ? { opacity: 0.55 } : undefined}>
            <td>{c.name} {c.isHome && <span className="muted">(your practice)</span>} {c.archived && <span className="muted">(archived)</span>}</td>
            <td>{c.gstin || '—'}</td><td>{c.stateCode}</td>
            <td>
              {c.active ? <span className="muted">Active now</span>
                : c.archived ? <button onClick={() => api('POST', `/companies/${c.id}/unarchive`).then(() => { load(); refreshMe?.(); }).catch((e) => { setErr(e.message); setLimitHit(e.code === 'COMPANY_LIMIT'); })}>Restore</button>
                  : <button className="primary" onClick={() => switchCompany(c.id)}>Open</button>}
              {consultant && !c.isHome && !c.active && !c.archived &&
                <button onClick={() => window.confirm(`Archive ${c.name}? It is hidden and stops counting against your plan. The data is kept.`) && api('POST', `/companies/${c.id}/archive`).then(() => { load(); refreshMe?.(); }).catch((e) => setErr(e.message))}>Archive</button>}
            </td>
          </tr>))}
        </tbody>
      </table>
    </>
  );
}

function Practice({ data, profile }) {
  const v = profile ? VERIFY[profile.status] : null;
  const pct = Math.min(100, Math.round((data.used / data.limit) * 100));
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <strong>Your practice</strong>
        {v && <span style={{ background: v[2], color: v[1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{profile.body} {profile.membershipNo} · {v[0]}</span>}
        {profile?.note && <span className="muted">{profile.note}</span>}
      </div>
      <div>{data.used} of {data.limit} companies in use <span className="muted">({data.plan})</span></div>
      <div style={{ background: '#e2e8f0', borderRadius: 6, height: 8, marginTop: 6, maxWidth: 360 }}>
        <div style={{ width: `${pct}%`, height: 8, borderRadius: 6, background: pct >= 100 ? '#b91c1c' : '#2563eb' }} />
      </div>
    </div>
  );
}

function Overview({ o }) {
  const rows = [...o.companies].sort((a, b) => b.overdue - a.overdue || b.dueSoon - a.dueSoon);
  const max = Math.max(1, ...rows.map((c) => c.overdue + c.dueSoon));
  const worst = rows[0];
  const clear = rows.filter((c) => !c.overdue && !c.dueSoon).length;
  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Companies in your practice" value={o.totals.companies} icon="building" tone="brand" hint={`${clear} with nothing pending`} />
        <KpiCard label="Overdue items" value={o.totals.overdue} icon="alert" tone="rose" hint={worst && worst.overdue ? `Most at ${worst.name} (${worst.overdue})` : 'None overdue'} />
        <KpiCard label="Due within 7 days" value={o.totals.dueSoon} icon="clock" tone="amber" hint="Across all clients" />
        <KpiCard label="Average overdue per client" value={(o.totals.overdue / Math.max(1, o.totals.companies)).toFixed(1)} icon="chart" tone="violet" hint="Lower is better" />
      </div>
      <div className="grid g-3-1">
        <Panel title="Deadlines by client" hint="Overdue and due this week, most behind first">
          <ul className="hbars">
            {rows.map((c) => (
              <li key={c.id}>
                <div className="hb-top"><span>{c.name}</span><b>{c.overdue} overdue · {c.dueSoon} soon</b></div>
                <div style={{ width: `${((c.overdue + c.dueSoon) / max) * 100}%`, minWidth: c.overdue + c.dueSoon ? 8 : 0 }}><StackBar height={8} segments={[{ label: 'Overdue', value: c.overdue, color: COLORS.rose }, { label: 'Due soon', value: c.dueSoon, color: COLORS.amber }]} /></div>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Next deadlines" hint="Soonest first">
          <ul className="list">
            {[...o.companies].filter((c) => c.next).sort((a, b) => a.next.daysToDue - b.next.daysToDue).slice(0, 5).map((c) => (
              <li key={c.id}><span className="dot" style={{ background: c.next.daysToDue <= 7 ? COLORS.amber : COLORS.sky }} /><div className="grow"><b title={c.next.name}>{c.next.name}</b><span>{c.name} · {c.next.daysToDue === 0 ? 'due today' : `in ${c.next.daysToDue} day(s)`}</span></div></li>
            ))}
          </ul>
        </Panel>
      </div>
      <table>
        <thead><tr><th>Company</th><th>Overdue</th><th>Due soon</th><th>Most overdue</th><th>Next deadline</th><th /></tr></thead>
        <tbody>{o.companies.map((c) => (
          <tr key={c.id}>
            <td>{c.name}</td>
            <td>{c.overdue ? <Badge tone="bad">{c.overdue}</Badge> : <Badge tone="ok">0</Badge>}</td><td>{c.dueSoon ? <Badge tone="warn">{c.dueSoon}</Badge> : <Badge tone="neutral">0</Badge>}</td>
            <td>{c.mostOverdue ? `${c.mostOverdue.name} (${-c.mostOverdue.daysToDue}d)` : '—'}</td>
            <td>{c.next ? `${c.next.name} (${c.next.daysToDue}d)` : '—'}</td>
            <td>{!c.active && <button onClick={() => switchCompany(c.id)}>Open</button>}</td>
          </tr>))}
        </tbody>
      </table>
    </>
  );
}

function AddCompany({ onAdded, onError }) {
  const [f, setF] = useState({ name: '', sector: 'trading', gstin: '', stateCode: '' });
  async function add(e) {
    e.preventDefault();
    try {
      await api('POST', '/companies', { name: f.name, sector: f.sector, ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : { stateCode: f.stateCode }) });
      setF({ name: '', sector: 'trading', gstin: '', stateCode: '' });
      onAdded();
    } catch (e2) { onError(e2); }
  }
  return (
    <form className="card row" onSubmit={add}>
      <strong>Add a client company</strong>
      <input placeholder="Company name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <select value={f.sector} onChange={(e) => setF({ ...f, sector: e.target.value })}>{SECTOR_LIST.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input placeholder="GSTIN" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} />
      {f.gstin.length === 15 && <button type="button" onClick={async () => { try { const g = await api('GET', `/filing/gstin/${f.gstin.trim()}`); setF({ ...f, gstin: g.gstin, name: f.name || g.tradeName || g.legalName }); } catch (e) { onError(e); } }}>Fetch</button>}
      {!f.gstin && <input placeholder="State code" maxLength={2} value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })} required style={{ width: 110 }} />}
      <button className="primary">Add</button>
    </form>
  );
}

function BecomeConsultant({ onDone }) {
  const [f, setF] = useState({ body: 'ICAI', membershipNo: '', registeredName: '' });
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault(); setErr('');
    try { await api('POST', '/account/consultant', f); onDone(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3 style={{ marginTop: 0 }}>Are you a CA, CS or CMA?</h3>
      <p className="muted">Switch to a consultant account to manage several client companies from this one login, with a slab plan that covers up to 5 or 10 companies. Your membership is checked by our team; you can start straight away.</p>
      <div className="row">
        <select value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })}><option>ICAI</option><option>ICSI</option><option>ICMAI</option></select>
        <input placeholder="Membership no." value={f.membershipNo} onChange={(e) => setF({ ...f, membershipNo: e.target.value })} required />
        <input placeholder="Name as registered with the institute" value={f.registeredName} onChange={(e) => setF({ ...f, registeredName: e.target.value })} required style={{ minWidth: 240 }} />
        <button className="primary">Switch to a consultant account</button>
      </div>
      {err && <p className="err">{err}</p>}
    </form>
  );
}
