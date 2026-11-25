import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertPdf, FORMATS } from '../src/core/index.js';

const load = async (f) => getDocument({ data: new Uint8Array(readFileSync(new URL('./samples/' + f, import.meta.url))), verbosity: 0 }).promise;
const result = await convertPdf(await load('us_debit_credit.pdf'));
const n = result.transactions.length;
const total = result.transactions.reduce((s, t) => s + t.amount, 0);
const ctx = { dateStyle: 'MDY', currency: 'USD' };
const out = (id) => FORMATS.find((f) => f.id === id).build(result, ctx);
const cents = (s) => Math.round(parseFloat(s.replace(',', '.')) * 100);
const count = (s, re) => (s.match(re) || []).length;

test('every format builds a non-empty file', () => {
  for (const f of FORMATS) {
    const o = f.build(result, ctx);
    assert.ok(o.length > 100, f.id);
  }
});

test('signed-amount CSVs keep every row and the total', () => {
  for (const [id, col] of [['quickbooks', 2], ['sage', 3], ['freshbooks', 2], ['wave', 2]]) {
    const rows = out(id).trim().split('\r\n').slice(1).map((r) => r.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '')));
    assert.equal(rows.length, n, id);
    assert.equal(rows.reduce((s, r) => s + cents(r[col]), 0), total, id);
  }
});

test('out/in CSVs (Zoho, YNAB) keep the total', () => {
  for (const [id, o, i] of [['zoho', 4, 5], ['ynab', 3, 4]]) {
    const rows = out(id).trim().split('\r\n').slice(1).map((r) => r.split(','));
    const sum = rows.reduce((s, r) => s - (r[o] ? cents(r[o]) : 0) + (r[i] ? cents(r[i]) : 0), 0);
    assert.equal(sum, total, id);
  }
});

test('QIF, OFX, QBO, QFX have one entry per transaction', () => {
  assert.equal(count(out('qif'), /\^/g), n);
  assert.equal(count(out('ofx'), /<STMTTRN>/g), n);
  assert.match(out('qbo'), /<INTU\.BID>\d+/);
  assert.equal(count(out('qfx'), /<STMTTRN>/g), n);
  const qifSum = [...out('qif').matchAll(/^T(-?[\d.]+)/gm)].reduce((s, m) => s + cents(m[1]), 0);
  assert.equal(qifSum, total);
});

test('MT940 balances and lines', () => {
  const s = out('mt940');
  assert.equal(count(s, /^:61:/gm), n);
  const signed = [...s.matchAll(/^:61:\d{10}([CD])([\d,]+)/gm)].reduce((a, m) => a + (m[1] === 'D' ? -1 : 1) * cents(m[2]), 0);
  assert.equal(signed, total);
  assert.match(s, /^:60F:C\d{6}USD/m);
});

test('CAMT.053 and Tally XML are well formed', () => {
  const camt = out('camt053');
  assert.equal(count(camt, /<Ntry>/g), n);
  assert.equal(count(camt, /&(?!amp;|lt;|gt;|quot;)/g), 0);
  const tally = out('tally');
  assert.equal(count(tally, /<VOUCHER /g), n);
  assert.equal(count(tally, /VCHTYPE="Payment"/g), result.transactions.filter((t) => t.amount < 0).length);
});

test('JSON round-trips', () => {
  const j = JSON.parse(out('json'));
  assert.equal(j.transactions.length, n);
  assert.equal(j.check, 'reconciled');
});
