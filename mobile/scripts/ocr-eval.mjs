// Battle test for OCR: runs tesseract on rendered and "phone photo" versions of the
// sample statements and checks that every row comes back exactly and the statement balances.
// Usage: node scripts/ocr-eval.mjs <image_dir>   (images from make_photo_samples.py)
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import { ocrImages, tesseractRecognizer } from '../../src/core/ocr.js';
import { parseStatement } from '../../src/core/parse.js';
import { reconcile } from '../../src/core/reconcile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const imgDir = process.argv[2];
const samples = join(HERE, '../../test/samples');
const worker = await createWorker('eng', 1, {
  langPath: join(HERE, '../node_modules/@tesseract.js-data/eng/4.0.0_best_int'), cacheMethod: 'none', gzip: true,
});
await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300'});
const recognize = tesseractRecognizer(worker, { psm: process.env.PSM || '6' });
const files = readdirSync(imgDir);
const groups = {};
for (const f of files) {
  const m = /^(.+)__(scan|photo|rough)-(\d+)\.(png|jpg)$/.exec(f);
  if (m) (groups[m[1] + '|' + m[2]] ||= []).push([+m[3], join(imgDir, f)]);
}
let fails = 0;
for (const key of Object.keys(groups).sort()) {
  const [name, kind] = key.split('|');
  const expected = JSON.parse(readFileSync(join(samples, name + '.json'), 'utf8'));
  const imgs = groups[key].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const t = Date.now();
  const { pages, confidence } = await ocrImages(imgs, { recognize, columnPass: !process.env.NOCOL });
  const st = parseStatement(pages, {});
  const r = reconcile(st);
  let exact = 0;
  const bad = [];
  r.transactions.forEach((tx, i) => {
    const e = expected.transactions[i];
    if (e && tx.date === e.date && tx.amount === e.amount) exact++;
    else if (bad.length < 4) bad.push(`#${i} got ${tx.date} ${tx.amount} "${tx.description}" want ${e?.date} ${e?.amount}`);
  });
  const ok = r.status === 'reconciled' && exact === expected.transactions.length && r.transactions.length === expected.transactions.length;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${kind}: ${exact}/${expected.transactions.length} rows exact, got ${r.transactions.length}, status ${r.status}, flagged ${r.flaggedCount}, opening ${r.opening}/${expected.opening}, closing ${r.closing}/${expected.closing}, conf ${confidence}, ${Date.now() - t} ms`);
  for (const b of bad) console.log('   ', b);
}
await worker.terminate();
process.exitCode = fails ? 1 : 0;
