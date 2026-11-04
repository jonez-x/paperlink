import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { readCanvas } from '../src/store.js';
import { createCanvas } from '../src/documents.js';
import { parseArguments } from '../src/cli.js';
const exec = promisify(execFile);

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paperlink-cli-')));
  const env = { ...process.env, PAPERLINK_CONFIG: path.join(root, 'config', 'config.json'), PAPERLINK_LOCK_DIR: path.join(root, 'locks') };
  delete env.PAPERLINK_PORT;
  const bin = path.resolve('bin/paper.js');
  // Commands run from the sandbox, so relative canvas paths land there.
  const paper = async (...args) => {
    const { stdout } = await exec(process.execPath, [bin, ...args], { env, cwd: root });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const fails = async (...args) => {
    const error = await exec(process.execPath, [bin, ...args], { env, cwd: root }).then(() => null, error => error);
    assert.ok(error, 'expected failure: ' + args.join(' '));
    return JSON.parse(error.stderr).error;
  };
  return { root, env, paper, fails };
}

test('argument parsing supports inline values and rejects unknown options', () => {
  assert.deepEqual(parseArguments(['new', 'A b', '--title=Sheet', '--json']), { flags: { title: 'Sheet', json: true }, positional: ['new', 'A b'] });
  assert.throws(() => parseArguments(['--nope']), /Unknown option/);
  assert.throws(() => parseArguments(['--port']), /Missing value/);
  assert.throws(() => parseArguments(['--library', 'x']), /canvases are plain files/);
});

test('machine interface: canvas files anywhere, background server, links and errors', async () => {
  const { root, paper, fails } = await sandbox();
  const port = '18877';
  try {
    // A library configured by an earlier version is adopted once.
    const old = await createCanvas(path.join(root, 'OldLibrary', 'Notes', 'Legacy.paperlink'));
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, 'config', 'config.json'), JSON.stringify({ library: path.join(root, 'OldLibrary'), defaultPath: 'Notes', obsidian: false, port: 8080, lan: false }));
    assert.deepEqual((await paper('list')).map(canvas => canvas.id), [old.id]);
    const config = await paper('config', 'set', 'port', port);
    assert.equal(config.library, undefined, 'library setting is dropped');
    assert.equal(config.obsidian, true);
    assert.match(await fails('init', root), /Libraries are gone/);

    // Without a server, new still creates the file but has no links.
    const offline = await paper('new', 'Uni/Analysis/Sheet 3');
    assert.equal(offline.path, path.join(root, 'Uni', 'Analysis', 'Sheet 3.paperlink'));
    assert.equal(offline.title, 'Sheet 3');
    assert.equal(offline.note, null, 'no note outside a vault');
    assert.deepEqual(offline.links, []);
    assert.match(await fails('new', 'Uni/Analysis/Sheet 3'), /already exists/);
    assert.equal((await paper('status')).running, false);
    assert.match(await fails('drafts'), /not running/);

    // Inside an Obsidian vault a note joins the canvas.
    await mkdir(path.join(root, 'Vault', '.obsidian'), { recursive: true });
    const inVault = await paper('new', 'Vault/Module X/Exercise 1', '--title', 'Exercise 1 · Analysis');
    assert.equal(inVault.title, 'Exercise 1 · Analysis');
    assert.equal(inVault.note, path.join(root, 'Vault', 'Module X', 'Exercise 1.md'));
    assert.match(await readFile(inVault.note, 'utf8'), new RegExp('!\\[\\[' + inVault.id + '\\.preview\\.svg\\]\\]'));

    const started = await paper('start');
    assert.equal(started.running, true);
    assert.equal((await paper('start')).pid, started.pid, 'start is idempotent');
    const opened = await paper('open', 'Uni/Analysis/Sheet 3');
    assert.equal(opened.id, offline.id, 'open by path, extension optional');
    assert.match(opened.links[0], new RegExp('#key=[a-f0-9]+&canvas=' + offline.id));
    assert.equal((await paper('open', 'exercise')).id, inVault.id, 'unique partial title match');
    assert.equal((await paper('open', offline.id.slice(0, 8))).id, offline.id, 'ID prefix match');
    await paper('new', 'Uni/Sheet 4');
    assert.match(await fails('open', 'sheet'), /matches several canvases/);

    const key = opened.links[0].match(/#key=([a-f0-9]+)/)[1];
    const request = (route, method, data) => fetch('http://127.0.0.1:' + port + route, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: data && JSON.stringify(data) });
    const strokes = ['M 10 10 l 0.01 0 L 30 40'];
    assert.equal((await request('/api/canvases/' + inVault.id, 'PUT', { revision: 0, operationId: 'browser-edit', strokes })).status, 200);
    assert.deepEqual((await readCanvas(inVault.path, inVault.id)).pages[0].strokes, strokes);
    assert.equal((await request('/api/canvases/' + old.id, 'GET')).status, 200, 'adopted canvas is served');

    // Devices only reach canvases the local CLI has created or opened.
    const unknown = await createCanvas(path.join(root, 'Elsewhere', 'Private.paperlink'));
    assert.equal((await request('/api/canvases/' + unknown.id, 'GET')).status, 404);
    await paper('open', path.join(root, 'Elsewhere', 'Private.paperlink'));
    assert.equal((await request('/api/canvases/' + unknown.id, 'GET')).status, 200);

    // Draft import into a chosen file stays idempotent.
    const draftId = 'b'.repeat(32);
    assert.equal((await request('/api/drafts/' + draftId, 'PUT', { strokes })).status, 200);
    assert.equal((await paper('drafts'))[0].strokes, 1);
    const imported = await paper('import', 'Inbox/From iPad', '--from-browser', draftId);
    assert.equal(imported.path, path.join(root, 'Inbox', 'From iPad.paperlink'));
    assert.equal((await paper('import', 'Inbox/Retry', '--from-browser', draftId)).id, imported.id);
    assert.equal((await (await request('/api/drafts/' + draftId, 'PUT', { strokes })).json()).document.id, imported.id);
    assert.deepEqual((await readCanvas(imported.path, imported.id)).pages[0].strokes, strokes);
    assert.ok((await paper('list')).some(canvas => canvas.id === imported.id), 'imported canvases are known');

    // `paper move` takes note and preview along, through the running server.
    const movedCanvas = await paper('move', 'exercise', 'Vault/Module Y/');
    assert.equal(movedCanvas.path, path.join(root, 'Vault', 'Module Y', 'Exercise 1.paperlink'));
    assert.equal(movedCanvas.note, path.join(root, 'Vault', 'Module Y', 'Exercise 1.md'));
    assert.deepEqual((await readdir(path.join(root, 'Vault', 'Module X'))).sort(), []);
    assert.equal((await request('/api/canvases/' + inVault.id, 'GET')).status, 200, 'the server serves the new place');
    inVault.path = movedCanvas.path;

    // A file moved in the Finder inside a vault is found again by ID.
    await mkdir(path.join(root, 'Vault', 'Archive'));
    await rename(inVault.path, path.join(root, 'Vault', 'Archive', 'Exercise 1.paperlink'));
    assert.equal((await request('/api/canvases/' + inVault.id, 'GET')).status, 200, 'server finds it');
    assert.equal((await paper('list')).find(canvas => canvas.id === inVault.id).path, path.join(root, 'Vault', 'Archive', 'Exercise 1.paperlink'));
    assert.equal((await paper('move', inVault.id, 'Vault/Module Y/Exercise 1')).path, movedCanvas.path, 'move back next to its note');

    // Moving only the note (as Obsidian does) brings the canvas along on the next save.
    await mkdir(path.join(root, 'Vault', 'Module Z'));
    await rename(movedCanvas.note, path.join(root, 'Vault', 'Module Z', 'Exercise 1.md'));
    assert.equal((await request('/api/canvases/' + inVault.id, 'PUT', { revision: 1, operationId: 'after-note-move', strokes })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.deepEqual((await readdir(path.join(root, 'Vault', 'Module Z'))).sort(), ['Exercise 1.md', 'Exercise 1.paperlink', inVault.id + '.preview.svg'].sort());
    inVault.path = path.join(root, 'Vault', 'Module Z', 'Exercise 1.paperlink');

    // Moved files are reported; forgetting keeps the file.
    await rename(offline.path, path.join(root, 'Moved.paperlink'));
    assert.equal((await paper('list')).find(canvas => canvas.id === offline.id).missing, true);
    assert.match(await fails('open', offline.id), /no longer at/);
    assert.equal((await paper('open', 'Moved')).id, offline.id, 'reopening by the new path updates the list');
    assert.equal((await paper('forget', 'Moved')).forgotten, offline.id);
    assert.ok(!(await paper('list')).some(canvas => canvas.id === offline.id));

    const blocked = await fetch('http://127.0.0.1:' + port + '/cli/status', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(blocked.status, 403);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/api/canvases/' + inVault.id)).status, 401);

    assert.equal((await paper('stop')).stopped, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await paper('status')).running, false);

    // Stopping flushes the pending preview of the browser edit.
    assert.match(await readFile(path.join(root, 'Vault', 'Module Z', inVault.id + '.preview.svg'), 'utf8'), /<path d="M 10 10 l 0\.01 0 L 30 40"\/>/);
    const refreshed = await paper('preview');
    assert.deepEqual(refreshed.map(result => result.id), [inVault.id], 'only canvases inside a vault');
    assert.equal(refreshed[0].noteCreated, false, 'existing notes are kept, not duplicated');
    assert.match(await fails('preview', 'Uni/Sheet 4'), /not inside an Obsidian vault/);
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('foreground serve prints connection links for scripts', async () => {
  const { root, env } = await sandbox();
  const server = spawn(process.execPath, ['bin/paper.js', 'serve', '--port', '18878'], { env });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
      server.stdout.on('data', data => { output += data; if (output.includes('#key=')) { clearTimeout(timer); resolve(); } });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
    });
    assert.match(output, /^Paperlink → http:\/\/localhost:18878\/#key=[a-f0-9]{48}/);
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    await rm(root, { recursive: true, force: true });
  }
});
