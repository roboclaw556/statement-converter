import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMimeMessage } from 'mimetext';
import PostalMime from 'postal-mime';
import { buildReply } from '../server/lib/email-reply.js';

function incoming(files) {
  const m = createMimeMessage();
  m.setSender('bookkeeper@example.com');
  m.setRecipient('statements@statementotter.com');
  m.setSubject('January statements');
  m.setHeader('Message-ID', '<abc123@example.com>');
  m.addMessage({ contentType: 'text/plain', data: 'see attached' });
  for (const f of files) {
    const bytes = readFileSync(new URL('./samples/' + f, import.meta.url));
    m.addAttachment({ filename: f, contentType: 'application/pdf', data: bytes.toString('base64') });
  }
  return new TextEncoder().encode(m.asRaw());
}

test('replies with converted files for each attached statement', async () => {
  const { raw, summary } = await buildReply(incoming(['uk_paid_in_out.pdf', 'signed_amount.pdf']), {
    from: 'statements@statementotter.com', to: 'bookkeeper@example.com', siteUrl: 'https://statementotter.com',
  });
  assert.deepEqual(summary.map((s) => s.status), ['reconciled', 'reconciled']);
  const parsed = await PostalMime.parse(raw);
  assert.equal(parsed.inReplyTo, '<abc123@example.com>');
  assert.deepEqual(parsed.attachments.map((a) => a.filename), [
    'uk_paid_in_out.xlsx', 'uk_paid_in_out-quickbooks.csv', 'uk_paid_in_out-xero.csv',
    'signed_amount.xlsx', 'signed_amount-quickbooks.csv', 'signed_amount-xero.csv',
  ]);
  assert.match(parsed.text, /Balanced to the cent/);
});

test('explains when no PDF is attached', async () => {
  const { raw } = await buildReply(incoming([]), { from: 'a@b.example', to: 'c@d.example' });
  assert.match((await PostalMime.parse(raw)).text, /did not find a PDF/);
});
