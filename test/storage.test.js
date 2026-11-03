import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas, documentFolder } from '../src/documents.js';
import { readCanvas, saveCanvas } from '../src/store.js';

test('durable save, exact retry, conflicts, validation and folder confinement', async () => {
  const vault = await mkdtemp(path.join(tmpdir(), 'paperlink-'));
  try {
    const document = await createCanvas(vault, 'Notes', 'Test');
    const directory = await documentFolder(vault, 'Notes');
    const request = { revision: 0, operationId: 'first', strokes: ['M 10 10 l 0.01 0 L 20 30'] };
    assert.deepEqual(await saveCanvas(directory, document.id, request), { revision: 1 });
    assert.deepEqual(await saveCanvas(directory, document.id, request), { revision: 1 });
    assert.equal((await readCanvas(directory, document.id)).pages[0].strokes[0], request.strokes[0]);
    await assert.rejects(saveCanvas(directory, document.id, { ...request, operationId: 'stale' }), error => error.status === 409);
    await assert.rejects(saveCanvas(directory, document.id, { ...request, strokes: [] }), error => error.status === 409);
    const before = await readFile(document.path, 'utf8');
    await assert.rejects(saveCanvas(directory, document.id, { revision: 1, operationId: 'bad', strokes: ['<script>'] }));
    assert.equal(await readFile(document.path, 'utf8'), before);
    await assert.rejects(documentFolder(vault, '../outside'));
    assert.deepEqual(await saveCanvas(directory, document.id, { revision: 1, operationId: 'erase', strokes: [] }), { revision: 2 });
    assert.deepEqual((await readCanvas(directory, document.id)).pages[0].strokes, []);
  } finally { await rm(vault, { recursive: true, force: true }); }
});
