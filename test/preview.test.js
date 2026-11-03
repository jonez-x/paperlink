import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderPreview, writeObsidianFiles } from '../src/preview.js';

const canvas = (strokes, title = 'Sheet') => ({ id: '8cdf569c-5c4a-4ca6-97c6-ed92c0ca05f5', title, pages: [{ strokes }] });
const viewBox = svg => svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);

test('preview keeps the page width and fits the content height', () => {
  assert.deepEqual(viewBox(renderPreview(canvas([]))), [0, 0, 900, 240], 'empty canvas');
  assert.deepEqual(viewBox(renderPreview(canvas(['M 100 500 l 0.01 0 L 200 600']))), [0, 0, 900, 640]);
  // Writing left of the page (wide screens) widens the preview instead of being cut off.
  assert.deepEqual(viewBox(renderPreview(canvas(['M -400 20 l 0.01 0 L 950 30']))), [-440, -20, 1430, 240]);
  assert.match(renderPreview(canvas([], 'A <b> & "c"')), /<title>A &lt;b&gt; &amp; &quot;c&quot;<\/title>/);
});

test('notes are created once, survive renames and avoid name clashes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperlink-preview-'));
  try {
    await writeFile(path.join(directory, 'Sheet.md'), 'my own note\n');
    const first = await writeObsidianFiles(directory, canvas(['M 1 1 l 0.01 0']));
    assert.equal(path.basename(first.note), 'Sheet (2).md');
    assert.equal(first.noteCreated, true);

    await writeFile(first.note, (await readFile(first.note, 'utf8')) + '\nMy annotations\n');
    await rename(first.note, path.join(directory, 'Renamed.md'));
    const second = await writeObsidianFiles(directory, canvas(['M 1 1 l 0.01 0 L 5 5']));
    assert.equal(path.basename(second.note), 'Renamed.md');
    assert.equal(second.noteCreated, false);
    assert.match(await readFile(second.note, 'utf8'), /My annotations/, 'user text is never overwritten');
    assert.match(await readFile(second.preview, 'utf8'), /L 5 5/);
    assert.deepEqual((await readdir(directory)).sort(), ['8cdf569c-5c4a-4ca6-97c6-ed92c0ca05f5.preview.svg', 'Renamed.md', 'Sheet.md']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
