import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { createCanvas, listCanvases } from './documents.js';
import { readCanvas, saveCanvas, validateStrokes } from './store.js';
import { acquireFolderLock } from './lock.js';
import { DraftStore } from './drafts.js';

// Private-range Wi-Fi/Ethernet addresses first, so QR codes target the home network.
export function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries || []) {
    if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
  }
  const isPrivate = address => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return addresses.sort((a, b) => isPrivate(b) - isPrivate(a));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Serves one library (any folder). Canvases may live in any non-hidden subfolder.
export async function serve({ port, lan, library: libraryInput }) {
  const library = libraryInput ? await realpath(libraryInput) : null;
  const token = randomBytes(24).toString('hex');
  const drafts = new DraftStore();
  const lock = library ? await acquireFolderLock(library) : null;
  const startedAt = new Date().toISOString();

  // Canvas ID → folder. Rebuilt on a miss so canvases created by the CLI or synced in appear.
  const index = new Map();
  let lastMissScan = 0;
  async function reindex() {
    const canvases = await listCanvases(library, '.', { recursive: true });
    index.clear();
    for (const canvas of canvases) index.set(canvas.id, path.dirname(canvas.path));
    return canvases;
  }
  // Network clients may trigger at most one rescan per second; the local CLI always may.
  async function locate(id, { trusted = false } = {}) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw httpError(400, 'Invalid canvas ID.');
    if (!index.has(id) && (trusted || Date.now() - lastMissScan > 1000)) {
      if (!trusted) lastMissScan = Date.now();
      await reindex();
    }
    if (!index.has(id)) throw httpError(404, 'Canvas not found in this library.');
    return index.get(id);
  }

  // One writer per library; serialize revision checks and replacements.
  let queue = Promise.resolve();
  function serialize(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  function links(suffix) {
    const result = ['http://localhost:' + port + suffix];
    if (lan) for (const address of lanAddresses()) result.push('http://' + address + ':' + port + suffix);
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
      if (size > 8 * 1024 * 1024) throw httpError(413, 'Document exceeds 8 MB.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { throw httpError(400, 'Invalid JSON.'); }
  }

  async function handleCli(req, res) {
    // Only local CLI clients may discover connection links or manage the server.
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local || req.headers.origin || req.headers.host !== '127.0.0.1:' + port || req.method !== 'POST') return json(res, 403, { error: 'Local CLI access only.' });
    const input = await body(req);
    if (input.library !== library) return json(res, 409, { error: 'This server uses a different library: ' + library, library });
    switch (req.url) {
      case '/cli/status':
        return json(res, 200, { running: true, pid: process.pid, library, port, lan, startedAt, links: links('/#key=' + token), drafts: drafts.list().filter(draft => draft.strokes !== null).length });
      case '/cli/stop':
        json(res, 200, { stopping: true });
        setImmediate(stop);
        return;
      case '/cli/drafts':
        return json(res, 200, drafts.list());
      case '/cli/import': {
        const draft = drafts.get(input.id);
        if (!draft) return json(res, 404, { error: 'Browser draft not found. Keep its connected tab open.' });
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) return json(res, 400, { error: 'Specify a title of 1–200 characters.' });
        const document = await serialize(async () => {
          if (draft.document) return draft.document;
          const created = await createCanvas(library, input.path || '.', input.title);
          const directory = path.dirname(created.path);
          await saveCanvas(directory, created.id, { revision: 0, operationId: randomBytes(16).toString('hex'), strokes: draft.strokes });
          index.set(created.id, directory);
          const imported = { id: created.id, title: created.title, revision: 1, folder: created.folder };
          drafts.markImported(input.id, imported);
          return imported;
        });
        return json(res, 200, { id: document.id, title: document.title, folder: document.folder });
      }
      case '/cli/open': {
        const document = await readCanvas(await locate(input.id, { trusted: true }), input.id);
        return json(res, 200, { id: document.id, title: document.title, links: links('/#key=' + token + '&canvas=' + document.id) });
      }
      default:
        return json(res, 404, { error: 'Unknown CLI command.' });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
        res.end(await readFile(new URL('../public/index.html', import.meta.url)));
        return;
      }
      if (!library) return json(res, 503, { error: 'Start the server with a library to enable file storage.' });
      if (req.url.startsWith('/cli/')) return await handleCli(req, res);
      if (req.headers.authorization !== 'Bearer ' + token) return json(res, 401, { error: 'Open the connection link printed by the server.' });
      if (req.url === '/api/canvases' && req.method === 'GET') {
        const canvases = await reindex();
        return json(res, 200, canvases.map(({ id, title, revision, folder }) => ({ id, title, revision, folder })));
      }
      const draftMatch = /^\/api\/drafts\/([a-f0-9]{32})$/.exec(req.url);
      if (draftMatch && req.method === 'PUT') {
        const input = await body(req);
        validateStrokes(input.strokes);
        return json(res, 200, { document: drafts.publish(draftMatch[1], input.strokes) });
      }
      const match = /^\/api\/canvases\/([a-f0-9-]{36})$/.exec(req.url);
      if (match && req.method === 'GET') {
        const directory = await locate(match[1]);
        return json(res, 200, await serialize(() => readCanvas(directory, match[1])));
      }
      if (match && req.method === 'PUT') {
        const input = await body(req);
        const directory = await locate(match[1]);
        return json(res, 200, await serialize(() => saveCanvas(directory, match[1], input)));
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      // Never expose absolute file paths to network clients.
      if (error.code === 'ENOENT') return json(res, 404, { error: 'Canvas not found.' });
      json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
      if (!error.status) console.error(error);
    }
  });

  if (library) await reindex();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', resolve);
    });
  } catch (error) {
    if (lock) await lock.release();
    throw error.code === 'EADDRINUSE' ? new Error('Port ' + port + ' is already in use. Is Paperlink already running? Try `paper status`.') : error;
  }

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    server.close(() => { (lock ? lock.release() : Promise.resolve()).then(() => process.exit(0)); });
    // Browser tabs keep connections alive; do not wait for them.
    setTimeout(() => server.closeAllConnections(), 500).unref();
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { library, port, lan, links: links(library ? '/#key=' + token : '/'), stop };
}
