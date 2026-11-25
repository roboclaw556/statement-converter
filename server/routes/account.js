// Sign-in (email link or 6-digit code), the signed-in profile, teams, invites, usage.
import { json, readJson, fail, isEmail, str, sessionCookie, clearCookie } from '../lib/http.js';
import { one, all, run, nowIso, isoIn, rateLimit } from '../lib/db.js';
import { randomToken, randomId, randomCode, sha256Hex, safeEqual } from '../lib/crypto.js';
import { requireUser, requireOwner, getUsage, useQuota } from '../lib/auth.js';
import { sendMail } from '../lib/mail.js';
import { PLANS, COMING_SOON } from '../../src/core/plans.js';

const LOGIN_TTL = 15 * 60;
const SESSION_TTL = { web: 30 * 86400, ios: 180 * 86400, android: 180 * 86400 };

const brand = (env) => env.BRAND || 'StatementOtter';

export async function startLogin(ctx) {
  const { env } = ctx;
  const body = await readJson(ctx.req);
  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) fail(400, 'bad_email', 'Enter a valid email address');
  // Same answer whether or not the address has an account, so this can't be used to probe for users.
  if (!(await rateLimit(env, `login:${email}`, 5, 900)) || !(await rateLimit(env, `login-ip:${ctx.ip}`, 30, 3600))) {
    fail(429, 'rate_limited', 'Too many sign-in emails. Wait a few minutes and try again.');
  }
  const link = randomToken(32);
  const code = randomCode();
  const id = randomId('lc_');
  await run(env, 'INSERT INTO login_codes (id, email, link_hash, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    id, email, await sha256Hex(link), await sha256Hex(id + ':' + code), isoIn(LOGIN_TTL));
  const url = `${env.SITE_URL || ctx.url.origin}/login/#t=${link}`;
  await sendMail(env, {
    to: email,
    subject: `${code} is your ${brand(env)} sign-in code`,
    text: `Sign in to ${brand(env)}:\n\n${url}\n\nOr enter this code: ${code}\n\nIt expires in 15 minutes. If you didn't ask for this, ignore this email.`,
  });
  return json({ ok: true, ...(env.DEV === '1' ? { dev: { code, link } } : {}) });
}

async function findOrCreateUser(env, email) {
  const existing = await one(env, 'SELECT * FROM users WHERE email = ?', email);
  if (existing) return existing;
  const invite = await one(env, 'SELECT * FROM invites WHERE email = ? ORDER BY created_at DESC', email);
  const userId = randomId('usr_');
  if (invite) {
    await run(env, 'INSERT INTO users (id, email, team_id, role) VALUES (?, ?, ?, ?)', userId, email, invite.team_id, 'member');
    await run(env, 'DELETE FROM invites WHERE email = ?', email);
  } else {
    const teamId = randomId('team_');
    await run(env, 'INSERT INTO teams (id, name, inbox_address) VALUES (?, ?, ?)', teamId, email.split('@')[1] || '', randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x'));
    await run(env, 'INSERT INTO users (id, email, team_id, role) VALUES (?, ?, ?, ?)', userId, email, teamId, 'owner');
  }
  return one(env, 'SELECT * FROM users WHERE id = ?', userId);
}

export async function verifyLogin(ctx) {
  const { env } = ctx;
  const body = await readJson(ctx.req);
  const client = ['ios', 'android'].includes(body.client) ? body.client : 'web';
  let row;
  if (body.link) {
    row = await one(env, 'SELECT * FROM login_codes WHERE link_hash = ?', await sha256Hex(str(body.link, 100)));
    if (!row || row.used_at || row.expires_at < nowIso()) fail(400, 'invalid_link', 'This sign-in link has expired or was already used');
  } else {
    const email = str(body.email, 254).toLowerCase();
    const code = str(body.code, 6);
    if (!isEmail(email) || !/^\d{6}$/.test(code)) fail(400, 'invalid_code', 'Enter the 6-digit code from the email');
    row = await one(env, 'SELECT * FROM login_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC', email, nowIso());
    if (!row || row.attempts >= 5) fail(400, 'invalid_code', 'That code has expired. Ask for a new one.');
    await run(env, 'UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    if (!safeEqual(await sha256Hex(row.id + ':' + code), row.code_hash)) fail(400, 'invalid_code', 'That code is not right');
  }
  // Single use: only the request that flips used_at wins.
  const flip = await run(env, 'UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', nowIso(), row.id);
  if (!(flip?.meta?.changes ?? 1)) fail(400, 'invalid_link', 'This sign-in link was already used');

  const user = await findOrCreateUser(env, row.email);
  const token = 'ses_' + randomToken(32);
  await run(env, 'INSERT INTO sessions (token_hash, user_id, client, expires_at) VALUES (?, ?, ?, ?)',
    await sha256Hex(token), user.id, client, isoIn(SESSION_TTL[client]));
  const headers = client === 'web' ? { 'set-cookie': sessionCookie(token, SESSION_TTL.web) } : {};
  return json({ ok: true, token, user: { id: user.id, email: user.email, role: user.role } }, 200, headers);
}

export async function logout(ctx) {
  await requireUser(ctx);
  await run(ctx.env, 'DELETE FROM sessions WHERE token_hash = ?', ctx.session.token_hash);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}

export async function me(ctx) {
  await requireUser(ctx);
  const t = ctx.team;
  const comingSoon = Object.fromEntries(Object.entries(COMING_SOON).filter(([k]) => ctx.env[`FEATURE_${k.toUpperCase()}`] !== '1'));
  return json({
    user: ctx.user,
    team: {
      id: t.id, name: t.name, plan: t.plan, planName: PLANS[t.plan]?.name, planSource: t.plan_source, status: t.plan_status,
      interval: t.plan_interval, periodEnd: t.period_end,
      inboxAddress: t.inbox_address && ctx.env.INBOX_DOMAIN ? `${t.inbox_address}@${ctx.env.INBOX_DOMAIN}` : null,
    },
    entitlements: ctx.ent,
    comingSoon,
    usage: await getUsage(ctx.env, t.id),
  });
}

/** Deletes the signed-in user. An owner who is alone on the team deletes the team's data too. */
export async function deleteMe(ctx) {
  await requireUser(ctx);
  const { env } = ctx;
  const members = await all(env, 'SELECT id FROM users WHERE team_id = ?', ctx.team.id);
  if (ctx.user.role === 'owner' && members.length > 1) fail(409, 'team_has_members', 'Remove your team members first');
  if (ctx.user.role === 'owner' && ctx.team.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(ctx.team.plan_status)) {
    fail(409, 'active_subscription', 'Cancel your subscription in billing first');
  }
  await run(env, 'DELETE FROM sessions WHERE user_id = ?', ctx.user.id);
  await run(env, 'DELETE FROM users WHERE id = ?', ctx.user.id);
  if (members.length === 1) {
    const uploads = await all(env, 'SELECT r2_key FROM client_uploads WHERE team_id = ?', ctx.team.id);
    for (const u of uploads) await env.FILES?.delete(u.r2_key);
    for (const tbl of ['client_uploads', 'clients', 'rules', 'api_keys', 'integrations', 'usage', 'invites', 'folder_files', 'pushes']) {
      await run(env, `DELETE FROM ${tbl} WHERE team_id = ?`, ctx.team.id);
    }
    await run(env, 'DELETE FROM teams WHERE id = ?', ctx.team.id);
  }
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}

export async function getTeam(ctx) {
  await requireUser(ctx);
  const members = await all(ctx.env, 'SELECT id, email, role, created_at FROM users WHERE team_id = ? ORDER BY created_at', ctx.team.id);
  const invites = await all(ctx.env, 'SELECT id, email, created_at FROM invites WHERE team_id = ? ORDER BY created_at', ctx.team.id);
  return json({ members, invites, seats: ctx.ent.seats });
}

export async function updateTeam(ctx) {
  await requireUser(ctx);
  requireOwner(ctx);
  const b = await readJson(ctx.req);
  if (b.name !== undefined) await run(ctx.env, 'UPDATE teams SET name = ? WHERE id = ?', str(b.name, 80), ctx.team.id);
  return json({ ok: true });
}

export async function invite(ctx) {
  await requireUser(ctx);
  requireOwner(ctx);
  const email = str((await readJson(ctx.req)).email, 254).toLowerCase();
  if (!isEmail(email)) fail(400, 'bad_email', 'Enter a valid email address');
  const used = (await one(ctx.env, 'SELECT COUNT(*) AS n FROM users WHERE team_id = ?', ctx.team.id)).n
    + (await one(ctx.env, 'SELECT COUNT(*) AS n FROM invites WHERE team_id = ?', ctx.team.id)).n;
  if (used >= ctx.ent.seats) fail(402, 'seats_full', `Your plan includes ${ctx.ent.seats} seat(s)`, { upgrade: true });
  if (await one(ctx.env, 'SELECT id FROM users WHERE email = ?', email)) fail(409, 'already_has_account', 'That person already has an account');
  if (!(await rateLimit(ctx.env, `invite:${ctx.team.id}`, 20, 86400))) fail(429, 'rate_limited', 'Too many invites today');
  await run(ctx.env, 'INSERT OR IGNORE INTO invites (id, team_id, email) VALUES (?, ?, ?)', randomId('inv_'), ctx.team.id, email);
  await sendMail(ctx.env, {
    to: email,
    subject: `${ctx.user.email} invited you to ${brand(ctx.env)}`,
    text: `${ctx.user.email} added you to their team on ${brand(ctx.env)}.\n\nSign in with this email address to join: ${ctx.env.SITE_URL || ctx.url.origin}/login/`,
  });
  return json({ ok: true });
}

export async function removeInvite(ctx, id) {
  await requireUser(ctx);
  requireOwner(ctx);
  await run(ctx.env, 'DELETE FROM invites WHERE id = ? AND team_id = ?', id, ctx.team.id);
  return json({ ok: true });
}

export async function removeMember(ctx, id) {
  await requireUser(ctx);
  requireOwner(ctx);
  if (id === ctx.user.id) fail(400, 'cannot_remove_self', 'You cannot remove yourself');
  const m = await one(ctx.env, 'SELECT id FROM users WHERE id = ? AND team_id = ?', id, ctx.team.id);
  if (!m) fail(404, 'not_found', 'No such member');
  await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ?', id);
  await run(ctx.env, 'DELETE FROM users WHERE id = ?', id);
  return json({ ok: true });
}

/** On-device conversions (web and mobile) are counted here, so Free's monthly limit holds everywhere. */
export async function countStatement(ctx) {
  await requireUser(ctx);
  const b = await readJson(ctx.req);
  const n = Number.isInteger(b.statements) && b.statements > 0 && b.statements <= 50 ? b.statements : 1;
  await useQuota(ctx, 'statements', n);
  return json({ ok: true, usage: await getUsage(ctx.env, ctx.team.id) });
}
