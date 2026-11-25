// Turns a pdf.js document into positioned text lines.
// Works in the browser, in Node and in a Cloudflare Worker: it only needs a
// pdf.js PDFDocumentProxy, which every environment loads its own way.

const LINE_TOLERANCE = 2.5; // points: items whose baselines differ less than this share a line
const CELL_GAP = 4; // points: items closer than this are joined into one cell

/**
 * @returns {Promise<{pages: Array<Array<Line>>, hasText: boolean}>}
 * Line = { page, y, cells: [{ x0, x1, text }], text }
 */
export async function extractLines(pdf) {
  const pages = [];
  let hasText = false;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const str = it.str.replace(/\s+/g, ' ');
      if (!str.trim()) continue;
      hasText = true;
      const x = it.transform[4];
      const y = it.transform[5];
      items.push({ x0: x, x1: x + (it.width || 0), y, text: str, font: it.fontName || '' });
    }
    pages.push(groupIntoLines(items, p));
  }
  return { pages, hasText };
}

export function groupIntoLines(items, pageNo = 1) {
  // Highest y first = top of the page first.
  items.sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= LINE_TOLERANCE);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.items.sort((a, b) => a.x0 - b.x0);
    const cells = [];
    for (const it of l.items) {
      const last = cells[cells.length - 1];
      if (last && it.x0 - last.x1 < CELL_GAP) {
        const sep = it.x0 - last.x1 > 0.5 && !last.text.endsWith(' ') && !it.text.startsWith(' ') ? ' ' : '';
        last.text += sep + it.text;
        last.x1 = Math.max(last.x1, it.x1);
        if (it.font && it.font !== last.font) last.mixedFont = true;
      } else {
        cells.push({ x0: it.x0, x1: it.x1, text: it.text, font: it.font || '' });
      }
    }
    for (const c of cells) c.text = c.text.trim();
    const kept = cells.filter((c) => c.text);
    return { page: pageNo, y: l.y, cells: kept, text: kept.map((c) => c.text).join(' ') };
  });
}
