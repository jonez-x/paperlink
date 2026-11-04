import { access, copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { canvasBase, findCanvasFiles, isCanvasFile, obsidianVault } from './documents.js';
import { backgroundDirectory, findNote, findNoteInVault, freeName, legacyPreviewName, previewPath } from './preview.js';
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

// Moves or renames a canvas together with its note.
export async function moveCanvas(file, id, destination, { withNote = true } = {}) {
  if (!isCanvasFile(destination)) throw new Error('The destination must end in .paperlink.');
  const document = await readCanvas(file, id);
  if (path.resolve(destination) === path.resolve(file)) return { path: file, note: withNote ? await findNote(path.dirname(file), id) : null };
  if (await exists(destination)) throw new Error('A file already exists at ' + destination + '.');
  const from = path.dirname(file), to = path.dirname(destination);
  await mkdir(to, { recursive: true });
  const note = withNote ? await findNote(from, id) : null;
  const oldVault = await obsidianVault(file);
  await moveFile(file, destination);
  // Leaving a vault leaves no orphaned preview behind.
  if (oldVault && oldVault !== await obsidianVault(destination)) await unlink(previewPath(oldVault, id)).catch(() => {});
  // Previews live in the vault's preview folder; only ones from earlier versions sit next to the canvas.
  const legacyPreview = path.join(from, legacyPreviewName(id));
  if (from !== to && await exists(legacyPreview)) await moveFile(legacyPreview, path.join(to, legacyPreviewName(id)), { overwrite: true });
  // The PDF behind the pages travels along; a name clash gets a free name.
  const pdf = document.pdf && path.join(from, document.pdf.file);
  if (pdf && from !== to && await exists(pdf)) {
    const target = await freeName(to, path.basename(pdf, path.extname(pdf)), path.extname(pdf));
    await moveFile(pdf, target);
    if (path.basename(target) !== document.pdf.file) {
      const stored = JSON.parse(await readFile(destination, 'utf8'));
      stored.pdf.file = path.basename(target);
      const temporary = destination + '.pdf-rename.tmp';
      await writeFile(temporary, JSON.stringify(stored, null, 2) + '\n');
      await rename(temporary, destination);
    }
  }
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

// The system trash, so deleting stays reversible.
function trashDirectory() {
  if (process.env.PAPERLINK_TRASH) return process.env.PAPERLINK_TRASH;
  return process.platform === 'darwin' ? path.join(homedir(), '.Trash') : path.join(homedir(), '.local', 'share', 'Trash', 'files');
}

export async function trash(file) {
  if (process.platform === 'win32' && !process.env.PAPERLINK_TRASH) return recycle(file);
  const directory = trashDirectory();
  await mkdir(directory, { recursive: true });
  const extension = path.extname(file);
  const target = await freeName(directory, path.basename(file, extension), extension);
  await moveFile(file, target);
  return target;
}

// Windows has no trash folder to move into; the Recycle Bin is reached through
// .NET. The path goes in an environment variable, never into the script.
async function recycle(file) {
  const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:PAPERLINK_RECYCLE, 'OnlyErrorDialogs', 'SendToRecycleBin')";
  try {
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, PAPERLINK_RECYCLE: file }, timeout: 30000, windowsHide: true });
  } catch (error) {
    throw new Error('Could not move ' + file + ' to the Recycle Bin: ' + (error.stderr?.trim() || error.message));
  }
  return 'Recycle Bin';
}

// Moves a canvas, its note and its preview to the trash.
// A PDF that was copied in goes too; one the user kept there already stays.
export async function deleteCanvas(file, id) {
  const removed = [];
  const document = await readCanvas(file, id).catch(() => null);
  const vault = await obsidianVault(file);
  const note = await findNote(path.dirname(file), id);
  const previews = [vault && previewPath(vault, id), path.join(path.dirname(file), legacyPreviewName(id))].filter(Boolean);
  const pdf = document?.pdf?.copied ? path.join(path.dirname(file), document.pdf.file) : null;
  for (const candidate of [file, note, pdf, ...previews]) {
    if (candidate && await exists(candidate)) { await trash(candidate); removed.push(candidate); }
  }
  await rm(backgroundDirectory(id), { recursive: true, force: true });
  return removed;
}
