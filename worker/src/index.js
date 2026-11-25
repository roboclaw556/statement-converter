// Cloudflare Email Worker. Route an address such as statements@yourdomain.com to
// this worker (Email Routing), and it replies to the sender with the converted files.
// Bindings: DB (the same D1 database as the site) for a simple per-sender daily limit.
import { EmailMessage } from 'cloudflare:email';
import { buildReply } from './process.js';

const DAILY_LIMIT = 20;

async function hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export default {
  async email(message, env) {
    const sender = message.from;
    if (env.DB) {
      const h = await hash(sender);
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS email_jobs (sender_hash TEXT, created_at TEXT DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\')))').run();
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_jobs WHERE sender_hash = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')").bind(h).first();
      if (row && row.n >= DAILY_LIMIT) { message.setReject('Daily limit reached, try again tomorrow.'); return; }
      await env.DB.prepare('INSERT INTO email_jobs (sender_hash) VALUES (?)').bind(h).run();
    }
    const raw = await new Response(message.raw).arrayBuffer();
    const { raw: reply } = await buildReply(raw, {
      from: message.to, to: sender, brand: env.BRAND || 'StatementOtter', siteUrl: env.SITE_URL || '',
    });
    await message.reply(new EmailMessage(message.to, sender, reply));
  },
};
