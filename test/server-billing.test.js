// Battle tests: Stripe and RevenueCat webhooks, checkout, API keys and the public API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeEnv, call, signIn, setPlan, sample, mockFetch } from './helpers.js';

const PRICES = { STRIPE_PRICE_PRO_MONTH: 'price_pm', STRIPE_PRICE_PRO_YEAR: 'price_py', STRIPE_PRICE_FIRM_MONTH: 'price_fm', STRIPE_PRICE_FIRM_YEAR: 'price_fy' };
const stripeEnv = () => makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', REVENUECAT_WEBHOOK_SECRET: 'rc_secret', ...PRICES });

function signed(env, event, { secret = env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return call(env, 'POST', '/api/webhooks/stripe', { raw: body, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
}

const sub = (teamId, price, status = 'active', id = 'sub_1') => ({
  id, customer: 'cus_1', status, metadata: { team_id: teamId },
  items: { data: [{ price: { id: price }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
});

test('checkout creates a Stripe session for the owner with the right price', async () => {
  const env = stripeEnv();
  const t = await signIn(env, 'pay@example.com');
  const f = mockFetch([[/checkout\/sessions/, (url, init) => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1', _body: init.body })]]);
  try {
    const r = await call(env, 'POST', '/api/billing/checkout', { token: t, body: { plan: 'firm', interval: 'year' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.url, 'https://checkout.stripe.test/cs_1');
    const body = decodeURIComponent(f.calls[0].init.body);
    assert.match(body, /line_items\[0\]\[price\]=price_fy/);
    assert.match(body, /client_reference_id=team_/);
    assert.equal(f.calls[0].init.headers.authorization, 'Bearer sk_test_x');
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { token: t, body: { plan: 'enterprise' } })).status, 400);
  } finally { f.restore(); }
});

test('stripe webhook: signature, plan changes, idempotency, cancellation', async () => {
  const env = stripeEnv();
  const t = await signIn(env, 'hook@example.com');
  const teamId = (await call(env, 'GET', '/api/me', { token: t })).data.team.id;
  const ev = (id, type, obj) => ({ id, type, data: { object: obj } });

  assert.equal((await signed(env, ev('evt_0', 'customer.subscription.updated', sub(teamId, 'price_fm')), { secret: 'wrong' })).status, 400);
  assert.equal((await signed(env, ev('evt_0', 'customer.subscription.updated', sub(teamId, 'price_fm')), { t: Math.floor(Date.now() / 1000) - 600 })).status, 400, 'replayed old signature');
  assert.equal((await call(env, 'POST', '/api/webhooks/stripe', { raw: '{}' })).status, 400);
  assert.equal((await call(env, 'GET', '/api/me', { token: t })).data.team.plan, 'free');

  // checkout completed: fetches the subscription from Stripe
  const f = mockFetch([[/\/subscriptions\/sub_1/, () => sub(undefined, 'price_pm')]]);
  try {
    assert.equal((await signed(env, ev('evt_1', 'checkout.session.completed', { mode: 'subscription', client_reference_id: teamId, customer: 'cus_1', subscription: 'sub_1' }))).status, 200);
  } finally { f.restore(); }
  let me = (await call(env, 'GET', '/api/me', { token: t })).data;
  assert.equal(me.team.plan, 'pro');
  assert.equal(me.team.interval, 'month');
  assert.equal(me.entitlements.lenderReport, true);

  // upgrade to firm via portal → subscription.updated
  assert.equal((await signed(env, ev('evt_2', 'customer.subscription.updated', sub(teamId, 'price_fy')))).status, 200);
  me = (await call(env, 'GET', '/api/me', { token: t })).data;
  assert.equal(me.team.plan, 'firm');
  assert.equal(me.team.interval, 'year');

  // the same event again does nothing (even if state changed since)
  env.DB.raw.prepare("UPDATE teams SET plan = 'pro'").run();
  assert.equal((await signed(env, ev('evt_2', 'customer.subscription.updated', sub(teamId, 'price_fy')))).data.duplicate, true);
  assert.equal((await call(env, 'GET', '/api/me', { token: t })).data.team.plan, 'pro');

  // unknown price never grants a plan
  await signed(env, ev('evt_3', 'customer.subscription.updated', sub(teamId, 'price_unknown')));
  assert.equal((await call(env, 'GET', '/api/me', { token: t })).data.team.plan, 'free');

  await signed(env, ev('evt_4', 'customer.subscription.updated', sub(teamId, 'price_pm')));
  await signed(env, ev('evt_5', 'invoice.payment_failed', { customer: 'cus_1' }));
  me = (await call(env, 'GET', '/api/me', { token: t })).data;
  assert.equal(me.team.status, 'past_due');
  assert.equal(me.entitlements.lenderReport, true, 'grace period keeps features');

  await signed(env, ev('evt_6', 'customer.subscription.deleted', sub(teamId, 'price_pm', 'canceled')));
  me = (await call(env, 'GET', '/api/me', { token: t })).data;
  assert.equal(me.team.plan, 'free');
  assert.equal(me.entitlements.lenderReport, false);
});

test('a failed webhook can be retried', async () => {
  const env = stripeEnv();
  const t = await signIn(env, 'retry@example.com');
  const teamId = (await call(env, 'GET', '/api/me', { token: t })).data.team.id;
  const event = { id: 'evt_r', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: teamId, customer: 'cus_1', subscription: 'sub_1' } } };
  let f = mockFetch([[/subscriptions/, () => new Response('{"error":{"message":"down"}}', { status: 500 })]]);
  try { assert.equal((await signed(env, event)).status, 502); } finally { f.restore(); }
  f = mockFetch([[/subscriptions/, () => sub(undefined, 'price_pm')]]);
  try { assert.equal((await signed(env, event)).status, 200); } finally { f.restore(); }
  assert.equal((await call(env, 'GET', '/api/me', { token: t })).data.team.plan, 'pro');
});

test('revenuecat: app store purchases, expiry, and web subscriptions win', async () => {
  const env = stripeEnv();
  const t = await signIn(env, 'app@example.com');
  const teamId = (await call(env, 'GET', '/api/me', { token: t })).data.team.id;
  const rc = (event, secret = 'rc_secret') => call(env, 'POST', '/api/webhooks/revenuecat', { body: { event }, headers: { authorization: `Bearer ${secret}` } });
  assert.equal((await rc({ id: 'rc1', type: 'INITIAL_PURCHASE', app_user_id: teamId, product_id: 'firm_monthly', store: 'APP_STORE' }, 'nope')).status, 401);
  assert.equal((await rc({ id: 'rc1', type: 'INITIAL_PURCHASE', app_user_id: teamId, product_id: 'firm_monthly', store: 'APP_STORE', expiration_at_ms: Date.now() + 1e9 })).status, 200);
  let me = (await call(env, 'GET', '/api/me', { token: t })).data;
  assert.equal(me.team.plan, 'firm');
  assert.equal(me.team.planSource, 'apple');
  assert.equal((await rc({ id: 'rc1', type: 'EXPIRATION', app_user_id: teamId })).data.duplicate, true);
  // web checkout is refused while an app-store plan is active
  assert.equal((await call(env, 'POST', '/api/billing/checkout', { token: t, body: { plan: 'pro' } })).status, 409);
  await rc({ id: 'rc2', type: 'EXPIRATION', app_user_id: teamId, product_id: 'firm_monthly', store: 'APP_STORE' });
  me = (await call(env, 'GET', '/api/me', { token: t })).data;
  assert.equal(me.team.plan, 'free');
  await rc({ id: 'rc3', type: 'INITIAL_PURCHASE', app_user_id: 'team_doesnotexist', product_id: 'pro_monthly', store: 'PLAY_STORE' });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM teams WHERE plan != 'free'").get().n, 0);
});

test('API keys: Firm only, owner only, shown once, hashed, revocable', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'dev@firm.test');
  assert.equal((await call(env, 'POST', '/api/keys', { token: t, body: { name: 'x' } })).status, 402);
  await setPlan(env, t, 'firm');
  const k = await call(env, 'POST', '/api/keys', { token: t, body: { name: 'Zapier' } });
  assert.equal(k.status, 201);
  assert.match(k.data.key, /^sk_[\w]+_[\w-]+$/);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE key_hash = ?').get(k.data.key).n, 0, 'stored hashed');
  const list = await call(env, 'GET', '/api/keys', { token: t });
  assert.equal(list.data.keys.length, 1);
  assert.equal(JSON.stringify(list.data).includes(k.data.key), false);
  // an API key is not a session
  assert.equal((await call(env, 'GET', '/api/me', { token: k.data.key })).status, 401);
  assert.equal((await call(env, 'GET', '/api/v1/usage', { token: k.data.key })).status, 200);
  assert.equal((await call(env, 'GET', '/api/v1/usage', { token: k.data.key.slice(0, -2) + 'xx' })).status, 401);
  // another team can't revoke it
  const other = await signIn(env, 'other@firm.test');
  await setPlan(env, other, 'firm');
  assert.equal((await call(env, 'DELETE', `/api/keys/${list.data.keys[0].id}`, { token: other })).status, 404);
  assert.equal((await call(env, 'DELETE', `/api/keys/${list.data.keys[0].id}`, { token: t })).status, 200);
  assert.equal((await call(env, 'GET', '/api/v1/usage', { token: k.data.key })).status, 401);
});

test('public API converts PDFs, meters pages, enforces limits', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'api@firm.test');
  await setPlan(env, t, 'firm');
  const key = (await call(env, 'POST', '/api/keys', { token: t, body: {} })).data.key;
  const pdf = sample('us_debit_credit.pdf');
  const r = await call(env, 'POST', '/api/v1/convert?include=categories,lender,fraud', { token: key, raw: pdf, headers: { 'content-type': 'application/pdf' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.check.status, 'reconciled');
  assert.ok(r.data.transactions.length > 5);
  assert.ok(r.data.transactions.every((x) => Number.isInteger(x.amount) && x.category));
  assert.ok(r.data.lender.monthly.length);
  assert.ok(['low', 'medium', 'high'].includes(r.data.fraud.level));
  const pages = r.data.pages;

  const csv = await call(env, 'POST', '/api/v1/convert?format=quickbooks', { token: key, raw: pdf });
  assert.equal(csv.status, 200);
  assert.match(csv.res.headers.get('content-type'), /csv/);
  assert.match(await csv.res.text(), /Date,Description,Amount/i);

  const fd = new FormData();
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'jan.pdf');
  const mp = await call(env, 'POST', '/api/v1/convert', { token: key, body: fd });
  assert.equal(mp.status, 200);
  assert.equal(mp.data.filename, 'jan.pdf');

  const usage = await call(env, 'GET', '/api/v1/usage', { token: key });
  assert.equal(usage.data.usage.apiPages, pages * 3);

  assert.equal((await call(env, 'POST', '/api/v1/convert', { token: key, raw: new TextEncoder().encode('hello') })).status, 415);
  assert.equal((await call(env, 'POST', '/api/v1/convert', { token: key, raw: new TextEncoder().encode('%PDF-1.4 garbage') })).status, 422);
  assert.equal((await call(env, 'POST', '/api/v1/convert?format=docx', { token: key, raw: pdf })).status, 400);
  assert.equal((await call(env, 'POST', '/api/v1/convert?include=secrets', { token: key, raw: pdf })).status, 400);
  assert.equal((await call(env, 'GET', '/api/v1/usage', { token: key })).data.usage.apiPages, pages * 3, 'failures are not charged');

  env.DB.raw.prepare("UPDATE usage SET count = ? WHERE kind = 'api_pages'").run(2000 - pages + 1);
  const over = await call(env, 'POST', '/api/v1/convert', { token: key, raw: pdf });
  assert.equal(over.status, 402);
  assert.equal(over.data.upgrade, true);
  const formats = await call(env, 'GET', '/api/v1/formats');
  assert.equal(formats.data.formats.length, 17);
  // CORS is open on /api/v1 for server-side and browser clients
  const pre = await call(env, 'OPTIONS', '/api/v1/convert', { origin: 'https://anything.test' });
  assert.equal(pre.res.headers.get('access-control-allow-origin'), '*');
});

test('password-protected PDFs through the API', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'pw@firm.test');
  await setPlan(env, t, 'firm');
  const key = (await call(env, 'POST', '/api/keys', { token: t, body: {} })).data.key;
  const pdf = sample('locked.pdf');
  const r = await call(env, 'POST', '/api/v1/convert', { token: key, raw: pdf });
  assert.equal(r.status, 422);
  assert.equal(r.data.error, 'password_required');
  const ok = await call(env, 'POST', '/api/v1/convert', { token: key, raw: pdf, headers: { 'x-pdf-password': 'secret' } });
  assert.equal(ok.status, 200);
});
