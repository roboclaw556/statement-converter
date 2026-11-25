// Browser/WebView side of OCR: prepares images on a canvas (size, contrast,
// straightening) and runs tesseract.js from files bundled with the app, so
// scans are read offline and never uploaded.
import { ocrImages, ocrPdf, tesseractRecognizer, estimateSkew } from './core/ocr.js';

const BASE = new URL('./vendor/tesseract/', import.meta.url).href;
let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import('./vendor/tesseract/tesseract.esm.min.js');
      const createWorker = mod.createWorker || mod.default?.createWorker;
      const worker = await createWorker('eng', 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE + 'core',
        langPath: BASE + 'lang',
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
      });
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** Frees the OCR engine's memory (about 40 MB) when the app is backgrounded. */
export async function releaseOcr() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try { (await p).terminate(); } catch { /* already gone */ }
}

const LONG_SIDE = 2600; // px: enough for 8pt type on a full page, small enough for phone memory

/**
 * Draws an image (Blob, ImageBitmap or canvas) to a greyscale canvas: scaled so
 * the page is about 250-300 dpi, contrast stretched, and rotated upright.
 */
export async function prepareImage(src) {
  const bmp = src instanceof Blob ? await createImageBitmap(src) : src;
  const w0 = bmp.width;
  const h0 = bmp.height;
  const scale = Math.min(LONG_SIDE / Math.max(w0, h0), 3);
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  if (bmp.close && src instanceof Blob) bmp.close();

  // greyscale + contrast stretch (2nd to 98th percentile) evens out shadows and grey paper
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const grey = new Uint8ClampedArray(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    grey[j] = v;
    hist[grey[j]]++;
  }
  const lo = percentile(hist, w * h, 0.02);
  const hi = Math.max(lo + 40, percentile(hist, w * h, 0.98));
  for (let j = 0; j < grey.length; j++) grey[j] = ((grey[j] - lo) * 255) / (hi - lo);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = grey[j]; d[i + 3] = 255; }
  g.putImageData(img, 0, 0);

  const angle = estimateSkew({ width: w, height: h, data: grey });
  globalThis.__lastAngle = angle;
  if (Math.abs(angle) < 0.003) return { canvas: c, angle: 0 };
  // rotate by -angle onto a white canvas big enough to hold the whole page
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const r = document.createElement('canvas');
  r.width = Math.ceil(w * cos + h * sin);
  r.height = Math.ceil(w * sin + h * cos);
  const rg = r.getContext('2d');
  rg.fillStyle = '#fff';
  rg.fillRect(0, 0, r.width, r.height);
  rg.translate(r.width / 2, r.height / 2);
  rg.rotate(-angle);
  rg.drawImage(c, -w / 2, -h / 2);
  c.width = c.height = 0; // free memory early on iOS
  return { canvas: r, angle };
}

function percentile(hist, total, p) {
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * p) return v; }
  return 255;
}

/** OCR photos/scans (Blobs), one per page. */
export async function ocrBlobs(blobs, onProgress) {
  const worker = await getWorker();
  const recognize = tesseractRecognizer(worker);
  const pages = blobs.map((b) => async () => (await prepareImage(b)).canvas);
  return ocrImages(pages, { recognize, onProgress });
}

/** OCR a scanned PDF (pdf.js document with no text layer). */
export async function ocrScannedPdf(pdf, onProgress) {
  const worker = await getWorker();
  const recognize = tesseractRecognizer(worker);
  const renderPage = async (page) => {
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(LONG_SIDE / Math.max(vp1.width, vp1.height), 4);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return (await prepareImage(c)).canvas;
  };
  return ocrPdf(pdf, { recognize, renderPage, onProgress });
}
