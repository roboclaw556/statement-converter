// Inbound email (Cloudflare Email Routing → this Worker). Two kinds of address:
//   <team inbox>@INBOX_DOMAIN   each team's private address (shown on the account page)
//   statements@INBOX_DOMAIN     shared address; works for any signed-up user on a plan with email import
// The sender must be a member of a team whose plan includes email import. Everyone else gets a
// short reply explaining how to turn it on. Replies carry Excel + QuickBooks + Xero files.
import { buildReply } from './lib/email-reply.js';
import { one, run, nowIso } from './lib/db.js';
import { sha256Hex } from './lib/crypto.js';
import { rateLimit } from './lib/db.js';
import { entitlementsFor } from '../src/core/plans.js';
import { createMimeMessage } from 'mimetext';

const DAILY_LIMIT = 50;

/** Decides what to do with a message. Kept separate from Cloudflare APIs so it can be tested. */
export async function routeEmail(env, { from, to }) {
  const sender = String(from || '').toLowerCase().trim();
  const local = String(to || '').toLowerCase().split('@')[0].split('+')[0];
  const user = await one(env, 'SELECT u.id, u.team_id FROM users u WHERE u.email = ?', sender);
  let team = null;
  if (local !== 'statements') {
    team = await one(env, 'SELECT * FROM teams WHERE inbox_address = ?', local);
    if (!team) return { action: 'reject', reason: 'Unknown address' };
    if (!user || user.team_id !== team.id) return { action: 'notice', reason: 'not_member' };
  } else {
    if (!user) return { action: 'notice', reason: 'no_account' };
    team = await one(env, 'SELECT * FROM teams WHERE id = ?', user.team_id);
  }
  if (!entitlementsFor(team.plan, team.plan_status).emailImport) return { action: 'notice', reason: 'upgrade' };
  if (!(await rateLimit(env, `email:${await sha256Hex(sender)}`, DAILY_LIMIT, 86400))) return { action: 'reject', reason: 'Daily limit reached, try again tomorrow.' };
  return { action: 'convert', team };
}

const NOTICES = {
  not_member: 'This address only accepts statements from members of its team. Sign in and invite yourself from the account page, or send from the address you signed up with.',
  no_account: 'Email import is part of StatementOtter Pro. Create a free account with this email address, then upgrade to send statements by email.',
  upgrade: 'Email import is part of the Pro and Firm plans. Upgrade on your account page and send this again.',
};

export function noticeReply({ from, to, subject, reason, siteUrl, brand }) {
  const m = createMimeMessage();
  m.setSender({ name: brand, addr: from });
  m.setRecipient(to);
  m.setSubject('Re: ' + (subject || 'your bank statements'));
  m.addMessage({ contentType: 'text/plain', data: `${NOTICES[reason]}\n\n${siteUrl}/pricing/` });
  return m.asRaw();
}

export async function handleEmail(message, env) {
  const { EmailMessage } = await import('cloudflare:email');
  const brand = env.BRAND || 'StatementOtter';
  const siteUrl = env.SITE_URL || '';
  const decision = await routeEmail(env, { from: message.from, to: message.to });
  if (decision.action === 'reject') { message.setReject(decision.reason); return; }
  if (decision.action === 'notice') {
    const raw = noticeReply({ from: message.to, to: message.from, subject: message.headers.get('subject'), reason: decision.reason, siteUrl, brand });
    await message.reply(new EmailMessage(message.to, message.from, raw));
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const { raw: reply, summary } = await buildReply(raw, { from: message.to, to: message.from, brand: decision.team.brand_name || brand, siteUrl });
  const ok = summary.filter((s) => !s.error).length;
  if (ok) {
    await run(env, `INSERT INTO usage (team_id, period, kind, count) VALUES (?, ?, 'statements', ?)
      ON CONFLICT (team_id, period, kind) DO UPDATE SET count = count + excluded.count`, decision.team.id, nowIso().slice(0, 7), ok);
  }
  await message.reply(new EmailMessage(message.to, message.from, reply));
}
