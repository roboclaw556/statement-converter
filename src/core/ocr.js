// OCR for scanned statements and phone photos of paper statements.
// Turns OCR word boxes into the same positioned lines extractLines() returns
// ({ page, y, cells: [{ x0, x1, text }], text }), so parseStatement() and
// reconcile() work unchanged.
//
// The OCR engine and the page renderer are passed in, so this file has no
// dependencies and runs in the browser, in the mobile app and in Node tests.
//   recognize(image) -> { width, height, words: [{ text, confidence, bbox: {x0,y0,x1,y1} }],
//                         lines?: [{ baseline: {x0,y0,x1,y1} }] }   (pixels, y grows downward)
//   renderPage(pdfPage) -> an image recognize() accepts
// Photos should be straightened first: estimateSkew() measures the tilt from
// greyscale pixels, and the caller rotates the image (a canvas in browsers).
// tesseractRecognizer(worker) adapts a tesseract.js worker to recognize().

const TARGET_WORD_HEIGHT = 8; // points: OCR pixels are scaled so a typical word is this tall
const MIN_CONFIDENCE = 20;
const ROTATE_SIGN = Number(globalThis.process?.env?.OCR_ROTATE_SIGN || -1); // words below this are usually specks, rules or stamps

/**
 * OCR a pdf.js document whose pages have no text layer.
 * @returns {Promise<{pages: Array<Array<Line>>, hasText: boolean, confidence: number|null}>}
 */
export async function ocrPdf(pdf, { recognize, renderPage, onProgress, columnPass } = {}) {
  const images = [];
  for (let p = 1; p <= pdf.numPages; p++) images.push(() => pdf.getPage(p).then(renderPage));
  return ocrImages(images, { recognize, onProgress, columnPass });
}

/**
 * OCR a list of page images (or functions returning them), one image per page, in order.
 * @returns {Promise<{pages: Array<Array<Line>>, hasText: boolean, confidence: number|null}>}
 */
export async function ocrImages(images, { recognize, onProgress, columnPass = true } = {}) {
  if (typeof recognize !== 'function') throw new Error('ocrImages needs a recognize(image) function');
  const pages = [];
  let hasText = false;
  let confSum = 0;
  let confN = 0;
  for (let i = 0; i < images.length; i++) {
    onProgress?.({ page: i + 1, pages: images.length, stage: 'reading' });
    const img = typeof images[i] === 'function' ? await images[i]() : images[i];
    const result = await recognize(img);
    // Tesseract's page layout step sometimes drops lone words in sparse table
    // columns (an amount far right of its row). Read each date and amount column
    // again as its own block and add any words the first pass missed.
    if (recognize.supportsRegions && columnPass) {
      for (const rect of columnRegions(result.words || [], result.lines || [])) {
        const extra = await recognize(img, { rectangle: rect, psm: 6 });
        result.words = mergeWords(result.words || [], extra.words || []);
      }
    }
    const lines = wordsToLines(result, i + 1);
    if (lines.length) hasText = true;
    for (const w of result.words || []) {
      if (Number.isFinite(w.confidence)) { confSum += w.confidence; confN++; }
    }
    pages.push(lines);
  }
  onProgress?.({ page: images.length, pages: images.length, stage: 'done' });
  return { pages, hasText, confidence: confN ? Math.round(confSum / confN) : null };
}

/**
 * Pure: OCR words (pixel boxes) -> statement lines in PDF-like points (y grows upward).
 * Handles a few degrees of skew from phone photos.
 */
export function wordsToLines({ words = [], lines: ocrLines = [] } = {}, pageNo = 1) {
  const ws = words
    .filter((w) => w && w.bbox && String(w.text || '').trim())
    .filter((w) => !Number.isFinite(w.confidence) || w.confidence >= MIN_CONFIDENCE || wellFormed(w.text))
    .map((w) => ({
      text: cleanToken(String(w.text).trim()),
      x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1,
      h: Math.max(1, w.bbox.y1 - w.bbox.y0),
    }))
    .filter((w) => w.text && !/^[|_\-—–=~.,:;'"`]+$/.test(w.text)); // table rules and specks
  if (!ws.length) return [];

  const h = median(ws.map((w) => w.h));
  const angle = skewAngle(ocrLines, ws);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  for (const w of ws) {
    // rotate each word's centre-left point to undo the skew
    const cx = w.x0;
    const cy = (w.y0 + w.y1) / 2;
    w.ry = cx * sin + cy * cos;
    w.rx0 = cx * cos - cy * sin;
    w.rx1 = w.rx0 + (w.x1 - w.x0);
  }

  // Group into rows by vertical centre.
  ws.sort((a, b) => a.ry - b.ry);
  const rows = [];
  for (const w of ws) {
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row && Math.abs(w.ry - row.y) <= h * 0.55) {
      row.words.push(w);
      row.y = row.words.reduce((s, x) => s + x.ry, 0) / row.words.length;
    } else {
      rows.push({ y: w.ry, words: [w] });
    }
  }

  const scale = TARGET_WORD_HEIGHT / h;
  const gap = h * 0.75; // words closer than this (in pixels) share a cell
  return rows.map((row) => {
    row.words.sort((a, b) => a.rx0 - b.rx0);
    const cells = [];
    for (const w of row.words) {
      const last = cells[cells.length - 1];
      if (last && w.rx0 - last.rx1 < gap) {
        last.text += ' ' + w.text;
        last.rx1 = Math.max(last.rx1, w.rx1);
      } else {
        cells.push({ rx0: w.rx0, rx1: w.rx1, text: w.text });
      }
    }
    const out = cells.map((c) => ({ x0: round(c.rx0 * scale), x1: round(c.rx1 * scale), text: joinCellText(c.text) }));
    return { page: pageNo, y: round(-row.y * scale), cells: out, text: out.map((c) => c.text).join(' ') };
  });
}

const DATE_WORD = /^(\d{1,2}[/.\-]\d{1,2}([/.\-]\d{2,4})?|\d{4}-\d{2}-\d{2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\d{0,2})$/i;
const AMOUNT_WORD = /^[($£€\-+−]?\d{1,3}([,.'\s]?\d{3})*[.,]\d{2}\)?(CR|DR|-)?$/i;

// Tesseract sometimes reports 0% confidence for a perfectly read number, so a
// token that is exactly an amount, a date or CR/DR is kept whatever its score.
function wellFormed(text) {
  const t = cleanToken(String(text || '').trim());
  return AMOUNT_WORD.test(t) || DATE_WORD.test(t) || /^(CR|DR|\d{1,2})$/i.test(t);
}

/** Pixel rectangles around the date column and each amount column, padded and covering the page's text. */
export function columnRegions(words, ocrLines = []) {
  const ws = words.filter((w) => w && w.bbox && w.text);
  if (ws.length < 6) return [];
  const h = median(ws.map((w) => w.bbox.y1 - w.bbox.y0)) || 10;
  const top = Math.min(...ws.map((w) => w.bbox.y0));
  const bottom = Math.max(...ws.map((w) => w.bbox.y1));
  const left = Math.min(...ws.map((w) => w.bbox.x0));
  const right = Math.max(...ws.map((w) => w.bbox.x1));
  const slant = Math.abs(Math.tan(skewAngle(ocrLines, ws.map((w) => w.bbox)))) * (bottom - top);
  const groups = [];
  const add = (key, w, edge) => {
    let g = groups.find((x) => x.key === key && Math.abs(x.edge - edge) < h * 2 + slant / 2);
    if (!g) groups.push(g = { key, edge, x0: w.bbox.x0, x1: w.bbox.x1, n: 0 });
    g.n++;
    g.x0 = Math.min(g.x0, w.bbox.x0);
    g.x1 = Math.max(g.x1, w.bbox.x1);
  };
  for (const w of ws) {
    const t = cleanToken(String(w.text).trim());
    if (DATE_WORD.test(t) && w.bbox.x0 < left + (right - left) * 0.35) add('date', w, w.bbox.x0);
    else if (AMOUNT_WORD.test(t)) add('amount', w, w.bbox.x1); // amounts are right aligned
  }
  return groups.filter((g) => g.n >= 3).map((g) => {
    const pad = h * 1.5 + slant / 2;
    const x0 = Math.max(0, Math.floor(g.x0 - pad - (g.key === 'amount' ? h * 3 : 0)));
    const x1 = Math.ceil(g.x1 + pad + h * (g.key === 'amount' ? 2 : 3));
    const y0 = Math.max(0, Math.floor(top - h));
    return { left: x0, top: y0, width: x1 - x0, height: Math.ceil(bottom + h) - y0 };
  });
}

/** Adds words from a second pass that don't overlap a word we already have. */
export function mergeWords(base, extra) {
  const out = [...base];
  for (const e of extra) {
    if (!e || !e.bbox || !String(e.text || '').trim()) continue;
    if (Number.isFinite(e.confidence) && e.confidence < 50 && !wellFormed(e.text)) continue;
    const hit = out.some((b) => overlap(b.bbox, e.bbox) > 0.3);
    if (!hit) out.push(e);
  }
  return out;
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)) || 1;
  return inter / small;
}

// Median baseline slope of the longer OCR lines; falls back to 0.
function skewAngle(ocrLines, words) {
  const slopes = [];
  for (const l of ocrLines || []) {
    const b = l && l.baseline;
    if (!b || !(b.x1 - b.x0 > 0)) continue;
    slopes.push({ a: Math.atan2(b.y1 - b.y0, b.x1 - b.x0), w: b.x1 - b.x0 });
  }
  if (!slopes.length) return 0;
  const wide = Math.max(...words.map((w) => w.x1)) - Math.min(...words.map((w) => w.x0));
  const long = slopes.filter((s) => s.w > wide * 0.25);
  const a = median((long.length ? long : slopes).map((s) => s.a));
  return Math.abs(a) < 0.2 ? a : 0; // more than ~11 degrees is not skew, it's a bad read
}

// OCR confuses letters and digits inside numbers: "1,2O4.5O" -> "1,204.50".
export function cleanToken(t) {
  t = t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/—|–/g, '-');
  // "Apr13" -> "Apr 13"
  t = t.replace(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(\d{1,2})$/i, '$1 $2');
  const digits = (t.match(/\d/g) || []).length;
  const moneyShape = /[.,][\dOo]{2}\)?(CR|DR|Cr|Dr|-)?$/.test(t); // ends like .00 / ,00
  if ((digits >= 2 || (digits >= 1 && moneyShape)) && /^[($£€\-+−]?[\dOoIlSB,.'\s]+[)]?(CR|DR|Cr|Dr|-)?$/.test(t)) {
    const m = /^(.*?)(CR|DR|Cr|Dr)?$/.exec(t);
    t = m[1].replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/B/g, '8') + (m[2] || '');
    // "1.234,56" style is left alone; "1,234 .56" -> "1,234.56"
    t = t.replace(/\s+(?=[.,]\d{2}\b)/g, '');
  }
  return t;
}

// "4,999 .76" split across two OCR words inside one cell
function joinCellText(text) {
  return text.replace(/(\d)\s+([.,]\d{2})(?!\d)/g, '$1$2').replace(/(\d[.,])\s+(\d{2})(?!\d)/g, '$1$2');
}

/**
 * Pure: estimates page tilt from a greyscale image ({ width, height, data } with one
 * byte per pixel, 0 = black) by finding the angle at which text rows line up best
 * (the projection-profile method). Returns radians; rotate the image by minus this.
 * Works on a downscaled copy, so it costs a few milliseconds.
 */
export function estimateSkew({ width, height, data }, { maxDegrees = 6, step = 0.2 } = {}) {
  // sample dark pixels from a reduced grid
  const target = 700;
  const k = Math.max(1, Math.floor(Math.max(width, height) / target));
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += k) for (let x = 0; x < width; x += k) { sum += data[y * width + x]; n++; }
  const threshold = Math.min(160, (sum / n) * 0.7);
  const pts = [];
  for (let y = 0; y < height; y += k) {
    for (let x = 0; x < width; x += k) if (data[y * width + x] < threshold) pts.push(x / k, y / k);
  }
  if (pts.length < 200) return 0;
  const rows = Math.ceil((height + width) / k) + 2;
  const score = (a) => {
    const t = Math.tan(a);
    const hist = new Float64Array(rows * 2);
    for (let i = 0; i < pts.length; i += 2) {
      const r = Math.round(pts[i + 1] - pts[i] * t) + rows;
      if (r >= 0 && r < hist.length) hist[r]++;
    }
    let sc = 0;
    for (let i = 1; i < hist.length; i++) { const diff = hist[i] - hist[i - 1]; sc += diff * diff; }
    return sc;
  };
  // coarse search, then a fine one around the best coarse angle
  let best = 0;
  let bestScore = -1;
  const search = (from, to, by) => {
    for (let d = from; d <= to + 1e-9; d += by) {
      const a = (d * Math.PI) / 180;
      const sc = score(a);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
  };
  search(-maxDegrees, maxDegrees, step);
  const c = (best * 180) / Math.PI;
  search(c - step, c + step, step / 8);
  return best;
}

/** Adapts a tesseract.js (v5+) worker to recognize(). */
export function tesseractRecognizer(worker, { psm = '6', rotateAuto = false } = {}) {
  let current = null;
  const recognize = async (image, { rectangle, psm: p, rotate } = {}) => {
    const want = String(p || psm);
    if (want !== current) { await worker.setParameters({ tessedit_pageseg_mode: want }); current = want; }
    // rotate (radians) straightens a tilted photo before layout analysis; word boxes
    // are then in the straightened image, so region passes must pass the same value.
    const opts = rotateAuto ? { rotateAuto: true } : {};
    if (rotate) opts.rotateRadians = rotate;
    if (rectangle) opts.rectangle = rectangle;
    const { data } = await worker.recognize(image, opts, { blocks: true, text: false });
    const words = [];
    const lines = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          lines.push({ baseline: l.baseline, bbox: l.bbox });
          for (const w of l.words || []) words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox });
        }
      }
    }
    return { words, lines };
  };
  recognize.supportsRegions = true;
  recognize.supportsRotate = true;
  return recognize;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (n) => Math.round(n * 100) / 100;
