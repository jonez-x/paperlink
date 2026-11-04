import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { createCanvas, EXTENSION, isCanvasFile, obsidianVault } from './documents.js';
import { readCanvas, saveCanvas, validateStrokes } from './store.js';
import { acquireFolderLock } from './lock.js';
import { DraftStore } from './drafts.js';
import { findNote, writeObsidianFiles, writePreview } from './preview.js';
import { loadRegistry, relocate } from './registry.js';
import { findMoved, followNote, moveCanvas } from './move.js';
import { stateDirectory } from './config.js';

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

// One server per user serves every canvas the local CLI has created or opened.
export async function serve({ port, lan, obsidian = true }) {
  const token = randomBytes(24).toString('hex');
  const drafts = new DraftStore();
  const lock = await acquireFolderLock(stateDirectory());
  const startedAt = new Date().toISOString();

  // Canvas ID → file, from the CLI's registry. Reloaded on a miss so canvases
  // the CLI added after the server started become reachable.
  const index = new Map();
  let lastMissScan = 0;
  async function reindex() {
    index.clear();
    for (const [id, entry] of Object.entries(await loadRegistry())) if (typeof entry?.path === 'string') index.set(id, entry.path);
  }
  // Network clients may trigger at most one reload per second; the local CLI always may.
  async function locate(id, { trusted = false } = {}) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw httpError(400, 'Invalid canvas ID.');
    // A missing file may have been reopened from its new place since the last load.
    if ((!index.has(id) || !existsSync(index.get(id))) && (trusted || Date.now() - lastMissScan > 1000)) {
      if (!trusted) lastMissScan = Date.now();
      await reindex();
    }
    if (!index.has(id)) throw httpError(404, 'Canvas not found. Open it with `paper open` on the computer first.');
    if (!existsSync(index.get(id))) await recover(id);
    return index.get(id);
  }
  // A known canvas moved in the Finder or by a sync client is searched for by ID.
  const searchedAt = new Map();
  async function recover(id) {
    if (Date.now() - (searchedAt.get(id) || 0) < 5000) return;
    searchedAt.set(id, Date.now());
    const found = await findMoved(id, index.get(id));
    if (found) await moved(id, found);
  }
  async function moved(id, file) {
    index.set(id, file);
    vaults.delete(file);
    await relocate(id, file);
  }

  // One writer per file; serialize revision checks and replacements.
  let queue = Promise.resolve();
  function serialize(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }

  // Obsidian previews follow saves after a short pause, so a stream of strokes
  // causes one file write (and one sync upload) instead of one per stroke.
  const vaults = new Map();
  const inVault = async file => {
    if (!vaults.has(file)) vaults.set(file, await obsidianVault(file));
    return vaults.get(file) !== null;
  };
  const pendingPreviews = new Map();
  const noteSearchedAt = new Map();
  async function schedulePreview(id, file) {
    if (!obsidian || !(await inVault(file))) return;
    clearTimeout(pendingPreviews.get(id)?.timer);
    const refresh = () => {
      pendingPreviews.delete(id);
      return serialize(async () => {
        // A note moved inside Obsidian takes its canvas along. The vault is only
        // searched when the note left the canvas folder, at most once a minute.
        let current = index.get(id) || file;
        if (!(await findNote(path.dirname(current), id)) && Date.now() - (noteSearchedAt.get(id) || 0) > 60000) {
          noteSearchedAt.set(id, Date.now());
          const followed = await followNote(current, id);
          if (followed) { await moved(id, followed); current = followed; noteSearchedAt.delete(id); }
        }
        return writePreview(current, await readCanvas(current, id));
      })
        .catch(error => console.error('Preview for ' + id + ' failed: ' + error.message));
    };
    pendingPreviews.set(id, { timer: setTimeout(refresh, 1500), refresh });
  }
  const flushPreviews = () => Promise.all([...pendingPreviews.values()].map(({ timer, refresh }) => { clearTimeout(timer); return refresh(); }));

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
    switch (req.url) {
      case '/cli/status':
        return json(res, 200, { running: true, pid: process.pid, port, lan, obsidian, startedAt, links: links('/#key=' + token), drafts: drafts.list().filter(draft => draft.strokes !== null).length });
      case '/cli/stop':
        json(res, 200, { stopping: true });
        setImmediate(stop);
        return;
      case '/cli/drafts':
        return json(res, 200, drafts.list());
      case '/cli/import': {
        const draft = drafts.get(input.id);
        if (!draft) return json(res, 404, { error: 'Browser draft not found. Keep its connected tab open.' });
        if (typeof input.file !== 'string' || !path.isAbsolute(input.file) || !isCanvasFile(input.file)) return json(res, 400, { error: 'Specify an absolute ' + EXTENSION + ' file path.' });
        const document = await serialize(async () => {
          if (draft.document) return draft.document;
          const created = await createCanvas(input.file, input.title || undefined);
          await saveCanvas(created.path, created.id, { revision: 0, operationId: randomBytes(16).toString('hex'), strokes: draft.strokes });
          index.set(created.id, created.path);
          const imported = { id: created.id, title: created.title, revision: 1, path: created.path };
          drafts.markImported(input.id, imported);
          // The canvas is saved; a failed preview must not make a retry import it twice.
          if (obsidian && await inVault(created.path)) await writeObsidianFiles(created.path, await readCanvas(created.path, created.id))
            .catch(error => console.error('Obsidian files for ' + created.id + ' failed: ' + error.message));
          return imported;
        });
        return json(res, 200, { id: document.id, title: document.title, path: document.path });
      }
      case '/cli/move': {
        if (typeof input.destination !== 'string' || !path.isAbsolute(input.destination) || !isCanvasFile(input.destination)) return json(res, 400, { error: 'Specify an absolute ' + EXTENSION + ' destination.' });
        await flushPreviews();
        const result = await serialize(async () => {
          const file = await locate(input.id, { trusted: true });
          const done = await moveCanvas(file, input.id, input.destination);
          await moved(input.id, done.path);
          return done;
        });
        return json(res, 200, result);
      }
      case '/cli/forget': {
        // Before the CLI deletes or forgets a canvas: no preview may recreate files.
        clearTimeout(pendingPreviews.get(input.id)?.timer);
        pendingPreviews.delete(input.id);
        await serialize(() => {});
        index.delete(input.id);
        return json(res, 200, { forgotten: input.id });
      }
      case '/cli/open': {
        // The CLI may just have recorded a new path for a moved file.
        await reindex();
        const file = await locate(input.id, { trusted: true });
        const document = await readCanvas(file, input.id);
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
      if (req.url.startsWith('/cli/')) return await handleCli(req, res);
      if (req.headers.authorization !== 'Bearer ' + token) return json(res, 401, { error: 'Open the connection link printed by the server.' });
      const draftMatch = /^\/api\/drafts\/([a-f0-9]{32})$/.exec(req.url);
      if (draftMatch && req.method === 'PUT') {
        const input = await body(req);
        validateStrokes(input.strokes);
        return json(res, 200, { document: drafts.publish(draftMatch[1], input.strokes) });
      }
      const match = /^\/api\/canvases\/([a-f0-9-]{36})$/.exec(req.url);
      if (match && req.method === 'GET') {
        const file = await locate(match[1]);
        return json(res, 200, await serialize(() => readCanvas(file, match[1])));
      }
      if (match && req.method === 'PUT') {
        const input = await body(req);
        const file = await locate(match[1]);
        const saved = await serialize(() => saveCanvas(file, match[1], input));
        void schedulePreview(match[1], file);
        return json(res, 200, saved);
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      // Never expose absolute file paths to network clients.
      if (error.code === 'ENOENT') return json(res, 404, { error: 'Canvas not found.' });
      json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
      if (!error.status) console.error(error);
    }
  });

  await reindex();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', resolve);
    });
  } catch (error) {
    await lock.release();
    throw error.code === 'EADDRINUSE' ? new Error('Port ' + port + ' is already in use. Is Paperlink already running? Try `paper status`.') : error;
  }

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    server.close(() => { flushPreviews().then(() => lock.release()).then(() => process.exit(0)); });
    // Browser tabs keep connections alive; do not wait for them.
    setTimeout(() => server.closeAllConnections(), 500).unref();
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { port, lan, obsidian, links: links('/#key=' + token), stop };
}
