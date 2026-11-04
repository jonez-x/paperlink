import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// A canvas is one file, "<Title>.paperlink", wherever the user keeps it.
// Earlier versions named files "<id>.paperlink.json"; those still open.
export const EXTENSION = '.paperlink';
const LEGACY_FILE = /^[a-f0-9-]{36}\.paperlink\.json$/;

export const isCanvasFile = file => path.basename(file).endsWith(EXTENSION) || LEGACY_FILE.test(path.basename(file));

// File name without the canvas extension: "Sheet 3.paperlink" → "Sheet 3".
export const canvasBase = file => path.basename(file).replace(/\.paperlink(?:\.json)?$/, '');

// Titles become file names that work on every system and as Obsidian links.
export const safeFileName = title => title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Canvas';

// "Uni/Sheet 3" → "<cwd>/Uni/Sheet 3.paperlink".
export function canvasPath(input, cwd = process.cwd()) {
  if (!input?.trim()) throw new Error('A canvas name is required.');
  const absolute = path.resolve(cwd, input.trim());
  return isCanvasFile(absolute) ? absolute : absolute + EXTENSION;
}

export async function createCanvas(file, title = canvasBase(file)) {
  if (!title?.trim()) throw new Error('A canvas title is required.');
  if (title.trim().length > 200) throw new Error('Canvas titles are limited to 200 characters.');
  if (!isCanvasFile(file)) throw new Error('Canvas files end in ' + EXTENSION + '.');
  await mkdir(path.dirname(file), { recursive: true });
  const document = {
    format: 'paperlink', version: 1, id: randomUUID(), title: title.trim(),
    revision: 0, createdAt: new Date().toISOString(),
    pages: [{ id: randomUUID(), width: 900, height: 1100, strokes: [] }]
  };
  try {
    await writeFile(file, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    throw error.code === 'EEXIST' ? new Error('A file already exists at ' + file + '.') : error;
  }
  return { ...document, path: file };
}

// The nearest enclosing Obsidian vault, recognised by its .obsidian folder.
export async function obsidianVault(file) {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    try { if ((await stat(path.join(directory, '.obsidian'))).isDirectory()) return directory; }
    catch { /* not a vault root */ }
    if (path.dirname(directory) === directory) return null;
  }
}

// Visible subfolders and canvases of a folder, for the interactive picker.
export async function folderEntries(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = entries.filter(entry => !entry.name.startsWith('.'));
    return {
      folders: visible.filter(entry => entry.isDirectory() && entry.name !== 'node_modules').map(entry => entry.name).sort((a, b) => a.localeCompare(b)),
      canvases: visible.filter(entry => entry.isFile() && isCanvasFile(entry.name)).map(entry => entry.name).sort((a, b) => a.localeCompare(b))
    };
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) return { folders: [], canvases: [] };
    throw error;
  }
}

// Canvas files below a folder: to adopt a library from earlier versions and to
// find canvases moved outside Paperlink.
export async function findCanvasFiles(directory, maxDepth = 16, depth = 0) {
  const found = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isFile() && isCanvasFile(entry.name)) found.push(full);
    else if (entry.isDirectory() && entry.name !== 'node_modules' && depth < maxDepth) found.push(...await findCanvasFiles(full, maxDepth, depth + 1));
  }
  return found;
}
