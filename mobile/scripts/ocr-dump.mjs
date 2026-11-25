import { createWorker } from 'tesseract.js';
import { ocrImages, tesseractRecognizer } from '../../src/core/ocr.js';
const worker = await createWorker('eng', 1, { langPath: '/home/user/sc/mobile/node_modules/@tesseract.js-data/eng/4.0.0_best_int', cacheMethod: 'none', gzip: true });
await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
const { pages } = await ocrImages(process.argv.slice(2), { recognize: tesseractRecognizer(worker) });
for (const l of pages.flat()) console.log(l.y.toFixed(0).padStart(6), l.cells.map(c => `[${c.x0.toFixed(0)}-${c.x1.toFixed(0)} ${c.text}]`).join(' '));
await worker.terminate();
