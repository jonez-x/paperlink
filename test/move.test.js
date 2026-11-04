import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '../src/documents.js';
import { writeObsidianFiles } from '../src/preview.js';
import { deleteCanvas, findMoved, followNote, moveCanvas } from '../src/move.js';

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-move-'));
  await mkdir(path.join(root, '.obsidian'));
  return root;
}
const list = async directory => (await readdir(directory)).sort();

test('move and rename take preview and note along', async () => {
  const root = await vault();
  try {
    const canvas = await createCanvas(path.join(root, 'A', 'Sheet.paperlink'));
    await writeObsidianFiles(canvas.path, canvas);
    const preview = path.join(root, 'Paperlink Previews', canvas.id + '.svg');

    // Rename in place: the note named like the canvas follows, the preview stays.
    const renamed = await moveCanvas(canvas.path, canvas.id, path.join(root, 'A', 'Sheet 2.paperlink'));
    assert.deepEqual(await list(path.join(root, 'A')), ['Sheet 2.md', 'Sheet 2.paperlink'].sort());
    assert.equal(renamed.note, path.join(root, 'A', 'Sheet 2.md'));

    // A note the user renamed keeps its name when moved.
    await rename(renamed.note, path.join(root, 'A', 'My notes.md'));
    await writeFile(path.join(root, 'B.md'), 'unrelated');
    const moved = await moveCanvas(renamed.path, canvas.id, path.join(root, 'B', 'Sheet 2.paperlink'));
    assert.deepEqual(await list(path.join(root, 'A')), []);
    assert.deepEqual(await list(path.join(root, 'B')), ['My notes.md', 'Sheet 2.paperlink'].sort());
    assert.equal(moved.note, path.join(root, 'B', 'My notes.md'));
    await assert.rejects(moveCanvas(moved.path, canvas.id, path.join(root, 'B', 'Sheet 2.paperlink.txt')), /must end in/);
    await readFile(preview);

    // Leaving the vault removes its preview; deleting sends everything to the trash.
    const outside = await mkdtemp(path.join(tmpdir(), 'paperlink-outside-'));
    process.env.PAPERLINK_TRASH = path.join(outside, 'Trash');
    try {
      const away = await moveCanvas(moved.path, canvas.id, path.join(outside, 'Sheet 2.paperlink'));
      await assert.rejects(readFile(preview), 'no orphaned preview');
      assert.deepEqual(await list(outside), ['My notes.md', 'Sheet 2.paperlink']);
      const trashed = await deleteCanvas(away.path, canvas.id);
      assert.equal(trashed.length, 2);
      assert.deepEqual(await list(outside), ['Trash']);
      assert.deepEqual(await list(path.join(outside, 'Trash')), ['My notes.md', 'Sheet 2.paperlink']);
    } finally {
      delete process.env.PAPERLINK_TRASH;
      await rm(outside, { recursive: true, force: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('canvases moved outside Paperlink are found by ID', async () => {
  const root = await vault();
  try {
    const canvas = await createCanvas(path.join(root, 'A', 'Sheet.paperlink'));
    await createCanvas(path.join(root, 'C', 'Other.paperlink'));
    await mkdir(path.join(root, 'Deep', 'er'), { recursive: true });
    await rename(canvas.path, path.join(root, 'Deep', 'er', 'Renamed.paperlink'));
    assert.equal(await findMoved(canvas.id, canvas.path), path.join(root, 'Deep', 'er', 'Renamed.paperlink'), 'anywhere in the vault');
    assert.equal(await findMoved('00000000-0000-0000-0000-000000000000', canvas.path), null);
  } finally { await rm(root, { recursive: true, force: true }); }
  const plainFolder = await mkdtemp(path.join(tmpdir(), 'paperlink-move-'));
  try {
    const canvas = await createCanvas(path.join(plainFolder, 'Uni', 'A', 'Sheet.paperlink'));
    await mkdir(path.join(plainFolder, 'Uni', 'B'));
    await rename(canvas.path, path.join(plainFolder, 'Uni', 'B', 'Sheet.paperlink'));
    assert.equal(await findMoved(canvas.id, canvas.path), path.join(plainFolder, 'Uni', 'B', 'Sheet.paperlink'), 'next to the old folder');
  } finally { await rm(plainFolder, { recursive: true, force: true }); }
});

test('a note moved in Obsidian takes its canvas along', async () => {
  const root = await vault();
  try {
    const canvas = await createCanvas(path.join(root, 'Inbox', 'Sheet.paperlink'));
    const files = await writeObsidianFiles(canvas.path, canvas);
    assert.equal(await followNote(canvas.path, canvas.id), null, 'note still next to the canvas');
    await mkdir(path.join(root, 'Module'));
    await rename(files.note, path.join(root, 'Module', 'Sheet.md'));
    assert.equal(await followNote(canvas.path, canvas.id), path.join(root, 'Module', 'Sheet.paperlink'));
    assert.deepEqual(await list(path.join(root, 'Module')), ['Sheet.md', 'Sheet.paperlink']);
    assert.deepEqual(await list(path.join(root, 'Inbox')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
