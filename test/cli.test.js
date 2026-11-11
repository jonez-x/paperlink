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
import { makePdf } from './pdf-fixture.js';
import { existsSync } from 'node:fs';
import { parseArguments } from '../src/cli.js';
const exec = promisify(execFile);

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paperlink-cli-')));
  const env = { ...process.env, PAPERLINK_CONFIG: path.join(root, 'config', 'config.json'), PAPERLINK_LOCK_DIR: path.join(root, 'locks'), PAPERLINK_TRASH: path.join(root, 'Trash'), PAPERLINK_HOST: 'paper-test.local' };
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
    assert.match(await readFile(inVault.note, 'utf8'), new RegExp('!\\[\\[' + inVault.id + '\\.svg\\]\\]'));
    assert.ok((await readFile(inVault.note, 'utf8')).includes('[Open in Paperlink](http://paper-test.local:' + port + '/#canvas=' + inVault.id + ')'), 'note links to the canvas');

    const started = await paper('start');
    assert.equal(started.running, true);
    assert.equal((await paper('start')).pid, started.pid, 'start is idempotent');
    const opened = await paper('open', 'Uni/Analysis/Sheet 3');
    assert.equal(opened.id, offline.id, 'open by path, extension optional');
    assert.match(opened.links[0], new RegExp('#pair=[a-f0-9]{32}&canvas=' + offline.id));
    assert.equal((await paper('open', 'exercise')).id, inVault.id, 'unique partial title match');
    assert.equal((await paper('open', offline.id.slice(0, 8))).id, offline.id, 'ID prefix match');
    await paper('new', 'Uni/Sheet 4');
    assert.match(await fails('open', 'sheet'), /matches several canvases/);

    // Pairing: a one-time code from a QR link becomes a lasting device token.
    const base = 'http://127.0.0.1:' + port;
    const code = opened.links[0].match(/#pair=([a-f0-9]+)/)[1];
    const iPad = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const pairWith = (pairCode, deviceId) => fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': iPad }, body: JSON.stringify({ code: pairCode, deviceId }) });
    const pairing = await (await pairWith(code)).json();
    assert.equal(pairing.name, 'iPad · Safari');
    assert.equal((await pairWith(code)).status, 403, 'codes work once');
    let key = pairing.token;
    const request = (route, method, data, token = key) => fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: data && JSON.stringify(data) });
    assert.equal((await request('/api/canvases/' + offline.id, 'GET', undefined, 'f'.repeat(64))).status, 401);
    // Re-pairing the same browser keeps one device entry.
    const again = await (await pairWith((await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1], pairing.deviceId)).json();
    assert.equal(again.deviceId, pairing.deviceId);
    assert.equal((await paper('devices')).length, 1);
    assert.equal((await request('/api/canvases/' + offline.id, 'GET')).status, 401, 'the replaced token no longer works');
    const second = await (await pairWith((await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1])).json();
    assert.equal((await paper('devices')).length, 2);
    assert.equal((await request('/api/canvases/' + offline.id, 'GET', undefined, second.token)).status, 200);
    assert.equal((await paper('unpair', second.deviceId))[0].unpaired, second.deviceId);
    assert.equal((await request('/api/canvases/' + offline.id, 'GET', undefined, second.token)).status, 401, 'unpairing takes effect immediately');
    key = again.token;
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
    assert.deepEqual((await readdir(path.join(root, 'Vault', 'Module Z'))).sort(), ['Exercise 1.md', 'Exercise 1.paperlink']);
    inVault.path = path.join(root, 'Vault', 'Module Z', 'Exercise 1.paperlink');

    // Moved files are reported; forgetting keeps the file.
    await rename(offline.path, path.join(root, 'Moved.paperlink'));
    assert.equal((await paper('list')).find(canvas => canvas.id === offline.id).missing, true);
    assert.match(await fails('open', offline.id), /no longer at/);
    assert.equal((await paper('open', 'Moved')).id, offline.id, 'reopening by the new path updates the list');
    assert.equal((await paper('forget', 'Moved'))[0].forgotten, offline.id);
    assert.ok(!(await paper('list')).some(canvas => canvas.id === offline.id));

    const blocked = await fetch('http://127.0.0.1:' + port + '/cli/status', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(blocked.status, 403);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/api/canvases/' + inVault.id)).status, 401);

    assert.equal((await paper('stop')).stopped, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await paper('status')).running, false);

    // Stopping flushes the pending preview of the browser edit.
    assert.match(await readFile(path.join(root, 'Vault', 'Paperlink Previews', inVault.id + '.svg'), 'utf8'), /<path d="M 10 10 l 0\.01 0 L 30 40" /);
    const refreshed = await paper('preview');
    assert.deepEqual(refreshed.map(result => result.id), [inVault.id], 'only canvases inside a vault');
    assert.equal(refreshed[0].noteCreated, false, 'existing notes are kept, not duplicated');
    assert.match(await fails('preview', 'Uni/Sheet 4'), /not inside an Obsidian vault/);

    // Deleting asks scripts for --yes and moves canvas, note and preview to the trash.
    assert.match(await fails('delete', 'exercise'), /--yes/);
    const deleted = await paper('delete', 'exercise', '--yes');
    assert.equal(deleted[0].trashed.length, 3);
    assert.deepEqual((await readdir(path.join(root, 'Vault', 'Module Z'))), []);
    assert.deepEqual((await readdir(path.join(root, 'Trash'))).sort(), ['Exercise 1.md', 'Exercise 1.paperlink', inVault.id + '.svg'].sort());
    assert.ok(!(await paper('list')).some(canvas => canvas.id === inVault.id));
    const remaining = (await paper('list')).length;
    assert.equal((await paper('forget', '--all', '--yes')).length, remaining);
    assert.deepEqual(await paper('list'), []);
    assert.ok((await readdir(path.join(root, 'Uni'))).includes('Sheet 4.paperlink'), 'forget keeps files');
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
      server.stdout.on('data', data => { output += data; if (output.includes('#pair=')) { clearTimeout(timer); resolve(); } });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
    });
    assert.match(output, /^Paperlink → http:\/\/localhost:18878\/#pair=[a-f0-9]{32}/);
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    await rm(root, { recursive: true, force: true });
  }
});

test('PDF worksheets: pages from the PDF, served to paired devices, moved and deleted with the canvas', async () => {
  const { root, paper, fails } = await sandbox();
  const port = '18879';
  try {
    await paper('config', 'set', 'port', port);
    await mkdir(path.join(root, 'Vault', '.obsidian'), { recursive: true });
    await mkdir(path.join(root, 'Downloads'));
    await writeFile(path.join(root, 'Downloads', 'Sheet 3.pdf'), makePdf([[595, 842], [842, 595]]));
    await writeFile(path.join(root, 'Downloads', 'broken.pdf'), 'not a pdf');
    assert.match(await fails('new', 'Vault/Bad', '--pdf', 'Downloads/broken.pdf'), /Not a readable PDF/);
    assert.ok(!existsSync(path.join(root, 'Vault', 'Bad.paperlink')), 'nothing is created for a broken PDF');

    // A PDF from elsewhere is copied next to the canvas; pages keep its aspect ratios.
    const created = await paper('new', 'Vault/Math/Sheet 3', '--pdf', 'Downloads/Sheet 3.pdf');
    assert.equal(created.pages, 2);
    assert.equal(created.pdf, 'Sheet 3.pdf');
    const document = await readCanvas(created.path, created.id);
    assert.deepEqual(document.pages.map(page => [page.width, page.height, page.pdfPage]), [[900, 1273.6, 1], [900, 636, 2]]);
    assert.deepEqual(document.pdf, { file: 'Sheet 3.pdf', copied: true });
    // A PDF already in the target folder is used in place.
    await mkdir(path.join(root, 'Vault', 'Physics'));
    await writeFile(path.join(root, 'Vault', 'Physics', 'Lab.pdf'), makePdf([[595, 842]]));
    const inPlace = await paper('new', '--pdf', 'Vault/Physics/Lab.pdf', 'Vault/Physics');
    assert.equal(inPlace.path, path.join(root, 'Vault', 'Physics', 'Lab.paperlink'), 'named after the PDF');
    assert.equal((await readCanvas(inPlace.path)).pdf.copied, false);

    await paper('start');
    const base = 'http://127.0.0.1:' + port;
    const code = (await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1];
    const { token } = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: 'Bearer ' + token };
    const pdf = await fetch(base + '/api/canvases/' + created.id + '/pdf', { headers: auth });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.equal((await fetch(base + '/api/canvases/' + created.id + '/pdf')).status, 401, 'the PDF needs a paired device');
    assert.equal((await fetch(base + '/vendor/pdfjs/pdf.min.mjs')).headers.get('content-type'), 'text/javascript');
    for (const route of ['/vendor/pdfjs/../../../package.json', '/vendor/pdfjs/%2e%2e/%2e%2e/package.json', '/vendor/pdfjs/cmaps/../../../src/cli.js']) {
      assert.notEqual((await fetch(base + route)).status, 200, route);
    }

    // Page images for the Obsidian preview: JPEG only, PDF pages only.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const upload = (pageId, image) => fetch(base + '/api/canvases/' + created.id + '/backgrounds/' + pageId, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: image });
    assert.equal((await upload(document.pages[0].id, jpeg)).status, 200);
    assert.equal((await upload(document.pages[0].id, Buffer.from('<svg/>'))).status, 400);
    assert.equal((await upload('unknown-page', jpeg)).status, 404);
    assert.deepEqual((await (await fetch(base + '/api/canvases/' + created.id, { headers: auth })).json()).cachedBackgrounds, [document.pages[0].id]);
    // Export for download, e.g. from the iPad.
    const exported = await fetch(base + '/api/canvases/' + created.id + '/export.pdf', { headers: auth });
    assert.equal(exported.headers.get('content-type'), 'application/pdf');
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="Sheet 3\.pdf"/);
    assert.ok(Buffer.from(await exported.arrayBuffer()).subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.equal((await fetch(base + '/api/canvases/' + created.id + '/export.pdf')).status, 401);
    // A browser cannot drop PDF pages.
    const drop = await fetch(base + '/api/canvases/' + created.id, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, operationId: 'drop', pages: [document.pages[1]] }) });
    assert.equal(drop.status, 400);
    await paper('stop');

    // Moving takes the copied PDF along; deleting trashes it, an in-place PDF stays.
    await rm(inPlace.path);
    await paper('forget', inPlace.id);
    const moved = await paper('move', created.id, 'Vault/Archive/');
    assert.deepEqual((await readdir(path.join(root, 'Vault', 'Archive'))).sort(), ['Sheet 3.md', 'Sheet 3.paperlink', 'Sheet 3.pdf']);
    assert.equal((await paper('delete', moved.id, '--yes'))[0].trashed.length, 4);
    assert.deepEqual(await readdir(path.join(root, 'Vault', 'Archive')), []);
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('live sync: operations from several devices merge, replay safely and stream to open tabs', async () => {
  const { root, paper } = await sandbox();
  const port = '18880';
  try {
    await paper('config', 'set', 'port', port);
    const canvas = await paper('new', 'Live');
    await paper('start');
    const base = 'http://127.0.0.1:' + port;
    const device = async () => {
      const code = (await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1];
      return (await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
    };
    const [iPad, mac] = [await device(), await device()];
    const headers = token => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
    const send = (token, operationId, ops) => fetch(base + '/api/canvases/' + canvas.id + '/ops', { method: 'POST', headers: headers(token), body: JSON.stringify({ operationId, ops }) });
    const read = async token => (await (await fetch(base + '/api/canvases/' + canvas.id, { headers: headers(token) })).json());
    const page = (await read(iPad)).pages[0].id;
    const a = 'M 1 1 l 0.01 0 L 2 2', b = 'M 5 5 l 0.01 0 L 6 6';

    // The Mac listens while the iPad writes.
    const events = [];
    const controller = new AbortController();
    const listening = fetch(base + '/api/canvases/' + canvas.id + '/events?since=0', { headers: headers(mac), signal: controller.signal }).then(async response => {
      const reader = response.body.getReader();
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
        for (let end; (end = text.indexOf('\n\n')) >= 0; text = text.slice(end + 2)) events.push(JSON.parse(text.slice(6, end)));
      }
    }).catch(() => {});
    const waitFor = async check => { for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(check()); };
    await waitFor(() => events.some(event => event.live));

    assert.equal((await send(iPad, 'ipad-1', [{ type: 'add', page, stroke: a }])).status, 200);
    // Both devices edit "at once" from the same revision: no conflict, both kept.
    assert.equal((await send(mac, 'mac-1', [{ type: 'add', page, stroke: b }])).status, 200);
    // A retried batch is not applied twice; a reused ID with other content is refused.
    assert.equal((await (await send(iPad, 'ipad-1', [{ type: 'add', page, stroke: a }])).json()).revision, 1);
    assert.equal((await send(iPad, 'ipad-1', [{ type: 'remove', page, stroke: a }])).status, 409);
    assert.equal((await send(iPad, 'bad', [{ type: 'add', page, stroke: '<script>' }])).status, 400);
    assert.deepEqual((await read(mac)).pages[0].strokes, [a, b]);
    await waitFor(() => events.filter(event => event.ops).length === 2);
    assert.deepEqual(events.filter(event => event.ops).map(event => [event.revision, event.operationId]), [[1, 'ipad-1'], [2, 'mac-1']]);

    // Pages: added by one device, strokes on it from another, PDF-free pages removable.
    assert.equal((await send(mac, 'mac-2', [{ type: 'addPage', page: { id: 'page-2', width: 900, height: 1273 } }, { type: 'add', page: 'page-2', stroke: a }])).status, 200);
    assert.equal((await send(iPad, 'ipad-2', [{ type: 'remove', page, stroke: b }, { type: 'remove', page, stroke: 'M 9 9 l 0.01 0' }])).status, 200);
    let document = await read(iPad);
    assert.deepEqual(document.pages.map(entry => entry.strokes), [[a], [a]]);
    // A page someone wrote on stays, so undoing "add page" elsewhere loses no ink.
    assert.equal((await send(iPad, 'ipad-3', [{ type: 'removePage', page: 'page-2' }])).status, 200);
    assert.equal((await read(iPad)).pages.length, 2);
    assert.equal((await send(iPad, 'ipad-4', [{ type: 'remove', page: 'page-2', stroke: a }, { type: 'removePage', page: 'page-2' }])).status, 200);
    assert.equal((await read(iPad)).pages.length, 1);

    // A tab reconnecting with an old revision catches up from the recent history,
    // one that is too far behind (or after a server restart) is told to reload.
    const catchUp = async since => {
      const response = await fetch(base + '/api/canvases/' + canvas.id + '/events?since=' + since, { headers: headers(iPad) });
      const reader = response.body.getReader();
      let text = '';
      while (!text.includes('"live":true')) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      return text.split('\n\n').filter(Boolean).map(chunk => JSON.parse(chunk.slice(6)));
    };
    assert.deepEqual((await catchUp(3)).map(event => event.revision), [4, 5, 6, 6]);
    controller.abort();
    await listening;
    await paper('stop');
    await new Promise(resolve => setTimeout(resolve, 300));
    await paper('start');
    const afterRestart = await catchUp(2);
    assert.equal(afterRestart[0].reload, true);
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('assistant commands: inspect, snapshots of a region, notes that appear live and can be removed', async () => {
  const { root, paper, fails } = await sandbox();
  const port = '18881';
  try {
    await paper('config', 'set', 'port', port);
    const canvas = await paper('new', 'Answers');
    // Without a server, notes go straight into the file.
    const offline = await paper('annotate', 'Answers', '--text', 'Check the sign in line 2', '--at', '120,300', '--width', '300');
    assert.equal(offline.stale, false);
    let info = await paper('inspect', 'Answers');
    assert.equal(info.pages.length, 1);
    assert.deepEqual(info.annotations.map(note => [note.text, note.x, note.y, note.width, note.pageNumber, note.author]), [['Check the sign in line 2', 120, 300, 300, 1, 'Assistant']]);
    assert.match(await fails('annotate', 'Answers', '--text', 'x', '--page', '2'), /--page must be between 1 and 1/);
    assert.match(await fails('annotate', 'Answers', '--text', 'x', '--at', '1'), /--at expects 2/);

    // With a server, a note reaches open tabs at once; an older --revision marks it stale.
    await paper('start');
    const base = 'http://127.0.0.1:' + port;
    const code = (await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1];
    const { token } = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
    const response = await fetch(base + '/api/canvases/' + canvas.id + '/events', { headers: { Authorization: 'Bearer ' + token } });
    const reader = response.body.getReader();
    const next = async () => { let text = ''; while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value); return JSON.parse(text.slice(6, text.indexOf('\n\n'))); };
    assert.equal((await next()).live, true);
    // Other notes since --revision do not make a note stale; changed writing does.
    const fresh = await paper('annotate', canvas.id, '--text', 'Second note', '--revision', '0');
    assert.equal(fresh.stale, false);
    assert.equal((await next()).ops[0].annotation.text, 'Second note');
    const page = (await paper('inspect', canvas.id)).pages[0].id;
    await fetch(base + '/api/canvases/' + canvas.id + '/ops', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'ink-1', ops: [{ type: 'add', page, stroke: 'M 10 10 l 0.01 0 L 50 50' }] }) });
    assert.ok((await next()).ops);
    const live = await paper('annotate', canvas.id, '--text', 'Nice!\\nNow simplify.', '--revision', '0', '--author', 'Claude');
    assert.equal(live.stale, true);
    const event = await next();
    assert.equal(event.ops[0].type, 'addAnnotation');
    assert.equal(event.ops[0].annotation.text, 'Nice!\nNow simplify.');
    assert.equal(event.ops[0].annotation.author, 'Claude');
    await reader.cancel();
    info = await paper('inspect', canvas.id);
    assert.equal(info.annotations.length, 3);

    // Snapshots: a region of a page as PDF (exact size) and as PNG on macOS.
    const pdf = await paper('snapshot', 'Answers', '--region', '0,0,450,300', '--output', path.join(root, 'region.pdf'));
    globalThis.DOMMatrix ??= class DOMMatrix {};
    const { getDocument, GlobalWorkerOptions } = await import('../public/vendor/pdfjs/pdf.min.mjs');
    GlobalWorkerOptions.workerSrc = new URL('../public/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    const snapshot = await getDocument({ data: new Uint8Array(await readFile(pdf.path)), verbosity: 0 }).promise;
    const { width, height } = (await snapshot.getPage(1)).getViewport({ scale: 1 });
    await snapshot.destroy();
    assert.deepEqual([Math.round(width * 10) / 10, Math.round(height * 10) / 10], [297.6, 198.4]);
    // PNG rendering uses the system: Quick Look, Windows' PDF engine or pdftoppm (installed in CI).
    if (process.platform !== 'linux' || process.env.CI) {
      const png = await paper('snapshot', 'Answers');
      assert.ok((await readFile(png.path)).subarray(1, 4).equals(Buffer.from('PNG')));
    }

    // Removing by ID prefix, then all.
    assert.deepEqual((await paper('annotate', 'Answers', '--remove', live.id.slice(0, 8))).removed, [live.id]);
    assert.equal((await paper('annotate', 'Answers', '--clear')).removed.length, 2);
    assert.deepEqual((await paper('inspect', 'Answers')).annotations, []);
    assert.match(await fails('annotate', 'Answers', '--clear'), /no notes/);
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('request feedback: a configured assistant runs with page and region, answers with live notes', async () => {
  const { root, env, paper } = await sandbox();
  const port = '18882';
  try {
    await paper('config', 'set', 'port', port);
    const canvas = await paper('new', 'Feedback');
    // A stand-in assistant: reads the prompt and answers through the `paper` shim on its PATH.
    const agent = path.join(root, 'agent.mjs');
    await writeFile(agent, [
      "import { execFileSync } from 'node:child_process';",
      "const prompt = process.argv[2];",
      "const id = prompt.match(/ID ([a-f0-9-]{36})/)[1];",
      "const question = (prompt.match(/\"\"\"(.*)\"\"\"/) || [])[1] || 'none';",
      "const region = (prompt.match(/--region ([0-9,]+)/) || [])[1] || 'page';",
      "const args = ['annotate', id, '--text', question + ' @ ' + region, '--author', 'Stand-in', '--json'];",
      // Windows starts the paper.cmd shim only through a shell (checked below); Git Bash, which Claude Code uses there, runs the sh shim.
      "if (process.platform === 'win32') execFileSync(process.execPath, [" + JSON.stringify(path.resolve('bin/paper.js')) + ", ...args]);",
      "else execFileSync('paper', args);"
    ].join('\n'));
    await paper('start');
    const base = 'http://127.0.0.1:' + port;
    const code = (await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1];
    const { token } = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const ask = data => fetch(base + '/api/canvases/' + canvas.id + '/feedback', { method: 'POST', headers, body: JSON.stringify(data) });

    // Off by default.
    assert.equal((await ask({ page: 1 })).status, 409);
    assert.equal((await (await fetch(base + '/api/canvases/' + canvas.id, { headers })).json()).assistant, false);
    await paper('config', 'set', 'assistant', JSON.stringify([process.execPath, agent, '{prompt}']));
    await paper('stop');
    await paper('start');
    assert.equal((await (await fetch(base + '/api/canvases/' + canvas.id, { headers })).json()).assistant, true);
    assert.equal((await ask({ page: 2 })).status, 400);
    assert.equal((await ask({ page: 1, region: { x: 0, y: 0, width: -5, height: 10 } })).status, 400);

    const response = await fetch(base + '/api/canvases/' + canvas.id + '/events', { headers });
    const reader = response.body.getReader();
    const events = [];
    let text = '';
    const until = async check => {
      while (!check()) {
        text += new TextDecoder().decode((await reader.read()).value);
        for (let end; (end = text.indexOf('\n\n')) >= 0; text = text.slice(end + 2)) events.push(JSON.parse(text.slice(6, end)));
      }
    };
    assert.equal((await ask({ page: 1, region: { x: 100, y: 200, width: 300, height: 150 }, question: 'Is step 2 right?' })).status, 202);
    assert.equal((await ask({ page: 1 })).status, 429, 'one run per canvas at a time');
    await until(() => events.some(event => event.assistant === 'done' || event.assistant === 'failed'));
    await reader.cancel();
    assert.deepEqual(events.filter(event => event.assistant).map(event => event.assistant), ['started', 'done']);
    const note = events.find(event => event.ops)?.ops[0].annotation;
    assert.equal(note.text, 'Is step 2 right? @ 100,200,300,150');
    assert.equal(note.author, 'Stand-in');
    if (process.platform === 'win32') {
      const { stdout } = await exec('cmd.exe', ['/d', '/c', path.join(root, 'config', 'bin', 'paper.cmd'), '--version', '--json'], { env });
      assert.ok(JSON.parse(stdout).version, 'paper.cmd shim runs the CLI');
    }
    assert.match(await paper('config', 'set', 'assistant', 'off').then(config => String(config.assistant)), /null/);
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('codex preset: read-only run with the snapshot attached, JSON notes added by Paperlink', { skip: process.platform === 'win32' && 'stand-in is a shell script' }, async () => {
  const { root, env, paper } = await sandbox();
  const port = '18883';
  try {
    await paper('config', 'set', 'port', port);
    const canvas = await paper('new', 'Codex feedback');
    // A stand-in `codex`: records its arguments, checks the attached image and answers with JSON.
    const fake = path.join(root, 'fake-bin');
    await mkdir(fake);
    await writeFile(path.join(fake, 'codex'), [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "' + path.join(root, 'codex-args.txt') + '"',
      'while [ $# -gt 0 ]; do case "$1" in --output-last-message) answer="$2"; shift;; --image) image="$2"; shift;; esac; shift; done',
      '[ -s "$image" ] || exit 3',
      'printf \'{"notes":[{"x":150,"y":260,"text":"Sign error in line 2"},{"x":99999,"y":-5,"text":"Clamped"},{"x":1,"y":1,"text":"  "}]}\' > "$answer"'
    ].join('\n'), { mode: 0o755 });
    env.PATH = fake + path.delimiter + env.PATH;
    await paper('config', 'set', 'assistant', 'codex');
    await paper('start');
    const base = 'http://127.0.0.1:' + port;
    const code = (await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1];
    const { token } = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const events = fetch(base + '/api/canvases/' + canvas.id + '/events', { headers });
    const response = await fetch(base + '/api/canvases/' + canvas.id + '/feedback', { method: 'POST', headers, body: JSON.stringify({ page: 1, region: { x: 100, y: 200, width: 300, height: 150 }, question: 'Richtig?' }) });
    assert.equal(response.status, 202);
    const reader = (await events).body.getReader();
    let text = '';
    while (!/"assistant":"(done|failed)"/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /"assistant":"done"/, text);

    // One argument per line; the prompt spans several.
    const recorded = await readFile(path.join(root, 'codex-args.txt'), 'utf8');
    const args = recorded.split('\n');
    for (const flag of ['exec', '--sandbox', 'read-only', '--ignore-user-config', '--ephemeral', '--output-schema', '--image']) assert.ok(args.includes(flag), flag);
    assert.match(recorded, /"""Richtig\?"""/);
    assert.match(recorded, /top left corner is page point \(100, 200\)/);
    const info = await paper('inspect', canvas.id, '--json');
    assert.deepEqual(info.annotations.map(note => [note.text, note.x, note.y, note.author, Boolean(note.stale)]),
      [['Sign error in line 2', 150, 260, 'Codex', false], ['Clamped', 860, 0, 'Codex', false]]);
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
