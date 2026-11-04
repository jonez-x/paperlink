import { open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { canvasBase } from './documents.js';
import { readCanvas } from './store.js';

// Exports a canvas as a PDF with pdf-lib (vendored in vendor/pdf-lib). PDF
// pages are copied unchanged and the ink is drawn on top as vectors, so text
// stays sharp and searchable; blank pages become white A4 pages.

const INK = [0x24 / 255, 0x23 / 255, 0x1f / 255];
const A4_WIDTH = 595.28; // points; blank pages are 900 units wide
const STROKE_WIDTH = 3;

export const defaultExportPath = file => path.join(path.dirname(file), canvasBase(file) + ' (annotated).pdf');

// Page units (origin top left, y down, 900 wide) → PDF user space of a page
// with the given crop box and rotation, as pdf.js displays it.
export function mapper(box, rotation, pageWidth) {
  const displayedWidth = rotation % 180 ? box.height : box.width;
  const s = displayedWidth / pageWidth;
  const x0 = box.x, y0 = box.y, x1 = box.x + box.width, y1 = box.y + box.height;
  const map = {
    0: (u, v) => [x0 + u * s, y1 - v * s],
    90: (u, v) => [x0 + v * s, y0 + u * s],
    180: (u, v) => [x1 - u * s, y0 + v * s],
    270: (u, v) => [x1 - v * s, y1 - u * s]
  }[((rotation % 360) + 360) % 360];
  return { map, scale: s };
}

// "M x y l 0.01 0 L x y …" → point list; the dot segment becomes a tiny line.
function strokePoints(stroke) {
  const numbers = stroke.replace(/ l 0\.01 0/, ' dot').split(/[\s,]+/);
  const points = [];
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] === 'dot') { const [x, y] = points[points.length - 1]; points.push([x + 0.01, y]); continue; }
    if (numbers[i] === 'M' || numbers[i] === 'L') { points.push([Number(numbers[i + 1]), Number(numbers[i + 2])]); i += 2; }
  }
  return points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

// `pages` (1-based numbers) limits the export; `region` ({x, y, width, height}
// in page units) crops a single page, e.g. for an assistant looking at an answer.
export async function exportPdf(file, id, output = defaultExportPath(file), { pages: numbers, region } = {}) {
  const document = await readCanvas(file, id);
  const selected = numbers ? numbers.map(number => {
    if (!Number.isInteger(number) || number < 1 || number > document.pages.length) throw new Error('Page ' + number + ' does not exist; the canvas has ' + document.pages.length + '.');
    return document.pages[number - 1];
  }) : document.pages;
  const { PDFDocument, rgb, LineCapStyle } = await import(new URL('../vendor/pdf-lib/pdf-lib.esm.min.js', import.meta.url).href);
  const result = await PDFDocument.create();
  let source = null;
  if (document.pdf) {
    const pdfFile = path.join(path.dirname(file), document.pdf.file);
    const bytes = await readFile(pdfFile).catch(() => { throw new Error('The PDF ' + document.pdf.file + ' is missing next to the canvas.'); });
    try { source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); }
    catch (error) { throw new Error('Cannot read ' + document.pdf.file + ': ' + error.message); }
  }
  for (const page of selected) {
    let target;
    if (page.pdfPage !== undefined && source) {
      if (page.pdfPage > source.getPageCount()) throw new Error('The PDF has fewer pages than the canvas expects.');
      [target] = await result.copyPages(source, [page.pdfPage - 1]);
      result.addPage(target);
    } else {
      const scale = A4_WIDTH / page.width;
      target = result.addPage([page.width * scale, page.height * scale]);
    }
    const box = page.pdfPage !== undefined && source ? target.getCropBox() : { x: 0, y: 0, ...target.getSize() };
    const rotation = page.pdfPage !== undefined && source ? target.getRotation().angle : 0;
    const { map, scale } = mapper(box, rotation, page.width);
    for (const stroke of page.strokes) {
      const points = strokePoints(stroke).map(([u, v]) => map(u, v));
      if (!points.length) continue;
      // drawSvgPath flips y, so PDF coordinates go in with a negated y.
      const d = points.map(([x, y], index) => (index ? 'L ' : 'M ') + x.toFixed(2) + ' ' + (-y).toFixed(2)).join(' ');
      target.drawSvgPath(d, { x: 0, y: 0, borderColor: rgb(...INK), borderWidth: STROKE_WIDTH * scale, borderLineCap: LineCapStyle.Round });
    }
    if (region) {
      const corners = [map(region.x, region.y), map(region.x + region.width, region.y + region.height)];
      const [left, right] = [Math.min(corners[0][0], corners[1][0]), Math.max(corners[0][0], corners[1][0])];
      const [bottom, top] = [Math.min(corners[0][1], corners[1][1]), Math.max(corners[0][1], corners[1][1])];
      target.setCropBox(left, bottom, right - left, top - bottom);
      target.setMediaBox(left, bottom, right - left, top - bottom);
    }
  }
  result.setTitle(document.title);
  result.setCreator('Paperlink');
  result.setProducer('Paperlink');
  const bytes = await result.save();
  // Atomic, so a synced folder never holds a half-written export.
  const temporary = output + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, output);
  } finally { await unlink(temporary).catch(() => {}); }
  return { path: output, pages: selected.length, bytes: bytes.length };
}
