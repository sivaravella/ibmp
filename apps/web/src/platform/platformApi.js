// The platform console signs in separately from the business portal: its own token, its own storage key, its own API prefix.
let token = localStorage.getItem('ibmp_platform_token');
export const hasPlatformToken = () => !!token;
export const setPlatformToken = (t) => { token = t; t ? localStorage.setItem('ibmp_platform_token', t) : localStorage.removeItem('ibmp_platform_token'); };

export async function papi(method, path, body) {
  const r = await fetch('/v1/platform' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token && path !== '/login') { setPlatformToken(null); location.reload(); }
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, code: data.code, issues: data.issues });
  return data;
}

export const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n));
export const fmt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');
export const issueText = (e) => (e.issues?.length ? e.issues.map((i) => i.message).join(' ') : e.message);
