import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { readCanvas } from '../src/store.js';
const exec = promisify(execFile);

test('CLI links, browser draft import, autosave and management boundaries', async () => {
  const vault = await realpath(await mkdtemp(path.join(tmpdir(), 'paperlink-cli-')));
  const port = 18876;
  const server = spawn(process.execPath, ['bin/paper.js', 'serve', '--port', String(port), '--vault', vault]);
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
      server.stdout.on('data', data => { output += data; if (output.includes('#key=')) { clearTimeout(timer); resolve(); } });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
    });
    const key = output.match(/#key=([a-f0-9]+)/)[1];
    const cli = async (...args) => JSON.parse((await exec(process.execPath, ['bin/paper.js', 'canvas', ...args, '--vault', vault, '--port', String(port)])).stdout);
    const request = (route, data, headers = {}) => fetch('http://127.0.0.1:' + port + route, { method: 'PUT', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    const id = 'a'.repeat(32);
    const strokes = ['M 10 10 l 0.01 0 L 30 40'];
    assert.equal((await request('/api/drafts/' + id, { strokes })).status, 200);
    assert.equal((await cli('drafts'))[0].strokes, 1);
    const imported = await cli('import', 'CLI imported draft', '--from-browser', id);
    assert.equal((await cli('import', 'Retry', '--from-browser', id)).id, imported.id);
    const document = (await (await request('/api/drafts/' + id, { strokes })).json()).document;
    assert.equal(document.id, imported.id);
    assert.deepEqual((await readCanvas(vault, imported.id)).pages[0].strokes, strokes);
    const opened = await cli('open', imported.id);
    assert.match(opened.links[0], new RegExp('&canvas=' + imported.id));
    assert.equal((await request('/api/canvases/' + imported.id, { revision: 1, operationId: 'browser-edit', strokes: [] })).status, 200);
    assert.deepEqual((await readCanvas(vault, imported.id)).pages[0].strokes, []);
    const blocked = await fetch('http://127.0.0.1:' + port + '/cli/drafts', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ directory: vault }) });
    assert.equal(blocked.status, 403);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/api/canvases/' + imported.id)).status, 401);
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    await rm(vault, { recursive: true, force: true });
  }
});
