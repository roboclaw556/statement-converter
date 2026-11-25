// Outgoing email through Resend's HTTP API (free tier: 3,000 emails a month).
// Without RESEND_API_KEY (local dev and tests) messages go to env.__outbox instead.

export async function sendMail(env, { to, subject, text, html }) {
  if (!env.RESEND_API_KEY) {
    (env.__outbox ||= []).push({ to, subject, text });
    return { ok: true, dev: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'StatementOtter <hello@statementotter.com>', to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`email failed: ${res.status} ${await res.text()}`);
  return { ok: true };
}
