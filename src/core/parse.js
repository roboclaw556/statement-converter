// Finds transactions in the text lines of a bank statement.
// Pure functions, no I/O: shared by the web app, the email worker and the tests.
// Money is kept in integer cents to avoid floating-point drift.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// ---------- amounts ----------

const AMOUNT_RE =
  /^(\()?\s*([-+−])?\s*(?:[$£€]|USD|GBP|EUR|CAD|AUD|NZD)?\s*([-+−])?\s*(\d{1,3}(?:[,.\s'’]\d{3})+|\d+)([.,])(\d{2})\s*(\))?\s*(CR|DR|Cr|Dr|cr|dr|C|D|[-+−])?$/;

/** @returns {{cents:number, sign:-1|0|1}|null} sign 0 = no explicit sign */
export function parseAmount(text) {
  const t = text.trim();
  const m = AMOUNT_RE.exec(t);
  if (!m) return null;
  const [, openParen, sign1, sign2, intPart, , dec, closeParen, suffix] = m;
  if (openParen && !closeParen) return null;
  if (closeParen && !openParen) return null;
  const whole = intPart.replace(/[,.\s'’]/g, '');
  const cents = parseInt(whole, 10) * 100 + parseInt(dec, 10);
  let sign = 0;
  const neg = (s) => s === '-' || s === '−';
  if (openParen || neg(sign1) || neg(sign2) || neg(suffix)) sign = -1;
  else if (sign1 === '+' || sign2 === '+' || suffix === '+') sign = 1;
  if (suffix && /^(dr|d)$/i.test(suffix)) sign = -1;
  if (suffix && /^(cr|c)$/i.test(suffix)) sign = 1;
  return { cents, sign };
}

/** Splits cells so that trailing amounts become cells of their own. */
export function splitAmountCells(cells) {
  const out = [];
  for (const c of cells) {
    if (parseAmount(c.text)) { out.push(c); continue; }
    const tokens = c.text.split(/\s+/);
    const tail = [];
    while (tokens.length > 1) {
      const last = tokens[tokens.length - 1];
      if (parseAmount(last)) { tail.unshift(tokens.pop()); continue; }
      // "1,234.56 CR" spread over two tokens
      if (tokens.length > 2 && /^(CR|DR)$/i.test(last) && parseAmount(tokens[tokens.length - 2])) {
        const s = tokens.pop();
        tail.unshift(tokens.pop() + ' ' + s);
        continue;
      }
      break;
    }
    if (!tail.length) { out.push(c); continue; }
    const len = c.text.length || 1;
    const perChar = (c.x1 - c.x0) / len;
    const head = tokens.join(' ');
    let pos = head.length + 1;
    out.push({ x0: c.x0, x1: c.x0 + head.length * perChar, text: head, font: c.font });
    for (const t of tail) {
      const x0 = c.x0 + pos * perChar;
      out.push({ x0, x1: x0 + t.length * perChar, text: t, font: c.font, split: true });
      pos += t.length + 1;
    }
  }
  return out;
}

// ---------- dates ----------

/** Matches a date at the start of a string. */
export function matchDate(s) {
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s))) {
    return { len: m[0].length, kind: 'iso', y: +m[1], m: +m[2], d: +m[3] };
  }
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d.,])/.exec(s))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[1] > 31 || +m[2] > 31) return null;
    return { len: m[0].length, kind: 'numeric', a: +m[1], b: +m[2], y };
  }
  if ((m = /^(\d{1,2})[/-](\d{1,2})(?![\d/.,-])/.exec(s))) {
    if (+m[1] > 31 || +m[2] > 31 || +m[1] === 0 || +m[2] === 0) return null;
    return { len: m[0].length, kind: 'numeric', a: +m[1], b: +m[2] };
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]?([A-Za-z]{3,9})\.?,?(?:[\s-](\d{4}|\d{2})(?![\d.,]))?(?![A-Za-z])/.exec(s))) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo && +m[1] >= 1 && +m[1] <= 31) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
      return { len: m[0].length, kind: 'named', d: +m[1], m: mo, y };
    }
  }
  if ((m = /^([A-Za-z]{3,9})\.?[\s-](\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?(?![\d.,])/.exec(s))) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo && +m[2] >= 1 && +m[2] <= 31) {
      return { len: m[0].length, kind: 'named', d: +m[2], m: mo, y: m[3] ? +m[3] : undefined };
    }
  }
  return null;
}

/** Decides between day-first and month-first from every numeric date seen. */
export function detectDateOrder(numericDates, hintText = '') {
  if (numericDates.some((d) => d.a > 12)) return 'DMY';
  if (numericDates.some((d) => d.b > 12)) return 'MDY';
  if (/[£€]|sort code|IBAN|BSB/i.test(hintText)) return 'DMY';
  return 'MDY';
}

function resolveDate(raw, order, end) {
  let y = raw.y, m, d;
  if (raw.kind === 'numeric') {
    [d, m] = order === 'DMY' ? [raw.a, raw.b] : [raw.b, raw.a];
  } else {
    m = raw.m; d = raw.d;
  }
  if (!y) {
    y = end ? end.y : new Date().getFullYear();
    if (end && m > end.m) y -= 1; // December entries on a January statement
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------- headers ----------

const COLUMN_PATTERNS = [
  ['date', /^(date|posting date|post date|trans\.? date|transaction date|value date|date posted)$/i],
  ['debit', /^(debits?|withdrawals?|withdrawals? ?\/ ?debits?|paid out|money out|payments?( out)?|out|charges|debit amount|withdrawal amount)$/i],
  ['credit', /^(credits?|deposits?|deposits? ?\/ ?credits?|paid in|money in|receipts?|in|credit amount|deposit amount)$/i],
  ['amount', /^(amount|amount \(.{1,4}\)|transaction amount)$/i],
  ['balance', /^(balance|running balance|balance \(.{1,4}\)|daily balance|ledger balance)$/i],
  ['description', /^(description|details|transaction details|particulars|narrative|payee|memo|transaction|transaction description)$/i],
];

function headerColumns(line) {
  const cols = {};
  for (const c of line.cells) {
    if (c.text.length > 32) continue;
    const label = c.text.replace(/[:*]/g, '').trim();
    for (const [name, re] of COLUMN_PATTERNS) {
      if (re.test(label) && !cols[name]) { cols[name] = c; break; }
    }
  }
  const money = ['debit', 'credit', 'amount', 'balance'].filter((k) => cols[k]);
  if (Object.keys(cols).length >= 2 && money.length >= 1) return cols;
  return null;
}

// ---------- statement-level facts ----------

const OPENING_RE = /\b(opening|beginning|starting|previous|start)\s+balance\b|balance\s+(brought\s+forward|forward|b\/f)|brought\s+forward/i;
const CLOSING_RE = /\b(closing|ending|end|new|final)\s+balance\b|balance\s+carried\s+forward|carried\s+forward|balance\s+c\/f/i;
const SUMMARY_RE = /\b(total|subtotal|sub-total)\b|\bbalance\b|\bpage\s+\d+|continued/i;
const TOTAL_CREDITS_RE = /total\s+(deposits|credits|money in|paid in)|(deposits|credits)\s+(and|&)\s+(other\s+)?(additions|credits)|^total in\b/i;
const TOTAL_DEBITS_RE = /total\s+(withdrawals|debits|money out|paid out|payments)|(withdrawals|debits)\s+(and|&)\s+(other\s+)?(subtractions|debits)|^total out\b/i;

function amountsIn(cells) {
  return cells.map((c) => ({ cell: c, amt: parseAmount(c.text) })).filter((x) => x.amt);
}

function lastAmount(line) {
  const a = amountsIn(splitAmountCells(line.cells));
  return a.length ? a[a.length - 1].amt : null;
}

function signedBalance(amt) {
  return amt.sign === -1 ? -amt.cents : amt.cents;
}

// ---------- main ----------

/**
 * @param {Array<Array<Line>>} pages lines per page from extractLines()
 * @param {{dateOrder?: 'MDY'|'DMY'}} opts
 */
export function parseStatement(pages, opts = {}) {
  const allLines = pages.flat();
  const fullText = allLines.map((l) => l.text).join('\n');

  // Pass 1: collect dates to decide the date order and the statement end date.
  const numeric = [];
  let end = null;
  const consider = (y, m, d) => {
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return;
    if (y < 1990 || y > new Date().getFullYear() + 1) return; // sort codes, account numbers
    if (!end || y * 10000 + m * 100 + d > end.y * 10000 + end.m * 100 + end.d) end = { y, m, d };
  };
  for (const l of allLines) {
    // dates anywhere in the line (periods like "January 1, 2026 to January 31, 2026")
    const words = l.text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const raw = matchDate(words.slice(i, i + 3).join(' '));
      if (!raw) continue;
      if (raw.kind === 'numeric') numeric.push(raw);
      if (raw.kind === 'iso' || raw.kind === 'named') consider(raw.y, raw.m, raw.d);
    }
  }
  const dateOrder = opts.dateOrder || detectDateOrder(numeric, fullText);
  for (const raw of numeric) {
    if (!raw.y) continue;
    const [d, m] = dateOrder === 'DMY' ? [raw.a, raw.b] : [raw.b, raw.a];
    consider(raw.y, m, d);
  }

  // Pass 2: walk lines, track table headers, emit transactions.
  const transactions = [];
  const warnings = [];
  let opening = null, closing = null, totalCredits = null, totalDebits = null;
  let cols = null;
  let inTable = false;
  let lastDate = null;
  let prevKind = null; // 'txn' | 'cont' | null
  let prevLine = null;

  for (const line of allLines) {
    const cells = splitAmountCells(line.cells);
    const text = line.text;

    const hdr = headerColumns({ cells });
    if (hdr && !amountsIn(cells).length) {
      cols = hdr; inTable = true; prevKind = null; prevLine = line;
      continue;
    }

    const amounts = amountsIn(cells);
    const dateRaw = matchDate(text);
    const descCells = cells.filter((c) => !parseAmount(c.text));
    let description = descCells.map((c) => c.text).join(' ');
    if (dateRaw) description = description.slice(dateRaw.len).trim();
    // a second date column (value date) right after the first
    const second = matchDate(description);
    if (dateRaw && second) description = description.slice(second.len).trim();

    // Opening / closing balance lines
    if (amounts.length && OPENING_RE.test(text) && !/total/i.test(text)) {
      if (opening === null) opening = signedBalance(amounts[amounts.length - 1].amt);
      prevKind = null; prevLine = line;
      continue;
    }
    if (amounts.length && CLOSING_RE.test(text) && !/total/i.test(text)) {
      closing = signedBalance(amounts[amounts.length - 1].amt);
      prevKind = null; prevLine = line;
      continue;
    }
    if (amounts.length && !dateRaw && TOTAL_CREDITS_RE.test(text)) { totalCredits = amounts[amounts.length - 1].amt.cents; continue; }
    if (amounts.length && !dateRaw && TOTAL_DEBITS_RE.test(text)) { totalDebits = amounts[amounts.length - 1].amt.cents; continue; }

    const undatedRow = !dateRaw && inTable && lastDate && amounts.length && description && !SUMMARY_RE.test(description);
    if ((dateRaw && amounts.length && description) || undatedRow) {
      const date = dateRaw ? resolveDate(dateRaw, dateOrder, end) : lastDate;
      if (!date) continue;
      const txn = buildTransaction(amounts, cols, description, date, line);
      if (!txn) continue;
      txn.dateSource = dateRaw ? 'row' : 'carried'; // carried: the row had no date and took the one above
      transactions.push(txn);
      lastDate = date; inTable = true; prevKind = 'txn'; prevLine = line;
      continue;
    }

    // Continuation of the previous description
    if (!dateRaw && !amounts.length && prevKind && prevLine && prevLine.page === line.page &&
        prevLine.y - line.y < 16 && !SUMMARY_RE.test(text) && text.length < 120) {
      const t = transactions[transactions.length - 1];
      const firstX = line.cells[0]?.x0 ?? 0;
      const descX = t._descX ?? 0;
      if (firstX >= descX - 6) {
        t.description = (t.description + ' ' + text).trim();
        prevKind = 'cont'; prevLine = line;
        continue;
      }
    }
    prevKind = null; prevLine = line;
  }

  for (const t of transactions) delete t._descX;
  if (!transactions.length) warnings.push('No transactions found. If this is a scanned statement, it needs OCR, which this version does not do yet.');

  return { transactions, opening, closing, totalCredits, totalDebits, dateOrder, warnings, endDate: end };
}

const round1 = (n) => Math.round(n * 10) / 10;

function buildTransaction(amounts, cols, description, date, line) {
  let amountCents = null, sign = 0, balance = null, signSource = 'none';
  let amountCell = null, balanceCell = null, column = null;
  const moneyCols = cols ? ['debit', 'credit', 'amount', 'balance'].filter((k) => cols[k]) : [];

  if (moneyCols.length) {
    for (const { cell, amt } of amounts) {
      let best = null, bestDist = Infinity;
      for (const k of moneyCols) {
        const col = cols[k];
        const dist = Math.min(Math.abs(cell.x1 - col.x1), Math.abs((cell.x0 + cell.x1) / 2 - (col.x0 + col.x1) / 2));
        if (dist < bestDist) { bestDist = dist; best = k; }
      }
      if (bestDist > 70) best = null;
      if (best === 'balance') { balance = signedBalance(amt); balanceCell = cell; }
      else if (best === 'debit' && amountCents === null) { amountCents = amt.cents; sign = -1; signSource = 'column'; amountCell = cell; column = 'debit'; }
      else if (best === 'credit' && amountCents === null) { amountCents = amt.cents; sign = 1; signSource = 'column'; amountCell = cell; column = 'credit'; }
      else if (best === 'amount' && amountCents === null) {
        amountCents = amt.cents; sign = amt.sign; signSource = amt.sign ? 'text' : 'none'; amountCell = cell; column = 'amount';
      }
    }
  }
  if (amountCents === null) {
    // No usable header: last amount is the running balance when there are two or more.
    const list = amounts.map((a) => a.amt);
    const main = list[0];
    if (list.length >= 2) { balance = signedBalance(list[list.length - 1]); balanceCell = amounts[amounts.length - 1].cell; }
    amountCents = main.cents; sign = main.sign; signSource = main.sign ? 'text' : 'none';
    amountCell = amounts[0].cell; column = 'amount';
    if (list.length === 1) { balance = null; balanceCell = null; }
  }
  if (amountCents === null) return null;
  const descCell = line.cells.find((c) => !matchDate(c.text) && !parseAmount(c.text));
  return {
    date,
    description: description.replace(/\s{2,}/g, ' '),
    amount: sign === 0 ? amountCents : sign * amountCents, // provisional when signSource === 'none'
    balance,
    signSource,
    page: line.page,
    flags: [],
    _descX: descCell ? descCell.x0 : undefined,
    // Layout evidence for the tamper checks (not exported).
    evidence: {
      column,
      amountX1: amountCell ? round1(amountCell.x1) : null,
      amountFont: amountCell?.font || '',
      amountMixedFont: !!amountCell?.mixedFont,
      amountSplit: !!amountCell?.split,
      balanceX1: balanceCell ? round1(balanceCell.x1) : null,
      balanceFont: balanceCell?.font || '',
    },
  };
}
