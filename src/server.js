import http from 'node:http';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { createCanvas, EXTENSION, isCanvasFile, obsidianVault } from './documents.js';
import { readCanvas, saveCanvas, saveOperations, validateStrokes } from './store.js';
import { acquireFolderLock } from './lock.js';
import { DraftStore } from './drafts.js';
import { backgroundDirectory, backgroundPath, findNote, writeObsidianFiles, writePreview } from './preview.js';
import { validPdfName } from './pdf.js';
import { exportPdf } from './export.js';
import { runAssistant, validAssistant } from './assistant.js';
import { loadRegistry, relocate } from './registry.js';
import { findMoved, followNote, moveCanvas } from './move.js';
import { stateDirectory } from './config.js';
import { canvasLink, deviceHost, deviceName, hashToken, loadDevices, pairDevice } from './devices.js';

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
export async function serve({ port, lan, obsidian = true, assistant = null }) {
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

  // Live updates: every open tab of a canvas holds an event stream. Each saved
  // batch of operations is sent to all of them; the recent ones are kept, so a
  // reconnecting tab catches up from its last revision instead of reloading.
  const streams = new Map(); // canvas ID → Set of responses
  const assistantRuns = new Set();
  const history = new Map(); // canvas ID → [{ revision, operationId, ops }]
  function broadcast(id, event) {
    if (event.assistant) { /* status only, not part of the history */ }
    else if (event.ops) {
      const log = history.get(id) || [];
      log.push(event);
      if (log.length > 300) log.shift();
      history.set(id, log);
    } else history.delete(id); // a whole-document change: tabs must reload
    for (const response of streams.get(id) || []) response.write('data: ' + JSON.stringify(event) + '\n\n');
  }
  async function subscribe(req, res, id) {
    const file = await locate(id);
    const given = new URL(req.url, 'http://local').searchParams.get('since');
    const since = given === null ? NaN : Number(given); // without `since`: live from now on
    const { revision } = await serialize(() => readCanvas(file, id));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const missed = (history.get(id) || []).filter(event => event.revision > since);
    const complete = !Number.isInteger(since) || since >= revision || (missed.length && missed[0].revision === since + 1 && missed.at(-1).revision === revision);
    if (!complete) res.write('data: ' + JSON.stringify({ revision, reload: true }) + '\n\n');
    else for (const event of missed) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.write('data: ' + JSON.stringify({ revision, live: true }) + '\n\n');
    const set = streams.get(id) || new Set();
    set.add(res);
    streams.set(id, set);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); set.delete(res); });
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
        return writePreview(current, await readCanvas(current, id), { link: noteLink(id) });
      })
        .catch(error => console.error('Preview for ' + id + ' failed: ' + error.message));
    };
    pendingPreviews.set(id, { timer: setTimeout(refresh, 1500), refresh });
  }
  const flushPreviews = () => Promise.all([...pendingPreviews.values()].map(({ timer, refresh }) => { clearTimeout(timer); return refresh(); }));

  // The Bonjour name comes first: QR codes and note links share its origin,
  // where the browser keeps its device token. IP addresses are fallbacks.
  function links(suffix) {
    const result = ['http://localhost:' + port + suffix];
    if (lan && deviceHost()) result.push('http://' + deviceHost() + ':' + port + suffix);
    if (lan) for (const address of lanAddresses()) result.push('http://' + address + ':' + port + suffix);
    return result;
  }
  const noteLink = id => canvasLink(port, id);

  // One-time pairing codes, created for each QR code the CLI prints.
  const pairCodes = new Map();
  function pairingLinks(canvasId) {
    const now = Date.now();
    for (const [code, expires] of pairCodes) if (expires < now) pairCodes.delete(code);
    while (pairCodes.size >= 100) pairCodes.delete(pairCodes.keys().next().value);
    // One code per link, so opening the link on this computer leaves the QR code valid.
    return links('').map(origin => {
      const code = randomBytes(16).toString('hex');
      pairCodes.set(code, now + 15 * 60 * 1000);
      return origin + '/#pair=' + code + (canvasId ? '&canvas=' + canvasId : '');
    });
  }

  // Paired devices by token hash; reloaded on a miss, at most once a second,
  // so `paper unpair` takes effect without a restart.
  let tokenHashes = new Set();
  let lastDeviceLoad = 0;
  async function reloadDevices() {
    lastDeviceLoad = Date.now();
    tokenHashes = new Set(Object.values(await loadDevices()).map(device => device.tokenHash));
  }
  async function authorized(req) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return false;
    const hash = hashToken(token);
    if (!tokenHashes.has(hash) && Date.now() - lastDeviceLoad > 1000) await reloadDevices();
    return tokenHashes.has(hash);
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function rawBody(req, limit) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw httpError(413, 'Upload too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
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
        return json(res, 200, { running: true, pid: process.pid, port, lan, obsidian, assistant: Boolean(assistant), startedAt, links: pairingLinks(), drafts: drafts.list().filter(draft => draft.strokes !== null).length });
      case '/cli/stop':
        json(res, 200, { stopping: true, pid: process.pid });
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
          if (obsidian && await inVault(created.path)) await writeObsidianFiles(created.path, await readCanvas(created.path, created.id), { link: noteLink(created.id) })
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
      case '/cli/ops': {
        // Annotations and other edits from the local CLI, shown live in open tabs.
        const file = await locate(input.id, { trusted: true });
        const saved = await serialize(() => saveOperations(file, input.id, { operationId: input.operationId, ops: input.ops }));
        if (!saved.duplicate) {
          broadcast(input.id, { revision: saved.revision, operationId: input.operationId, ops: input.ops });
          void schedulePreview(input.id, file);
        }
        return json(res, 200, { revision: saved.revision });
      }
      case '/cli/pair':
        return json(res, 200, { links: pairingLinks() });
      case '/cli/devices':
        await reloadDevices();
        return json(res, 200, { reloaded: true });
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
        return json(res, 200, { id: document.id, title: document.title, links: pairingLinks(document.id) });
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
      // Stroke format and geometry, shared with the server.
      if (req.url === '/ink.js' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(new URL('./ink.js', import.meta.url)));
        return;
      }
      // pdf.js, served from the project so it works offline.
      const vendor = /^\/vendor\/pdfjs\/((?:[a-z_]+\/)?[A-Za-z0-9_.-]+)$/.exec(req.url);
      if (vendor && req.method === 'GET' && !vendor[1].includes('..')) {
        const types = { '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
        const content = await readFile(new URL('../public/vendor/pdfjs/' + vendor[1], import.meta.url));
        res.writeHead(200, { 'Content-Type': types[path.extname(vendor[1])] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
        res.end(content);
        return;
      }
      if (req.url.startsWith('/cli/')) return await handleCli(req, res);
      if (req.url === '/api/pair' && req.method === 'POST') {
        const input = await body(req);
        const expires = pairCodes.get(input.code);
        if (typeof input.code !== 'string' || !expires || expires < Date.now()) return json(res, 403, { error: 'This pairing code expired or was already used. Run `paper pair` on your computer and scan the new code.' });
        pairCodes.delete(input.code);
        const paired = await pairDevice({ deviceId: input.deviceId, name: deviceName(req.headers['user-agent']) });
        await reloadDevices();
        return json(res, 200, { deviceId: paired.deviceId, token: paired.token, name: paired.devices[paired.deviceId].name });
      }
      if (!(await authorized(req))) return json(res, 401, { error: 'This device is not paired. Run `paper pair` on your computer and scan the code.' });
      const draftMatch = /^\/api\/drafts\/([a-f0-9]{32})$/.exec(req.url);
      if (draftMatch && req.method === 'PUT') {
        const input = await body(req);
        validateStrokes(input.strokes);
        return json(res, 200, { document: drafts.publish(draftMatch[1], input.strokes) });
      }
      const pdfMatch = /^\/api\/canvases\/([a-f0-9-]{36})\/pdf$/.exec(req.url);
      if (pdfMatch && req.method === 'GET') {
        const file = await locate(pdfMatch[1]);
        const document = await readCanvas(file, pdfMatch[1]);
        if (!validPdfName(document.pdf?.file)) throw httpError(404, 'This canvas has no PDF.');
        const content = await readFile(path.join(path.dirname(file), document.pdf.file)).catch(() => { throw httpError(404, 'The PDF ' + document.pdf.file + ' is missing next to the canvas.'); });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
        res.end(content);
        return;
      }
      // Low-resolution page images for the Obsidian preview of PDF pages.
      const backgroundMatch = /^\/api\/canvases\/([a-f0-9-]{36})\/backgrounds\/([a-zA-Z0-9-]{1,64})$/.exec(req.url);
      if (backgroundMatch && req.method === 'PUT') {
        const [, id, pageId] = backgroundMatch;
        const file = await locate(id);
        const document = await readCanvas(file, id);
        if (!document.pages.some(page => page.id === pageId && page.pdfPage !== undefined)) throw httpError(404, 'Unknown PDF page.');
        const image = await rawBody(req, 1024 * 1024);
        if (image[0] !== 0xff || image[1] !== 0xd8) throw httpError(400, 'Expected a JPEG image.');
        await mkdir(backgroundDirectory(id), { recursive: true });
        await writeFile(backgroundPath(id, pageId), image);
        void schedulePreview(id, file);
        return json(res, 200, { stored: pageId });
      }
      const exportMatch = /^\/api\/canvases\/([a-f0-9-]{36})\/export\.pdf$/.exec(req.url);
      if (exportMatch && req.method === 'GET') {
        const [, id] = exportMatch;
        const file = await locate(id);
        const temporary = path.join(stateDirectory(), 'export-' + randomBytes(8).toString('hex') + '.pdf');
        await mkdir(stateDirectory(), { recursive: true });
        try {
          const document = await serialize(() => readCanvas(file, id));
          await serialize(() => exportPdf(file, id, temporary));
          const content = await readFile(temporary);
          const name = document.title.replace(/[^\x20-\x7e]|["\\]/g, '_') + '.pdf';
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="' + name + '"; filename*=UTF-8\'\'' + encodeURIComponent(document.title + '.pdf') });
          res.end(content);
        } finally { await unlink(temporary).catch(() => {}); }
        return;
      }
      // "Request feedback": one assistant run per canvas at a time.
      const feedbackMatch = /^\/api\/canvases\/([a-f0-9-]{36})\/feedback$/.exec(req.url);
      if (feedbackMatch && req.method === 'POST') {
        const [, id] = feedbackMatch;
        if (!assistant || !validAssistant(assistant)) throw httpError(409, 'No assistant is set up. On the computer run `paper config set assistant claude` (or codex) and restart Paperlink.');
        if (assistantRuns.has(id)) throw httpError(429, 'The assistant is still working on this canvas.');
        const input = await body(req);
        const file = await locate(id);
        const document = await serialize(() => readCanvas(file, id));
        const page = input.page;
        if (!Number.isInteger(page) || page < 1 || page > document.pages.length) throw httpError(400, 'Invalid page.');
        const region = input.region ?? null;
        if (region !== null && !['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key]) && Math.abs(region[key]) < 20000) || (region && (region.width <= 0 || region.height <= 0))) throw httpError(400, 'Invalid region.');
        if (input.question !== undefined && (typeof input.question !== 'string' || input.question.length > 1000)) throw httpError(400, 'Questions are limited to 1000 characters.');
        assistantRuns.add(id);
        broadcast(id, { assistant: 'started' });
        await runAssistant({
          setting: assistant, port,
          request: { document, page, region, question: input.question?.trim() || '' },
          onExit: ({ ok, message }) => { assistantRuns.delete(id); broadcast(id, { assistant: ok ? 'done' : 'failed', message }); }
        }).catch(error => { assistantRuns.delete(id); throw error; });
        return json(res, 202, { started: true });
      }
      const eventsMatch = /^\/api\/canvases\/([a-f0-9-]{36})\/events(?:\?since=-?\d+)?$/.exec(req.url);
      if (eventsMatch && req.method === 'GET') return await subscribe(req, res, eventsMatch[1]);
      const opsMatch = /^\/api\/canvases\/([a-f0-9-]{36})\/ops$/.exec(req.url);
      if (opsMatch && req.method === 'POST') {
        const [, id] = opsMatch;
        const input = await body(req);
        const file = await locate(id);
        const saved = await serialize(() => saveOperations(file, id, input));
        if (!saved.duplicate) {
          broadcast(id, { revision: saved.revision, operationId: input.operationId, ops: input.ops });
          void schedulePreview(id, file);
        }
        return json(res, 200, { revision: saved.revision });
      }
      const match = /^\/api\/canvases\/([a-f0-9-]{36})$/.exec(req.url);
      if (match && req.method === 'GET') {
        const file = await locate(match[1]);
        const document = await serialize(() => readCanvas(file, match[1]));
        // Tells the browser which page images the preview still lacks.
        const cached = await readdir(backgroundDirectory(match[1])).catch(() => []);
        return json(res, 200, { ...document, receipts: undefined, cachedBackgrounds: cached.map(name => name.replace(/\.jpg$/, '')), assistant: Boolean(assistant) });
      }
      if (match && req.method === 'PUT') {
        const input = await body(req);
        const file = await locate(match[1]);
        const saved = await serialize(() => saveCanvas(file, match[1], input));
        broadcast(match[1], { revision: saved.revision, reload: true });
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
  await reloadDevices();
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
    // Live tabs hold their streams open; end them now, so a restart right after
    // `paper stop` finds the port and lock free. Tabs reconnect on their own.
    for (const set of streams.values()) for (const response of set) response.end();
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 300).unref();
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { port, lan, obsidian, links: pairingLinks(), stop };
}
