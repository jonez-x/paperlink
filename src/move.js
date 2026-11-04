import { access, copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { canvasBase, findCanvasFiles, isCanvasFile, obsidianVault } from './documents.js';
import { findNote, findNoteInVault, freeName, previewName } from './preview.js';
import { readCanvas } from './store.js';

const exists = file => access(file).then(() => true, () => false);

// Same-volume renames are atomic; across volumes the file is copied first.
async function moveFile(from, to, { overwrite = false } = {}) {
  try { await rename(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(from, to, overwrite ? 0 : 1); // 1 = COPYFILE_EXCL
    await unlink(from);
  }
}

// Moves or renames a canvas together with its preview and note.
export async function moveCanvas(file, id, destination, { withNote = true } = {}) {
  if (!isCanvasFile(destination)) throw new Error('The destination must end in .paperlink.');
  await readCanvas(file, id);
  if (path.resolve(destination) === path.resolve(file)) return { path: file, note: withNote ? await findNote(path.dirname(file), id) : null };
  if (await exists(destination)) throw new Error('A file already exists at ' + destination + '.');
  const from = path.dirname(file), to = path.dirname(destination);
  await mkdir(to, { recursive: true });
  const note = withNote ? await findNote(from, id) : null;
  await moveFile(file, destination);
  const preview = path.join(from, previewName(id));
  if (from !== to && await exists(preview)) await moveFile(preview, path.join(to, previewName(id)), { overwrite: true });
  let movedNote = null;
  if (note) {
    // A note still named like the canvas follows a rename; a name the user chose stays.
    const current = path.basename(note, '.md');
    const base = current === canvasBase(file) ? canvasBase(destination) : current;
    movedNote = from === to && base === current ? note : await freeName(to, base, '.md');
    if (movedNote !== note) await moveFile(note, movedNote);
  }
  return { path: destination, note: movedNote };
}

// Finds a canvas moved outside Paperlink: anywhere in its Obsidian vault, or
// otherwise close to where it was. Home and root folders are never scanned.
export async function findMoved(id, oldPath) {
  let directory = path.dirname(oldPath);
  while (!(await exists(directory))) {
    if (path.dirname(directory) === directory) return null;
    directory = path.dirname(directory);
  }
  const vault = await obsidianVault(path.join(directory, 'x'));
  const blocked = root => root === homedir() || path.dirname(root) === root;
  let root = vault || directory;
  if (!vault && !blocked(path.dirname(root))) root = path.dirname(root);
  if (blocked(root)) return null;
  for (const candidate of await findCanvasFiles(root, vault ? 16 : 3)) {
    try { if ((await readCanvas(candidate)).id === id) return candidate; } catch { /* not this one */ }
  }
  return null;
}

// When the user moved the note inside Obsidian, the canvas follows it.
// Returns the new canvas path, or null when nothing moved.
export async function followNote(file, id) {
  const vault = await obsidianVault(file);
  if (!vault || await findNote(path.dirname(file), id)) return null;
  const note = await findNoteInVault(vault, id);
  if (!note || path.dirname(note) === path.dirname(file)) return null;
  const extension = path.basename(file).slice(canvasBase(file).length);
  const destination = await freeName(path.dirname(note), canvasBase(file), extension);
  return (await moveCanvas(file, id, destination, { withNote: false })).path;
}
