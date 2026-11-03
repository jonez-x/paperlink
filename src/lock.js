import { mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Locks live in the per-user temp directory, not in the vault: synced folders
// (iCloud, Obsidian Sync) would otherwise copy them to other devices.
export function lockDirectory() {
  return process.env.PAPERLINK_LOCK_DIR || path.join(tmpdir(), 'paperlink-locks');
}

function lockPathFor(directory) {
  const name = createHash('sha256').update(directory).digest('hex').slice(0, 32) + '.lock';
  return path.join(lockDirectory(), name);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function ownerPid(file) {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return text.startsWith('{') ? JSON.parse(text).pid : Number(text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return NaN; // Unreadable lock content counts as stale.
  }
}

async function removeIfStale(file) {
  const pid = await ownerPid(file);
  if (pid === null) return;
  if (isAlive(pid)) throw new Error('This folder is already served by process ' + pid + '. Stop that server first.');
  await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

// Acquire a single-writer lock for a canvas folder. Locks left by crashed
// processes are detected via their PID and replaced.
export async function acquireFolderLock(directory) {
  // Earlier versions wrote the lock into the vault folder itself.
  await removeIfStale(path.join(directory, '.paperlink-server.lock'));
  await mkdir(lockDirectory(), { recursive: true, mode: 0o700 });
  const file = lockPathFor(directory);
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, directory })); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await link(temporary, file); break; } // Atomic: fails if the lock exists.
      catch (error) {
        if (error.code !== 'EEXIST' || attempt > 0) {
          if (error.code === 'EEXIST') throw new Error('Could not acquire the folder lock at ' + file + '.');
          throw error;
        }
        await removeIfStale(file);
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
  let released = false;
  return {
    path: file,
    async release() {
      if (released) return;
      released = true;
      if (await ownerPid(file) === process.pid) await unlink(file).catch(() => {});
    }
  };
}
