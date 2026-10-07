import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

export default function Dashboard({ go }) {
  const [d, setD] = useState(null);
  const [c, setC] = useState(null);
  const [lv, setLv] = useState(null);
  useEffect(() => { api('GET', '/dashboard').then(setD); api('GET', '/compliance/summary').then(setC).catch(() => {}); api('GET', '/leave/summary').then(setLv).catch(() => {}); }, []);
  if (!d) return <p>Loading…</p>;
  const tiles = [
    ['Invoices', d.invoices], ['Total sales', inr(d.sales)],
    ['Receivable', inr(d.outstanding)], ['Output GST (net)', inr(d.outputGst)],
    ['Bills', d.bills], ['Total purchases', inr(d.purchases)],
    ['Payable', inr(d.payable)], ['Input GST (ITC, net)', inr(d.inputGst)],
    ['Sales returns', inr(d.salesReturns)], ['Purchase returns', inr(d.purchaseReturns)],
  ];
  return (
    <>
      <h2>Dashboard</h2>
      {lv && (lv.pending > 0 || lv.onLeave.length > 0) && (
        <div className="card">
          <div className="row" style={{ marginBottom: 4 }}>
            <strong>Leave</strong>
            {lv.pending > 0 && <span style={{ color: '#92400e' }}>{lv.pending} awaiting approval</span>}
            <button onClick={() => go('leave')}>Open leave</button>
          </div>
          {lv.onLeave.length > 0 && <div className="muted">On leave today: {lv.onLeave.map((x) => `${x.name} (${x.type}${x.halfDay ? ', half day' : ''})`).join(', ')}</div>}
        </div>
      )}
      {c && (
        <div className="card" style={{ borderLeft: `4px solid ${c.overdue ? '#b91c1c' : c.dueSoon ? '#92400e' : '#15803d'}` }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <strong>Compliance</strong>
            <span style={{ color: '#b91c1c' }}>{c.overdue} overdue</span>
            <span style={{ color: '#92400e' }}>{c.dueSoon} due within 7 days</span>
            <button onClick={() => go('compliance')}>Open calendar</button>
          </div>
          {[...c.mostOverdue.map((i) => ({ ...i, late: true })), ...c.next].map((i) => (
            <div key={i.name + i.due} className="muted">
              {i.name} — {i.late ? `${-i.daysToDue} day(s) overdue` : i.daysToDue === 0 ? 'due today' : `due in ${i.daysToDue} day(s)`}
            </div>
          ))}
          {!c.overdue && !c.next.length && <span className="muted">Nothing pending.</span>}
        </div>
      )}
      <div className="tiles">
        {tiles.map(([k, v]) => <div className="card tile" key={k}><span className="muted">{k}</span><strong>{v}</strong></div>)}
      </div>
    </>
  );
}
