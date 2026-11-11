import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canvasPath, createCanvas } from '../src/documents.js';
import { readCanvas, saveCanvas } from '../src/store.js';

test('durable save, exact retry, conflicts and validation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-'));
  try {
    const file = canvasPath('Notes/Test', root);
    assert.equal(file, path.join(root, 'Notes', 'Test.paperlink'));
    const document = await createCanvas(file);
    assert.equal(document.title, 'Test', 'title defaults to the file name');
    await assert.rejects(createCanvas(file), /already exists/);
    const request = { revision: 0, operationId: 'first', strokes: ['M 10 10 l 0.01 0 L 20 30'] };
    assert.deepEqual(await saveCanvas(file, document.id, request), { revision: 1 });
    assert.deepEqual(await saveCanvas(file, document.id, request), { revision: 1 });
    assert.equal((await readCanvas(file, document.id)).pages[0].strokes[0], request.strokes[0]);
    await assert.rejects(saveCanvas(file, document.id, { ...request, operationId: 'stale' }), error => error.status === 409);
    await assert.rejects(saveCanvas(file, document.id, { ...request, strokes: [] }), error => error.status === 409);
    const before = await readFile(file, 'utf8');
    await assert.rejects(saveCanvas(file, document.id, { revision: 1, operationId: 'bad', strokes: ['<script>'] }));
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(await saveCanvas(file, document.id, { revision: 1, operationId: 'erase', strokes: [] }), { revision: 2 });
    assert.deepEqual((await readCanvas(file, document.id)).pages[0].strokes, []);

    // A file replaced by another canvas is never served under the old ID.
    const other = await createCanvas(path.join(root, 'Other.paperlink'));
    await writeFile(file, await readFile(other.path));
    await assert.rejects(readCanvas(file, document.id), error => error.code === 'ENOENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('multi-page saves: new pages, kept sizes, protected PDF pages and old single-page clients', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-'));
  try {
    const file = path.join(root, 'Pages.paperlink');
    const document = await createCanvas(file);
    assert.equal(document.version, 2);
    const first = document.pages[0];
    const stroke = 'M 1 1 l 0.01 0 L 5 5';
    // A client sends a second page; known pages keep their stored size.
    await saveCanvas(file, document.id, { revision: 0, operationId: 'add', pages: [{ ...first, width: 50, strokes: [stroke] }, { id: 'second-page', width: 900, height: 1273, strokes: [] }] });
    let saved = await readCanvas(file, document.id);
    assert.deepEqual(saved.pages.map(page => [page.id, page.width, page.strokes.length]), [[first.id, 900, 1], ['second-page', 900, 0]]);
    await assert.rejects(saveCanvas(file, document.id, { revision: 1, operationId: 'dup', pages: [first, first] }), error => error.status === 400);
    await assert.rejects(saveCanvas(file, document.id, { revision: 1, operationId: 'pdf', pages: [first, { id: 'fake', width: 900, height: 900, strokes: [], pdfPage: 1 }] }), /Unknown PDF page/);
    // Old clients sending one page's strokes are refused once there are several pages.
    await assert.rejects(saveCanvas(file, document.id, { revision: 1, operationId: 'old', strokes: [] }), error => error.status === 409);

    // PDF-backed pages cannot be dropped.
    saved.pages[0].pdfPage = 1;
    saved.pdf = { file: 'Sheet.pdf' };
    await writeFile(file, JSON.stringify(saved));
    await assert.rejects(saveCanvas(file, document.id, { revision: 1, operationId: 'drop', pages: [saved.pages[1]] }), /cannot be removed/);
    await saveCanvas(file, document.id, { revision: 1, operationId: 'keep', pages: [{ id: first.id, width: 60, height: 60, strokes: [] }, saved.pages[1]] });
    saved = await readCanvas(file, document.id);
    assert.equal(saved.pages[0].pdfPage, 1, 'PDF backing survives a save');
    assert.equal(saved.pages[0].height, 1273);

    // Version 1 files are read and upgraded on the next save.
    const legacy = path.join(root, 'Legacy.paperlink');
    await writeFile(legacy, JSON.stringify({ format: 'paperlink', version: 1, id: '8cdf569c-5c4a-4ca6-97c6-ed92c0ca05f5', title: 'Old', revision: 0, pages: [{ id: 'p', width: 900, height: 1100, strokes: [] }] }));
    await saveCanvas(legacy, '8cdf569c-5c4a-4ca6-97c6-ed92c0ca05f5', { revision: 0, operationId: 'old-client', strokes: [stroke] });
    const upgraded = await readCanvas(legacy);
    assert.equal(upgraded.version, 2);
    assert.equal(upgraded.pages[0].height, 1100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('page templates and pages inserted after another page', async () => {
  const { saveOperations } = await import('../src/store.js');
  const { templateMarks } = await import('../src/ink.js');
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-'));
  try {
    const file = path.join(root, 'Templates.paperlink');
    const document = await createCanvas(file);
    const first = document.pages[0].id;
    const page = (id, template) => ({ id, width: 900, height: 1273, ...(template && { template }) });
    await saveOperations(file, document.id, { operationId: 'a', ops: [{ type: 'addPage', page: page('end-page') }] });
    await saveOperations(file, document.id, { operationId: 'b', ops: [{ type: 'addPage', page: page('lined-page', 'lined'), after: first }] });
    // A page whose predecessor is gone lands at the end.
    await saveOperations(file, document.id, { operationId: 'c', ops: [{ type: 'addPage', page: page('dotted-page', 'dotted'), after: 'missing-page' }] });
    const saved = await readCanvas(file, document.id);
    assert.deepEqual(saved.pages.map(p => [p.id === first ? 'first' : p.id, p.template ?? null]), [['first', null], ['lined-page', 'lined'], ['end-page', null], ['dotted-page', 'dotted']]);
    await assert.rejects(saveOperations(file, document.id, { operationId: 'd', ops: [{ type: 'addPage', page: page('bad-page', 'music') }] }), error => error.status === 400);
    await assert.rejects(saveCanvas(file, document.id, { revision: saved.revision, operationId: 'e', pages: [...saved.pages, { ...page('x-page', 'zigzag'), strokes: [] }] }), error => error.status === 400);
    // Older pages without a template keep their squares; blank has none.
    assert.ok(templateMarks(undefined, 900, 1273).lines.length > 70);
    assert.deepEqual(templateMarks('blank', 900, 1273), { lines: [], dots: [] });
    assert.ok(templateMarks('lined', 900, 1273).lines.every(([x1, y1, x2, y2]) => y1 === y2 && x1 === 0 && x2 === 900));
    assert.equal(templateMarks('dotted', 900, 1273).dots.length, 32 * 45);
  } finally { await rm(root, { recursive: true, force: true }); }
});
