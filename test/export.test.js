import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '../src/documents.js';
import { readCanvas, saveCanvas } from '../src/store.js';
import { exportPdf, mapper } from '../src/export.js';
import { makePdf } from './pdf-fixture.js';

const close = (actual, expected) => assert.deepEqual(actual.map(value => Math.round(value * 100) / 100), expected);

test('page coordinates map onto PDF pages for every rotation', () => {
  const box = { x: 0, y: 0, width: 595, height: 842 };
  // Unrotated: top left of the page is (0, 842) in PDF space.
  close(mapper(box, 0, 900).map(0, 0), [0, 842]);
  close(mapper(box, 0, 900).map(900, 1273.6), [595, 0.01]);
  // Rotated 90°: displayed 842 wide; its top left is the PDF's bottom left.
  close(mapper(box, 90, 900).map(0, 0), [0, 0]);
  close(mapper(box, 90, 900).map(900, 0), [0, 842]);
  close(mapper(box, 180, 900).map(0, 0), [595, 0]);
  close(mapper(box, 270, 900).map(0, 0), [595, 842]);
  // Crop boxes shift the origin.
  close(mapper({ x: 10, y: 20, width: 595, height: 842 }, 0, 900).map(0, 0), [10, 862]);
});

test('export keeps PDF pages, draws the ink and appends blank pages as A4', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-export-'));
  try {
    const pdf = path.join(root, 'Sheet.pdf');
    await writeFile(pdf, makePdf([[595, 842], [595, 842, 90]]));
    const canvas = await createCanvas(path.join(root, 'Sheet.paperlink'), 'Sheet', { pdf });
    const pages = (await readCanvas(canvas.path)).pages;
    await saveCanvas(canvas.path, canvas.id, { revision: 0, operationId: 'ink', pages: [
      { ...pages[0], strokes: ['M 100 100 l 0.01 0 L 400 300'] },
      { ...pages[1], strokes: ['M 10 10 l 0.01 0'] },
      { id: 'blank', width: 900, height: 1273, strokes: ['M 50 50 l 0.01 0 L 60 70'] }
    ] });
    const result = await exportPdf(canvas.path, canvas.id);
    assert.equal(result.path, path.join(root, 'Sheet (annotated).pdf'));
    assert.equal(result.pages, 3);

    // Read the export back with pdf.js: sizes as displayed, ink present on every page.
    globalThis.DOMMatrix ??= class DOMMatrix {};
    const { getDocument, OPS } = await import('../public/vendor/pdfjs/pdf.min.mjs');
    const exported = await getDocument({ data: new Uint8Array(await readFile(result.path)), verbosity: 0 }).promise;
    try {
      assert.equal(exported.numPages, 3);
      const sizes = [];
      for (let number = 1; number <= 3; number++) {
        const page = await exported.getPage(number);
        const { width, height } = page.getViewport({ scale: 1 });
        sizes.push([Math.round(width), Math.round(height)]);
        const operators = await page.getOperatorList();
        assert.ok(operators.fnArray.includes(OPS.constructPath), 'ink on page ' + number);
      }
      assert.deepEqual(sizes, [[595, 842], [842, 595], [595, 842]]);
      assert.equal((await exported.getMetadata()).info.Title, 'Sheet');
      const text = (await (await exported.getPage(1)).getTextContent()).items.map(item => item.str).join('');
      assert.match(text, /Exercise 1/, 'the original PDF text survives as text');
    } finally { await exported.destroy(); }
    await assert.rejects(exportPdf(canvas.path, canvas.id, path.join(root, 'missing', 'x.pdf')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
