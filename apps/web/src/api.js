let token = localStorage.getItem('ibmp_token');

export const setToken = (t) => {
  token = t;
  t ? localStorage.setItem('ibmp_token', t) : localStorage.removeItem('ibmp_token');
};
export const hasToken = () => !!token;

/** What a person should read when a request fails for a reason that is not theirs. */
function failure(status, data) {
  if (data.error && status < 500) return data.error;
  if (status === 429) return data.error || 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return `Something went wrong on our side. Try again in a moment${data.requestId ? ` (reference ${data.requestId})` : ''}.`;
  return `Request failed (${status})`;
}

export async function api(method, path, body) {
  let r;
  try {
    r = await fetch('/v1' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects when the request never got an answer: offline, DNS, the server restarting.
    throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0, code: 'NETWORK' });
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { setToken(null); location.reload(); }
  if (r.status === 402) window.dispatchEvent(new CustomEvent('ibmp:402', { detail: { message: data.error, code: data.code } }));
  if (!r.ok) throw Object.assign(new Error(failure(r.status, data)), { status: r.status, code: data.code, requiredPlan: data.requiredPlan, issues: data.issues });
  return data;
}

export { inr } from './ui/format.js';

/** Download a file from an authenticated endpoint (a plain link cannot carry the sign-in token). */
export async function download(path, filename) {
  let r;
  try { r = await fetch('/v1' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }); } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  if (!r.ok) throw new Error(failure(r.status, await r.json().catch(() => ({}))));
  const url = URL.createObjectURL(await r.blob());
  const el = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(el); el.click(); el.remove();
  URL.revokeObjectURL(url);
}
