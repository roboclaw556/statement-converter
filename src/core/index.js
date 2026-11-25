import { extractLines } from './extract.js';
import { parseStatement } from './parse.js';
import { reconcile } from './reconcile.js';

export { extractLines, parseStatement, reconcile };
export * from './export.js';
export { formatCents } from './reconcile.js';

/**
 * One call from a pdf.js document to checked transactions.
 * @param pdf a pdf.js PDFDocumentProxy
 * @param {{dateOrder?: 'MDY'|'DMY'}} opts
 */
export async function convertPdf(pdf, opts = {}) {
  const { pages, hasText } = await extractLines(pdf);
  if (!hasText) {
    return {
      transactions: [], opening: null, closing: null, credits: 0, debits: 0, status: 'unverified',
      difference: null, checks: [], flaggedCount: 0, dateOrder: opts.dateOrder || 'MDY',
      warnings: ['This PDF has no text layer (it looks scanned). Scanned statements need OCR, coming in a later version.'],
      scanned: true,
    };
  }
  return fromLines(pages, opts);
}

export function fromLines(pages, opts = {}) {
  const st = parseStatement(pages, opts);
  const result = reconcile(st);
  return { ...result, dateOrder: st.dateOrder, warnings: st.warnings, pages };
}
export { FORMATS, formatById } from './formats.js';
