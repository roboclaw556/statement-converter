// Unit tests for the OCR layout code (pure functions, no OCR engine needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordsToLines, cleanToken, columnRegions, mergeWords, estimateSkew, ocrImages } from '../../src/core/ocr.js';
import { parseStatement } from '../../src/core/parse.js';
import { reconcile } from '../../src/core/reconcile.js';

const W = (text, x0, y0, w = 60, h = 20, confidence = 95) => ({ text, confidence, bbox: { x0, y0, x1: x0 + w, y1: y0 + h } });

test('cleanToken fixes letters read inside numbers, and leaves words alone', () => {
  assert.equal(cleanToken('1,2O4.5O'), '1,204.50');
  assert.equal(cleanToken('l,234.56'), '1,234.56');
  assert.equal(cleanToken('$1,OOO.OO'), '$1,000.00');
  assert.equal(cleanToken('123.45CR'), '123.45CR');
  assert.equal(cleanToken('Apr13'), 'Apr 13');
  assert.equal(cleanToken('GOOGLE'), 'GOOGLE');
  assert.equal(cleanToken('SO'), 'SO');
  assert.equal(cleanToken('—'), '-');
});

test('wordsToLines groups words into rows and cells, top row first', () => {
  const lines = wordsToLines({ words: [
    W('01/05', 100, 300), W('COFFEE', 200, 300), W('SHOP', 270, 302), W('4.50', 700, 301),
    W('01/04', 100, 260), W('PAYROLL', 200, 261), W('1,000.00', 700, 259),
  ] });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '01/04 PAYROLL 1,000.00');
  assert.deepEqual(lines[1].cells.map((c) => c.text), ['01/05', 'COFFEE SHOP', '4.50']);
  assert.ok(lines[0].y > lines[1].y, 'y grows upward like PDF coordinates');
});

test('wordsToLines undoes a 3 degree tilt using baselines', () => {
  const a = (3 * Math.PI) / 180;
  const words = [];
  const lines = [];
  for (let r = 0; r < 12; r++) {
    const y = 200 + r * 40;
    const row = [['01/' + String(r + 10).padStart(2, '0'), 100], ['ITEM' + r, 220], [(r + 1) + '0.00', 900]];
    for (const [t, x] of row) words.push(W(t, x, y + Math.tan(a) * x));
    lines.push({ baseline: { x0: 100, y0: y + 20 + Math.tan(a) * 100, x1: 960, y1: y + 20 + Math.tan(a) * 960 } });
  }
  const out = wordsToLines({ words, lines });
  assert.equal(out.length, 12);
  for (const l of out) assert.equal(l.cells.length, 3, l.text);
});

test('low-confidence words are dropped unless they are well-formed amounts or dates', () => {
  const lines = wordsToLines({ words: [W('01/02', 100, 100), W('~~', 200, 100, 30, 20, 5), W('381.13', 700, 100, 60, 20, 0)] });
  assert.equal(lines[0].text, '01/02 381.13');
});

test('columnRegions finds the date column and each amount column; mergeWords adds only new words', () => {
  const words = [];
  for (let r = 0; r < 6; r++) words.push(W('01/0' + (r + 1), 100, 100 + r * 30), W('SHOP', 200, 100 + r * 30), W(`${r + 1}2.00`, 700, 100 + r * 30), W('99.00', 900, 100 + r * 30));
  const regs = columnRegions(words);
  assert.equal(regs.length, 3);
  const merged = mergeWords(words, [W('12.00', 700, 100), W('77.00', 700, 280)]);
  assert.equal(merged.length, words.length + 1);
});

test('estimateSkew measures tilt from pixels', () => {
  for (const deg of [-3.5, -1, 0, 2.2]) {
    const width = 800, height = 1000;
    const data = new Uint8ClampedArray(width * height).fill(255);
    const t = Math.tan((deg * Math.PI) / 180);
    for (let row = 0; row < 25; row++) {
      for (let x = 60; x < 740; x++) {
        if ((x >> 3) % 3 === 0) continue; // gaps between "words"
        for (let k = 0; k < 6; k++) {
          const y = Math.round(80 + row * 34 + k + x * t);
          if (y >= 0 && y < height) data[y * width + x] = 20;
        }
      }
    }
    const got = (estimateSkew({ width, height, data }) * 180) / Math.PI;
    assert.ok(Math.abs(got - deg) < 0.15, `${deg} -> ${got}`);
  }
});

test('ocrImages feeds the parser: a fake OCR statement converts and balances', async () => {
  const rows = [
    ['Opening balance', '', '', '1,000.00'],
    ['01/03/2026', 'PAYROLL', '500.00', '1,500.00'],
    ['01/05/2026', 'RENT', '-1,200.00', '300.00'],
    ['01/09/2026', 'COFFEE', '-4.50', '295.50'],
    ['Closing balance', '', '', '295.50'],
  ];
  const header = ['Date', 'Description', 'Amount', 'Balance'];
  const xs = [100, 260, 700, 900];
  const page = (y0) => {
    const words = header.map((t, i) => W(t, xs[i], y0, 80));
    rows.forEach((r, ri) => r.forEach((t, ci) => {
      if (!t) return;
      if (ci === 0 && /balance/.test(t)) { t.split(' ').forEach((p, k) => words.push(W(p, 100 + k * 90, y0 + 40 + ri * 30, 80))); return; }
      words.push(W(t, xs[ci] + (ci >= 2 ? 80 - t.length * 8 : 0), y0 + 40 + ri * 30, ci >= 2 ? t.length * 8 : 120));
    }));
    return { words };
  };
  const { pages, hasText } = await ocrImages(['img1'], { recognize: async () => page(100) });
  assert.ok(hasText);
  const r = reconcile(parseStatement(pages, { dateOrder: 'MDY' }));
  assert.equal(r.transactions.length, 3);
  assert.equal(r.status, 'reconciled');
});
