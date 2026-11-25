// Email import: statements@yourdomain -> converted files back to the sender.
// Kept free of Cloudflare-only APIs so it can be tested in Node.
import PostalMime from 'postal-mime';
import { createMimeMessage } from 'mimetext';
import { getDocumentProxy } from 'unpdf';
import { convertPdf, toXlsx, toQuickBooksCsv, toXeroCsv, formatCents } from '../../src/core/index.js';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDFS = 10;

const toBase64 = (bytes) => {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
};

/**
 * @param {ArrayBuffer|Uint8Array} raw the incoming email
 * @param {{from: string, to: string, brand?: string, siteUrl?: string}} opts
 * @returns {Promise<{raw: string, summary: object[]}>} the reply as raw MIME
 */
export async function buildReply(raw, { from, to, brand = 'StatementOtter', siteUrl = '' }) {
  const email = await PostalMime.parse(raw);
  const pdfs = (email.attachments || [])
    .filter((a) => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename || ''))
    .slice(0, MAX_PDFS);

  const msg = createMimeMessage();
  msg.setSender({ name: brand, addr: from });
  msg.setRecipient(to);
  msg.setSubject('Re: ' + (email.subject || 'your bank statements'));
  if (email.messageId) {
    msg.setHeader('In-Reply-To', email.messageId);
    msg.setHeader('References', email.messageId);
  }

  const summary = [];
  for (const att of pdfs) {
    const name = (att.filename || 'statement.pdf').replace(/[^\w.\- ]+/g, '_');
    const bytes = new Uint8Array(att.content);
    if (bytes.length > MAX_PDF_BYTES) { summary.push({ name, error: 'File is larger than 10 MB.' }); continue; }
    try {
      const pdf = await getDocumentProxy(bytes);
      const r = await convertPdf(pdf);
      if (r.scanned || !r.transactions.length) {
        summary.push({ name, error: r.warnings[0] || 'No transactions found.' });
        continue;
      }
      const base = name.replace(/\.pdf$/i, '');
      const style = r.dateOrder === 'DMY' ? 'DMY' : 'MDY';
      msg.addAttachment({ filename: base + '.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: toBase64(toXlsx(r)) });
      msg.addAttachment({ filename: base + '-quickbooks.csv', contentType: 'text/csv', data: toBase64(new TextEncoder().encode(toQuickBooksCsv(r, style))) });
      msg.addAttachment({ filename: base + '-xero.csv', contentType: 'text/csv', data: toBase64(new TextEncoder().encode(toXeroCsv(r, style))) });
      summary.push({ name, status: r.status, transactions: r.transactions.length, flagged: r.flaggedCount, difference: r.difference });
    } catch (e) {
      summary.push({ name, error: e?.name === 'PasswordException' ? 'This PDF is password protected. Open it on the website instead.' : 'Could not read this PDF.' });
    }
  }

  const lines = [];
  if (!pdfs.length) lines.push('We did not find a PDF attached. Forward or attach your bank statement PDFs and we will send back Excel, QuickBooks and Xero files.');
  for (const s of summary) {
    if (s.error) { lines.push(`${s.name}: not converted. ${s.error}`); continue; }
    const check = s.status === 'reconciled' ? 'Balanced to the cent.'
      : s.status === 'running_balance_ok' ? 'Running balance checks out.'
      : s.status === 'mismatch' ? `Does NOT balance (off by ${formatCents(s.difference)}). ${s.flagged} row(s) flagged in the Excel file.`
      : 'Could not verify against the statement balances; please spot-check.';
    lines.push(`${s.name}: ${s.transactions} transactions. ${check}`);
  }
  if (siteUrl) lines.push('', `Want to fix a row before importing? Open the PDF at ${siteUrl}, it converts on your own device.`);
  lines.push('', `Tell us what to improve: ${siteUrl ? siteUrl + '/feedback/' : 'reply to this email'}`);
  msg.addMessage({ contentType: 'text/plain', data: lines.join('\n') });
  return { raw: msg.asRaw(), summary };
}
