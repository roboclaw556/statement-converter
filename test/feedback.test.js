import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequestPost, onRequestGet, onRequestPatch } from '../server/routes/feedback.js';

// Minimal stand-in for the D1 binding, backed by in-memory SQLite.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      let args = [];
      const stmt = db.prepare(sql);
      return {
        bind(...a) { args = a; return this; },
        async first() { return stmt.get(...args); },
        async all() { return { results: stmt.all(...args) }; },
        async run() { const r = stmt.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
      };
    },
  };
}

const env = { DB: fakeD1(), EXPORT_TOKEN: 'secret-token-123', IP_SALT: 'salt' };
const post = (body, ip = '1.2.3.4') => onRequestPost({ env, request: new Request('https://x/api/feedback', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }) });

test('stores feedback and exports it for the weekly review', async () => {
  assert.equal((await post({ kind: 'idea', message: 'Add Wise statements', rating: 4, page: '/banks/' })).status, 200);
  assert.equal((await post({ kind: 'conversion_ok', message: '', context: { status: 'reconciled', transactions: 40 } })).status, 200);
  assert.equal((await post({ kind: 'idea', message: '' })).status, 400);
  assert.equal((await post({ kind: 'idea', message: 'spam', website: 'http://bot' })).status, 200); // honeypot: accepted, not stored

  const unauth = await onRequestGet({ env, request: new Request('https://x/api/feedback') });
  assert.equal(unauth.status, 401);

  const res = await onRequestGet({ env, request: new Request('https://x/api/feedback?since=2000-01-01&format=json', { headers: { authorization: 'Bearer secret-token-123' } }) });
  const data = await res.json();
  assert.equal(data.count, 2);
  assert.equal(data.feedback[1].context.status, 'reconciled');

  const md = await (await onRequestGet({ env, request: new Request('https://x/api/feedback?since=2000-01-01', { headers: { authorization: 'Bearer secret-token-123' } }) })).text();
  assert.match(md, /Add Wise statements/);
  assert.match(md, /1 worked, 0 had a problem/);

  const patch = await onRequestPatch({ env, request: new Request('https://x/api/feedback', { method: 'PATCH', headers: { authorization: 'Bearer secret-token-123' }, body: JSON.stringify({ ids: [1], status: 'planned' }) }) });
  assert.equal(patch.status, 200);
});

test('rate limits a flood from one address', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await post({ kind: 'bug', message: 'x' + i }, '9.9.9.9');
  assert.equal(last.status, 429);
});
