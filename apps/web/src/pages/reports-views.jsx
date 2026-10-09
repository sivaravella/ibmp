import React from 'react';
import { inr } from '../api.js';
import { Notice } from '../ui/forms.jsx';
import { EmptyState } from '../ui/kit.jsx';
import { fmtDate } from '../ui/format.js';

/** The letterhead of a report: it is what appears at the top of the printed page too. */
export function ReportHead({ company, title, period }) {
  return (
    <div className="rp-head">
      <strong>{company.name}</strong>
      <span>GSTIN {company.gstin || 'not set'}{company.address ? ` · ${company.address}` : ''}</span>
      <h2>{title}</h2>
      <span className="rp-period">{period}</span>
    </div>
  );
}

const cls = (r) => `rp-row rp-${r.kind}${r.highlight ? ' rp-hi' : ''}`;
const neg = (n) => (Number(n) < 0 ? ' rp-neg' : '');

/** Profit and loss or balance sheet rows in a Schedule III style layout. */
export function Statement({ rows, hasPrev, curLabel, prevLabel, label }) {
  const cols = hasPrev ? 'rp-cols2' : 'rp-cols1';
  return (
    <div className="rp-scroll" tabIndex={0} role="region" aria-label={label}>
      <div className={`rp-table ${cols}`} role="table" aria-label={label}>
        <div className="rp-row rp-colhead" role="row">
          <span role="columnheader">Particulars</span>
          <span role="columnheader" className="rp-num">{curLabel}</span>
          {hasPrev && <span role="columnheader" className="rp-num">{prevLabel}</span>}
        </div>
        {rows.map((r, i) => {
          const heading = r.kind === 'group' || r.kind === 'section';
          return (
            <div key={`${r.key ?? r.code ?? i}-${i}`} className={cls(r)} role="row">
              <span role="cell" className="rp-label">{r.label}{r.code ? <small> {r.code}</small> : null}</span>
              <span role="cell" className={`rp-num${heading ? '' : neg(r.amount)}`}>{heading ? '' : inr(r.amount)}</span>
              {hasPrev && <span role="cell" className={`rp-num${heading ? '' : neg(r.previous)}`}>{heading ? '' : inr(r.previous)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BalanceCheck({ data }) {
  return data.balanced
    ? <Notice tone="ok">Balance sheet balances: total assets equal total equity and liabilities.</Notice>
    : <Notice tone="warn">Balance sheet does not balance: it is out by {inr(Math.abs(data.difference))}. Check for manual journals or unposted entries.</Notice>;
}

function AgedTable({ title, side, buckets, noun }) {
  const keys = buckets.map((b) => b.key);
  return (
    <section className="rp-aged">
      <h3>{title}</h3>
      {side.parties.length === 0 ? <p className="muted">Nothing outstanding.</p> : (
        <div className="rp-scroll" tabIndex={0} role="region" aria-label={title}>
          <div className="rp-table rp-aged-grid" role="table" aria-label={title}>
            <div className="rp-row rp-colhead" role="row">
              <span role="columnheader">{noun}</span>
              {buckets.map((b) => <span key={b.key} role="columnheader" className="rp-num">{b.label}</span>)}
              <span role="columnheader" className="rp-num">Total</span>
            </div>
            {side.parties.map((p) => (
              <div key={p.partyId} className="rp-row" role="row">
                <span role="cell" className="rp-label">{p.name}<small> {p.documents.length} open · oldest {fmtDate(p.documents[0].date)}</small></span>
                {keys.map((k) => <span key={k} role="cell" className="rp-num">{p[k] ? inr(p[k]) : '–'}</span>)}
                <span role="cell" className="rp-num"><b>{inr(p.total)}</b></span>
              </div>
            ))}
            <div className="rp-row rp-total" role="row">
              <span role="cell" className="rp-label">Total</span>
              {keys.map((k) => <span key={k} role="cell" className="rp-num">{inr(side.totals[k])}</span>)}
              <span role="cell" className="rp-num">{inr(side.totals.total)}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function Outstanding({ data }) {
  const none = !data.receivables.parties.length && !data.payables.parties.length;
  if (none) return <EmptyState icon="check" title="Nothing outstanding" text="No unpaid invoices or bills as at this date." />;
  return (
    <>
      <AgedTable title="Receivables: what customers owe you" side={data.receivables} buckets={data.buckets} noun="Customer" />
      <AgedTable title="Payables: what you owe vendors" side={data.payables} buckets={data.buckets} noun="Vendor" />
    </>
  );
}
