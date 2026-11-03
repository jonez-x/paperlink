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

export async function listCanvases(vault, folder) {
  const directory = await documentFolder(vault, folder);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.paperlink.json')) continue;
    const filename = path.join(directory, entry.name);
    const document = JSON.parse(await readFile(filename, 'utf8'));
    if (document.format !== 'paperlink' || document.version !== 1) {
      throw new Error('Unsupported canvas format: ' + filename);
    }
    result.push({ id: document.id, title: document.title, revision: document.revision, path: filename });
  }
  return result.sort((a, b) => a.title.localeCompare(b.title));
}
