let token = localStorage.getItem('ibmp_token');

export const setToken = (t) => {
  token = t;
  t ? localStorage.setItem('ibmp_token', t) : localStorage.removeItem('ibmp_token');
};
export const hasToken = () => !!token;

export async function api(method, path, body) {
  const r = await fetch('/v1' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { setToken(null); location.reload(); }
  if (r.status === 402) window.dispatchEvent(new CustomEvent('ibmp:402', { detail: { message: data.error, code: data.code } }));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, code: data.code, requiredPlan: data.requiredPlan });
  return data;
}

export const inr = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(n));

/** Download a file from an authenticated endpoint (a plain link cannot carry the sign-in token). */
export async function download(path, filename) {
  const r = await fetch('/v1' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Download failed (${r.status})`);
  const url = URL.createObjectURL(await r.blob());
  const el = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(el); el.click(); el.remove();
  URL.revokeObjectURL(url);
}
