import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function documentFolder(library, folder = '.') {
  const root = await realpath(library);
  const target = path.resolve(root, folder);
  const inside = candidate => candidate === root || candidate.startsWith(root + path.sep);
  if (!inside(target)) throw new Error('Canvas folder must be inside the library.');
  // Check each existing component before creating directories through it.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!inside(await realpath(current))) throw new Error('Folder symlink leaves the library.');
  }
  return target;
}

export async function createCanvas(library, folder, title) {
  if (!title?.trim()) throw new Error('A canvas title is required.');
  if (title.trim().length > 200) throw new Error('Canvas titles are limited to 200 characters.');
  const directory = await documentFolder(library, folder);
  const document = {
    format: 'paperlink', version: 1, id: randomUUID(), title: title.trim(),
    revision: 0, createdAt: new Date().toISOString(),
    pages: [{ id: randomUUID(), width: 900, height: 1100, strokes: [] }]
  };
  const filename = path.join(directory, document.id + '.paperlink.json');
  await writeFile(filename, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  const root = await realpath(library);
  return { ...document, path: filename, folder: path.relative(root, directory) || '.' };
}

const CANVAS_FILE = /^([a-f0-9-]{36})\.paperlink\.json$/;
const SKIPPED_FOLDERS = new Set(['node_modules']);

// Hidden folders (.obsidian, .git, .trash) and symlinked folders are never entered.
async function* walk(directory, recursive, depth = 0) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) yield { directory, entry };
    else if (recursive && entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name) && depth < 16) {
      yield* walk(path.join(directory, entry.name), true, depth + 1);
    }
  }
}

// Lists valid canvases. Unreadable files, unsupported formats and sync conflict
// copies (e.g. "<id> 2.paperlink.json") are skipped and reported via onSkip,
// so one damaged or half-synced file never hides the rest of the library.
export async function listCanvases(library, folder = '.', { recursive = false, onSkip = () => {} } = {}) {
  const root = await realpath(library);
  const start = await documentFolder(library, folder);
  const result = [];
  for await (const { directory, entry } of walk(start, recursive)) {
    if (!entry.name.endsWith('.paperlink.json') || entry.name.startsWith('.')) continue;
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
    result.push({
      id: document.id, title: document.title, revision: document.revision,
      folder: path.relative(root, directory) || '.', updatedAt: document.updatedAt || document.createdAt, path: filename
    });
  }
  return result.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title));
}

// Immediate subfolders for the interactive folder picker.
export async function listFolders(library, folder = '.') {
  const root = await realpath(library);
  const target = path.resolve(root, folder);
  if (target !== root && !target.startsWith(root + path.sep)) return [];
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name))
      .map(entry => entry.name).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
