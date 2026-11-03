import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { documentFolder, createCanvas, listCanvases } from './documents.js';
import { readCanvas, saveCanvas, validateStrokes } from './store.js';
import { acquireFolderLock } from './lock.js';
import { DraftStore } from './drafts.js';

export async function serve({ port, lan, vault, folder }) {
  const directory = vault ? await documentFolder(vault, folder) : null;
  const token = randomBytes(24).toString('hex');
  const drafts = new DraftStore();
  const lock = directory ? await acquireFolderLock(directory) : null;
  // One writer per folder; serialize revision checks and replacements.
  let queue = Promise.resolve();
  function serialize(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw Object.assign(new Error('Document exceeds 8 MB.'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
        res.end(await readFile(new URL('../public/index.html', import.meta.url)));
        return;
      }
      if (!directory) return json(res, 503, { error: 'Start the server with --vault to enable file storage.' });
      if (req.url.startsWith('/cli/')) {
        // Only local CLI clients may discover connection links or manage drafts.
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (!local || req.headers.origin || req.headers.host !== '127.0.0.1:' + port || req.method !== 'POST') return json(res, 403, { error: 'Local CLI access only.' });
        const input = await body(req);
        if (input.directory !== directory) return json(res, 409, { error: 'This server uses a different vault folder.' });
        if (req.url === '/cli/drafts') return json(res, 200, drafts.list());
        if (req.url === '/cli/import') {
          const draft = drafts.get(input.id);
          if (!draft) return json(res, 404, { error: 'Browser draft not found. Keep its connected tab open.' });
          if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) return json(res, 400, { error: 'Specify a title of 1–200 characters.' });
          const document = await serialize(async () => {
            if (draft.document) return draft.document;
            const created = await createCanvas(vault, folder, input.title);
            await saveCanvas(directory, created.id, { revision: 0, operationId: randomBytes(16).toString('hex'), strokes: draft.strokes });
            const saved = await readCanvas(directory, created.id);
            drafts.markImported(input.id, { id: saved.id, title: saved.title, revision: saved.revision });
            return saved;
          });
          return json(res, 200, { id: document.id, title: document.title });
        }
        if (req.url === '/cli/open') {
          const document = await readCanvas(directory, input.id);
          const suffix = '/#key=' + token + '&canvas=' + document.id;
          const links = ['http://localhost:' + port + suffix];
          if (lan) for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) links.push('http://' + address.address + ':' + port + suffix);
          }
          return json(res, 200, { id: document.id, title: document.title, links });
        }
        return json(res, 404, { error: 'Unknown CLI command.' });
      }
      if (req.headers.authorization !== 'Bearer ' + token) return json(res, 401, { error: 'Open the connection link printed by the server.' });
      if (req.url === '/api/canvases' && req.method === 'GET') {
        const documents = await listCanvases(vault, folder);
        return json(res, 200, documents.map(({ id, title, revision }) => ({ id, title, revision })));
      }
      const draftMatch = /^\/api\/drafts\/([a-f0-9]{32})$/.exec(req.url);
      if (draftMatch && req.method === 'PUT') {
        const input = await body(req);
        validateStrokes(input.strokes);
        return json(res, 200, { document: drafts.publish(draftMatch[1], input.strokes) });
      }
      const match = /^\/api\/canvases\/([a-f0-9-]{36})$/.exec(req.url);
      if (match && req.method === 'GET') return json(res, 200, await serialize(() => readCanvas(directory, match[1])));
      if (match && req.method === 'PUT') {
        const input = await body(req);
        return json(res, 200, await serialize(() => saveCanvas(directory, match[1], input)));
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) { json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.message }); }
  });
  async function cleanup() {
    if (lock) await lock.release();
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', resolve);
    });
  } catch (error) { await cleanup(); throw error; }
  const suffix = directory ? '/#key=' + token : '/';
  console.log('Paperlink → http://localhost:' + port + suffix);
  if (lan) for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log('Device link → http://' + address.address + ':' + port + suffix);
    }
  }
  const stop = () => server.close(() => { cleanup().then(() => process.exit(0)); });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
