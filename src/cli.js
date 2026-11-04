// Paperlink CLI. Every action works two ways:
//   humans: `paper` opens a keyboard-driven menu; commands ask for missing input.
//   scripts and AI agents: commands with flags, JSON on stdout when not in a
//   terminal (or with --json), errors as JSON on stderr and a non-zero exit code.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './server.js';
import { canvasBase, canvasPath, createCanvas, EXTENSION, findCanvasFiles, folderEntries, isCanvasFile, obsidianVault, safeFileName } from './documents.js';
import { configPath, expandHome, loadConfig, saveConfig, stateDirectory, validPort } from './config.js';
import { forget, loadRegistry, relocate, remember } from './registry.js';
import { deleteCanvas, findMoved, moveCanvas } from './move.js';
import { readCanvas } from './store.js';
import { writeObsidianFiles } from './preview.js';
import { renderQr } from './qr.js';
import * as ui from './tui.js';

const { c } = ui;
const BIN = fileURLToPath(new URL('../bin/paper.js', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

class CliError extends Error {}

// ── Arguments ────────────────────────────────────────────────────────────────
const BOOLEAN_FLAGS = new Set(['lan', 'no-lan', 'json', 'qr', 'no-qr', 'obsidian', 'no-obsidian', 'help', 'version', 'no-start', 'all', 'yes']);
const VALUE_FLAGS = new Set(['port', 'title', 'from-browser']);

export function parseArguments(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '-h') { flags.help = true; continue; }
    if (argument === '-v') { flags.version = true; continue; }
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const [name, inline] = argument.slice(2).split(/=(.*)/s);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (['library', 'vault', 'path', 'default-path'].includes(name)) throw new CliError('--' + name + ' is gone: canvases are plain files now. Pass the file path instead, e.g. paper new "Uni/Sheet 3".');
    if (!VALUE_FLAGS.has(name)) throw new CliError('Unknown option --' + name + '. See `paper help`.');
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new CliError('Missing value for --' + name + '.');
    flags[name] = value;
  }
  return { flags, positional };
}

// Earlier versions kept canvases in one configured "library". Its canvases are
// adopted into the list of known canvases once, then the setting is dropped.
async function migrateLibrary(config) {
  if (!config.library) return config;
  const adopted = [];
  for (const file of await findCanvasFiles(config.library)) {
    try { const document = await readCanvas(file); adopted.push({ id: document.id, title: document.title, path: file }); } catch { /* skip damaged files */ }
  }
  if (adopted.length) await remember(adopted);
  return saveConfig({ ...config, obsidian: true });
}

async function context(flags) {
  const config = await migrateLibrary(await loadConfig());
  return {
    flags, config,
    port: validPort(flags.port ?? process.env.PAPERLINK_PORT ?? config.port),
    lan: flags.lan ? true : flags['no-lan'] ? false : config.lan,
    obsidian: flags.obsidian ? true : flags['no-obsidian'] ? false : config.obsidian,
    json: Boolean(flags.json) || !process.stdout.isTTY,
    interactive: !flags.json && ui.isInteractive()
  };
}

// ── Output ───────────────────────────────────────────────────────────────────
function emit(ctx, data, pretty) {
  if (ctx.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else console.log(pretty());
}

function prettyPath(absolute) {
  if (!absolute) return c.muted('not set');
  const obsidian = path.join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents');
  if (absolute.startsWith(obsidian + path.sep)) return 'Obsidian › ' + absolute.slice(obsidian.length + 1).split(path.sep).join(' › ');
  const icloud = path.join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs');
  if (absolute.startsWith(icloud + path.sep)) return 'iCloud Drive › ' + absolute.slice(icloud.length + 1).split(path.sep).join(' › ');
  return absolute.startsWith(homedir() + path.sep) ? '~/' + absolute.slice(homedir().length + 1) : absolute;
}
const plain = text => String(text).replace(/\x1b\[[0-9;]*m/g, '');

function ago(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
  return Math.round(seconds / 86400) + 'd ago';
}

const deviceLink = links => (links || []).find(link => !link.startsWith('http://localhost'));
const wantsQr = ctx => !ctx.flags['no-qr'] && (ctx.flags.qr || !ctx.json);

function qrSection(ctx, links, label) {
  const device = deviceLink(links);
  if (!device) {
    return ['', '  ' + c.muted('Network access is off, so only this computer can connect:'), '  ' + links[0],
      '  ' + c.muted('Allow your iPad with `paper config set lan true`, then restart the server.')].join('\n');
  }
  if (!wantsQr(ctx)) return '  ' + device;
  return ['', '  ' + c.bold(label), ui.indent(renderQr(device), '  '),
    '  ' + c.muted(device.split('#')[0] + ' · the code contains your access key, do not share it')].join('\n');
}
// JSON mode keeps stdout machine-readable; an explicit --qr goes to stderr.
function jsonQr(ctx, links) {
  const device = deviceLink(links);
  if (ctx.json && ctx.flags.qr && device) process.stderr.write(renderQr(device) + '\n');
}

const ok = text => '  ' + c.green('✓') + ' ' + text;

// ── Server control ───────────────────────────────────────────────────────────
async function callServer(ctx, command, payload = {}) {
  let response;
  try {
    response = await fetch('http://127.0.0.1:' + ctx.port + '/cli/' + command, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(5000)
    });
  } catch { return null; }
  const result = await response.json().catch(() => ({ error: 'Port ' + ctx.port + ' is used by another program.' }));
  // `paper` always runs the current code, a background server keeps what it started with.
  if (response.status === 404 && result.error === 'Unknown CLI command.') throw new CliError('The running server is older than this command. Restart it with `paper stop` and `paper start`.');
  if (!response.ok) throw new CliError(result.error);
  return result;
}

async function requireServer(ctx) {
  const status = await callServer(ctx, 'status');
  if (status) return status;
  if (ctx.interactive && !ctx.flags['no-start']) {
    const start = await ui.confirm({ message: 'Paperlink is not running. Start it now?' });
    if (start) return startBackground(ctx);
  }
  throw new CliError('Paperlink is not running. Start it with `paper start`.');
}

async function startBackground(ctx) {
  const existing = await callServer(ctx, 'status');
  if (existing) return existing;
  await mkdir(stateDirectory(), { recursive: true });
  const logFile = path.join(stateDirectory(), 'server.log');
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(ctx.port), ctx.lan ? '--lan' : '--no-lan', ctx.obsidian ? '--obsidian' : '--no-obsidian', '--no-qr'], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, PAPERLINK_BACKGROUND: '1' }
  });
  closeSync(log);
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.unref();
  for (let waited = 0; waited < 8000 && !exited; waited += 150) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const status = await callServer(ctx, 'status');
    if (status) return status;
  }
  const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' ');
  throw new CliError('The server did not start. ' + (tail || 'See ' + logFile));
}

// ── Known canvases ───────────────────────────────────────────────────────────
// Canvases moved outside Paperlink are looked for by ID and the list is updated.
async function knownCanvases() {
  const canvases = [];
  for (const [id, entry] of Object.entries(await loadRegistry())) {
    let file = entry.path;
    if (!existsSync(file)) {
      const found = await findMoved(id, file);
      if (found) { file = found; await relocate(id, found); }
    }
    canvases.push({ id, title: entry.title, path: file, openedAt: entry.openedAt, missing: !existsSync(file) });
  }
  return canvases.sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || ''));
}

// A query is a file path first, then an ID, ID prefix or title of a known canvas.
async function findCanvas(ctx, query, { allowMissing = false } = {}) {
  if (!query) {
    if (!ctx.interactive) throw new CliError('Specify a canvas file, ID or title.');
    const known = (await knownCanvases()).filter(canvas => allowMissing || !canvas.missing);
    if (!known.length) throw new CliError('No canvases yet. Create one with `paper new`.');
    return ui.select({
      message: 'Which canvas?',
      choices: known.map(canvas => ({ label: canvas.title, value: canvas, hint: plain(prettyPath(path.dirname(canvas.path))) + ' · ' + ago(canvas.openedAt) }))
    });
  }
  for (const candidate of [path.resolve(expandHome(query)), canvasPath(expandHome(query))]) {
    if (!isCanvasFile(candidate) || !existsSync(candidate)) continue;
    const document = await readCanvas(candidate);
    return { id: document.id, title: document.title, path: candidate };
  }
  const known = await knownCanvases();
  const lower = query.toLowerCase();
  const groups = [
    known.filter(canvas => canvas.id === query),
    query.length >= 4 ? known.filter(canvas => canvas.id.startsWith(lower)) : [],
    known.filter(canvas => canvas.title.toLowerCase() === lower),
    known.filter(canvas => canvas.title.toLowerCase().includes(lower))
  ];
  let match = groups.find(group => group.length === 1)?.[0];
  if (!match) {
    const candidates = [...new Set(groups.flat())];
    if (!candidates.length) throw new CliError('No canvas file or known canvas matches "' + query + '". See `paper list`.');
    if (!ctx.interactive) throw new CliError('"' + query + '" matches several canvases: ' + candidates.map(canvas => canvas.id + ' (' + canvas.path + ')').join(', '));
    match = await ui.select({ message: 'Several canvases match. Which one?', choices: candidates.map(canvas => ({ label: canvas.title, value: canvas, hint: plain(prettyPath(canvas.path)) })) });
    if (!match) return null;
  }
  if (match.missing && !allowMissing) throw new CliError('"' + match.title + '" is no longer at ' + match.path + '. If you moved it, open it by its new path: paper open "<file>".');
  return match;
}

// ── Interactive helpers ──────────────────────────────────────────────────────
function completeDirectory(value) {
  const expanded = expandHome(value || '~/');
  const base = expanded.endsWith('/') ? expanded : path.dirname(expanded);
  const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);
  let names;
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter(entry => (entry.isDirectory() || (entry.isSymbolicLink() && statSync(path.join(base, entry.name), { throwIfNoEntry: false })?.isDirectory())) &&
        entry.name.startsWith(prefix) && (prefix.startsWith('.') || !entry.name.startsWith('.')))
      .map(entry => entry.name);
  } catch { return value; }
  if (!names.length) return value;
  let common = names[0];
  for (const name of names) while (!name.startsWith(common)) common = common.slice(0, -1);
  const completed = path.join(base, common) + (names.length === 1 ? '/' : '');
  return value?.startsWith('~') && completed.startsWith(homedir()) ? '~' + completed.slice(homedir().length) : completed;
}

// Browse the file system, starting in the current folder; recent canvas
// folders are one step away.
async function pickFolder(start = process.cwd(), action = 'Create here') {
  const recent = [...new Set((await knownCanvases()).filter(canvas => !canvas.missing).map(canvas => path.dirname(canvas.path)))].slice(0, 3);
  let current = path.resolve(start);
  for (;;) {
    const { folders, canvases } = await folderEntries(current);
    const vault = await obsidianVault(path.join(current, 'x'));
    const choices = [
      { label: '✓ ' + action, value: { save: true }, hint: vault ? 'Obsidian vault · a note is added' : '' },
      { label: '+ New folder…', value: { create: true } },
      { label: '… Type a path', value: { type: true } },
      ...(path.dirname(current) !== current ? [{ label: '↩ Up one level', value: { enter: path.dirname(current) } }] : []),
      ...(recent.filter(folder => folder !== current).length ? [{ separator: 'Recent' }] : []),
      ...recent.filter(folder => folder !== current).map(folder => ({ label: '★ ' + plain(prettyPath(folder)), value: { enter: folder } })),
      ...(folders.length ? [{ separator: 'Folders' + (canvases.length ? c.muted(' · ' + canvases.length + ' canvas' + (canvases.length === 1 ? '' : 'es') + ' here') : '') }] : []),
      ...folders.map(name => ({ label: '▸ ' + name, value: { enter: path.join(current, name) } }))
    ];
    const choice = await ui.select({ message: 'Folder  ' + c.muted(plain(prettyPath(current))), choices, quiet: true });
    if (!choice) return null;
    if (choice.save) { console.log(ok('Folder ' + c.muted('· ' + plain(prettyPath(current))))); return current; }
    if (choice.enter) current = choice.enter;
    if (choice.type) {
      const answer = await ui.input({ message: 'Folder', initial: plain(prettyPath(current)).startsWith('~') ? plain(prettyPath(current)) + '/' : current + '/', complete: completeDirectory });
      if (answer) current = path.resolve(expandHome(answer));
    }
    if (choice.create) {
      const name = await ui.input({
        message: 'New folder name',
        validate: value => !value ? 'Enter a name.' : /[\\/]/.test(value) || value === '.' || value === '..' || value.startsWith('.') ? 'Use a single, visible folder name.' : ''
      });
      if (name) current = path.join(current, name);
    }
  }
}

function canvasCard(canvas, title = 'Canvas') {
  return ui.card([
    c.bold(canvas.title),
    c.muted('File  ') + prettyPath(canvas.path),
    c.muted('ID    ') + canvas.id
  ], { title });
}

// Canvases inside an Obsidian vault get a note and a preview next to them.
async function obsidianFiles(ctx, file, document) {
  if (!ctx.obsidian || !(await obsidianVault(file))) return null;
  return writeObsidianFiles(file, document);
}

// ── Commands ─────────────────────────────────────────────────────────────────
const RESTART_KEYS = ['lan', 'port', 'obsidian'];

async function cmdConfig(ctx, positional) {
  const [action, key, ...rest] = positional;
  if (!action || action === 'show') {
    return emit(ctx, { ...ctx.config, configPath: configPath() }, () => ui.card([
      c.muted('obsidian  ') + ctx.config.obsidian + c.muted('  · notes for canvases inside a vault'),
      c.muted('lan       ') + ctx.config.lan + c.muted('  · iPad and other devices may connect'),
      c.muted('port      ') + ctx.config.port,
      '', c.muted(configPath())
    ], { title: 'Config' }));
  }
  if (action !== 'set' || !key || !rest.length) throw new CliError('Use `paper config`, or `paper config set <obsidian|lan|port> <value>`.');
  const value = rest.join(' ');
  const parseBoolean = text => { if (/^(true|on|yes|1)$/i.test(text)) return true; if (/^(false|off|no|0)$/i.test(text)) return false; throw new CliError(key + ' must be true or false.'); };
  const update = { obsidian: parseBoolean, lan: parseBoolean, port: validPort }[key];
  if (!update) throw new CliError('Unknown setting ' + key + '. Use obsidian, lan or port.');
  const config = await saveConfig({ ...ctx.config, [key]: update(value) });
  emit(ctx, { ...config, configPath: configPath() }, () => ok(key + ' = ' + config[key] + (RESTART_KEYS.includes(key) ? c.muted('  · restart the server to apply') : '')) +
    (key === 'obsidian' && config.obsidian ? '\n  ' + c.muted('Run `paper preview` to add notes for existing canvases.') : ''));
}

async function cmdServe(ctx) {
  const server = await serve({ port: ctx.port, lan: ctx.lan, obsidian: ctx.obsidian });
  if (!process.stdout.isTTY || process.env.PAPERLINK_BACKGROUND) {
    console.log('Paperlink → ' + server.links[0]);
    for (const link of server.links.slice(1)) console.log('Device link → ' + link);
    return;
  }
  console.log(ui.banner());
  console.log(ui.card([
    c.green('●') + ' running on port ' + ctx.port,
    c.muted('Network   ') + (ctx.lan ? 'iPad can connect' : 'this computer only'),
    c.muted('Obsidian  ') + (ctx.obsidian ? 'notes and previews in vaults' : 'off')
  ], { title: 'Server' }));
  console.log(qrSection(ctx, server.links, 'Scan with your iPad to connect'));
  console.log('\n  ' + c.muted('Keep this window open · Ctrl-C stops the server · `paper start` runs it in the background') + '\n');
}

async function cmdStart(ctx) {
  const status = await startBackground(ctx);
  jsonQr(ctx, status.links);
  emit(ctx, status, () => ok('Paperlink is running in the background ' + c.muted('· port ' + status.port + ' · pid ' + status.pid)) + '\n' + qrSection(ctx, status.links, 'Scan with your iPad to connect'));
}

async function cmdStop(ctx) {
  // `anyLibrary` lets servers of the earlier library-based version stop too.
  const result = await callServer(ctx, 'stop', { anyLibrary: true });
  emit(ctx, { running: false, stopped: Boolean(result) }, () => result ? ok('Server stopped') : '  ' + c.muted('Paperlink was not running.'));
}

async function cmdStatus(ctx) {
  const status = await callServer(ctx, 'status');
  emit(ctx, status || { running: false, port: ctx.port }, () => statusCard(ctx, status));
}

function statusCard(ctx, status) {
  return ui.card([
    c.muted('Server    ') + (status ? c.green('● running') + c.muted(' · port ' + status.port + (status.lan ? ' · iPad can connect' : ' · this computer only')) : c.muted('○ stopped')),
    c.muted('Obsidian  ') + (ctx.obsidian ? 'notes and previews in vaults' : 'off')
  ]);
}

async function cmdNew(ctx, positional) {
  const name = positional.join(' ');
  let title = ctx.flags.title;
  let file;
  if (name && !(existsSync(path.resolve(expandHome(name))) && statSync(path.resolve(expandHome(name))).isDirectory())) {
    file = canvasPath(expandHome(name));
  } else {
    if (!ctx.interactive) throw new CliError('Specify where to create it: paper new "<folder>/<name>" [--title TITLE].');
    title ??= await ui.input({ message: 'Title', placeholder: 'e.g. Analysis sheet 3', validate: value => value ? (value.length > 200 ? 'At most 200 characters.' : '') : 'Enter a title.' });
    if (title === null) return;
    const folder = name ? path.resolve(expandHome(name)) : await pickFolder();
    if (folder === null) return;
    file = path.join(folder, safeFileName(title) + EXTENSION);
  }
  const canvas = await createCanvas(file, title);
  await remember(canvas);
  const obsidian = await obsidianFiles(ctx, canvas.path, canvas);
  // The canvas exists now; a missing server only means no link yet.
  const status = await (ctx.interactive ? requireServer(ctx) : callServer(ctx, 'status')).catch(() => null);
  const opened = status ? await callServer(ctx, 'open', { id: canvas.id }).catch(() => null) : null;
  jsonQr(ctx, opened?.links);
  emit(ctx, { id: canvas.id, title: canvas.title, path: canvas.path, note: obsidian?.note ?? null, links: opened?.links ?? [] }, () =>
    '\n' + canvasCard(canvas, 'Canvas created') + (obsidian ? '\n' + ok('Obsidian note ' + c.muted('· ' + path.basename(obsidian.note))) : '') +
    (opened ? qrSection(ctx, opened.links, 'Scan to start writing · saves automatically')
      : '\n  ' + c.muted('Start the server with `paper start` to get a QR code for this canvas.')));
}

async function cmdOpen(ctx, positional) {
  const canvas = await findCanvas(ctx, positional.join(' '));
  if (!canvas) return;
  const document = await readCanvas(canvas.path);
  await remember({ id: document.id, title: document.title, path: canvas.path });
  await requireServer(ctx);
  const opened = await callServer(ctx, 'open', { id: document.id });
  jsonQr(ctx, opened.links);
  emit(ctx, { ...opened, path: canvas.path }, () => '\n' + canvasCard({ ...opened, path: canvas.path }) + qrSection(ctx, opened.links, 'Scan to open on your iPad'));
}

async function cmdList(ctx) {
  const canvases = await knownCanvases();
  emit(ctx, canvases, () => {
    if (!canvases.length) return '  ' + c.muted('No canvases yet. Create one with `paper new`.');
    const byFolder = new Map();
    for (const canvas of canvases) byFolder.set(path.dirname(canvas.path), [...(byFolder.get(path.dirname(canvas.path)) || []), canvas]);
    const lines = [];
    for (const [folder, entries] of byFolder) {
      lines.push((lines.length ? '\n' : '') + '  ' + c.accent('▪') + ' ' + c.bold(prettyPath(folder)));
      for (const canvas of entries) lines.push('    ' + canvas.title + '  ' + c.muted(canvas.id.slice(0, 8) + ' · ' + ago(canvas.openedAt)) + (canvas.missing ? '  ' + c.danger('missing · `paper forget ' + canvas.id.slice(0, 8) + '`') : ''));
    }
    return '\n' + lines.join('\n') + '\n';
  });
}

// Moves or renames a canvas with its note and preview. Through the running
// server when there is one, so no save can land on the old path meanwhile.
async function cmdMove(ctx, positional) {
  const canvas = await findCanvas(ctx, positional[0] ?? '');
  if (!canvas) return;
  const target = positional.slice(1).join(' ');
  let destination;
  if (target) {
    const resolved = path.resolve(expandHome(target));
    const intoFolder = /[\\/]$/.test(target) || (existsSync(resolved) && statSync(resolved).isDirectory());
    destination = intoFolder ? path.join(resolved, path.basename(canvas.path)) : canvasPath(expandHome(target));
  } else {
    if (!ctx.interactive) throw new CliError('Use: paper move <file|id|title> <folder/ or new path>.');
    const folder = await pickFolder(path.dirname(canvas.path), 'Move here');
    if (folder === null) return;
    const name = await ui.input({ message: 'File name', initial: canvasBase(canvas.path), validate: value => value ? '' : 'Enter a name.' });
    if (name === null) return;
    destination = path.join(folder, safeFileName(name) + path.basename(canvas.path).slice(canvasBase(canvas.path).length));
  }
  const viaServer = await callServer(ctx, 'move', { id: canvas.id, destination });
  const result = viaServer ?? await moveCanvas(canvas.path, canvas.id, destination);
  await relocate(canvas.id, result.path);
  // Inside a vault the preview is refreshed there; moved into one, a note appears too.
  const added = await obsidianFiles(ctx, result.path, await readCanvas(result.path, canvas.id));
  const note = added?.note ?? result.note ?? null;
  emit(ctx, { id: canvas.id, title: canvas.title, path: result.path, note }, () =>
    ok('Moved ' + canvas.title + c.muted(' → ' + plain(prettyPath(result.path)))) + (note ? '\n' + ok('Note ' + c.muted('· ' + plain(prettyPath(note)))) : ''));
}

// Canvases named on the command line, or all of them with --all.
async function targets(ctx, positional) {
  if (ctx.flags.all) return knownCanvases();
  const canvas = await findCanvas(ctx, positional.join(' '), { allowMissing: true });
  return canvas ? [canvas] : [];
}

async function confirmed(ctx, message) {
  if (ctx.flags.yes) return true;
  if (!ctx.interactive) throw new CliError(message + ' Add --yes to confirm.');
  return ui.confirm({ message, initial: false });
}

// Deleting moves canvas, note and preview to the trash, so it can be undone there.
async function cmdDelete(ctx, positional) {
  const canvases = await targets(ctx, positional);
  if (!canvases.length) return emit(ctx, [], () => '  ' + c.muted('No canvases to delete.'));
  const what = canvases.length === 1 ? '"' + canvases[0].title + '"' : 'all ' + canvases.length + ' canvases';
  if (!(await confirmed(ctx, 'Move ' + what + ' with notes and previews to the Trash?'))) return;
  const results = [];
  for (const canvas of canvases) {
    await callServer(ctx, 'forget', { id: canvas.id });
    const trashed = canvas.missing ? [] : await deleteCanvas(canvas.path, canvas.id);
    await forget(canvas.id);
    results.push({ id: canvas.id, title: canvas.title, trashed });
  }
  emit(ctx, results, () => results.map(result => ok('Deleted ' + result.title + c.muted(result.trashed.length ? ' · ' + result.trashed.length + ' file' + (result.trashed.length === 1 ? '' : 's') + ' in the Trash' : ' · file was already gone'))).join('\n'));
}

async function cmdForget(ctx, positional) {
  const canvases = await targets(ctx, positional);
  if (ctx.flags.all && canvases.length && !(await confirmed(ctx, 'Remove all ' + canvases.length + ' canvases from the list? Files stay where they are.'))) return;
  for (const canvas of canvases) {
    await callServer(ctx, 'forget', { id: canvas.id });
    await forget(canvas.id);
  }
  emit(ctx, canvases.map(canvas => ({ forgotten: canvas.id, path: canvas.path })), () => canvases.length
    ? canvases.map(canvas => ok('Removed ' + canvas.title + ' from the list ' + c.muted('· the file is untouched'))).join('\n')
    : '  ' + c.muted('The list is already empty.'));
}

// Interactive list: pick a canvas, then act on it.
async function browse(ctx) {
  for (;;) {
    const canvases = await knownCanvases();
    if (!canvases.length) return console.log('  ' + c.muted('No canvases yet. Create one with New canvas.'));
    const missing = canvases.filter(canvas => canvas.missing);
    const choice = await ui.select({
      message: 'Canvases', quiet: true,
      choices: [
        ...canvases.map(canvas => ({ label: canvas.title, value: { canvas }, hint: canvas.missing ? 'missing' : plain(prettyPath(path.dirname(canvas.path))) + ' · ' + ago(canvas.openedAt) })),
        { separator: '' },
        ...(missing.length ? [{ label: 'Remove missing from list', value: { forgetMissing: true }, hint: String(missing.length) }] : []),
        { label: 'Delete all…', value: { deleteAll: true }, hint: 'to the Trash' },
        { label: 'Back', value: { back: true } }
      ]
    });
    if (!choice || choice.back) return;
    ui.clearScreen();
    if (choice.forgetMissing) { for (const canvas of missing) { await callServer(ctx, 'forget', { id: canvas.id }); await forget(canvas.id); } continue; }
    if (choice.deleteAll) { await cmdDelete({ ...ctx, flags: { ...ctx.flags, all: true } }, []); await ui.pause(); continue; }
    const { canvas } = choice;
    console.log(canvasCard(canvas) + '\n');
    const action = await ui.select({
      message: 'What should happen with it?', quiet: true,
      choices: [
        { label: 'Open', value: 'open', disabled: canvas.missing, hint: 'QR code for the iPad' },
        { label: 'Move or rename', value: 'move', disabled: canvas.missing },
        { label: 'Delete', value: 'delete', hint: 'canvas, note and preview to the Trash' },
        { label: 'Remove from list', value: 'forget', hint: 'keeps the file' },
        { label: 'Back', value: 'back' }
      ]
    });
    if (!action || action === 'back') { ui.clearScreen(); continue; }
    if (action === 'open') await cmdOpen(ctx, [canvas.id]);
    if (action === 'move') await cmdMove(ctx, [canvas.id]);
    if (action === 'delete') await cmdDelete(ctx, [canvas.id]);
    if (action === 'forget') await cmdForget(ctx, [canvas.id]);
    console.log();
    await ui.pause();
    ui.clearScreen();
  }
}

async function cmdDrafts(ctx) {
  await requireServer(ctx);
  const drafts = await callServer(ctx, 'drafts');
  emit(ctx, drafts, () => drafts.length ? '\n' + drafts.map(draft => '  ' + (draft.importedCanvas ? c.green('✓') : c.accent('▪')) + ' ' + draft.id + '  ' +
    c.muted(draft.importedCanvas ? 'imported · ' + draft.importedCanvas.slice(0, 8) : draft.strokes + ' strokes · ' + ago(draft.updatedAt))).join('\n') + '\n'
    : '  ' + c.muted('No browser drafts. Open the server link on a device and start writing.'));
}

async function cmdImport(ctx, positional) {
  await requireServer(ctx);
  let id = ctx.flags['from-browser'];
  const name = positional.join(' ');
  let title = ctx.flags.title;
  let file = name ? canvasPath(expandHome(name)) : null;
  if (!id || !file) {
    if (!ctx.interactive) throw new CliError('Use: paper import "<folder>/<name>" --from-browser <draft-id>.');
    if (!id) {
      const drafts = (await callServer(ctx, 'drafts')).filter(draft => !draft.importedCanvas);
      if (!drafts.length) throw new CliError('No browser drafts to import.');
      id = await ui.select({ message: 'Which draft?', choices: drafts.map(draft => ({ label: draft.id.slice(0, 12) + '…', value: draft.id, hint: draft.strokes + ' strokes · ' + ago(draft.updatedAt) })) });
      if (!id) return;
    }
    if (!file) {
      title ??= await ui.input({ message: 'Title', validate: value => value ? '' : 'Enter a title.' });
      if (!title) return;
      const folder = await pickFolder();
      if (folder === null) return;
      file = path.join(folder, safeFileName(title) + EXTENSION);
    }
  }
  const imported = await callServer(ctx, 'import', { id, file, title });
  await remember(imported);
  emit(ctx, imported, () => '\n' + canvasCard(imported, 'Draft imported') + '\n  ' + c.muted('The browser tab switches to this canvas and saves automatically.'));
}

// Creates or refreshes Obsidian previews; notes are only added where missing.
async function cmdPreview(ctx, positional) {
  const query = positional.join(' ');
  const canvases = query ? [await findCanvas(ctx, query)].filter(Boolean) : (await knownCanvases()).filter(canvas => !canvas.missing);
  const results = [], skipped = [];
  for (const canvas of canvases) {
    if (!(await obsidianVault(canvas.path))) { skipped.push({ id: canvas.id, title: canvas.title, path: canvas.path, reason: 'not inside an Obsidian vault' }); continue; }
    const files = await writeObsidianFiles(canvas.path, await readCanvas(canvas.path, canvas.id));
    results.push({ id: canvas.id, title: canvas.title, path: canvas.path, ...files });
  }
  if (query && skipped.length) throw new CliError(canvases[0].title + ' is not inside an Obsidian vault.');
  emit(ctx, results, () => {
    if (!results.length) return '  ' + c.muted('No canvases inside an Obsidian vault yet.');
    const lines = results.map(result => ok(result.title + '  ' + c.muted((result.noteCreated ? 'note created: ' : 'preview updated: ') + plain(prettyPath(result.note)))));
    if (!ctx.obsidian) lines.push('  ' + c.muted('Automatic updates are off. Turn them on with `paper config set obsidian true`.'));
    return '\n' + lines.join('\n');
  });
}

// ── Interactive home ─────────────────────────────────────────────────────────
async function home(ctx) {
  for (;;) {
    ctx = await context(ctx.flags);
    const status = await callServer(ctx, 'status').catch(() => null);
    const recent = (await knownCanvases()).filter(canvas => !canvas.missing);
    ui.clearScreen();
    console.log(ui.banner());
    console.log(statusCard(ctx, status));
    console.log();
    const choice = await ui.select({
      message: 'What would you like to do?', quiet: true,
      choices: [
        { label: 'New canvas', value: 'new', hint: 'pick a folder, scan, write' },
        { label: 'Open canvas', value: 'open', disabled: !recent.length, hint: recent.length ? 'last: ' + recent[0].title : 'none yet' },
        { label: 'All canvases', value: 'list', hint: 'open, move, delete' },
        status ? { label: 'Show connection QR', value: 'qr' } : { label: 'Start server', value: 'start', hint: 'runs in the background' },
        { label: 'Import browser draft', value: 'import', disabled: !status?.drafts, hint: status ? status.drafts + ' unsaved' : 'needs the server' },
        { separator: '' },
        { label: 'Settings', value: 'settings' },
        ...(status ? [{ label: 'Stop server', value: 'stop' }] : []),
        { label: 'Quit', value: 'quit' }
      ],
      hint: '↑↓ move · enter select · q quit'
    });
    if (!choice || choice === 'quit') { ui.clearScreen(); return; }
    console.log();
    try {
      if (choice === 'new') await cmdNew(ctx, []);
      if (choice === 'open') await cmdOpen(ctx, []);
      if (choice === 'list') { ui.clearScreen(); await browse(ctx); continue; }
      if (choice === 'start') await cmdStart(ctx);
      if (choice === 'qr') console.log(qrSection(ctx, status.links, 'Scan with your iPad to connect'));
      if (choice === 'import') await cmdImport(ctx, []);
      if (choice === 'stop') await cmdStop(ctx);
      if (choice === 'settings') { await settings(ctx, status); continue; }
    } catch (error) {
      console.log('  ' + c.danger('✗ ' + error.message));
    }
    console.log();
    await ui.pause('Press any key to return to the menu');
  }
}

async function settings(ctx, status) {
  let config = ctx.config;
  for (;;) {
    ui.clearScreen();
    console.log(ui.banner('settings'));
    const choice = await ui.select({
      message: 'Settings', quiet: true,
      choices: [
        { label: 'Obsidian notes', value: 'obsidian', hint: config.obsidian ? 'on · for canvases inside a vault' : 'off' },
        { label: 'iPad & network access', value: 'lan', hint: config.lan ? 'on' : 'off · this computer only' },
        { label: 'Port', value: 'port', hint: String(config.port) },
        { separator: '' },
        { label: 'Back', value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    let value;
    if (choice === 'obsidian') value = await ui.confirm({ message: 'Add a note and preview to canvases inside an Obsidian vault?', initial: config.obsidian });
    if (choice === 'lan') value = await ui.confirm({ message: 'Allow your iPad and other devices on this Wi-Fi to connect?', initial: config.lan });
    if (choice === 'port') {
      const answer = await ui.input({ message: 'Port', initial: String(config.port), validate: text => { try { validPort(text); return ''; } catch (error) { return error.message; } } });
      if (answer) value = validPort(answer);
    }
    if (value === null || value === undefined) continue;
    config = await saveConfig({ ...config, [choice]: value });
    if (choice === 'obsidian' && value) {
      const count = (await knownCanvases()).filter(canvas => !canvas.missing).length;
      if (count && await ui.confirm({ message: 'Add notes for existing canvases inside vaults now?', initial: true })) {
        await cmdPreview({ ...ctx, config, obsidian: true }, []);
        await ui.pause();
      }
    }
    if (status && RESTART_KEYS.includes(choice)) {
      console.log('  ' + c.muted('The running server keeps its old settings until it restarts.'));
      await ui.pause();
    }
  }
}

// ── Help ─────────────────────────────────────────────────────────────────────
function helpText() {
  const command = (name, description) => '    ' + c.accent(name.padEnd(42)) + ' ' + c.muted(description);
  return [
    ui.banner(),
    '  ' + c.bold('Usage'),
    '    paper                                       ' + c.muted('interactive menu (in a terminal)'),
    '    paper <command> [options]',
    '',
    '  ' + c.bold('Canvases') + c.muted('  · a canvas is a ' + EXTENSION + ' file, wherever you keep it'),
    command('new "<folder>/<name>" [--title TITLE]', 'create a canvas file, print its QR code'),
    command('open <file|id|title>', 'print links and QR code for a canvas'),
    command('list', 'canvases created or opened on this computer'),
    command('move <canvas> <folder/ | new path>', 'move or rename with note and preview'),
    command('delete <canvas> | --all [--yes]', 'move canvas, note and preview to the Trash'),
    command('forget <canvas> | --all', 'remove from the list, keep the file'),
    command('preview [file|id|title]', 'write Obsidian notes and previews'),
    command('drafts', 'unsaved drafts from connected tabs'),
    command('import "<folder>/<name>" --from-browser <id>', 'save a draft as a canvas'),
    '',
    '  ' + c.bold('Server'),
    command('start', 'run in the background and show the QR code'),
    command('serve', 'run in this terminal (Ctrl-C stops)'),
    command('status', 'is it running, on which port and links'),
    command('stop', 'stop the background server'),
    '',
    '  ' + c.bold('Settings'),
    command('config', 'show settings'),
    command('config set <key> <value>', 'obsidian, lan, port'),
    '',
    '  ' + c.bold('Options'),
    command('--port <n>', 'server port (default from config, 8080)'),
    command('--lan / --no-lan', 'allow devices on your network'),
    command('--obsidian / --no-obsidian', 'Obsidian notes for this command or server'),
    command('--yes', 'confirm deleting without a prompt'),
    command('--json', 'machine-readable output'),
    command('--qr / --no-qr', 'force or hide QR codes'),
    command('--no-start', 'never offer to start the server'),
    '',
    '  ' + c.bold('Scripts and AI agents'),
    '    ' + c.muted('Outside a terminal every command prints JSON and never prompts. Errors go to'),
    '    ' + c.muted('stderr as {"error": "..."} with exit code 1. Relative paths are resolved from'),
    '    ' + c.muted('the current folder. Settings: flags, then PAPERLINK_PORT, then ' + prettyPath(configPath()) + '.'),
    ''
  ].join('\n');
}

// ── Entry ────────────────────────────────────────────────────────────────────
export async function main(argv) {
  let ctx = { json: !process.stdout.isTTY, flags: {} };
  try {
    const { flags, positional } = parseArguments(argv);
    ctx = await context(flags);
    if (flags.version) return console.log(ctx.json ? JSON.stringify({ version: VERSION }) : 'paperlink ' + VERSION);
    let [command, ...rest] = positional;
    if (command === 'canvas') [command, ...rest] = rest;
    if (flags.help || command === 'help') return console.log(helpText());
    switch (command) {
      case undefined: return ctx.interactive ? await home(ctx) : console.log(helpText());
      case 'config': return await cmdConfig(ctx, rest);
      case 'serve': return await cmdServe(ctx);
      case 'start': return await cmdStart(ctx);
      case 'stop': return await cmdStop(ctx);
      case 'status': return await cmdStatus(ctx);
      case 'new': case 'create': return await cmdNew(ctx, rest);
      case 'list': return await cmdList(ctx);
      case 'open': return await cmdOpen(ctx, rest);
      case 'move': case 'mv': return await cmdMove(ctx, rest);
      case 'delete': case 'rm': return await cmdDelete(ctx, rest);
      case 'forget': return await cmdForget(ctx, rest);
      case 'preview': return await cmdPreview(ctx, rest);
      case 'drafts': return await cmdDrafts(ctx);
      case 'import': return await cmdImport(ctx, rest);
      case 'init': throw new CliError('Libraries are gone: a canvas is a ' + EXTENSION + ' file wherever you create it. Try `paper new "<folder>/<name>"`.');
      default: throw new CliError('Unknown command ' + command + '. See `paper help`.');
    }
  } catch (error) {
    if (ctx.json) process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    else console.error('  ' + c.danger('✗ ' + error.message));
    process.exitCode = 1;
  }
}
