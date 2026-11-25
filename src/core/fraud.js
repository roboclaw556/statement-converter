// Tamper and fraud checks. Signals, not proof: each finding says what was seen
// so a person can look closer. Works from what every environment has: the
// pdf.js metadata, the raw file bytes and the parsed result.

const EDITORS = [
  'photoshop', 'illustrator', 'gimp', 'inkscape', 'canva', 'ilovepdf', 'smallpdf', 'sejda', 'pdfescape',
  'pdf-xchange editor', 'phantompdf', 'foxit pdf editor', 'nitro', 'pdfelement', 'wondershare', 'pdffiller',
  'dochub', 'microsoft word', 'microsoft excel', 'libreoffice', 'openoffice', 'google docs', 'pages', 'preview',
  'quartz pdfcontext', 'sodapdf', 'pdf candy', 'pdf2go', 'pdfsam',
];

function parsePdfDate(s) {
  // D:YYYYMMDDHHmmSS+hh'mm'
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return null;
  return Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
}

function countEof(bytes) {
  if (!bytes) return 0;
  let n = 0;
  // "%%EOF"
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x25 && bytes[i + 2] === 0x45 && bytes[i + 3] === 0x4f && bytes[i + 4] === 0x46) n++;
  }
  return n;
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return { value: best, count: bestN };
}

/**
 * @param {{info?:object}|null} metadata pdf.getMetadata() result
 * @param {Uint8Array|null} bytes the original file
 * @param {object} result reconciled statement (transactions keep `evidence`)
 * @returns {{score:number, level:'low'|'medium'|'high', findings:Array<{level, code, message}>}}
 */
export function fraudChecks(metadata, bytes, result) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  const info = metadata?.info || {};
  const producer = `${info.Producer || ''} ${info.Creator || ''}`.toLowerCase();

  const editor = EDITORS.find((e) => producer.includes(e));
  if (editor) add('medium', 'editor_software', `The PDF was produced or saved with "${(info.Producer || info.Creator || '').trim()}", an editing tool rather than a bank's statement system.`);

  const created = parsePdfDate(info.CreationDate);
  const modified = parsePdfDate(info.ModDate);
  if (created && modified && modified - created > 60 * 60 * 1000) {
    add('medium', 'modified_after_creation', `The file was modified ${Math.round((modified - created) / 86400000)} day(s) after it was created.`);
  }

  const eofs = countEof(bytes);
  if (eofs > 1) add('medium', 'incremental_update', `The file has ${eofs - 1} later revision(s) appended to the original, which happens when a PDF is edited and re-saved.`);

  // Arithmetic
  if (result.status === 'mismatch') add('high', 'does_not_balance', 'The transactions do not add up to the closing balance printed on the statement.');
  const broken = result.transactions.filter((t) => t.flags.includes('balance_mismatch'));
  if (broken.length) add('high', 'running_balance_breaks', `The running balance breaks on ${broken.length} row(s).`);

  // Layout: amounts in a column normally share a right edge and a font
  const tx = result.transactions.filter((t) => t.evidence && t.evidence.amountX1 !== null);
  for (const col of ['debit', 'credit', 'amount']) {
    const inCol = tx.filter((t) => t.evidence.column === col && !t.evidence.amountSplit);
    if (inCol.length >= 5) {
      const edge = mode(inCol.map((t) => Math.round(t.evidence.amountX1)));
      if (edge.count / inCol.length >= 0.8) {
        const off = inCol.filter((t) => Math.abs(t.evidence.amountX1 - edge.value) > 1.5);
        if (off.length && off.length <= 3) add('high', 'misaligned_amounts', `${off.length} amount(s) in the ${col} column sit out of line with the others (${off.map((t) => t.date).join(', ')}).`);
      }
    }
    const fonts = inCol.map((t) => t.evidence.amountFont).filter(Boolean);
    if (fonts.length >= 5) {
      const f = mode(fonts);
      const odd = inCol.filter((t) => t.evidence.amountFont && t.evidence.amountFont !== f.value);
      if (f.count / fonts.length >= 0.8 && odd.length && odd.length <= 3) {
        add('high', 'font_mismatch', `${odd.length} amount(s) use a different font from the rest of the ${col} column (${odd.map((t) => t.date).join(', ')}).`);
      }
    }
  }
  const mixed = tx.filter((t) => t.evidence.amountMixedFont);
  if (mixed.length) add('high', 'mixed_font_in_amount', `${mixed.length} amount(s) mix two fonts inside one number.`);

  // Content patterns
  const dates = result.transactions.map((t) => t.date);
  const outOfOrder = dates.filter((d, i) => i > 0 && d < dates[i - 1]).length;
  if (outOfOrder > 1) add('medium', 'dates_out_of_order', `${outOfOrder} transaction(s) are out of date order.`);

  const seen = new Map();
  let dupes = 0;
  for (const t of result.transactions) {
    const k = `${t.date}|${t.amount}|${t.description}`;
    seen.set(k, (seen.get(k) || 0) + 1);
    if (seen.get(k) === 2) dupes++;
  }
  if (dupes) add('info', 'duplicates', `${dupes} transaction(s) appear twice with the same date, amount and description. Often legitimate, worth a look.`);

  const credits = result.transactions.filter((t) => t.amount > 0);
  const round = credits.filter((t) => t.amount >= 10000 && t.amount % 10000 === 0);
  if (credits.length >= 4 && round.length / credits.length > 0.5) add('info', 'round_deposits', `${round.length} of ${credits.length} deposits are round amounts.`);

  if (!info.Producer && !info.Creator) add('info', 'no_metadata', 'The PDF carries no producer information. Bank systems usually set it.');

  const weights = { high: 40, medium: 15, info: 3 };
  const score = Math.min(100, findings.reduce((s, f) => s + weights[f.level], 0));
  const level = findings.some((f) => f.level === 'high') ? 'high' : score >= 15 ? 'medium' : 'low';
  return { score, level, findings };
}
