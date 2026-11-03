import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createCanvas, documentFolder, listCanvases } from '../src/documents.js';
import { acquireFolderLock } from '../src/lock.js';
import { DraftStore } from '../src/drafts.js';

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('folder lock lives outside the vault, blocks a live owner and replaces stale locks', async () => {
  const vault = await mkdtemp(path.join(tmpdir(), 'paperlink-lock-'));
  process.env.PAPERLINK_LOCK_DIR = await mkdtemp(path.join(tmpdir(), 'paperlink-locks-'));
  try {
    const directory = await documentFolder(vault, 'Canvases');
    const lock = await acquireFolderLock(directory);
    assert.deepEqual(await readdir(directory), [], 'no lock file inside the vault');
    await assert.rejects(acquireFolderLock(directory), /already served by process/);
    await lock.release();

    // A lock left by a crashed process is replaced.
    await writeFile(lock.path, JSON.stringify({ pid: deadPid(), directory }));
    const second = await acquireFolderLock(directory);
    await second.release();
    await assert.rejects(access(second.path));

    // A stale lock from earlier versions inside the vault is removed.
    const legacy = path.join(directory, '.paperlink-server.lock');
    await writeFile(legacy, String(deadPid()));
    await (await acquireFolderLock(directory)).release();
    await assert.rejects(access(legacy));

    // A legacy lock held by a live process still blocks.
    await writeFile(legacy, String(process.pid));
    await assert.rejects(acquireFolderLock(directory), /already served by process/);
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(process.env.PAPERLINK_LOCK_DIR, { recursive: true, force: true });
    delete process.env.PAPERLINK_LOCK_DIR;
  }
});

test('listing skips damaged files and sync conflict copies', async () => {
  const vault = await mkdtemp(path.join(tmpdir(), 'paperlink-list-'));
  try {
    const good = await createCanvas(vault, 'Notes', 'Good');
    const directory = path.dirname(good.path);
    await writeFile(path.join(directory, good.id.replace(/.$/, last => last === '0' ? '1' : '0') + '.paperlink.json'), '{"broken');
    await writeFile(path.join(directory, good.id + ' 2.paperlink.json'), JSON.stringify({ ...good, path: undefined }));
    const mismatched = '00000000-0000-0000-0000-000000000000';
    await writeFile(path.join(directory, mismatched + '.paperlink.json'), JSON.stringify({ ...good, path: undefined }));
    const skipped = [];
    const list = await listCanvases(vault, 'Notes', { onSkip: entry => skipped.push(entry) });
    assert.deepEqual(list.map(entry => entry.id), [good.id]);
    assert.equal(skipped.length, 3);
  } finally { await rm(vault, { recursive: true, force: true }); }
});

test('draft store bounds memory, frees imported drafts and expires idle ones', () => {
  let clock = 0;
  const drafts = new DraftStore({ maxDrafts: 2, maxTotalBytes: 100, idleMilliseconds: 1000 }, () => clock);
  const stroke = 'M 1 1 l 0.01 0';
  assert.equal(drafts.publish('a', [stroke]), null);
  assert.equal(drafts.publish('b', [stroke]), null);
  assert.throws(() => drafts.publish('c', [stroke]), error => error.status === 429);
  assert.throws(() => drafts.publish('a', ['x'.repeat(200)]), error => error.status === 429);
  assert.equal(drafts.get('a').strokes.length, 1, 'rejected update keeps the previous snapshot');

  drafts.markImported('a', { id: 'canvas', title: 'T', revision: 1 });
  assert.equal(drafts.publish('a', [stroke]).id, 'canvas');
  assert.equal(drafts.get('a').strokes, null, 'strokes are freed after the tab adopts the canvas');
  assert.equal(drafts.totalBytes, stroke.length);
  assert.equal(drafts.get('a').document.id, 'canvas', 'retried imports stay idempotent');

  clock = 2000;
  assert.deepEqual(drafts.list(), []);
  assert.equal(drafts.totalBytes, 0);
  assert.equal(drafts.publish('c', [stroke]), null);
});
