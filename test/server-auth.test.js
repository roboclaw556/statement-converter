// Battle tests: sign-in, sessions, CSRF, teams, seats, quotas, and the router itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, setPlan, SITE } from './helpers.js';

test('sign-in code: wrong codes count, 5 strikes locks, single use', async () => {
  const env = makeEnv();
  const s = await call(env, 'POST', '/api/auth/start', { body: { email: 'A@Example.com' } });
  assert.equal(s.status, 200);
  const code = s.data.dev.code;
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await call(env, 'POST', '/api/auth/verify', { body: { email: 'a@example.com', code: wrong } })).status, 400);
  // 5th attempt uses the right code and still works (4 wrong so far)
  const ok = await call(env, 'POST', '/api/auth/verify', { body: { email: 'a@example.com', code } });
  assert.equal(ok.status, 200);
  assert.match(ok.data.token, /^ses_/);
  assert.match(ok.res.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  // reuse fails
  assert.equal((await call(env, 'POST', '/api/auth/verify', { body: { email: 'a@example.com', code } })).status, 400);

  const s2 = await call(env, 'POST', '/api/auth/start', { body: { email: 'b@example.com' } });
  for (let i = 0; i < 5; i++) await call(env, 'POST', '/api/auth/verify', { body: { email: 'b@example.com', code: '999999' === s2.data.dev.code ? '888888' : '999999' } });
  const locked = await call(env, 'POST', '/api/auth/verify', { body: { email: 'b@example.com', code: s2.data.dev.code } });
  assert.equal(locked.status, 400, 'locked after 5 wrong codes');
});

test('sign-in link: works once, mobile gets no cookie and a long session', async () => {
  const env = makeEnv();
  const s = await call(env, 'POST', '/api/auth/start', { body: { email: 'c@example.com' } });
  const v = await call(env, 'POST', '/api/auth/verify', { body: { link: s.data.dev.link, client: 'ios' } });
  assert.equal(v.status, 200);
  assert.equal(v.res.headers.get('set-cookie'), null);
  assert.equal((await call(env, 'POST', '/api/auth/verify', { body: { link: s.data.dev.link } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/auth/verify', { body: { link: 'nope' } })).status, 400);
  const sess = env.DB.raw.prepare('SELECT client, expires_at FROM sessions').get();
  assert.equal(sess.client, 'ios');
  assert.ok(new Date(sess.expires_at) - Date.now() > 170 * 86400e3);
});

test('sign-in rate limits and input validation', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.equal((await call(env, 'POST', '/api/auth/start', { body: { email: 'd@example.com' } })).status, 200);
  assert.equal((await call(env, 'POST', '/api/auth/start', { body: { email: 'd@example.com' } })).status, 429);
  assert.equal((await call(env, 'POST', '/api/auth/start', { body: { email: 'not-an-email' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/auth/start', { raw: '{bad json', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/auth/start', { raw: '[1,2]' })).status, 400);
  const big = await call(env, 'POST', '/api/auth/start', { raw: 'x'.repeat(70000) });
  assert.equal(big.status, 413);
});

test('sessions: bearer and cookie, CSRF on cookie writes, logout', async () => {
  const env = makeEnv();
  const token = await signIn(env, 'e@example.com');
  assert.equal((await call(env, 'GET', '/api/me')).status, 401);
  assert.equal((await call(env, 'GET', '/api/me', { token: 'ses_forged' })).status, 401);
  const me = await call(env, 'GET', '/api/me', { cookie: token });
  assert.equal(me.status, 200);
  assert.equal(me.data.team.plan, 'free');
  assert.equal(me.data.entitlements.statementsPerMonth, 5);
  assert.ok(me.data.comingSoon.accountingPush);
  assert.match(me.data.team.inboxAddress, /@so\.test$/);
  // cookie write without/with wrong Origin is blocked; right Origin works; bearer needs no Origin
  assert.equal((await call(env, 'PATCH', '/api/team', { cookie: token, body: { name: 'x' } })).status, 403);
  assert.equal((await call(env, 'PATCH', '/api/team', { cookie: token, origin: 'https://evil.test', body: { name: 'x' } })).status, 403);
  assert.equal((await call(env, 'PATCH', '/api/team', { cookie: token, origin: SITE, body: { name: 'Acme' } })).status, 200);
  assert.equal((await call(env, 'PATCH', '/api/team', { token, body: { name: 'Acme 2' } })).status, 200);
  assert.equal((await call(env, 'POST', '/api/auth/logout', { token })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { token })).status, 401);
});

test('expired sessions are refused', async () => {
  const env = makeEnv();
  const token = await signIn(env, 'exp@example.com');
  env.DB.raw.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z'").run();
  assert.equal((await call(env, 'GET', '/api/me', { token })).status, 401);
});

test('free plan: 5 statements a month, enforced atomically', async () => {
  const env = makeEnv();
  const token = await signIn(env, 'f@example.com');
  const results = await Promise.all(Array.from({ length: 12 }, () => call(env, 'POST', '/api/usage/statement', { token, body: { statements: 1 } })));
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  assert.equal(results.filter((r) => r.status === 402).length, 7);
  assert.equal(results.find((r) => r.status === 402).data.upgrade, true);
  const me = await call(env, 'GET', '/api/me', { token });
  assert.equal(me.data.usage.statements, 5);
  // a batch that would cross the limit is refused whole
  const env2 = makeEnv();
  const t2 = await signIn(env2, 'g@example.com');
  assert.equal((await call(env2, 'POST', '/api/usage/statement', { token: t2, body: { statements: 3 } })).status, 200);
  assert.equal((await call(env2, 'POST', '/api/usage/statement', { token: t2, body: { statements: 3 } })).status, 402);
  assert.equal((await call(env2, 'GET', '/api/me', { token: t2 })).data.usage.statements, 3);
  // Pro is unlimited
  await setPlan(env2, t2, 'pro');
  for (let i = 0; i < 10; i++) assert.equal((await call(env2, 'POST', '/api/usage/statement', { token: t2, body: { statements: 5 } })).status, 200);
});

test('canceled plans fall back to Free entitlements', async () => {
  const env = makeEnv();
  const token = await signIn(env, 'h@example.com');
  await setPlan(env, token, 'firm', 'canceled');
  assert.equal((await call(env, 'GET', '/api/me', { token })).data.entitlements.clientPortal, false);
  await setPlan(env, token, 'firm', 'past_due');
  assert.equal((await call(env, 'GET', '/api/me', { token })).data.entitlements.clientPortal, true);
});

test('teams: seats, invites, member rights, removal', async () => {
  const env = makeEnv();
  const owner = await signIn(env, 'owner@firm.test');
  assert.equal((await call(env, 'POST', '/api/team/invites', { token: owner, body: { email: 'm1@firm.test' } })).status, 402, 'free has 1 seat');
  await setPlan(env, owner, 'firm');
  for (const e of ['m1', 'm2', 'm3', 'm4']) assert.equal((await call(env, 'POST', '/api/team/invites', { token: owner, body: { email: `${e}@firm.test` } })).status, 200);
  assert.equal((await call(env, 'POST', '/api/team/invites', { token: owner, body: { email: 'm5@firm.test' } })).status, 402, '5 seats');
  assert.equal(env.__outbox.filter((m) => m.to === 'm1@firm.test').length, 1);

  const member = await signIn(env, 'm1@firm.test');
  const mm = await call(env, 'GET', '/api/me', { token: member });
  assert.equal(mm.data.user.role, 'member');
  assert.equal(mm.data.team.plan, 'firm');
  assert.equal((await call(env, 'POST', '/api/team/invites', { token: member, body: { email: 'x@firm.test' } })).status, 403);
  assert.equal((await call(env, 'POST', '/api/keys', { token: member, body: {} })).status, 403);
  assert.equal((await call(env, 'POST', '/api/billing/checkout', { token: member, body: { plan: 'pro' } })).status, 403);

  const team = await call(env, 'GET', '/api/team', { token: owner });
  assert.equal(team.data.members.length, 2);
  assert.equal(team.data.invites.length, 3);
  // owner can't delete themselves while members remain
  assert.equal((await call(env, 'DELETE', '/api/me', { token: owner })).status, 409);
  const mid = mm.data.user.id;
  assert.equal((await call(env, 'DELETE', `/api/team/members/${mid}`, { token: owner })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { token: member })).status, 401, 'removed member is signed out');
});

test('another team cannot touch your members', async () => {
  const env = makeEnv();
  const a = await signIn(env, 'a@one.test');
  const b = await signIn(env, 'b@two.test');
  const aid = (await call(env, 'GET', '/api/me', { token: a })).data.user.id;
  assert.equal((await call(env, 'DELETE', `/api/team/members/${aid}`, { token: b })).status, 404);
  assert.equal((await call(env, 'GET', '/api/me', { token: a })).status, 200);
});

test('delete account removes the team and its data', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'gone@example.com');
  await setPlan(env, t, 'pro');
  await call(env, 'POST', '/api/rules', { token: t, body: { pattern: 'ACME', category: 'Income' } });
  assert.equal((await call(env, 'DELETE', '/api/me', { token: t })).status, 200);
  for (const tbl of ['users', 'teams', 'rules', 'sessions']) assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n, 0, tbl);
});

test('router: 404, 405, CORS for the mobile app, errors as JSON', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/api/nothing')).status, 404);
  const r405 = await call(env, 'PUT', '/api/me');
  assert.equal(r405.status, 405);
  assert.match(r405.res.headers.get('allow'), /GET/);
  const pre = await call(env, 'OPTIONS', '/api/me', { origin: 'capacitor://localhost' });
  assert.equal(pre.status, 204);
  assert.equal(pre.res.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  const evil = await call(env, 'OPTIONS', '/api/me', { origin: 'https://evil.test' });
  assert.equal(evil.res.headers.get('access-control-allow-origin'), null);
  const plans = await call(env, 'GET', '/api/plans');
  assert.equal(plans.data.plans.pro.priceMonthly, 19);
  // an unexpected exception becomes a 500 JSON without internals
  const broken = { ...env, DB: { prepare() { throw new Error('db exploded: secret detail'); } } };
  const err = await call(broken, 'GET', '/api/me', { token: 'ses_x' });
  assert.equal(err.status, 500);
  assert.doesNotMatch(JSON.stringify(err.data), /secret detail/);
});
