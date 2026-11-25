// Billing: Stripe Checkout and Customer Portal on the web, RevenueCat for the app stores.
// The plan on the team row is only ever changed by verified webhooks, never by the browser.
import { json, readJson, fail, str } from '../lib/http.js';
import { one, run } from '../lib/db.js';
import { hmacHex, safeEqual } from '../lib/crypto.js';
import { requireUser, requireOwner } from '../lib/auth.js';
import { PRODUCT_PLANS } from '../../src/core/plans.js';

const STRIPE = 'https://api.stripe.com/v1';

function form(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') out.push(form(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}

async function stripe(env, path, params, method = 'POST') {
  if (!env.STRIPE_SECRET_KEY) fail(503, 'billing_not_configured', 'Billing is not set up yet');
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : form(params),
  });
  const data = await res.json();
  if (!res.ok) fail(502, 'stripe_error', data?.error?.message || 'Payment provider error');
  return data;
}

function priceFor(env, plan, interval) {
  const key = `STRIPE_PRICE_${plan.toUpperCase()}_${interval === 'year' ? 'YEAR' : 'MONTH'}`;
  return env[key];
}

function planForPrice(env, priceId) {
  for (const plan of ['pro', 'firm']) {
    for (const iv of ['month', 'year']) if (priceFor(env, plan, iv) === priceId) return { plan, interval: iv };
  }
  return null;
}

export async function checkout(ctx) {
  await requireUser(ctx);
  requireOwner(ctx);
  const b = await readJson(ctx.req);
  const plan = ['pro', 'firm'].includes(b.plan) ? b.plan : fail(400, 'bad_plan', 'Choose pro or firm');
  const interval = b.interval === 'year' ? 'year' : 'month';
  const price = priceFor(ctx.env, plan, interval);
  if (!price) fail(503, 'billing_not_configured', 'Billing is not set up yet');
  if (ctx.team.plan_source !== 'web' && ctx.team.plan !== 'free' && ctx.team.plan_status === 'active') {
    fail(409, 'store_subscription', 'This account is subscribed through the app store. Manage it there.');
  }
  // Already subscribed on the web: plan changes go through the portal (prorated by Stripe).
  if (ctx.team.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(ctx.team.plan_status)) return portal(ctx);
  const site = ctx.env.SITE_URL || ctx.url.origin;
  const session = await stripe(ctx.env, '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': 1,
    client_reference_id: ctx.team.id,
    customer: ctx.team.stripe_customer_id || undefined,
    customer_email: ctx.team.stripe_customer_id ? undefined : ctx.user.email,
    allow_promotion_codes: 'true',
    'subscription_data[metadata][team_id]': ctx.team.id,
    'metadata[team_id]': ctx.team.id,
    automatic_tax: ctx.env.STRIPE_AUTOMATIC_TAX === '1' ? { enabled: 'true' } : undefined,
    success_url: `${site}/account/?checkout=success`,
    cancel_url: `${site}/pricing/?checkout=canceled`,
  });
  return json({ url: session.url });
}

export async function portal(ctx) {
  if (!ctx.user) { await requireUser(ctx); requireOwner(ctx); }
  if (!ctx.team.stripe_customer_id) fail(400, 'no_billing', 'No billing account yet. Choose a plan first.');
  const site = ctx.env.SITE_URL || ctx.url.origin;
  const s = await stripe(ctx.env, '/billing_portal/sessions', { customer: ctx.team.stripe_customer_id, return_url: `${site}/account/` });
  return json({ url: s.url });
}

/** Stripe-Signature: t=timestamp,v1=hex HMAC-SHA256 of "t.body". Rejects anything older than 5 minutes. */
export async function verifyStripeSignature(secret, header, body, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return sigs.some((s) => safeEqual(s, expected));
}

async function applySubscription(env, sub) {
  const teamId = sub.metadata?.team_id;
  const team = teamId
    ? await one(env, 'SELECT * FROM teams WHERE id = ?', teamId)
    : await one(env, 'SELECT * FROM teams WHERE stripe_customer_id = ?', sub.customer);
  if (!team) return;
  const priceId = sub.items?.data?.[0]?.price?.id;
  const mapped = planForPrice(env, priceId);
  const ended = ['canceled', 'incomplete_expired', 'unpaid'].includes(sub.status);
  const plan = !mapped || ended ? 'free' : mapped.plan;
  const status = ended ? 'canceled' : sub.status === 'incomplete' ? 'past_due' : sub.status;
  const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
  await run(env, `UPDATE teams SET plan = ?, plan_status = ?, plan_source = 'web', plan_interval = ?, period_end = ?,
      stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?`,
    plan, status, mapped?.interval || null, end ? new Date(end * 1000).toISOString() : null,
    sub.customer, ended ? null : sub.id, team.id);
}

export async function stripeWebhook(ctx) {
  const { env, req } = ctx;
  const body = await req.text();
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, req.headers.get('stripe-signature'), body))) {
    fail(400, 'bad_signature', 'Invalid signature');
  }
  const event = JSON.parse(body);
  const seen = await one(env, 'SELECT id FROM billing_events WHERE id = ?', event.id);
  if (seen) return json({ ok: true, duplicate: true });

  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const teamId = obj.client_reference_id || obj.metadata?.team_id;
    if (teamId) await run(env, 'UPDATE teams SET stripe_customer_id = ? WHERE id = ?', obj.customer, teamId);
    // Fetch the subscription so the plan comes from Stripe's record, not from the event alone.
    const sub = await stripe(env, `/subscriptions/${obj.subscription}`, null, 'GET');
    sub.metadata = { ...(sub.metadata || {}), team_id: sub.metadata?.team_id || teamId };
    await applySubscription(env, sub);
  } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
    await applySubscription(env, obj);
  } else if (event.type === 'invoice.payment_failed' && obj.customer) {
    await run(env, "UPDATE teams SET plan_status = 'past_due' WHERE stripe_customer_id = ?", obj.customer);
  }
  await run(env, 'INSERT INTO billing_events (id, provider, type) VALUES (?, ?, ?)', event.id, 'stripe', event.type);
  return json({ ok: true });
}

/**
 * RevenueCat webhook for in-app purchases (iOS / Android).
 * The app must log in to RevenueCat with app_user_id = our team id.
 */
export async function revenuecatWebhook(ctx) {
  const { env, req } = ctx;
  const auth = req.headers.get('authorization') || '';
  if (!env.REVENUECAT_WEBHOOK_SECRET || !safeEqual(auth, `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`)) fail(401, 'unauthorized', 'Bad webhook secret');
  const { event } = await readJson(req, 256 * 1024);
  if (!event?.id) fail(400, 'bad_event', 'Missing event');
  if (await one(env, 'SELECT id FROM billing_events WHERE id = ?', event.id)) return json({ ok: true, duplicate: true });
  const teamId = str(event.app_user_id, 80);
  const team = await one(env, 'SELECT * FROM teams WHERE id = ?', teamId);
  if (team) {
    const plan = PRODUCT_PLANS[event.product_id] || null;
    const source = event.store === 'PLAY_STORE' ? 'google' : 'apple';
    const activate = ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'SUBSCRIPTION_EXTENDED'].includes(event.type);
    const lapse = ['EXPIRATION'].includes(event.type);
    if (activate && plan) {
      if (team.stripe_subscription_id && team.plan_status === 'active') {
        // Already paying on the web; keep the web plan and record nothing else.
      } else {
        await run(env, `UPDATE teams SET plan = ?, plan_status = 'active', plan_source = ?, plan_interval = ?, period_end = ?, revenuecat_app_user_id = ? WHERE id = ?`,
          plan, source, /yearly/.test(event.product_id) ? 'year' : 'month',
          event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null, teamId, team.id);
      }
    } else if (lapse && team.plan_source !== 'web') {
      await run(env, "UPDATE teams SET plan = 'free', plan_status = 'canceled' WHERE id = ?", team.id);
    } else if (event.type === 'BILLING_ISSUE' && team.plan_source !== 'web') {
      await run(env, "UPDATE teams SET plan_status = 'past_due' WHERE id = ?", team.id);
    }
  }
  await run(env, 'INSERT INTO billing_events (id, provider, type) VALUES (?, ?, ?)', event.id, 'revenuecat', String(event.type));
  return json({ ok: true });
}
