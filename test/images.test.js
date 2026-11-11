import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eraseFrom, formatStroke, inLasso, parseStroke, strokeBounds, strokeDistance, transformStroke, translateStroke, validStroke } from '../src/ink.js';
import { assetDirectory, createCanvas } from '../src/documents.js';
import { readCanvas, saveCanvas, saveOperations } from '../src/store.js';
import { exportPdf } from '../src/export.js';
import { renderPreview } from '../src/preview.js';
import { deleteCanvas, moveCanvas } from '../src/move.js';
import { makePdf } from './pdf-fixture.js';

const exec = promisify(execFile);
const ASSET = '3f9a1c2b7d4e5f60.png';

// A real width × height RGB PNG, so pdf-lib and pdf.js can embed and read it.
function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8 bits, RGB
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
// Only the header a JPEG starts with: enough for the server's signature check.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

test('picture strokes: round trip, geometry, and strict asset names', () => {
  const stroke = 'I 100 50 300 200 ' + ASSET;
  const picture = parseStroke(stroke);
  assert.deepEqual(picture, { kind: 'image', x: 100, y: 50, width: 300, height: 200, asset: ASSET });
  assert.equal(formatStroke(picture), stroke);
  assert.deepEqual(strokeBounds(picture), { minX: 100, minY: 50, maxX: 400, maxY: 250 });
  assert.equal(strokeDistance(picture, { x: 200, y: 100 }), 0, 'inside the picture');
  assert.equal(strokeDistance(picture, { x: 90, y: 100 }), 10);
  assert.equal(translateStroke(picture, 10, -10), 'I 110 40 300 200 ' + ASSET);
  // Scaling keeps the middle and the aspect ratio; turning moves only the middle.
  assert.equal(transformStroke(picture, { cx: 250, cy: 150, scale: 2 }), 'I -50 -50 600 400 ' + ASSET);
  assert.equal(transformStroke(picture, { cx: 0, cy: 0, angle: Math.PI / 2 }), 'I -300 150 300 200 ' + ASSET);
  assert.equal(parseStroke(transformStroke(picture, { cx: 0, cy: 0, scale: 0.0001 })).height, 1, 'never smaller than a unit');
  assert.ok(inLasso(picture, [{ x: 200, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 }, { x: 200, y: 200 }]), 'middle inside');
  assert.ok(!inLasso(picture, [{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 100 }]));
  assert.deepEqual(eraseFrom(picture, { x: 120, y: 60 }, { x: 130, y: 60 }, 5), [], 'erased whole');
  assert.equal(eraseFrom(picture, { x: 0, y: 0 }, { x: 1, y: 0 }, 5), null);
  assert.equal(formatStroke({ ...picture, color: '#e0453a' }), stroke, 'pictures take no colour');
  assert.ok(validStroke('I 1.5 -2 30 40.25 0123456789abcdef.jpg'));
  for (const bad of ['I 1 2 3 4', 'I 1 2 3 4 ../x.png', 'I 1 2 3 4 0123456789ABCDEF.jpg', 'I 1 2 3 4 0123456789abcdef.gif', 'I 1 2 3 4 0123456789abcde.png',
    'I 1 2 0 4 ' + ASSET, 'I 1 2 3 -4 ' + ASSET, 'I 1 2 30000 4 ' + ASSET, '#e0453a I 1 2 3 4 ' + ASSET, 'w4 I 1 2 3 4 ' + ASSET, 'h I 1 2 3 4 ' + ASSET, 'I 1 2 3 4 ' + ASSET + ' x']) {
    assert.equal(validStroke(bad), false, bad);
  }
});

test('pictures: stored with the canvas, exported, previewed, moved and trashed along', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paperlink-images-')));
  try {
    const pdf = path.join(root, 'Book.pdf');
    await writeFile(pdf, makePdf([[595, 842, 90]]));
    const canvas = await createCanvas(path.join(root, 'A', 'Book.paperlink'), 'Book', { pdf });
    const pages = (await readCanvas(canvas.path)).pages;
    const picture = 'I 100 200 300 150 ' + ASSET;
    // Validation needs a valid name, not the file.
    await assert.rejects(saveOperations(canvas.path, canvas.id, { operationId: 'bad', ops: [{ type: 'add', page: pages[0].id, stroke: 'I 1 2 3 4 ../../etc.png' }] }), error => error.status === 400);
    await saveCanvas(canvas.path, canvas.id, { revision: 0, operationId: 'pictures', pages: [
      { ...pages[0], strokes: [picture, 'I 10 10 50 50 ffffffffffffffff.jpg', 'M 100 100 l 0.01 0 L 400 300'] },
      { id: 'blank', width: 900, height: 1273, strokes: [picture] }
    ] });
    await mkdir(assetDirectory(canvas.path));
    assert.equal(assetDirectory(canvas.path), path.join(root, 'A', 'Book.assets'));
    await writeFile(path.join(assetDirectory(canvas.path), ASSET), makePng(4, 2));

    // The export embeds the picture (the missing one is skipped) where the page shows it, also on a turned PDF page.
    const result = await exportPdf(canvas.path, canvas.id);
    globalThis.DOMMatrix ??= class DOMMatrix {};
    const { getDocument, OPS } = await import('../public/vendor/pdfjs/pdf.min.mjs');
    const exported = await getDocument({ data: new Uint8Array(await readFile(result.path)), verbosity: 0 }).promise;
    try {
      for (const [number, pageSize] of [[1, 900], [2, 900]]) {
        const page = await exported.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const { fnArray, argsArray } = await page.getOperatorList();
        // Follows the transforms to where the image's unit square lands.
        let matrix = [1, 0, 0, 1, 0, 0];
        const stack = [], drawn = [];
        const multiply = ([a, b, c, d, e, f], [A, B, C, D, E, F]) => [A * a + B * c, A * b + B * d, C * a + D * c, C * b + D * d, E * a + F * c + e, E * b + F * d + f];
        fnArray.forEach((fn, i) => {
          if (fn === OPS.save) stack.push(matrix);
          else if (fn === OPS.restore) matrix = stack.pop();
          else if (fn === OPS.transform) matrix = multiply(matrix, argsArray[i]);
          else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) drawn.push(matrix);
        });
        assert.equal(drawn.length, 1, 'one picture on page ' + number);
        const corners = [[0, 0], [1, 1]].map(([u, v]) => {
          const [a, b, c, d, e, f] = drawn[0];
          return viewport.convertToViewportPoint(a * u + c * v + e, b * u + d * v + f);
        });
        const s = viewport.width / pageSize;
        const xs = corners.map(p => p[0] / s), ys = corners.map(p => p[1] / s);
        assert.deepEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round), [100, 200, 400, 350], 'placed on page ' + number);
      }
    } finally { await exported.destroy(); }

    // Previews mark the picture with a placeholder.
    const svg = renderPreview(await readCanvas(canvas.path));
    assert.match(svg, /<rect x="100" y="200" width="300" height="150"[^>]*\/><text[^>]*>Image<\/text>/);

    // Moving and renaming take the pictures along; deleting trashes them.
    const moved = await moveCanvas(canvas.path, canvas.id, path.join(root, 'B', 'Textbook.paperlink'));
    assert.deepEqual((await readdir(path.join(root, 'B'))).sort(), ['Book.pdf', 'Textbook.assets', 'Textbook.paperlink']);
    assert.deepEqual(await readdir(path.join(root, 'B', 'Textbook.assets')), [ASSET]);
    process.env.PAPERLINK_TRASH = path.join(root, 'Trash');
    try {
      const trashed = await deleteCanvas(moved.path, canvas.id);
      assert.ok(trashed.includes(path.join(root, 'B', 'Textbook.assets')));
      assert.deepEqual(await readdir(path.join(root, 'Trash', 'Textbook.assets')), [ASSET]);
    } finally { delete process.env.PAPERLINK_TRASH; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('picture uploads: paired devices only, checked, content-addressed and moved by paper move', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paperlink-images-cli-')));
  const env = { ...process.env, PAPERLINK_CONFIG: path.join(root, 'config', 'config.json'), PAPERLINK_LOCK_DIR: path.join(root, 'locks'), PAPERLINK_TRASH: path.join(root, 'Trash') };
  delete env.PAPERLINK_PORT;
  const paper = async (...args) => {
    const { stdout } = await exec(process.execPath, [path.resolve('bin/paper.js'), ...args], { env, cwd: root });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const port = '18892';
  try {
    await paper('config', 'set', 'port', port);
    const canvas = await paper('new', 'Notes/Reading');
    await paper('start');
    const base = 'http://127.0.0.1:' + port;
    const code = (await paper('pair')).links[0].match(/#pair=([a-f0-9]+)/)[1];
    const { token } = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: 'Bearer ' + token };
    const route = base + '/api/canvases/' + canvas.id + '/assets';
    const upload = (body, type, headers = auth) => fetch(route, { method: 'POST', headers: { ...headers, 'Content-Type': type }, body });

    const png = makePng(3, 3);
    const first = await upload(png, 'image/png');
    assert.equal(first.status, 200);
    const { asset } = await first.json();
    assert.match(asset, /^[0-9a-f]{16}\.png$/);
    assert.equal((await (await upload(png, 'image/png')).json()).asset, asset, 'the same picture, the same name');
    const folder = path.join(root, 'Notes', 'Reading.assets');
    assert.deepEqual(await readdir(folder), [asset], 'stored once, no temporary files left');
    assert.match((await (await upload(JPEG, 'image/jpeg')).json()).asset, /^[0-9a-f]{16}\.jpg$/);
    assert.equal((await upload(png, 'image/png', {})).status, 401, 'uploads need a paired device');
    assert.equal((await upload(png, 'image/jpeg')).status, 400, 'type and signature must agree');
    assert.equal((await upload(Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);
    assert.equal((await upload(Buffer.alloc(15 * 1024 * 1024 + 1), 'image/png').catch(() => ({ status: 413 }))).status, 413);

    const served = await fetch(route + '/' + asset, { headers: auth });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('cache-control'), /max-age=31536000/);
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(png));
    assert.equal((await fetch(route + '/' + asset)).status, 401);
    assert.equal((await fetch(route + '/ffffffffffffffff.png', { headers: auth })).status, 404);
    // fetch resolves ".." segments itself; encoded slashes reach the server and are refused.
    for (const name of ['..%2F..%2Fconfig%2Fconfig.json', '%2e%2e%2fReading.paperlink', 'x.png', asset.toUpperCase()]) {
      assert.equal((await fetch(route + '/' + name, { headers: auth })).status, 400, name);
    }

    // A picture stroke saves like any other and shows up in inspect.
    const page = (await paper('inspect', canvas.id)).pages[0].id;
    const saved = await fetch(base + '/api/canvases/' + canvas.id + '/ops', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'picture', ops: [{ type: 'add', page, stroke: 'I 100 100 300 300 ' + asset }] }) });
    assert.equal(saved.status, 200);
    assert.equal((await paper('inspect', canvas.id)).pages[0].images, 1);

    // `paper move` through the server takes the folder along, and uploads follow the new place.
    await paper('move', canvas.id, 'Archive/');
    assert.deepEqual((await readdir(path.join(root, 'Archive'))).sort(), ['Reading.assets', 'Reading.paperlink']);
    assert.equal((await fetch(route + '/' + asset, { headers: auth })).status, 200);
    await upload(makePng(5, 5), 'image/png');
    assert.equal((await readdir(path.join(root, 'Archive', 'Reading.assets'))).length, 3);
    assert.equal((await readdir(path.join(root, 'Notes'))).length, 0);
  } finally {
    await paper('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
