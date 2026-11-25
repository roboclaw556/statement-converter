// Export formats. Every function returns a string or a Uint8Array, so the
// browser can download it and the email worker can attach it.
import { buildXlsx } from './xlsx.js';

const money = (c) => (c / 100).toFixed(2);
const csvCell = (v) => {
  const s = String(v ?? '');
  // Neutralise spreadsheet formulas (CSV injection) as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

function fmtDate(iso, style) {
  const [y, m, d] = iso.split('-');
  if (style === 'DMY') return `${d}/${m}/${y}`;
  if (style === 'MDY') return `${m}/${d}/${y}`;
  return iso;
}

/** Full detail: one row per transaction, with debit/credit split and flags. */
export function toGenericCsv(result) {
  const cat = result.transactions.some((t) => t.category);
  const rows = [['Date', 'Description', 'Debit', 'Credit', 'Amount', 'Balance', 'Check', ...(cat ? ['Category'] : [])]];
  for (const t of result.transactions) {
    rows.push([
      t.date, t.description,
      t.amount < 0 ? money(-t.amount) : '',
      t.amount > 0 ? money(t.amount) : '',
      money(t.amount),
      t.balance !== null ? money(t.balance) : '',
      t.flags.join(' '),
      ...(cat ? [t.category || ''] : []),
    ]);
  }
  return toCsv(rows);
}

/** QuickBooks Online bank upload, 3-column format (Date, Description, Amount). */
export function toQuickBooksCsv(result, dateStyle = 'MDY') {
  const rows = [['Date', 'Description', 'Amount']];
  for (const t of result.transactions) rows.push([fmtDate(t.date, dateStyle), t.description, money(t.amount)]);
  return toCsv(rows);
}

/** Xero bank statement import CSV. */
export function toXeroCsv(result, dateStyle = 'DMY') {
  const rows = [['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Check Number']];
  for (const t of result.transactions) {
    rows.push([fmtDate(t.date, dateStyle), money(t.amount), t.description.slice(0, 255), t.description.slice(0, 255), '', '']);
  }
  return toCsv(rows);
}

/** OFX 1.0.2 (imports into Xero, QuickBooks Desktop, Sage, Wave and most others). */
export function toOfx(result, { accountId = '000000000', currency = 'USD' } = {}) {
  const ymd = (iso) => iso.replace(/-/g, '');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const txns = result.transactions;
  const start = txns.length ? ymd(txns[0].date) : '';
  const endD = txns.length ? ymd(txns[txns.length - 1].date) : '';
  const seen = new Map();
  const body = txns.map((t) => {
    const base = `${ymd(t.date)}${Math.abs(t.amount)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return [
      '<STMTTRN>',
      `<TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}`,
      `<DTPOSTED>${ymd(t.date)}`,
      `<TRNAMT>${money(t.amount)}`,
      `<FITID>${base}${n}`,
      `<NAME>${esc(t.description.slice(0, 32))}`,
      `<MEMO>${esc(t.description.slice(0, 255))}`,
      '</STMTTRN>',
    ].join('\n');
  }).join('\n');
  const closing = result.closing ?? (result.opening !== null ? result.opening + txns.reduce((s, t) => s + t.amount, 0) : 0);
  return [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII',
    'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
    '<OFX>', '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    `<DTSERVER>${endD || '19700101'}<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>`,
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    `<STMTRS><CURDEF>${currency}`,
    `<BANKACCTFROM><BANKID>000000000<ACCTID>${accountId}<ACCTTYPE>CHECKING</BANKACCTFROM>`,
    `<BANKTRANLIST><DTSTART>${start}<DTEND>${endD}`,
    body,
    '</BANKTRANLIST>',
    `<LEDGERBAL><BALAMT>${money(closing)}<DTASOF>${endD}</LEDGERBAL>`,
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>', '',
  ].join('\n');
}

/** Excel workbook with real dates and numbers, plus a summary sheet. */
export function toXlsx(result) {
  const cat = result.transactions.some((t) => t.category);
  const rows = [['Date', 'Description', 'Debit', 'Credit', 'Amount', 'Balance', 'Check', ...(cat ? ['Category'] : [])]];
  for (const t of result.transactions) {
    rows.push([
      { date: t.date }, t.description,
      t.amount < 0 ? -t.amount / 100 : null,
      t.amount > 0 ? t.amount / 100 : null,
      t.amount / 100,
      t.balance !== null ? t.balance / 100 : null,
      t.flags.join(' '),
      ...(cat ? [t.category || ''] : []),
    ]);
  }
  const summary = [
    ['Balance check', statusLabel(result.status)],
    ['Opening balance', result.opening !== null ? result.opening / 100 : null],
    ['Money in', result.credits / 100],
    ['Money out', result.debits / 100],
    ['Closing balance (statement)', result.closing !== null ? result.closing / 100 : null],
    ['Difference', result.difference !== null ? result.difference / 100 : null],
    ['Transactions', result.transactions.length],
    ['Rows to review', result.flaggedCount],
  ];
  return buildXlsx([
    { name: 'Transactions', rows, widths: [12, 60, 12, 12, 12, 14, 18, 24] },
    { name: 'Summary', rows: summary, widths: [28, 22] },
  ]);
}

export function statusLabel(status) {
  return {
    reconciled: 'Balanced: opening + transactions = closing',
    running_balance_ok: 'Running balance checks out (no closing balance printed)',
    mismatch: 'Does not balance: review flagged rows',
    unverified: 'Could not verify: opening or closing balance not found',
  }[status] || status;
}

// ---------- more formats ----------

const ymdCompact = (iso) => iso.replace(/-/g, '');
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Web Connect (.qbo for QuickBooks Desktop, .qfx for Quicken): OFX plus Intuit's bank id. */
export function toWebConnect(result, { bankId = '3000', currency = 'USD', accountId } = {}) {
  return toOfx(result, { currency, accountId }).replace(
    '<LANGUAGE>ENG</SONRS>',
    `<LANGUAGE>ENG<FI><ORG>B1<FID>${bankId}</FI><INTU.BID>${bankId}</SONRS>`,
  );
}

/** QIF (Quicken, MYOB, GnuCash, Moneydance, older desktop apps). */
export function toQif(result, dateStyle = 'MDY') {
  const lines = ['!Type:Bank'];
  for (const t of result.transactions) {
    lines.push(`D${fmtDate(t.date, dateStyle)}`, `T${money(t.amount)}`, `P${t.description.slice(0, 64)}`, `M${t.description}`, '^');
  }
  return lines.join('\r\n') + '\r\n';
}

/** MT940 (SWIFT customer statement, used by European banks and ERPs such as SAP, Exact, Odoo). */
export function toMt940(result, { accountId = 'NOTPROVIDED', currency = 'EUR' } = {}) {
  const yymmdd = (iso) => iso.slice(2).replace(/-/g, '');
  const amt = (c) => (Math.abs(c) / 100).toFixed(2).replace('.', ',');
  const dc = (c) => (c < 0 ? 'D' : 'C');
  const txns = result.transactions;
  if (!txns.length) return '';
  const opening = result.opening ?? 0;
  const closing = result.closing ?? opening + txns.reduce((s, t) => s + t.amount, 0);
  const clean = (s) => s.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').slice(0, 390);
  const out = [':20:STATEMENT', `:25:${accountId}`, ':28C:00001/001',
    `:60F:${dc(opening)}${yymmdd(txns[0].date)}${currency}${amt(opening)}`];
  for (const t of txns) {
    out.push(`:61:${yymmdd(t.date)}${t.date.slice(5).replace('-', '')}${dc(t.amount)}${amt(t.amount)}NTRFNONREF`);
    out.push(`:86:${clean(t.description)}`);
  }
  out.push(`:62F:${dc(closing)}${yymmdd(txns[txns.length - 1].date)}${currency}${amt(closing)}`, '-');
  return out.join('\r\n') + '\r\n';
}

/** CAMT.053 (ISO 20022 bank-to-customer statement XML). */
export function toCamt053(result, { accountId = 'NOTPROVIDED', currency = 'EUR' } = {}) {
  const txns = result.transactions;
  const opening = result.opening ?? 0;
  const closing = result.closing ?? opening + txns.reduce((s, t) => s + t.amount, 0);
  const first = txns[0]?.date ?? '1970-01-01';
  const last = txns[txns.length - 1]?.date ?? first;
  const bal = (code, cents, date) => `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${currency}">${money(Math.abs(cents))}</Amt><CdtDbtInd>${cents < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const entries = txns.map((t) => `<Ntry><Amt Ccy="${currency}">${money(Math.abs(t.amount))}</Amt><CdtDbtInd>${t.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${t.date}</Dt></BookgDt><ValDt><Dt>${t.date}</Dt></ValDt><BkTxCd><Prtry><Cd>NTRF</Cd></Prtry></BkTxCd><NtryDtls><TxDtls><RmtInf><Ustrd>${xmlEsc(t.description.slice(0, 140))}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>STMT${ymdCompact(last)}</MsgId><CreDtTm>${last}T00:00:00</CreDtTm></GrpHdr><Stmt><Id>STMT${ymdCompact(first)}</Id><CreDtTm>${last}T00:00:00</CreDtTm><FrToDt><FrDtTm>${first}T00:00:00</FrDtTm><ToDtTm>${last}T23:59:59</ToDtTm></FrToDt><Acct><Id><Othr><Id>${xmlEsc(accountId)}</Id></Othr></Id><Ccy>${currency}</Ccy></Acct>
${bal('OPBD', opening, first)}${bal('CLBD', closing, last)}
${entries}
</Stmt></BkToCstmrStmt></Document>
`;
}

/** Tally Prime / Tally ERP 9 voucher import XML: payments and receipts against a bank ledger. */
export function toTallyXml(result, { bankLedger = 'Bank Account', contraLedger = 'Suspense A/c' } = {}) {
  const v = result.transactions.map((t) => {
    const a = money(Math.abs(t.amount));
    const isPay = t.amount < 0;
    const [dr, cr] = isPay ? [contraLedger, bankLedger] : [bankLedger, contraLedger];
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${isPay ? 'Payment' : 'Receipt'}" ACTION="Create"><DATE>${ymdCompact(t.date)}</DATE><VOUCHERTYPENAME>${isPay ? 'Payment' : 'Receipt'}</VOUCHERTYPENAME><NARRATION>${xmlEsc(t.description)}</NARRATION>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEsc(dr)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${a}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEsc(cr)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${a}</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>`;
  }).join('\n');
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>
${v}
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
`;
}

const simpleCsv = (header, rowFn) => (result, dateStyle = 'MDY') => {
  const rows = [header];
  for (const t of result.transactions) rows.push(rowFn(t, (iso) => fmtDate(iso, dateStyle)));
  return toCsv(rows);
};
const outIn = (t) => [t.amount < 0 ? money(-t.amount) : '', t.amount > 0 ? money(t.amount) : ''];

export const toSageCsv = simpleCsv(['Date', 'Reference', 'Description', 'Amount'], (t, d) => [d(t.date), '', t.description, money(t.amount)]);
export const toFreshBooksCsv = simpleCsv(['Date', 'Description', 'Amount'], (t, d) => [d(t.date), t.description, money(t.amount)]);
export const toWaveCsv = simpleCsv(['Date', 'Description', 'Amount'], (t, d) => [d(t.date), t.description, money(t.amount)]);
export const toZohoCsv = simpleCsv(['Date', 'Payee', 'Description', 'Reference Number', 'Withdrawals', 'Deposits'], (t, d) => [d(t.date), t.description.slice(0, 100), t.description, '', ...outIn(t)]);
export const toYnabCsv = simpleCsv(['Date', 'Payee', 'Memo', 'Outflow', 'Inflow'], (t, d) => [d(t.date), t.description.slice(0, 100), t.description, ...outIn(t)]);

export function toJson(result) {
  return JSON.stringify({
    opening: result.opening === null ? null : result.opening / 100,
    closing: result.closing === null ? null : result.closing / 100,
    check: result.status,
    transactions: result.transactions.map((t) => ({
      date: t.date, description: t.description, amount: t.amount / 100,
      balance: t.balance === null ? null : t.balance / 100, flags: t.flags,
      ...(t.category ? { category: t.category } : {}),
    })),
  }, null, 2);
}
