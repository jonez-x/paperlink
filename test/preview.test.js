import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderPreview, writeObsidianFiles, writePreview } from '../src/preview.js';

const canvas = (strokes, title = 'Sheet') => ({ id: '8cdf569c-5c4a-4ca6-97c6-ed92c0ca05f5', title, pages: [{ strokes }] });
const viewBox = svg => svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);

test('preview keeps the page width and fits the content height', () => {
  assert.deepEqual(viewBox(renderPreview(canvas([]))), [0, 0, 900, 240], 'empty canvas');
  assert.deepEqual(viewBox(renderPreview(canvas(['M 100 500 l 0.01 0 L 200 600']))), [0, 0, 900, 640]);
  // Writing left of the page (wide screens) widens the preview instead of being cut off.
  assert.deepEqual(viewBox(renderPreview(canvas(['M -400 20 l 0.01 0 L 950 30']))), [-440, -20, 1430, 240]);
  assert.match(renderPreview(canvas([], 'A <b> & "c"')), /<title>A &lt;b&gt; &amp; &quot;c&quot;<\/title>/);
});

const ID = '8cdf569c-5c4a-4ca6-97c6-ed92c0ca05f5';
async function vault() {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperlink-preview-'));
  await mkdir(path.join(directory, '.obsidian'));
  return directory;
}

test('notes are created once, survive renames and avoid name clashes', async () => {
  const directory = await vault();
  try {
    await writeFile(path.join(directory, 'Sheet.md'), 'my own note\n');
    const file = path.join(directory, 'Sheet.paperlink');
    const first = await writeObsidianFiles(file, canvas(['M 1 1 l 0.01 0']));
    assert.equal(path.basename(first.note), 'Sheet (2).md');
    assert.match(await readFile(first.note, 'utf8'), new RegExp('!\\[\\[' + ID + '\\.svg\\]\\]'));
    assert.equal(first.preview, path.join(directory, 'Paperlink Previews', ID + '.svg'), 'previews live in one folder per vault');
    assert.equal(first.noteCreated, true);

    await writeFile(first.note, (await readFile(first.note, 'utf8')) + '\nMy annotations\n');
    await rename(first.note, path.join(directory, 'Renamed.md'));
    const second = await writeObsidianFiles(file, canvas(['M 1 1 l 0.01 0 L 5 5']));
    assert.equal(path.basename(second.note), 'Renamed.md');
    assert.equal(second.noteCreated, false);
    assert.match(await readFile(second.note, 'utf8'), /My annotations/, 'user text is never overwritten');
    assert.match(await readFile(second.preview, 'utf8'), /L 5 5/);
    assert.deepEqual((await readdir(directory)).sort(), ['.obsidian', 'Paperlink Previews', 'Renamed.md', 'Sheet.md']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('notes from earlier versions get the preview folder and a link', async () => {
  const directory = await vault();
  try {
    const file = path.join(directory, ID + '.paperlink.json');
    await writeFile(path.join(directory, ID + '.preview.svg'), '<svg/>');
    await writeFile(path.join(directory, 'iPad Test.md'), '---\npaperlink: ' + ID + '\n---\n\n![[' + ID + '.preview.svg]]\n\nOpen on your iPad: `paper open 8cdf569c`\n\nMy text\n');
    const link = 'http://mac.local:8080/#canvas=' + ID;
    const files = await writeObsidianFiles(file, canvas([], 'iPad Test'), { link });
    assert.equal(path.basename(files.note), 'iPad Test.md');
    assert.equal(await readFile(files.note, 'utf8'), '---\npaperlink: ' + ID + '\n---\n\n![[' + ID + '.svg]]\n\n[Open in Paperlink](' + link + ')\n\nMy text\n', 'only embed and open line change');
    assert.deepEqual((await readdir(directory)).sort(), ['.obsidian', 'Paperlink Previews', 'iPad Test.md']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('no preview outside a vault', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperlink-preview-'));
  try { assert.equal(await writePreview(path.join(directory, 'Sheet.paperlink'), canvas([])), null); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
