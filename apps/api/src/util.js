// Express 4 does not catch async errors; wrap handlers.
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const httpError = (status, message) => Object.assign(new Error(message), { status });

/** 'YYYY-MM-DD' from a DATE value that may arrive as a string (real pg, with our type parser) or a Date. */
export const ymd = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

/** Today as 'YYYY-MM-DD' in server-local time. */
export const today = () => ymd(new Date());

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * The API speaks camelCase JSON while the database columns stay snake_case. Converts lowercase snake_case keys (UPPER_CASE codes
 * and values are left alone). Subtrees named in `raw` are copied untouched: they hold the government portals' own field names
 * (inv_typ, nt_num, ...), which must reach the portal and the user exactly as the portal defines them.
 */
export function camelizeKeys(v, raw = new Set(['payload'])) {
  if (Array.isArray(v)) return v.map((x) => camelizeKeys(x, raw));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[SNAKE.test(k) ? camel(k) : k] = raw.has(k) ? x : camelizeKeys(x, raw);
    return out;
  }
  return v;
}
