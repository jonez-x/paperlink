import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eraseFrom, formatStroke, inLasso, outline, parseStroke, shapePoints, strokeDistance, textLines, translateStroke, validStroke } from '../src/ink.js';
import { createCanvas } from '../src/documents.js';
import { readCanvas, saveCanvas, saveOperations } from '../src/store.js';
import { exportPdf } from '../src/export.js';
import { renderPreview } from '../src/preview.js';
import { makePdf } from './pdf-fixture.js';

test('stroke strings: old strokes stay valid, styles and kinds round-trip', () => {
  const old = parseStroke('M 10 20 l 0.01 0 L 30 40');
  assert.deepEqual(old, { kind: 'line', color: null, width: 3, highlighter: false, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] });
  assert.equal(formatStroke(old), 'M 10 20 l 0.01 0 L 30 40');
  const marker = '#ffd23f w20 h M 0 0 l 0.01 0 L 100 0';
  assert.equal(formatStroke(parseStroke(marker)), marker);
  assert.equal(parseStroke(marker).highlighter, true);
  const pencil = '#2f6fde V 1 2 0.5 3 4 0.75';
  assert.deepEqual(parseStroke(pencil).points, [{ x: 1, y: 2, p: 0.5 }, { x: 3, y: 4, p: 0.75 }]);
  assert.equal(formatStroke(parseStroke(pencil)), pencil);
  const text = formatStroke({ kind: 'text', x: 5, y: 6, width: 36, color: '#e0453a', text: 'x² = 4\nüber 100%' });
  assert.equal(text, '#e0453a w36 T 5 6 x%C2%B2%20%3D%204%0A%C3%BCber%20100%25');
  assert.equal(parseStroke(text).text, 'x² = 4\nüber 100%');
  assert.deepEqual(textLines(parseStroke(text)).map(line => line.y), [6 + 36 * 0.9, 6 + 36 * 2.15]);
  for (const bad of ['', 'M 1 2', 'w0 M 1 2 l 0.01 0', '#fff M 1 2 l 0.01 0', 'V 1 2', 'V 1 2 3', 'T 1 2 ', 'T 1 2 %E0', 'h T 1 2 a', 'M 1 2 l 0.01 0 <x>']) {
    assert.equal(validStroke(bad), false, bad);
  }
});

test('geometry: distance, outlines, partial erasing, lasso and shapes', () => {
  const line = parseStroke('w10 M 0 0 l 0.01 0 L 100 0');
  assert.equal(strokeDistance(line, { x: 50, y: 4 }), -1);
  assert.equal(strokeDistance(line, { x: 50, y: 25 }), 20);
  // A pressure outline is closed around both ends.
  const polygon = outline(parseStroke('V 0 0 0.5 100 0 0.5'));
  assert.ok(polygon.length > 10 && Math.min(...polygon.map(p => p.x)) < 0 && Math.max(...polygon.map(p => p.x)) > 100);
  // Erasing the middle leaves two pieces with the original style.
  const pieces = eraseFrom(parseStroke('#e0453a M 0 0 l 0.01 0 L 100 0'), { x: 50, y: -20 }, { x: 50, y: 20 }, 5);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every(piece => piece.startsWith('#e0453a M ')));
  const xs = pieces.map(piece => parseStroke(piece).points.map(p => p.x));
  assert.ok(Math.max(...xs[0]) < 50 && Math.min(...xs[1]) > 50);
  assert.equal(eraseFrom(line, { x: 50, y: 100 }, { x: 60, y: 100 }, 5), null, 'missed');
  assert.deepEqual(eraseFrom(parseStroke('T 0 0 hello'), { x: 5, y: 5 }, { x: 5, y: 5 }, 5), [], 'text goes whole');
  // Lasso and moving.
  const square = [{ x: -10, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 10 }, { x: -10, y: 10 }];
  assert.equal(inLasso(parseStroke('M 0 0 l 0.01 0 L 50 0'), square), true);
  assert.equal(inLasso(parseStroke('M 0 0 l 0.01 0 L 500 0 L 600 0'), square), false);
  assert.equal(translateStroke(parseStroke('#2f6fde w6 M 1 1 l 0.01 0 L 2 2'), 10, 20), '#2f6fde w6 M 11 21 l 0.01 0 L 12 22');
  assert.equal(shapePoints('rectangle', { x: 0, y: 0 }, { x: 10, y: 5 }).length, 5);
  const arrow = shapePoints('arrow', { x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(arrow[1], { x: 100, y: 0 });
  assert.ok(arrow[2].x < 100 && arrow[2].y * arrow[4].y < 0, 'wings on both sides');
});

test('styled strokes and text are stored, synced, exported and previewed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-ink-'));
  try {
    const pdf = path.join(root, 'Sheet.pdf');
    await writeFile(pdf, makePdf([[595, 842]]));
    const canvas = await createCanvas(path.join(root, 'Sheet.paperlink'), 'Sheet', { pdf });
    const page = (await readCanvas(canvas.path)).pages[0];
    const strokes = ['#ffd23f w20 h M 100 100 l 0.01 0 L 400 100', '#2f6fde V 100 200 0.4 300 260 0.9', 'w36 T 100 300 Answer%3A%20%E2%88%9A2%20%C3%A4'];
    await saveOperations(canvas.path, canvas.id, { operationId: 'styled', ops: strokes.map(stroke => ({ type: 'add', page: page.id, stroke })) });
    await assert.rejects(saveOperations(canvas.path, canvas.id, { operationId: 'bad', ops: [{ type: 'add', page: page.id, stroke: '#zzz M 1 1 l 0.01 0' }] }), { status: 400 });
    await assert.rejects(saveCanvas(canvas.path, canvas.id, { revision: 1, operationId: 'bad2', pages: [{ ...page, strokes: ['T 1 1 %'] }] }), { status: 400 });
    assert.deepEqual((await readCanvas(canvas.path)).pages[0].strokes, strokes);

    const { path: output } = await exportPdf(canvas.path, canvas.id);
    globalThis.DOMMatrix ??= class DOMMatrix {};
    const { getDocument } = await import('../public/vendor/pdfjs/pdf.min.mjs');
    const pdfDocument = await getDocument({ data: new Uint8Array(await readFile(output)), verbosity: 0 }).promise;
    const content = await (await pdfDocument.getPage(1)).getTextContent();
    const text = content.items.map(item => item.str).join(' ');
    assert.match(text, /Exercise 1/, 'the worksheet text stays');
    assert.match(text, /Answer: \?2 ä/, 'typed text is real PDF text; unsupported characters become ?');

    const svg = renderPreview(await readCanvas(canvas.path), {});
    assert.ok(svg.indexOf('opacity="0.35"') < svg.indexOf('fill="#2f6fde"'), 'highlighter below the ink');
    assert.match(svg, /<text [^>]*font-size="36"[^>]*><tspan x="100" y="332.4">Answer: √2 ä<\/tspan><\/text>/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
