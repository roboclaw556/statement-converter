import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertPdf } from '../src/core/index.js';
import { categorize, ruleFromCorrection, validateRule, payeeKey } from '../src/core/categorize.js';
import { lenderReport } from '../src/core/lender.js';
import { fraudChecks } from '../src/core/fraud.js';

const open = async (f) => {
  const bytes = new Uint8Array(readFileSync(new URL('./samples/' + f, import.meta.url)));
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  return { pdf, bytes, result: await convertPdf(pdf), metadata: await pdf.getMetadata() };
};

test('built-in categories and learned rules', () => {
  const tx = [
    { description: 'PAYROLL ACME CORP DIRECT DEP', amount: 100000 },
    { description: 'SHELL OIL 57442', amount: -4000 },
    { description: 'MONTHLY SERVICE FEE', amount: -1200 },
    { description: 'HARBOR DESIGN STUDIO 8812', amount: -50000 },
  ];
  const c = categorize(tx);
  assert.deepEqual(c.map((t) => t.category), ['Income', 'Fuel & Auto', 'Bank Fees', 'Uncategorized']);
  const rule = ruleFromCorrection(tx[3], 'Professional Fees');
  assert.equal(rule.pattern, 'HARBOR DESIGN STUDIO');
  const again = categorize([{ description: 'HARBOR DESIGN STUDIO 9921', amount: -100 }], [rule]);
  assert.equal(again[0].category, 'Professional Fees');
  assert.equal(again[0].categorySource, 'rule');
  assert.equal(payeeKey('POS PURCHASE STARBUCKS #1102 CARD 4471'), 'STARBUCKS');
});

test('rejects bad or dangerous rules', () => {
  assert.equal(validateRule({ pattern: '(a+)+$', matchType: 'regex', category: 'X' }), 'nested repetition is not allowed');
  assert.equal(validateRule({ pattern: '[', matchType: 'regex', category: 'X' }), 'invalid regex');
  assert.equal(validateRule({ pattern: 'ok', category: '' }), 'category required');
  assert.equal(validateRule({ pattern: 'STARBUCKS', category: 'Meals' }), null);
});

test('lender report on a real statement', async () => {
  const { result } = await open('us_debit_credit.pdf');
  const r = lenderReport(result);
  assert.ok(r.monthly.length >= 1);
  const sumNet = r.monthly.reduce((a, m) => a + m.net, 0);
  assert.equal(sumNet, result.transactions.reduce((a, t) => a + t.amount, 0));
  assert.ok(r.incomeStreams.find((s) => s.payroll && s.recurring), 'payroll found as recurring income');
  assert.equal(r.totalInflow - r.totalOutflow, result.closing - result.opening);
  assert.ok(r.averageDailyBalance !== null);
});

test('lender report flags NSF, negative days and big deposits', () => {
  const t = (date, description, amount) => ({ date, description, amount, balance: null, flags: [] });
  const r = lenderReport({ opening: 10000, closing: null, transactions: [
    t('2026-01-01', 'PAYROLL ACME', 300000), t('2026-01-15', 'RENT', -350000), t('2026-01-16', 'NSF FEE', -3500),
    t('2026-01-20', 'WIRE FROM UNKNOWN LLC', 900000), t('2026-02-01', 'PAYROLL ACME', 300000), t('2026-02-03', 'DRAFTKINGS', -5000),
  ] });
  const codes = r.flags.map((f) => f.code);
  for (const c of ['nsf', 'negative_days', 'large_deposits', 'gambling']) assert.ok(codes.includes(c), c);
  assert.equal(r.recurringMonthlyIncome, 300000);
});

test('a clean statement scores low on tamper checks', async () => {
  const { result, bytes, metadata } = await open('signed_amount.pdf');
  const f = fraudChecks(metadata, bytes, result);
  assert.equal(f.level, 'low', JSON.stringify(f.findings));
});

test('the tampered statement is caught', async () => {
  const { result, bytes, metadata } = await open('tampered.pdf');
  const f = fraudChecks(metadata, bytes, result);
  const codes = f.findings.map((x) => x.code);
  assert.equal(f.level, 'high');
  for (const c of ['editor_software', 'running_balance_breaks', 'font_mismatch', 'misaligned_amounts']) assert.ok(codes.includes(c), `${c} in ${codes}`);
});
