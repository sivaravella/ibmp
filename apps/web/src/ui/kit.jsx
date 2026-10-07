import React from 'react';
import { Icon } from './icons.jsx';
import { Sparkline } from './charts.jsx';

/** The heading of a page: title, a line of context and the actions on the right. */
export function PageHeader({ title, subtitle, children }) {
  return (
    <header className="page-head">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

/** A titled surface for one chart or list. */
export function Panel({ title, hint, action, children, className = '', pad = true }) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && <div className="panel-head"><div><h3>{title}</h3>{hint && <span>{hint}</span>}</div>{action}</div>}
      <div className={pad ? 'panel-body' : ''}>{children}</div>
    </section>
  );
}

/** Up or down arrow with the percentage change. `good` says which direction is good news (costs rising is not). */
export function Delta({ pct, good = 'up', suffix = 'vs last month' }) {
  if (pct === null || pct === undefined) return <span className="delta flat">– <span className="sfx">{suffix}</span></span>;
  const up = pct > 0, flat = Math.abs(pct) < 0.05;
  const tone = flat ? 'flat' : (up === (good === 'up')) ? 'pos' : 'neg';
  return <span className={`delta ${tone}`}>{!flat && <Icon name={up ? 'up' : 'down'} size={12} />}{Math.abs(pct).toFixed(1)}%<span className="sfx"> {suffix}</span></span>;
}

/** A headline figure with its trend: value, change against the previous period and a sparkline. */
export function KpiCard({ label, value, icon, tone = 'brand', pct, good = 'up', suffix, spark, color, hint, onClick }) {
  return (
    <div className={`kpi tone-${tone}${onClick ? ' clickable' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}>
      <div className="kpi-top"><span className="kpi-label">{label}</span>{icon && <span className="kpi-icon"><Icon name={icon} size={16} /></span>}</div>
      <div className="kpi-value">{value}</div>
      {pct !== undefined && <Delta pct={pct} good={good} suffix={suffix} />}
      {hint && <div className="kpi-hint">{hint}</div>}
      {spark && <div className="kpi-spark"><Sparkline values={spark} color={color} /></div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={`badge b-${tone}`}>{children}</span>;
}

/** Shown while a screen's data loads: the shape of the page, so nothing jumps when it arrives. */
export function Skeleton({ rows = 3, height = 18 }) {
  return <div className="skeleton" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <span key={i} style={{ height, width: `${92 - i * 11}%` }} />)}</div>;
}

export function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div className="kpi-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="kpi skel-card"><span /><span /><span /></div>)}</div>
      <div className="grid g-3-1"><div className="panel skel-card tall"><span /></div><div className="panel skel-card tall"><span /></div></div>
    </div>
  );
}

export function EmptyState({ icon = 'layers', title, text, children }) {
  return <div className="empty"><span className="empty-icon"><Icon name={icon} size={22} /></span><strong>{title}</strong>{text && <p>{text}</p>}{children}</div>;
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

/** Catches a crash in one screen so the rest of the app stays usable. */
export class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Screen crashed:', error, info?.componentStack); }
  componentDidUpdate(prev) { if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel crash"><div className="panel-body">
        <EmptyState icon="alert" title="This screen hit a problem" text="Nothing you entered has been lost. Try again, and if it keeps happening tell support what you were doing.">
          <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
        </EmptyState>
      </div></div>
    );
  }
}
