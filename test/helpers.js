// Test doubles for the Cloudflare bindings, backed by in-memory SQLite and a Map.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../server/index.js';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql) => {
    let args = [];
    const stmt = db.prepare(sql);
    const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
    return {
      bind(...a) { args = norm(a); return this; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      async run() { const r = stmt.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
    };
  };
  return { prepare, raw: db };
}

export function fakeR2() {
  const store = new Map();
  return {
    store,
    async put(key, bytes, opts) { store.set(key, { bytes: new Uint8Array(bytes), opts }); },
    async get(key) { const o = store.get(key); return o ? { body: new Blob([o.bytes]).stream(), size: o.bytes.length } : null; },
    async delete(key) { store.delete(key); },
  };
}

export const ENC_KEY = Buffer.alloc(32, 7).toString('base64');

export function makeEnv(extra = {}) {
  return {
    DB: fakeD1(), FILES: fakeR2(), DEV: '1', SITE_URL: 'https://so.test', ENC_KEY, EXPORT_TOKEN: 'export-token-abc',
    IP_SALT: 'salt', INBOX_DOMAIN: 'so.test', ...extra,
  };
}

export const SITE = 'https://so.test';

/** Calls the router like the Worker would. */
export async function call(env, method, path, { body, token, cookie, origin, headers = {}, ip = '9.9.9.9', raw } = {}) {
  const h = new Headers(headers);
  h.set('cf-connecting-ip', ip);
  if (token) h.set('authorization', `Bearer ${token}`);
  if (cookie) h.set('cookie', `sid=${cookie}`);
  if (origin) h.set('origin', origin);
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body instanceof FormData) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); h.set('content-type', 'application/json'); }
  const req = new Request(SITE + path, { method, headers: h, body: payload });
  const res = await handleApi(req, env, new URL(req.url));
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : null;
  return { status: res.status, data, res };
}

/** Signs in a new user and returns their session token. */
export async function signIn(env, email, ip = `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`) {
  const start = await call(env, 'POST', '/api/auth/start', { body: { email }, ip });
  if (start.status !== 200) throw new Error('start failed ' + JSON.stringify(start.data));
  const v = await call(env, 'POST', '/api/auth/verify', { body: { email, code: start.data.dev.code }, ip });
  if (v.status !== 200) throw new Error('verify failed ' + JSON.stringify(v.data));
  return v.data.token;
}

export function setPlan(env, token, plan, status = 'active') {
  return call(env, 'GET', '/api/me', { token }).then(({ data }) => {
    env.DB.raw.prepare('UPDATE teams SET plan = ?, plan_status = ? WHERE id = ?').run(plan, status, data.team.id);
    return data.team.id;
  });
}

export const sample = (name) => new Uint8Array(readFileSync(new URL('./samples/' + name, import.meta.url)));

/** Replaces global fetch for one test; routes is [[regex, (url, init) => Response|object]]. */
export function mockFetch(routes) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    for (const [re, fn] of routes) {
      if (re.test(url)) {
        const out = await fn(url, init);
        return out instanceof Response ? out : new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
