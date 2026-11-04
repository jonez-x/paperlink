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
