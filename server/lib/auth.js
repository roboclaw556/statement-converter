// Sessions, API keys, the signed-in team, entitlements and usage.
import { one, run, nowIso, period } from './db.js';
import { sha256Hex, safeEqual } from './crypto.js';
import { parseCookies, fail } from './http.js';
import { entitlementsFor, withinLimit, COMING_SOON } from '../../src/core/plans.js';

export async function loadSession(ctx) {
  const { req, env } = ctx;
  const header = req.headers.get('authorization') || '';
  let token = null, via = null;
  if (header.startsWith('Bearer ses_')) { token = header.slice(7); via = 'bearer'; }
  else {
    const c = parseCookies(req).sid;
    if (c && c.startsWith('ses_')) { token = c; via = 'cookie'; }
  }
  if (!token) return null;
  const row = await one(env,
    `SELECT s.token_hash, s.expires_at, s.client, u.id AS user_id, u.email, u.role, u.team_id
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    await sha256Hex(token));
  if (!row || row.expires_at < nowIso()) return null;
  return { ...row, via, token };
}

export async function loadTeam(env, teamId) {
  return one(env, 'SELECT * FROM teams WHERE id = ?', teamId);
}

/** Resolves the signed-in user, or throws 401. Checks the Origin on cookie-authenticated writes. */
export async function requireUser(ctx) {
  const s = await loadSession(ctx);
  if (!s) fail(401, 'unauthorized', 'Sign in first');
  if (s.via === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method)) {
    const origin = ctx.req.headers.get('origin');
    const site = new URL(ctx.env.SITE_URL || ctx.url.origin).origin;
    if (!origin || (origin !== site && origin !== ctx.url.origin)) fail(403, 'bad_origin', 'Cross-site request blocked');
  }
  const team = await loadTeam(ctx.env, s.team_id);
  ctx.session = s;
  ctx.user = { id: s.user_id, email: s.email, role: s.role };
  ctx.team = team;
  ctx.ent = entitlementsFor(team.plan, team.plan_status);
  return ctx;
}

export function requireOwner(ctx) {
  if (ctx.user.role !== 'owner') fail(403, 'owner_only', 'Only the account owner can do this');
}

export function requireFeature(ctx, feature, { allowComingSoon = false } = {}) {
  const v = ctx.ent[feature];
  if (!v) fail(402, 'upgrade_required', `Your plan does not include this feature`, { feature, upgrade: true });
  if (!allowComingSoon && COMING_SOON[feature] && ctx.env[`FEATURE_${feature.toUpperCase()}`] !== '1') {
    fail(403, 'coming_soon', COMING_SOON[feature], { feature, comingSoon: true });
  }
}

/** API key auth for /api/v1. Keys look like sk_<prefix>_<secret>. */
export async function requireApiKey(ctx) {
  const header = ctx.req.headers.get('authorization') || '';
  if (!header.startsWith('Bearer sk_')) fail(401, 'unauthorized', 'Send your API key as "Authorization: Bearer sk_..."');
  const key = header.slice(7);
  const row = await one(ctx.env, 'SELECT * FROM api_keys WHERE key_hash = ?', await sha256Hex(key));
  if (!row || row.revoked_at || !safeEqual(row.prefix, key.slice(0, row.prefix.length))) fail(401, 'unauthorized', 'Invalid or revoked API key');
  const team = await loadTeam(ctx.env, row.team_id);
  ctx.team = team;
  ctx.ent = entitlementsFor(team.plan, team.plan_status);
  ctx.apiKey = row;
  await run(ctx.env, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
  return ctx;
}

const LIMIT_KEYS = { statements: 'statementsPerMonth', api_pages: 'apiPagesPerMonth', ai_statements: 'aiCategorizePerMonth' };

export async function getUsage(env, teamId) {
  const p = period();
  const rows = (await env.DB.prepare('SELECT kind, count FROM usage WHERE team_id = ? AND period = ?').bind(teamId, p).all()).results || [];
  const u = { period: p, statements: 0, apiPages: 0, aiStatements: 0 };
  for (const r of rows) {
    if (r.kind === 'statements') u.statements = r.count;
    if (r.kind === 'api_pages') u.apiPages = r.count;
    if (r.kind === 'ai_statements') u.aiStatements = r.count;
  }
  return u;
}

/**
 * Atomically adds usage if it stays within the plan limit. Throws 402 when over.
 * The conditional UPSERT means two concurrent requests cannot both squeeze past the limit.
 */
export async function useQuota(ctx, kind, n = 1) {
  const limit = ctx.ent[LIMIT_KEYS[kind]];
  if (limit === 0) fail(402, 'upgrade_required', 'Your plan does not include this', { upgrade: true, kind });
  const p = period();
  if (limit === null || limit === undefined) {
    await run(ctx.env, `INSERT INTO usage (team_id, period, kind, count) VALUES (?, ?, ?, ?)
      ON CONFLICT (team_id, period, kind) DO UPDATE SET count = count + excluded.count`, ctx.team.id, p, kind, n);
    return;
  }
  if (n > limit) fail(402, 'limit', `This needs ${n} and your plan allows ${limit} a month`, { upgrade: true, kind, limit });
  await run(ctx.env, `INSERT INTO usage (team_id, period, kind, count) VALUES (?, ?, ?, 0)
    ON CONFLICT (team_id, period, kind) DO NOTHING`, ctx.team.id, p, kind);
  const r = await run(ctx.env, `UPDATE usage SET count = count + ? WHERE team_id = ? AND period = ? AND kind = ? AND count + ? <= ?`,
    n, ctx.team.id, p, kind, n, limit);
  const changed = r?.meta?.changes ?? r?.changes ?? 0;
  if (!changed) {
    const used = await one(ctx.env, 'SELECT count FROM usage WHERE team_id = ? AND period = ? AND kind = ?', ctx.team.id, p, kind);
    fail(402, 'limit', `You've used ${used?.count ?? limit} of ${limit} this month`, { upgrade: true, kind, limit, used: used?.count ?? limit });
  }
}

export { withinLimit };
