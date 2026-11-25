// Fuzzing the parser: hundreds of random statements in the layouts we support, random garbage,
// and a very long statement for speed. Deterministic (seeded) so failures can be replayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoLines } from '../src/core/extract.js';
import { fromLines } from '../src/core/index.js';
import { lenderReport } from '../src/core/lender.js';
import { fraudChecks } from '../src/core/fraud.js';
import { categorize } from '../src/core/categorize.js';
import { FORMATS } from '../src/core/formats.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const WORDS = ['CARD PURCHASE', 'ACH DEBIT', 'ZELLE FROM', 'PAYROLL', 'OFFICE DEPOT', 'STRIPE TRANSFER', 'MONTHLY FEE', 'AMAZON MKTP', 'SHELL OIL', 'RENT', 'INVOICE', 'COMCAST', 'CHECK', 'DEPOSIT', 'UBER TRIP', 'GOOGLE ADS', 'WIRE IN', 'ATM WITHDRAWAL'];
const W = 4.6; // approx glyph width at 9pt

const money = (c, sep = ',') => {
  const s = (Math.abs(c) / 100).toFixed(2);
  const [i, d] = s.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, sep) + '.' + d;
};

function makeStatement(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const layout = pick(['debit_credit', 'signed', 'crdr']);
  const dateStyle = pick(['us', 'iso', 'uk']);
  const n = 1 + Math.floor(r() * 120);
  let bal = Math.floor(r() * 5_000_000) - 200_000;
  const opening = bal;
  const txns = [];
  let day = new Date(Date.UTC(2026, Math.floor(r() * 11), 1));
  for (let i = 0; i < n; i++) {
    if (r() < 0.5) day = new Date(day.getTime() + 86400e3 * Math.floor(1 + r() * 2));
    const amt = (r() < 0.35 ? 1 : -1) * (1 + Math.floor(r() ** 3 * 1_500_000));
    bal += amt;
    const desc = `${pick(WORDS)} ${Math.floor(r() * 99999)}${r() < 0.2 ? ' REF ' + Math.floor(r() * 1e8) : ''}`;
    txns.push({ date: day.toISOString().slice(0, 10), description: desc, amount: amt, balance: bal });
  }
  const closing = bal;
  const fmtDate = (iso) => {
    const [y, m, d] = iso.split('-');
    return dateStyle === 'us' ? `${m}/${d}/${y}` : dateStyle === 'uk' ? `${d}/${m}/${y}` : iso;
  };
  const items = [];
  const left = (x, y, text) => items.push({ x0: x, x1: x + text.length * W, y, text, font: 'F1' });
  const right = (x, y, text) => items.push({ x0: x - text.length * W, x1: x, y, text, font: 'F1' });
  const signed = (c) => (c < 0 ? '-' : '') + money(c);
  let y = 760;
  left(50, y, 'Sample Bank'); y -= 14;
  left(50, y, `Opening balance ${signed(opening)}`); y -= 12;
  left(50, y, `Closing balance ${signed(closing)}`); y -= 20;
  const cols = layout === 'debit_credit' ? ['Date', 'Description', 'Withdrawals', 'Deposits', 'Balance'] : layout === 'signed' ? ['Date', 'Description', 'Amount', 'Balance'] : ['Date', 'Details', 'Amount', 'Balance'];
  const xs = layout === 'debit_credit' ? [50, 120, 400, 480, 560] : [50, 120, 460, 560];
  cols.forEach((c, i) => (i < 2 ? left(xs[i], y, c) : right(xs[i], y, c)));
  y -= 14;
  const pages = [];
  for (const t of txns) {
    if (y < 60) { pages.push(groupIntoLines(items.splice(0), pages.length + 1)); y = 760; }
    left(50, y, fmtDate(t.date));
    left(120, y, t.description);
    if (layout === 'debit_credit') right(t.amount < 0 ? 400 : 480, y, money(t.amount));
    else if (layout === 'signed') right(460, y, signed(t.amount));
    else right(460, y, `${money(t.amount)} ${t.amount < 0 ? 'DR' : 'CR'}`);
    right(560, y, layout === 'crdr' ? `${money(t.balance)}${t.balance < 0 ? ' DR' : ' CR'}` : signed(t.balance));
    y -= 12;
  }
  pages.push(groupIntoLines(items, pages.length + 1));
  return { pages, txns, opening, closing, layout, dateStyle, dateOrder: dateStyle === 'uk' ? 'DMY' : 'MDY' };
}

test('300 random statements: every row found, every cent balanced', () => {
  const failures = [];
  for (let seed = 1; seed <= 300; seed++) {
    const s = makeStatement(seed);
    let res;
    try { res = fromLines(s.pages, { dateOrder: s.dateOrder }); } catch (e) { failures.push(`seed ${seed}: threw ${e.message}`); continue; }
    const why = [];
    if (res.transactions.length !== s.txns.length) why.push(`rows ${res.transactions.length}/${s.txns.length}`);
    else {
      s.txns.forEach((t, i) => {
        const got = res.transactions[i];
        if (got.amount !== t.amount) why.push(`row ${i} amount ${got.amount} != ${t.amount}`);
        if (got.date !== t.date) why.push(`row ${i} date ${got.date} != ${t.date}`);
      });
    }
    if (!['reconciled', 'running_balance_ok'].includes(res.status)) why.push(`status ${res.status} diff ${res.difference}`);
    if (why.length) failures.push(`seed ${seed} (${s.layout}, ${s.dateStyle}, ${s.txns.length} rows): ${why.slice(0, 3).join('; ')}`);
  }
  assert.deepEqual(failures, [], failures.slice(0, 15).join('\n'));
});

test('every export format handles random statements', () => {
  for (let seed = 500; seed < 530; seed++) {
    const s = makeStatement(seed);
    const res = fromLines(s.pages, { dateOrder: s.dateOrder });
    res.transactions = categorize(res.transactions);
    for (const f of FORMATS) {
      const out = f.build(res, { dateStyle: s.dateOrder, currency: 'USD' });
      assert.ok(out && (out.length > 0), `${f.id} produced nothing`);
    }
    lenderReport(res);
    fraudChecks(null, null, res);
  }
});

test('garbage never crashes the parser', () => {
  const r = rng(42);
  const junk = ['', ' ', '$', '-', '1,2,3', '99/99/9999', '31/02/2026', 'NaN', '1e309', '((((', '0.00', '-0.00', '€1.234,56', '12/31', 'CR', 'DR', 'Balance', 'Opening balance', 'Date', '\u0000', '😀', 'A'.repeat(500)];
  for (let i = 0; i < 400; i++) {
    const items = [];
    const n = Math.floor(r() * 200);
    for (let j = 0; j < n; j++) {
      const text = r() < 0.5 ? junk[Math.floor(r() * junk.length)] : String(Math.floor(r() * 1e7) / 100);
      const x = r() * 600;
      items.push({ x0: x, x1: x + Math.max(1, text.length) * W, y: Math.floor(r() * 60) * 12, text: text || 'x', font: r() < 0.1 ? 'F2' : 'F1' });
    }
    const res = fromLines([groupIntoLines(items)]);
    assert.ok(Array.isArray(res.transactions));
    for (const t of res.transactions) assert.ok(Number.isInteger(t.amount), 'amounts stay integer cents');
    lenderReport(res);
    fraudChecks({ info: { Producer: 'x' } }, new Uint8Array(10), res);
  }
});

test('a 5,000-row statement parses quickly', () => {
  // stitch many random statements' rows into one long one by using a big seed set
  let s = makeStatement(7);
  while (s.txns.length < 100) s = makeStatement(s.txns.length + 1000);
  const r = rng(9);
  const items = [];
  let bal = 100000, y = 760, pageNo = 1;
  const pages = [];
  const txns = [];
  const left = (x, text) => items.push({ x0: x, x1: x + text.length * W, y, text, font: 'F1' });
  const right = (x, text) => items.push({ x0: x - text.length * W, x1: x, y, text, font: 'F1' });
  left(50, 'Opening balance 1,000.00'); y -= 20;
  left(50, 'Date'); left(120, 'Description'); right(460, 'Amount'); right(560, 'Balance'); y -= 14;
  for (let i = 0; i < 5000; i++) {
    if (y < 60) { pages.push(groupIntoLines(items.splice(0), pageNo++)); y = 760; }
    const amt = (r() < 0.4 ? 1 : -1) * (1 + Math.floor(r() * 50000));
    bal += amt;
    const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(i / 14) * 86400e3).toISOString().slice(0, 10);
    txns.push(amt);
    left(50, d); left(120, `PAYMENT ${i}`); right(460, (amt < 0 ? '-' : '') + money(amt)); right(560, (bal < 0 ? '-' : '') + money(bal));
    y -= 12;
  }
  pages.push(groupIntoLines(items, pageNo));
  const t0 = performance.now();
  const res = fromLines(pages);
  const ms = performance.now() - t0;
  assert.equal(res.transactions.length, 5000);
  assert.ok(['reconciled', 'running_balance_ok'].includes(res.status), res.status);
  assert.ok(ms < 4000, `took ${Math.round(ms)} ms`);
  const t1 = performance.now();
  lenderReport(res);
  for (const f of FORMATS) f.build(res, { dateStyle: 'MDY', currency: 'USD' });
  assert.ok(performance.now() - t1 < 6000, 'reports and all 17 exports stay fast');
});
