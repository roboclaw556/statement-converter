// Sign-in, plan and monthly usage. Talks to the same API as the web app
// (server/routes/account.js). Native HTTP (CapacitorHttp) sends the requests,
// so no CORS setup is needed for the app.
import { CONFIG } from './config.js';
import { PLANS, entitlementsFor, withinLimit } from './core/plans.js';
import { store, platform } from './platform.js';

const TOKEN = 'auth.token';
const ME = 'auth.me';
const LOCAL_USAGE = 'usage.local';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body || {};
  }
}

let token = null;
let me = null;
const listeners = new Set();
export const onAccountChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => { try { fn(me); } catch (e) { console.error(e); } });

export async function api(path, { method = 'GET', body, auth = true, timeout = 15000 } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && token) headers.authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(CONFIG.apiBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new ApiError(0, { error: 'offline', message: "Can't reach the server. Check your connection." });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or not JSON */ }
  if (res.status === 401 && auth && token) await forget(); // session expired or revoked
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export async function loadAccount() {
  token = await store.get(TOKEN);
  me = await store.get(ME);
  emit();
  if (token) refresh().catch(() => {}); // keep the cached plan when offline
  return me;
}

export const signedIn = () => !!token;
export const account = () => me;

export async function startSignIn(email) {
  return api('/api/auth/start', { method: 'POST', body: { email }, auth: false });
}

export async function verifyCode(email, code) {
  const res = await api('/api/auth/verify', { method: 'POST', body: { email, code, client: platform === 'web' ? 'web' : platform }, auth: false });
  if (!res?.token) throw new ApiError(500, { message: 'Sign-in did not return a session' });
  token = res.token;
  await store.set(TOKEN, token);
  await refresh();
  return me;
}

export async function refresh() {
  if (!token) return null;
  const data = await api('/api/me');
  me = data;
  await store.set(ME, me);
  emit();
  return me;
}

async function forget() {
  token = null;
  me = null;
  await store.remove(TOKEN);
  await store.remove(ME);
  emit();
}

export async function signOut() {
  try { if (token) await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* sign out locally anyway */ }
  await forget();
}

export async function deleteAccount() {
  await api('/api/me', { method: 'DELETE' });
  await forget();
}

// ---------- plan, entitlements, usage ----------

export function planId() {
  return me?.team?.plan || 'free';
}

export function entitlements() {
  if (me?.entitlements) return me.entitlements;
  return entitlementsFor(planId(), me?.team?.status || 'active');
}

export const comingSoon = () => me?.comingSoon || {};

const period = () => new Date().toISOString().slice(0, 7);

/** Statements converted this month: server count when signed in, device count otherwise. */
export async function usage() {
  if (token && me?.usage) return me.usage;
  const local = await store.get(LOCAL_USAGE, { period: period(), statements: 0 });
  return local.period === period() ? local : { period: period(), statements: 0 };
}

export async function remaining() {
  const limit = entitlements().statementsPerMonth;
  if (limit === null || limit === undefined) return Infinity;
  return Math.max(0, limit - (await usage()).statements);
}

/**
 * Counts one converted statement against the plan. Called on the first export
 * of each statement, so failed reads and re-exports don't use up the quota.
 * @returns {{ok:true}|{ok:false, reason:'limit', message}}
 */
export async function countStatement() {
  if (token) {
    try {
      const res = await api('/api/usage/statement', { method: 'POST', body: { statements: 1 } });
      if (res?.usage && me) { me = { ...me, usage: res.usage }; await store.set(ME, me); emit(); }
      return { ok: true };
    } catch (e) {
      if (e.status === 402) return { ok: false, reason: 'limit', message: e.message };
      if (e.status === 0) return { ok: true }; // offline: don't block someone at a client's office
      throw e;
    }
  }
  const u = await usage();
  const limit = PLANS.free.entitlements.statementsPerMonth;
  if (!withinLimit(limit, u.statements, 1)) {
    return { ok: false, reason: 'limit', message: `The free plan converts ${limit} statements a month. Sign in to a Pro plan for unlimited statements.` };
  }
  await store.set(LOCAL_USAGE, { period: u.period, statements: u.statements + 1 });
  emit();
  return { ok: true };
}

export { PLANS };
