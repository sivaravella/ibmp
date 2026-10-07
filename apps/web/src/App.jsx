import React, { Suspense, lazy, useEffect, useState } from 'react';
import { api, hasToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import { Icon } from './ui/icons.jsx';
import { DashboardSkeleton, ErrorBoundary } from './ui/kit.jsx';
import { fmtDate, initials } from './ui/format.js';

// Each screen is its own chunk, loaded when first opened, so signing in downloads only the shell and the dashboard.
const page = (loader) => lazy(loader);
const Dashboard = page(() => import('./pages/Dashboard.jsx'));
const Parties = page(() => import('./pages/Parties.jsx'));
const Items = page(() => import('./pages/Items.jsx'));
const Invoices = page(() => import('./pages/Invoices.jsx'));
const Purchases = page(() => import('./pages/Purchases.jsx'));
const Returns = page(() => import('./pages/Returns.jsx'));
const Ledger = page(() => import('./pages/Ledger.jsx'));
const GstReports = page(() => import('./pages/GstReports.jsx'));
const Compliance = page(() => import('./pages/Compliance.jsx'));
const Payroll = page(() => import('./pages/Payroll.jsx'));
const Attendance = page(() => import('./pages/Attendance.jsx'));
const Leave = page(() => import('./pages/Leave.jsx'));
const Billing = page(() => import('./pages/Billing.jsx'));
const Filing = page(() => import('./pages/Filing.jsx'));
const EDocs = page(() => import('./pages/EDocs.jsx'));
const Tds = page(() => import('./pages/Tds.jsx'));
const Statutory = page(() => import('./pages/Statutory.jsx'));
const Companies = page(() => import('./pages/Companies.jsx'));

// [id, label, icon, page, feature the plan must include (omit = always available)], grouped for the sidebar.
const NAV = [
  ['Overview', [['dashboard', 'Dashboard', 'dashboard', Dashboard]]],
  ['Sales & purchases', [
    ['invoices', 'Invoices', 'file', Invoices], ['purchases', 'Purchases', 'cart', Purchases], ['returns', 'Returns', 'undo', Returns],
    ['parties', 'Parties', 'users', Parties], ['items', 'Items', 'package', Items]]],
  ['Accounts & tax', [
    ['ledger', 'Ledger', 'book', Ledger], ['gst', 'GST reports', 'chart', GstReports], ['filing', 'GST filing', 'send', Filing],
    ['edocs', 'E-invoice & e-way', 'zap', EDocs], ['tds', 'TDS & Form 16', 'receipt', Tds], ['compliance', 'Compliance', 'calendar', Compliance]]],
  ['People', [
    ['payroll', 'Payroll', 'briefcase', Payroll, 'hr'], ['attendance', 'Attendance', 'userCheck', Attendance, 'hr'],
    ['leave', 'Leave', 'sun', Leave, 'hr'], ['statutory', 'PF & ESI', 'landmark', Statutory, 'hr']]],
  ['Account', [['companies', 'Companies', 'building', Companies], ['billing', 'Billing', 'card', Billing]]],
];
const TABS = NAV.flatMap(([, items]) => items);

/** The strip across the top that tells the customer where their subscription stands. */
function banner(sub) {
  if (!sub) return null;
  if (sub.status === 'trialing') return { tone: sub.daysLeft <= 3 ? 'warn' : 'info', text: `Free trial: ${sub.daysLeft} day(s) left (ends ${fmtDate(sub.trialEnds)}).`, action: 'Choose a plan' };
  if (sub.status === 'grace') return { tone: 'warn', text: `Your ${sub.planName} plan ended ${fmtDate(sub.periodEnd)}. Renew within ${sub.graceDays} days to avoid read-only mode.`, action: 'Renew now' };
  if (sub.status === 'expired') return { tone: 'bad', text: 'Your subscription has expired. The portal is read-only: you can view and export data but not make changes.', action: 'Renew' };
  if (sub.status === 'active' && sub.daysLeft <= 7 && !sub.cancelAtPeriodEnd) return { tone: 'info', text: `Your ${sub.planName} plan ends in ${sub.daysLeft} day(s) (${fmtDate(sub.periodEnd)}).`, action: 'Renew' };
  if (sub.status === 'active' && sub.cancelAtPeriodEnd && sub.daysLeft <= 14) return { tone: 'warn', text: `Your ${sub.planName} plan is set not to renew and ends ${fmtDate(sub.periodEnd)}.`, action: 'Keep my plan' };
  return null;
}

const planPill = (sub) => (!sub ? null : sub.status === 'trialing' ? { tone: sub.daysLeft <= 3 ? 'warn' : 'info', text: `Trial · ${sub.daysLeft}d left` } : sub.status === 'expired' ? { tone: 'bad', text: 'Expired' } : sub.status === 'grace' ? { tone: 'warn', text: `${sub.planName} · renew` } : { tone: 'ok', text: sub.planName });

async function switchCompany(id) {
  const { token } = await api('POST', '/auth/switch', { companyId: id });
  setToken(token);
  location.reload();
}

export default function App() {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('dashboard');
  const [params, setParams] = useState({});
  const [sub, setSub] = useState(null);
  const [blocked, setBlocked] = useState(null);       // a 402 from the server while using a page
  const [menu, setMenu] = useState(false);            // the sidebar on small screens
  const [authed, setAuthed] = useState(hasToken());
  const go = (t, p = {}) => { setParams(p); setTab(t); setBlocked(null); setMenu(false); window.scrollTo(0, 0); };
  const refreshSub = () => api('GET', '/billing/subscription').then(setSub).catch(() => {});
  const refreshMe = () => api('GET', '/auth/me').then(setMe).catch(() => {});

  useEffect(() => {
    if (!authed) return undefined;
    refreshMe();
    refreshSub();
    const onBlocked = (e) => { setBlocked(e.detail); refreshSub(); };
    window.addEventListener('ibmp:402', onBlocked);
    return () => window.removeEventListener('ibmp:402', onBlocked);
  }, [authed]);
  useEffect(() => { const t = TABS.find(([id]) => id === tab); document.title = `${t ? t[1] : 'IBMP'} · IBMP`; }, [tab]);

  if (!authed) return <Login onAuth={() => setAuthed(true)} />;
  const [, label, , Page, feature] = TABS.find(([id]) => id === tab);
  const locked = (f) => f && sub && !sub.features.includes(f);
  const b = blocked?.code === 'PLAN_REQUIRED' || blocked?.code === 'SUBSCRIPTION_EXPIRED' ? { tone: 'bad', text: blocked.message, action: 'View plans' } : banner(sub);
  const pill = planPill(sub);

  return (
    <div className="shell">
      <div className={`scrim${menu ? ' open' : ''}`} onClick={() => setMenu(false)} />
      <aside className={menu ? 'open' : ''} aria-label="Main navigation">
        <div className="brand"><div className="brand-mark">I</div><div><strong>IBMP</strong><span>Business management</span></div></div>
        <nav>
          {NAV.map(([group, items]) => (
            <React.Fragment key={group}>
              <div className="nav-label">{group}</div>
              {items.map(([id, text, icon, , f]) => (
                <button key={id} className={id === tab ? 'active' : ''} aria-current={id === tab ? 'page' : undefined} onClick={() => go(id)}>
                  <Icon name={icon} />{text}{locked(f) && <span className="lock" title="Not in your plan">Upgrade</span>}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="who">
          {me && me.companies.length > 1
            ? <select value={me.companyId} onChange={(e) => switchCompany(Number(e.target.value))} aria-label="Switch company">
              {me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            : me && <strong>{me.company}</strong>}
          {me && <span>{me.sector} · GST state {me.stateCode}{me.accountType === 'consultant' ? ' · professional' : ''}</span>}
          {sub && <span className="plan-chip">{sub.planName}{sub.status === 'trialing' ? ` · ${sub.daysLeft}d left` : ''}</span>}
          <button onClick={() => { setToken(null); setAuthed(false); setMe(null); setSub(null); }}><Icon name="logout" size={15} />Sign out</button>
        </div>
      </aside>
      <div className="main-col">
        <div className="topbar">
          <button className="menu-btn" onClick={() => setMenu(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <div className="crumb"><span>{me?.company ?? 'IBMP'} / </span>{label}</div>
          <div className="spacer" />
          {pill && <button className={`pill ${pill.tone}`} onClick={() => go('billing')} style={{ minHeight: 0 }}>{pill.text}</button>}
          {me && <div className="avatar" title={`${me.name} · ${me.email}`}>{initials(me.name)}</div>}
        </div>
        <main>
          {b && tab !== 'billing' && (
            <div className={`banner ${b.tone}`}><span>{b.text}</span><button onClick={() => go('billing')}>{b.action}</button></div>
          )}
          <ErrorBoundary resetKey={tab}>
            {locked(feature)
              ? <div className="card"><h2>Not included in your plan</h2><p>Payroll, attendance and leave management are available on the Professional plan and above.</p><button className="primary" onClick={() => go('billing')}>See plans</button></div>
              : <Suspense fallback={<DashboardSkeleton />}><Page key={tab} me={me} go={go} params={params} refreshSub={refreshSub} refreshMe={refreshMe} /></Suspense>}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
