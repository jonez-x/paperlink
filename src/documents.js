import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function documentFolder(vault, folder = '.') {
  const root = await realpath(vault);
  const target = path.resolve(root, folder);
  const inside = candidate => candidate === root || candidate.startsWith(root + path.sep);
  if (!inside(target)) throw new Error('Canvas folder must be inside the vault.');
  // Check each existing component before creating directories through it.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!inside(await realpath(current))) throw new Error('Folder symlink leaves the vault.');
  }
  return target;
}

export async function createCanvas(vault, folder, title) {
  if (!title?.trim()) throw new Error('A canvas title is required.');
  const directory = await documentFolder(vault, folder);
  const document = {
    format: 'paperlink', version: 1, id: randomUUID(), title: title.trim(),
    revision: 0, createdAt: new Date().toISOString(),
    pages: [{ id: randomUUID(), width: 900, height: 1100, strokes: [] }]
  };
  const filename = path.join(directory, document.id + '.paperlink.json');
  await writeFile(filename, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  return { ...document, path: filename };
}

const CANVAS_FILE = /^([a-f0-9-]{36})\.paperlink\.json$/;

// Lists valid canvases. Unreadable files, unsupported formats and sync conflict
// copies (e.g. "<id> 2.paperlink.json") are skipped and reported via onSkip,
// so one damaged or half-synced file never hides the rest of the folder.
export async function listCanvases(vault, folder, { onSkip = () => {} } = {}) {
  const directory = await documentFolder(vault, folder);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.paperlink.json') || entry.name.startsWith('.')) continue;
    const filename = path.join(directory, entry.name);
    const match = CANVAS_FILE.exec(entry.name);
    if (!match) { onSkip({ path: filename, reason: 'Unexpected file name (possibly a sync conflict copy).' }); continue; }
    let document;
    try { document = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { onSkip({ path: filename, reason: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }); continue; }
    if (document?.format !== 'paperlink' || document.version !== 1 || document.id !== match[1] ||
        typeof document.title !== 'string' || !Number.isInteger(document.revision)) {
      onSkip({ path: filename, reason: 'Unsupported or inconsistent canvas format.' });
      continue;
    }
    result.push({ id: document.id, title: document.title, revision: document.revision, path: filename });
  }
  return result.sort((a, b) => a.title.localeCompare(b.title));
}
