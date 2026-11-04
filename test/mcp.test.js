import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const exec = promisify(execFile);

test('mcp: initialize, list tools, create, open, inspect, note and snapshot a canvas', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paperlink-mcp-')));
  const env = { ...process.env, PAPERLINK_CONFIG: path.join(root, 'config', 'config.json'), PAPERLINK_LOCK_DIR: path.join(root, 'locks'), PAPERLINK_TRASH: path.join(root, 'Trash'), PAPERLINK_HOST: 'paper-test.local', PAPERLINK_PORT: '18891' };
  const bin = path.resolve('bin/paper.js');
  const child = spawn(process.execPath, [bin, 'mcp'], { env, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let next = 1;
  const request = (method, params) => new Promise(resolve => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const { result } = await request('tools/call', { name, arguments: args });
    return { ...result, json: result.content[0].type === 'text' && !result.isError ? JSON.parse(result.content[0].text) : null };
  };
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'paperlink');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const names = (await request('tools/list')).result.tools.map(tool => tool.name);
    for (const name of ['list_canvases', 'create_canvas', 'open_canvas', 'inspect_canvas', 'snapshot_page', 'add_note', 'remove_notes', 'export_pdf']) assert.ok(names.includes(name), name);
    assert.equal((await request('nope')).error.code, -32601);

    const created = (await call('create_canvas', { path: path.join(root, 'Uni', 'Sheet 1') })).json;
    assert.equal(created.title, 'Sheet 1');
    assert.equal((await call('list_canvases', {})).json[0].id, created.id);
    const missing = await call('inspect_canvas', { canvas: 'does not exist' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No canvas file or known canvas/);

    const opened = (await call('open_canvas', { canvas: created.id })).json;
    assert.ok(opened.links.some(link => link.startsWith('http://localhost:18891/#pair=')), 'starts the server and returns links');

    const note = (await call('add_note', { canvas: 'Sheet 1', text: 'Check the sign.', x: 100, y: 200, author: 'Claude' })).json;
    const inspected = (await call('inspect_canvas', { canvas: created.id })).json;
    assert.equal(inspected.revision, note.revision);
    assert.ok(JSON.stringify(inspected).includes('Check the sign.'));
    assert.equal((await call('remove_notes', { canvas: created.id })).isError, true, 'needs id or all');
    assert.deepEqual((await call('remove_notes', { canvas: created.id, id: note.id })).json.removed, [note.id]);

    // PNG rendering uses the system: Quick Look, Windows' PDF engine or pdftoppm (installed in CI).
    if (process.platform !== 'linux' || process.env.CI) {
      const snapshot = await call('snapshot_page', { canvas: created.id, region: { x: 0, y: 0, width: 450, height: 300 } });
      assert.equal(snapshot.content[0].type, 'image');
      assert.equal(Buffer.from(snapshot.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
    }
  } finally {
    child.stdin.end();
    await exec(process.execPath, [bin, 'stop'], { env, cwd: root }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
