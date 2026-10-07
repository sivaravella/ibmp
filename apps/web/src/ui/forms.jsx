import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { Badge } from './kit.jsx';

/**
 * A panel that slides in from the right for creating or editing something, so the list stays visible behind it.
 * Escape and the scrim close it; focus moves into it when it opens and returns to where it was when it closes.
 */
export function Drawer({ open, title, subtitle, onClose, children, footer, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const back = document.activeElement;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    document.body.classList.add('has-drawer');
    const t = setTimeout(() => ref.current?.querySelector('input:not([type=hidden]), select, textarea, button.primary')?.focus(), 60);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; document.body.classList.remove('has-drawer'); clearTimeout(t); back?.focus?.(); };
  }, [open]);
  if (!open) return null;
  // Rendered on <body>: a page that is animating (transform) would otherwise become the containing block of this fixed panel.
  return createPortal(
    <div className="drawer-wrap">
      <div className="drawer-scrim" onClick={onClose} />
      <div className={`drawer${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="drawer-head">
          <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** A labelled form control with optional hint and error. */
export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/** Search box and filter chips above a table. filters: [{ value, label, count }]. */
export function Toolbar({ search, onSearch, placeholder = 'Search', filters, active, onFilter, children }) {
  return (
    <div className="toolbar">
      {onSearch && (
        <div className="search"><Icon name="search" size={16} /><input type="search" value={search} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} aria-label={placeholder} /></div>
      )}
      {filters && (
        <div className="chips" role="group" aria-label="Filter">
          {filters.map((f) => <button key={f.value} type="button" className={`chip${active === f.value ? ' on' : ''}`} aria-pressed={active === f.value} onClick={() => onFilter(f.value)}>{f.label}{f.count !== undefined && <span>{f.count}</span>}</button>)}
        </div>
      )}
      {children && <div className="toolbar-end">{children}</div>}
    </div>
  );
}

export function Pager({ page, pages, total, size, onPage }) {
  if (pages <= 1) return <p className="muted" style={{ marginTop: 8 }}>{total} {total === 1 ? 'row' : 'rows'}</p>;
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  return (
    <div className="pager">
      <span className="muted">{from}–{to} of {total}</span>
      <button onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
      <span>Page {page} of {pages}</span>
      <button onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">›</button>
    </div>
  );
}

/** Search, one filter and paging over rows held in memory. match(row, lowercaseQuery) decides what the search finds. */
export function useTable(rows, { match, filter, size = 20 }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState('all');
  const [page, setPage] = useState(1);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => (active === 'all' || filter(r) === active) && (!needle || match(r, needle)));
  }, [rows, q, active]);
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const cur = Math.min(page, pages);
  return { q, setQ: (v) => { setQ(v); setPage(1); }, active, setActive: (v) => { setActive(v); setPage(1); }, page: cur, setPage, pages, size, total: shown.length, visible: shown.slice((cur - 1) * size, cur * size) };
}

const STATUS = { paid: ['ok', 'Paid'], partial: ['warn', 'Part paid'], unpaid: ['bad', 'Unpaid'], returned: ['neutral', 'Returned'], draft: ['neutral', 'Draft'], active: ['ok', 'Active'], archived: ['neutral', 'Archived'] };
export function StatusBadge({ status }) {
  const [tone, label] = STATUS[status] ?? ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
}

/** A table cell with a main line and a quieter second line. */
export const Cell = ({ main, sub }) => <div className="cell"><span>{main}</span>{sub && <small>{sub}</small>}</div>;

/** Confirmation of a result or an error at the top of a drawer. */
export const Notice = ({ tone = 'bad', children }) => (children ? <div className={`notice n-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>{children}</div> : null);
