import { open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { canvasBase } from './documents.js';
import { readCanvas } from './store.js';
import { HIGHLIGHT_OPACITY, outline, parseStroke, templateMarks, textLines } from './ink.js';

// Exports a canvas as a PDF with pdf-lib (vendored in vendor/pdf-lib). PDF
// pages are copied unchanged and the ink is drawn on top as vectors, so text
// stays sharp and searchable; blank pages become A4 pages with their template
// (lines, squares or dots) in a light grey.

const INK = [0x24 / 255, 0x23 / 255, 0x1f / 255];
const A4_WIDTH = 595.28; // points; blank pages are 900 units wide

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

const hexColor = (color, rgb) => color ? rgb(...[1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)) : rgb(...INK);

// Draws one page's strokes, highlighters first so they lie below the ink.
function drawStrokes(target, strokes, { map, scale }, { rgb, LineCapStyle, degrees }, font) {
  const parsed = strokes.map(parseStroke).filter(Boolean);
  const ordered = [...parsed.filter(stroke => stroke.highlighter), ...parsed.filter(stroke => !stroke.highlighter)];
  // drawSvgPath flips y, so PDF coordinates go in with a negated y.
  const pathOf = (points, close) => points.map(({ x, y }, i) => { const [px, py] = map(x, y); return (i ? 'L ' : 'M ') + px.toFixed(2) + ' ' + (-py).toFixed(2); }).join(' ') + (close ? ' Z' : '');
  for (const stroke of ordered) {
    const color = hexColor(stroke.color, rgb);
    if (stroke.kind === 'text') {
      // The direction of the page's x axis in PDF space, for rotated pages.
      const [ox, oy] = map(0, 0), [ux, uy] = map(1, 0);
      const angle = Math.atan2(uy - oy, ux - ox) * 180 / Math.PI;
      for (const line of textLines(stroke)) {
        // The standard font covers Latin text; anything else becomes "?".
        const text = [...line.text].map(char => { try { font.encodeText(char); return char; } catch { return '?'; } }).join('');
        const [x, y] = map(line.x, line.y);
        if (text.trim()) target.drawText(text, { x, y, size: stroke.width * scale, font, color, rotate: degrees(angle) });
      }
      continue;
    }
    if (!stroke.points.length) continue;
    const opacity = stroke.highlighter ? HIGHLIGHT_OPACITY : 1;
    if (stroke.kind === 'pressure') { target.drawSvgPath(pathOf(outline(stroke), true), { x: 0, y: 0, color, opacity }); continue; }
    const points = stroke.points.length === 1 ? [stroke.points[0], { x: stroke.points[0].x + 0.01, y: stroke.points[0].y }] : stroke.points;
    target.drawSvgPath(pathOf(points), { x: 0, y: 0, borderColor: color, borderOpacity: opacity, borderWidth: stroke.width * scale, borderLineCap: LineCapStyle.Round });
  }
}

const TEMPLATE_GREY = [0.86, 0.85, 0.82];
function drawTemplate(target, page, { map, scale }, { rgb }) {
  const { lines, dots } = templateMarks(page.template, page.width, page.height);
  const color = rgb(...TEMPLATE_GREY);
  for (const [x1, y1, x2, y2] of lines) {
    const [sx, sy] = map(x1, y1), [ex, ey] = map(x2, y2);
    target.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: 0.5, color });
  }
  for (const [x, y] of dots) {
    const [px, py] = map(x, y);
    target.drawCircle({ x: px, y: py, size: 1.6 * scale, color });
  }
}

// `pages` (1-based numbers) limits the export; `region` ({x, y, width, height}
// in page units) crops a single page, e.g. for an assistant looking at an answer.
export async function exportPdf(file, id, output = defaultExportPath(file), { pages: numbers, region } = {}) {
  const document = await readCanvas(file, id);
  const selected = numbers ? numbers.map(number => {
    if (!Number.isInteger(number) || number < 1 || number > document.pages.length) throw new Error('Page ' + number + ' does not exist; the canvas has ' + document.pages.length + '.');
    return document.pages[number - 1];
  }) : document.pages;
  const lib = await import(new URL('../vendor/pdf-lib/pdf-lib.esm.min.js', import.meta.url).href);
  const { PDFDocument, StandardFonts } = lib;
  const result = await PDFDocument.create();
  const font = await result.embedFont(StandardFonts.Helvetica);
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
    if (page.pdfPage === undefined) drawTemplate(target, page, { map, scale }, lib);
    drawStrokes(target, page.strokes, { map, scale }, lib, font);
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
