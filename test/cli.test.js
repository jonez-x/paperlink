import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { readCanvas } from '../src/store.js';
import { parseArguments } from '../src/cli.js';
const exec = promisify(execFile);

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paperlink-cli-')));
  const library = path.join(root, 'library');
  await mkdir(library);
  const env = { ...process.env, PAPERLINK_CONFIG: path.join(root, 'config', 'config.json'), PAPERLINK_LOCK_DIR: path.join(root, 'locks') };
  delete env.PAPERLINK_LIBRARY;
  delete env.PAPERLINK_PORT;
  const paper = async (...args) => {
    const { stdout } = await exec(process.execPath, ['bin/paper.js', ...args], { env });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const fails = async (...args) => {
    const error = await exec(process.execPath, ['bin/paper.js', ...args], { env }).then(() => null, error => error);
    assert.ok(error, 'expected failure: ' + args.join(' '));
    return JSON.parse(error.stderr).error;
  };
  return { root, library, env, paper, fails };
}

test('argument parsing supports inline values and rejects unknown options', () => {
  assert.deepEqual(parseArguments(['canvas', 'new', 'A b', '--path=Uni/Math', '--json']), { flags: { path: 'Uni/Math', json: true }, positional: ['canvas', 'new', 'A b'] });
  assert.throws(() => parseArguments(['--nope']), /Unknown option/);
  assert.throws(() => parseArguments(['--port']), /Missing value/);
});

test('machine interface: config, background server, canvases, links and errors', async () => {
  const { root, library, paper, fails } = await sandbox();
  const port = '18877';
  try {
    assert.match(await fails('canvas', 'list'), /No library configured/);
    const init = await paper('init', library, '--default-path', 'Notes', '--port', port);
    assert.equal(init.config.library, library);
    assert.equal((await paper('config', 'set', 'obsidian', 'true')).obsidian, true);
    assert.match(await fails('config', 'set', 'defaultPath', '../outside'), /relative to the library/);

    // Without a server, new still creates the file but has no links.
    const offline = await paper('canvas', 'new', 'Offline sheet');
    assert.equal(offline.folder, 'Notes');
    assert.deepEqual(offline.links, []);
    assert.equal(offline.note, path.join(library, 'Notes', 'Offline sheet.md'), 'Obsidian note next to the canvas');
    assert.match(await readFile(offline.note, 'utf8'), new RegExp('!\\[\\[' + offline.id + '\\.preview\\.svg\\]\\]'));
    assert.equal((await paper('status')).running, false);
    assert.match(await fails('canvas', 'drafts'), /not running/);

    const started = await paper('start');
    assert.equal(started.running, true);
    assert.equal((await paper('start')).pid, started.pid, 'start is idempotent');
    const created = await paper('new', 'Analysis sheet 3', '--path', 'Uni/Analysis');
    assert.equal(created.folder, path.join('Uni', 'Analysis'));
    assert.match(created.links[0], new RegExp('#key=[a-f0-9]+&canvas=' + created.id));

    const listed = await paper('list');
    assert.deepEqual(listed.map(canvas => canvas.title).sort(), ['Analysis sheet 3', 'Offline sheet']);
    assert.equal((await paper('canvas', 'open', 'analysis')).id, created.id, 'unique partial title match');
    assert.equal((await paper('open', created.id.slice(0, 8))).id, created.id, 'ID prefix match');
    assert.match(await fails('open', 'sheet'), /matches several canvases/);

    // The browser API resolves canvases anywhere in the library.
    const key = created.links[0].match(/#key=([a-f0-9]+)/)[1];
    const request = (route, method, data) => fetch('http://127.0.0.1:' + port + route, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: data && JSON.stringify(data) });
    const strokes = ['M 10 10 l 0.01 0 L 30 40'];
    assert.equal((await request('/api/canvases/' + created.id, 'PUT', { revision: 0, operationId: 'browser-edit', strokes })).status, 200);
    assert.deepEqual((await readCanvas(path.join(library, 'Uni', 'Analysis'), created.id)).pages[0].strokes, strokes);
    assert.equal((await request('/api/canvases/' + offline.id, 'GET')).status, 200, 'canvas created before the server started');
    assert.equal((await request('/api/canvases/00000000-0000-0000-0000-000000000000', 'GET')).status, 404);

    // Draft import into a chosen folder stays idempotent.
    const draftId = 'b'.repeat(32);
    assert.equal((await request('/api/drafts/' + draftId, 'PUT', { strokes })).status, 200);
    assert.equal((await paper('drafts'))[0].strokes, 1);
    const imported = await paper('import', 'From iPad', '--from-browser', draftId, '--path', 'Inbox');
    assert.equal(imported.folder, 'Inbox');
    assert.equal((await paper('import', 'Retry', '--from-browser', draftId)).id, imported.id);
    assert.equal((await (await request('/api/drafts/' + draftId, 'PUT', { strokes })).json()).document.id, imported.id);
    assert.deepEqual((await readCanvas(path.join(library, 'Inbox'), imported.id)).pages[0].strokes, strokes);

    const blocked = await fetch('http://127.0.0.1:' + port + '/cli/status', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ library }) });
    assert.equal(blocked.status, 403);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/api/canvases/' + created.id)).status, 401);
    assert.match(await fails('open', created.id, '--library', root), /another library/);
    const foreign = await paper('status', '--library', root);
    assert.equal(foreign.library, library, 'status reports the server of another library');
    assert.equal(foreign.configuredLibrary, root);

    assert.equal((await paper('stop')).stopped, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await paper('status')).running, false);

    // Stopping flushes the pending preview of the browser edit.
    assert.match(await readFile(path.join(library, 'Uni', 'Analysis', created.id + '.preview.svg'), 'utf8'), /<path d="M 10 10 l 0\.01 0 L 30 40"\/>/);
    assert.ok((await readdir(path.join(library, 'Inbox'))).includes('From iPad.md'), 'imported drafts get a note');
    const refreshed = await paper('preview');
    assert.equal(refreshed.length, 3);
    assert.ok(refreshed.every(result => !result.noteCreated), 'existing notes are kept, not duplicated');
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('foreground serve prints connection links for scripts', async () => {
  const { root, library, env } = await sandbox();
  const server = spawn(process.execPath, ['bin/paper.js', 'serve', '--port', '18878', '--library', library], { env });
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
