import React, { useEffect, useMemo, useRef, useState } from 'react';
import { inrCompact } from './format.js';

// Charts drawn as plain SVG, sized to their container. No charting library: the whole set is a few kilobytes.
export const COLORS = { brand: '#5b5bd6', violet: '#8b5cf6', teal: '#14b8a6', amber: '#f59e0b', rose: '#f43f5e', sky: '#0ea5e9', green: '#10b981', slate: '#94a3b8', ink: '#0f172a' };
export const SERIES = [COLORS.brand, COLORS.teal, COLORS.amber, COLORS.rose, COLORS.sky, COLORS.violet, COLORS.green, COLORS.slate];

/** The width of an element, kept up to date, so SVG text stays at its real pixel size. */
function useWidth(initial = 640) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const set = () => setW(Math.max(160, Math.floor(el.getBoundingClientRect().width)));
    set();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A round upper bound and step for an axis: niceScale(7300) -> { max: 8000, step: 2000 }. */
export function niceScale(maxValue, ticks = 4) {
  if (!(maxValue > 0)) return { max: 1, step: 0.25 };
  const raw = maxValue / ticks, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { max: step * Math.ceil(maxValue / step), step };
}

/** A smooth line through the points (monotone-ish cubic), as an SVG path. */
function smooth(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

const Empty = ({ height, text = 'No data yet' }) => <div className="chart-empty" style={{ height }}>{text}</div>;

/**
 * Time series with bars, lines and areas on one set of axes, a hover guide and a tooltip.
 * data: [{ label, ...values }]; series: [{ key, label, color, type: 'bar' | 'line' | 'area' }].
 */
export function TrendChart({ data, series, height = 260, format = inrCompact, ariaLabel = 'Trend chart', integer = false }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { l: 52, r: 12, t: 12, b: 28 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const values = data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0));
  const max = Math.max(0, ...values), min = Math.min(0, ...values);
  // The axis runs from below zero when a series goes negative (net GST can: input credit above output tax).
  const step = integer ? Math.max(1, Math.ceil(niceScale(Math.max(max, -min)).step)) : niceScale(Math.max(max, -min)).step;
  const top = Math.max(step, step * Math.ceil(max / step)), bottom = min < 0 ? -step * Math.ceil(-min / step) : 0;
  const y = (v) => pad.t + ih - ((v - bottom) / (top - bottom)) * ih;
  const slot = iw / Math.max(data.length, 1);
  const cx = (i) => pad.l + slot * i + slot / 2;
  const bars = series.filter((s) => (s.type ?? 'bar') === 'bar'), lines = series.filter((s) => s.type === 'line' || s.type === 'area');
  const gap = Math.min(6, slot * 0.08), group = Math.min(slot * 0.7, 44 * Math.max(bars.length, 1)), bw = bars.length ? Math.max(3, (group - gap * (bars.length - 1)) / bars.length) : 0;
  const every = Math.ceil(data.length / Math.max(1, Math.floor(iw / 46)));
  const gridValues = Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, i) => bottom + i * step);
  const uid = useMemo(() => `g${Math.random().toString(36).slice(2, 8)}`, []);

  if (!max && !min) return <div ref={ref}><Empty height={height} /></div>;
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.min(data.length - 1, Math.max(0, Math.floor((e.clientX - r.left - pad.l) / slot)));
    setHover(i);
  };
  const tipLeft = hover === null ? 0 : Math.min(Math.max(cx(hover) - 80, 4), width - 164);

  return (
    <div ref={ref} className="chart" style={{ height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          {lines.filter((s) => s.type === 'area').map((s) => (
            <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity="0.28" /><stop offset="100%" stopColor={s.color} stopOpacity="0.02" /></linearGradient>
          ))}
        </defs>
        {gridValues.map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} className="grid" />
            <text x={pad.l - 8} y={y(g) + 4} textAnchor="end" className="axis">{format(g)}</text>
          </g>
        ))}
        {hover !== null && <rect x={pad.l + slot * hover} y={pad.t} width={slot} height={ih} className="hover-band" />}
        {bars.map((s, bi) => data.map((d, i) => {
          const v = Number(d[s.key]) || 0, x = cx(i) - group / 2 + bi * (bw + gap), h = Math.abs(y(v) - y(0));
          return v !== 0 ? <rect key={`${s.key}${i}`} x={x} y={v > 0 ? y(v) : y(0)} width={bw} height={h} rx={Math.min(5, bw / 2)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} /> : null;
        }))}
        {lines.map((s) => {
          const pts = data.map((d, i) => [cx(i), y(Number(d[s.key]) || 0)]);
          return (
            <g key={s.key}>
              {s.type === 'area' && <path d={`${smooth(pts)} L${pts[pts.length - 1][0]},${y(0)} L${pts[0][0]},${y(0)} Z`} fill={`url(#${uid}-${s.key})`} />}
              <path d={smooth(pts)} fill="none" stroke={s.color} strokeWidth="2.25" strokeLinecap="round" />
              {hover !== null && <circle cx={pts[hover][0]} cy={pts[hover][1]} r="4.5" fill="#fff" stroke={s.color} strokeWidth="2.25" />}
            </g>
          );
        })}
        {data.map((d, i) => (i % every === 0 ? <text key={d.label + i} x={cx(i)} y={height - 8} textAnchor="middle" className="axis">{d.label}</text> : null))}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: tipLeft, top: 8 }}>
          <strong>{data[hover].tipLabel ?? data[hover].label}</strong>
          {series.map((s) => <div key={s.key}><i style={{ background: s.color }} />{s.label}<b>{format(Number(data[hover][s.key]) || 0)}</b></div>)}
        </div>
      )}
    </div>
  );
}

/** A tiny trend line for a KPI card. */
export function Sparkline({ values, color = COLORS.brand, height = 40 }) {
  const [ref, width] = useWidth(120);
  const uid = useMemo(() => `s${Math.random().toString(36).slice(2, 8)}`, []);
  const max = Math.max(...values, 0), min = Math.min(...values, 0), span = max - min || 1;
  const pts = values.map((v, i) => [(i / Math.max(values.length - 1, 1)) * (width - 6) + 3, height - 4 - ((v - min) / span) * (height - 10)]);
  const flat = !values.some((v) => v);
  return (
    <div ref={ref} style={{ height }}>
      <svg width={width} height={height} aria-hidden="true">
        <defs><linearGradient id={uid} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.25" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        {!flat && <path d={`${smooth(pts)} L${pts[pts.length - 1][0]},${height} L${pts[0][0]},${height} Z`} fill={`url(#${uid})`} />}
        <path d={flat ? `M3,${height - 6} L${width - 3},${height - 6}` : smooth(pts)} fill="none" stroke={flat ? '#cbd5e1' : color} strokeWidth="2" strokeLinecap="round" />
        {!flat && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3.5" fill="#fff" stroke={color} strokeWidth="2" />}
      </svg>
    </div>
  );
}

/** A ring split into segments, with an optional label in the middle. segments: [{ label, value, color }]. */
export function Donut({ segments, size = 168, thickness = 20, centerLabel, centerValue, ariaLabel = 'Breakdown' }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef0f7" strokeWidth={thickness} />
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * c, gap = segments.filter((x) => x.value > 0).length > 1 ? 3 : 0;
          const el = <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeDasharray={`${Math.max(len - gap, 0.5)} ${c - Math.max(len - gap, 0.5)}`} strokeDashoffset={-offset} strokeLinecap="butt" transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
          offset += len;
          return el;
        })}
      </svg>
      <div className="donut-center"><strong style={{ fontSize: Math.max(13, Math.round(size / 7.2)) }}>{centerValue}</strong><span>{centerLabel}</span></div>
    </div>
  );
}

export function Legend({ items, format, inline = false }) {
  return (
    <ul className={`legend${inline ? ' inline' : ''}`}>
      {items.map((x) => <li key={x.label}><i style={{ background: x.color }} /><span>{x.label}</span>{x.value !== undefined && <b>{format ? format(x.value) : x.value}</b>}</li>)}
    </ul>
  );
}

/** One horizontal bar made of segments (ageing buckets, status split). */
export function StackBar({ segments, height = 14 }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className="stackbar" style={{ height }} role="img" aria-label="Distribution">
      {total > 0 ? segments.filter((s) => s.value > 0).map((s) => <span key={s.label} title={`${s.label}`} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />) : <span style={{ width: '100%', background: '#eef0f7' }} />}
    </div>
  );
}

/** A ranked list of horizontal bars. rows: [{ label, value }]. */
export function HBars({ rows, color = COLORS.brand, format = inrCompact, empty = 'Nothing to show yet' }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!rows.length || !max) return <div className="chart-empty" style={{ height: 120 }}>{empty}</div>;
  return (
    <ol className="hbars">
      {rows.map((r, i) => (
        <li key={r.label + i}>
          <div className="hb-top"><span title={r.label}>{r.label}</span><b>{format(r.value)}</b></div>
          <div className="hb-track"><span style={{ width: `${(r.value / max) * 100}%`, background: Array.isArray(color) ? color[i % color.length] : color }} /></div>
        </li>
      ))}
    </ol>
  );
}
