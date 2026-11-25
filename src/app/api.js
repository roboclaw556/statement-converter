// Small client for the StatementOtter API, shared by every page (and usable by the mobile app,
// which passes a base URL and a Bearer token instead of relying on the cookie).
const SIGNED_IN = 'so_signed_in';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
    this.body = body || {};
  }
}

export function makeApi({ base = '', token = null } = {}) {
  async function call(method, path, body, { raw = false } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers, body: payload, credentials: token ? 'omit' : 'same-origin' });
    if (raw && res.ok) return res;
    const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => ({})) : {};
    if (res.status === 401 && !token) markSignedIn(false);
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    put: (p, b) => call('PUT', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    del: (p) => call('DELETE', p),
  };
}

export const api = makeApi();

export function markSignedIn(yes) {
  try { yes ? localStorage.setItem(SIGNED_IN, '1') : localStorage.removeItem(SIGNED_IN); } catch {}
}
export function looksSignedIn() {
  try { return localStorage.getItem(SIGNED_IN) === '1'; } catch { return false; }
}

let mePromise = null;
/** The signed-in profile, or null. Cached for the page. Only calls the API if this browser signed in before. */
export function getMe() {
  if (!looksSignedIn()) return Promise.resolve(null);
  mePromise ||= api.get('/api/me').catch(() => null);
  return mePromise;
}

export const money = (cents, currency = 'USD') =>
  cents === null || cents === undefined ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
