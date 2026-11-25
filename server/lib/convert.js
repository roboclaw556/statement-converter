// Server-side conversion (API, email import, folder import). Same core as the browser.
import { getDocumentProxy } from 'unpdf';
import { convertPdf } from '../../src/core/index.js';
import { categorize } from '../../src/core/categorize.js';
import { lenderReport } from '../../src/core/lender.js';
import { fraudChecks } from '../../src/core/fraud.js';
import { all } from './db.js';

export async function loadRules(env, teamId) {
  return (await all(env, 'SELECT pattern, match_type AS matchType, category FROM rules WHERE team_id = ? ORDER BY created_at', teamId));
}

/**
 * @param {Uint8Array} bytes
 * @param {{dateOrder?, include?: Set<string>, rules?: Array, password?: string}} opts
 */
export async function convertBytes(bytes, opts = {}) {
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes.slice(), { password: opts.password });
  } catch (e) {
    if (e?.name === 'PasswordException') return { error: 'password_required', message: 'This PDF is password protected. Send the password in the X-PDF-Password header.' };
    return { error: 'unreadable', message: 'Could not read this PDF.' };
  }
  const pages = pdf.numPages;
  const result = await convertPdf(pdf, { dateOrder: opts.dateOrder });
  const include = opts.include || new Set();
  if (include.has('categories')) result.transactions = categorize(result.transactions, opts.rules || []);
  const extra = {};
  if (include.has('lender')) extra.lender = lenderReport(result);
  if (include.has('fraud')) extra.fraud = fraudChecks(await pdf.getMetadata().catch(() => null), bytes, result);
  return { pages, result, ...extra };
}
