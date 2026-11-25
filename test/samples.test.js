import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertPdf, toXlsx, toOfx, toQuickBooksCsv, toXeroCsv, toGenericCsv } from '../src/core/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const samples = readdirSync(dir).filter((f) => f.endsWith('.pdf') && readdirSync(dir).includes(f.replace('.pdf', '.json')));

async function load(file) {
  const data = new Uint8Array(readFileSync(join(dir, file)));
  return getDocument({ data, verbosity: 0 }).promise;
}

for (const file of samples) {
  test(`converts ${file} exactly and balances`, async () => {
    const expected = JSON.parse(readFileSync(join(dir, file.replace('.pdf', '.json')), 'utf8'));
    const result = await convertPdf(await load(file));
    assert.equal(result.transactions.length, expected.transactions.length, 'transaction count');
    result.transactions.forEach((t, i) => {
      const e = expected.transactions[i];
      assert.equal(t.date, e.date, `row ${i} date`);
      assert.equal(t.amount, e.amount, `row ${i} amount (${t.description})`);
      assert.equal(t.description.replace(/\s+/g, ' '), e.description.replace(/\s+/g, ' '), `row ${i} description`);
      if (e.balance !== null) assert.equal(t.balance, e.balance, `row ${i} balance`);
    });
    assert.equal(result.opening, expected.opening, 'opening');
    assert.equal(result.closing, expected.closing, 'closing');
    assert.equal(result.status, 'reconciled');
    assert.equal(result.flaggedCount, 0);
  });
}

test('exports are well formed', async () => {
  const result = await convertPdf(await load('us_debit_credit.pdf'));
  const xlsx = toXlsx(result);
  assert.equal(xlsx[0], 0x50); // "PK" zip header
  assert.equal(xlsx[1], 0x4b);
  assert.match(toOfx(result), /<STMTTRN>/);
  assert.match(toQuickBooksCsv(result).split('\r\n')[1], /^01\/\d\d\/2026,/);
  assert.match(toXeroCsv(result).split('\r\n')[0], /^\*Date,\*Amount/);
  assert.equal(toGenericCsv(result).trim().split('\r\n').length, result.transactions.length + 1);
});

test('csv neutralises formula injection', async () => {
  const { toGenericCsv: csv } = await import('../src/core/export.js');
  const out = csv({ transactions: [{ date: '2026-01-01', description: '=HYPERLINK("x")', amount: -100, balance: null, flags: [] }] });
  assert.match(out, /"'=HYPERLINK\(""x""\)"/);
});

test('a dropped row is caught by the balance check', async () => {
  const { fromLines } = await import('../src/core/index.js');
  const { extractLines } = await import('../src/core/extract.js');
  const { pages } = await extractLines(await load('signed_amount.pdf'));
  // remove the 5th transaction line from page 1
  const txnLines = pages[0].filter((l) => /^\d{4}-\d\d-\d\d/.test(l.text));
  const broken = [pages[0].filter((l) => l !== txnLines[4])];
  const result = fromLines(broken);
  assert.equal(result.status, 'mismatch');
  assert.ok(result.flaggedCount >= 1);
});
