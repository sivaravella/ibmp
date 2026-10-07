import React, { useEffect, useState } from 'react';
import { api, hasToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Parties from './pages/Parties.jsx';
import Items from './pages/Items.jsx';
import Invoices from './pages/Invoices.jsx';
import Purchases from './pages/Purchases.jsx';
import Returns from './pages/Returns.jsx';
import Ledger from './pages/Ledger.jsx';
import GstReports from './pages/GstReports.jsx';
import Compliance from './pages/Compliance.jsx';
import Payroll from './pages/Payroll.jsx';
import Attendance from './pages/Attendance.jsx';
import Leave from './pages/Leave.jsx';
import Billing from './pages/Billing.jsx';
import Filing from './pages/Filing.jsx';
import EDocs from './pages/EDocs.jsx';
import Tds from './pages/Tds.jsx';
import Statutory from './pages/Statutory.jsx';
import Companies, { switchCompany } from './pages/Companies.jsx';

// [id, label, page, feature the plan must include (omit = always available)]
const TABS = [
  ['dashboard', 'Dashboard', Dashboard],
  ['parties', 'Parties', Parties],
  ['items', 'Items', Items],
  ['invoices', 'Invoices', Invoices],
  ['purchases', 'Purchases', Purchases],
  ['returns', 'Returns', Returns],
  ['ledger', 'Ledger', Ledger],
  ['gst', 'GST Reports', GstReports],
  ['filing', 'GST Filing', Filing],
  ['edocs', 'E-invoice & E-way', EDocs],
  ['tds', 'TDS & Form 16', Tds],
  ['statutory', 'PF & ESI', Statutory, 'hr'],
  ['payroll', 'Payroll', Payroll, 'hr'],
  ['attendance', 'Attendance', Attendance, 'hr'],
  ['leave', 'Leave', Leave, 'hr'],
  ['compliance', 'Compliance', Compliance],
  ['companies', 'Companies', Companies],
  ['billing', 'Billing', Billing],
];

const fmt = (d) => (d ? d.split('-').reverse().join('-') : '');

/** The strip across the top that tells the customer where their subscription stands. */
function banner(sub) {
  if (!sub) return null;
  if (sub.status === 'trialing') return { tone: sub.daysLeft <= 3 ? 'warn' : 'info', text: `Free trial: ${sub.daysLeft} day(s) left (ends ${fmt(sub.trialEnds)}).`, action: 'Choose a plan' };
  if (sub.status === 'grace') return { tone: 'warn', text: `Your ${sub.planName} plan ended ${fmt(sub.periodEnd)}. Renew within ${sub.graceDays} days to avoid read-only mode.`, action: 'Renew now' };
  if (sub.status === 'expired') return { tone: 'bad', text: 'Your subscription has expired. The portal is read-only: you can view and export data but not make changes.', action: 'Renew' };
  if (sub.status === 'active' && sub.daysLeft <= 7 && !sub.cancelAtPeriodEnd) return { tone: 'info', text: `Your ${sub.planName} plan ends in ${sub.daysLeft} day(s) (${fmt(sub.periodEnd)}).`, action: 'Renew' };
  if (sub.status === 'active' && sub.cancelAtPeriodEnd && sub.daysLeft <= 14) return { tone: 'warn', text: `Your ${sub.planName} plan is set not to renew and ends ${fmt(sub.periodEnd)}.`, action: 'Keep my plan' };
  return null;
}
const TONE = { info: ['#1e3a8a', '#dbeafe'], warn: ['#92400e', '#fef3c7'], bad: ['#991b1b', '#fee2e2'] };

export default function App() {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('dashboard');
  const [params, setParams] = useState({});
  const [sub, setSub] = useState(null);
  const [blocked, setBlocked] = useState(null);       // a 402 from the server while using a page
  const go = (t, p = {}) => { setParams(p); setTab(t); setBlocked(null); };
  const [authed, setAuthed] = useState(hasToken());
  const refreshSub = () => api('GET', '/billing/subscription').then(setSub).catch(() => {});
  const refreshMe = () => api('GET', '/auth/me').then(setMe).catch(() => {});

  useEffect(() => {
    if (!authed) return;
    refreshMe();
    refreshSub();
    const onBlocked = (e) => { setBlocked(e.detail); refreshSub(); };
    window.addEventListener('ibmp:402', onBlocked);
    return () => window.removeEventListener('ibmp:402', onBlocked);
  }, [authed]);

  if (!authed) return <Login onAuth={() => setAuthed(true)} />;
  const [, , Page, feature] = TABS.find(([id]) => id === tab);
  const locked = (f) => f && sub && !sub.features.includes(f);
  const b = blocked?.code === 'PLAN_REQUIRED' || blocked?.code === 'SUBSCRIPTION_EXPIRED' ? { tone: 'bad', text: blocked.message, action: 'View plans' } : banner(sub);

  return (
    <div className="shell">
      <aside>
        <h1>IBMP</h1>
        <nav>
          {TABS.map(([id, label, , f]) => (
            <button key={id} className={id === tab ? 'active' : ''} onClick={() => go(id)}>{label}{locked(f) ? ' 🔒' : ''}</button>
          ))}
        </nav>
        <div className="who">
          {me && me.companies.length > 1
            ? <select value={me.companyId} onChange={(e) => switchCompany(Number(e.target.value))} title="Switch company" style={{ width: '100%' }}>
              {me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            : me && <strong>{me.company}</strong>}
          {me && <span>{me.sector} · GST state {me.stateCode}{me.accountType === 'consultant' ? ' · consultant' : ''}</span>}
          {sub && <span>{sub.planName}{sub.status === 'trialing' ? ` · ${sub.daysLeft}d left` : ''}</span>}
          <button onClick={() => { setToken(null); setAuthed(false); setMe(null); setSub(null); }}>Sign out</button>
        </div>
      </aside>
      <main>
        {b && tab !== 'billing' && (
          <div style={{ background: TONE[b.tone][1], color: TONE[b.tone][0], padding: '8px 14px', borderRadius: 8, marginBottom: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1 }}>{b.text}</span><button onClick={() => go('billing')}>{b.action}</button>
          </div>
        )}
        {locked(feature)
          ? <div className="card"><h2>Not included in your plan</h2><p>Payroll, attendance and leave management are available on the Professional plan and above.</p><button className="primary" onClick={() => go('billing')}>See plans</button></div>
          : <Page key={tab} me={me} go={go} params={params} refreshSub={refreshSub} refreshMe={refreshMe} />}
      </main>
    </div>
  );
}
