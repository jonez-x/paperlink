// Paperlink CLI. Every action works two ways:
//   humans: `paper` opens a keyboard-driven menu; commands ask for missing input.
//   scripts and AI agents: commands with flags, JSON on stdout when not in a
//   terminal (or with --json), errors as JSON on stderr and a non-zero exit code.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './server.js';
import { createCanvas, listCanvases, listFolders } from './documents.js';
import { configPath, expandHome, loadConfig, saveConfig, stateDirectory, validPort } from './config.js';
import { renderQr } from './qr.js';
import { readCanvas } from './store.js';
import { writeObsidianFiles } from './preview.js';
import * as ui from './tui.js';

const { c } = ui;
const BIN = fileURLToPath(new URL('../bin/paper.js', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

class CliError extends Error {}

// ── Arguments ────────────────────────────────────────────────────────────────
const BOOLEAN_FLAGS = new Set(['lan', 'no-lan', 'json', 'qr', 'no-qr', 'obsidian', 'no-obsidian', 'help', 'version', 'no-start']);
const VALUE_FLAGS = new Set(['port', 'library', 'vault', 'path', 'from-browser', 'title', 'default-path']);

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
    if (!VALUE_FLAGS.has(name)) throw new CliError('Unknown option --' + name + '. See `paper help`.');
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new CliError('Missing value for --' + name + '.');
    flags[name] = value;
  }
  return { flags, positional };
}

async function context(flags) {
  const config = await loadConfig();
  const libraryInput = flags.library ?? flags.vault ?? process.env.PAPERLINK_LIBRARY ?? config.library;
  return {
    flags, config,
    libraryInput: libraryInput ? expandHome(libraryInput) : null,
    port: validPort(flags.port ?? process.env.PAPERLINK_PORT ?? config.port),
    lan: flags.lan ? true : flags['no-lan'] ? false : config.lan,
    obsidian: flags.obsidian ? true : flags['no-obsidian'] ? false : config.obsidian,
    json: Boolean(flags.json) || !process.stdout.isTTY,
    interactive: !flags.json && ui.isInteractive()
  };
}

async function requireLibrary(ctx) {
  if (!ctx.libraryInput) throw new CliError('No library configured. Run `paper init <folder>` or pass --library <folder>.');
  try {
    const library = await realpath(ctx.libraryInput);
    if (!(await stat(library)).isDirectory()) throw new Error();
    return library;
  } catch {
    throw new CliError('Library folder not found: ' + ctx.libraryInput);
  }
}

// ── Output ───────────────────────────────────────────────────────────────────
function emit(ctx, data, pretty) {
  if (ctx.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else console.log(pretty());
}

function prettyPath(absolute) {
  if (!absolute) return c.muted('not set');
  const obsidian = path.join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents');
  if (absolute.startsWith(obsidian + path.sep)) return 'iCloud › Obsidian › ' + absolute.slice(obsidian.length + 1).split(path.sep).join(' › ');
  const icloud = path.join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs');
  if (absolute.startsWith(icloud + path.sep)) return 'iCloud Drive › ' + absolute.slice(icloud.length + 1).split(path.sep).join(' › ');
  return absolute.startsWith(homedir() + path.sep) ? '~/' + absolute.slice(homedir().length + 1) : absolute;
}
const tilde = absolute => absolute.startsWith(homedir() + path.sep) ? '~/' + absolute.slice(homedir().length + 1) : absolute;
const prettyFolder = folder => !folder || folder === '.' ? c.muted('(library root)') : folder.split(path.sep).join(' › ');

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
async function callServer(ctx, library, command, payload = {}) {
  let response;
  try {
    response = await fetch('http://127.0.0.1:' + ctx.port + '/cli/' + command, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library, ...payload }), signal: AbortSignal.timeout(5000)
    });
  } catch { return null; }
  const result = await response.json().catch(() => ({ error: 'Port ' + ctx.port + ' is used by another program.' }));
  if (!response.ok) throw new CliError(result.error);
  return result;
}

async function requireServer(ctx, library) {
  const status = await callServer(ctx, library, 'status');
  if (status) return status;
  if (ctx.interactive && !ctx.flags['no-start']) {
    const start = await ui.confirm({ message: 'Paperlink is not running. Start it now?' });
    if (start) return startBackground(ctx, library);
  }
  throw new CliError('Paperlink is not running. Start it with `paper start`.');
}

async function startBackground(ctx, library) {
  const existing = await callServer(ctx, library, 'status');
  if (existing) return existing;
  await mkdir(stateDirectory(), { recursive: true });
  const logFile = path.join(stateDirectory(), 'server.log');
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [BIN, 'serve', '--library', library, '--port', String(ctx.port), ctx.lan ? '--lan' : '--no-lan', ctx.obsidian ? '--obsidian' : '--no-obsidian', '--no-qr'], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, PAPERLINK_BACKGROUND: '1' }
  });
  closeSync(log);
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.unref();
  for (let waited = 0; waited < 8000 && !exited; waited += 150) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const status = await callServer(ctx, library, 'status');
    if (status) return status;
  }
  const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' ');
  throw new CliError('The server did not start. ' + (tail || 'See ' + logFile));
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

async function pickFolder(library, start = '.') {
  let current = path.normalize(start || '.');
  for (;;) {
    const subfolders = await listFolders(library, current);
    const choices = [
      { label: '✓ Save here', value: { save: true }, hint: current === '.' ? 'library root' : current },
      { label: '+ New folder…', value: { create: true } },
      ...(current !== '.' ? [{ label: '↩ Up one level', value: { up: true } }] : []),
      ...(subfolders.length ? [{ separator: 'Folders' }] : []),
      ...subfolders.map(name => ({ label: '▸ ' + name, value: { enter: name } }))
    ];
    const choice = await ui.select({ message: 'Folder  ' + c.muted(current === '.' ? '/' : '/' + current.split(path.sep).join('/')), choices, quiet: true });
    if (!choice) return null;
    if (choice.save) { console.log(ok('Folder ' + c.muted('· ' + prettyFolder(current)))); return current; }
    if (choice.up) current = path.dirname(current);
    if (choice.enter) current = path.join(current, choice.enter);
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
    c.muted('Folder  ') + prettyFolder(canvas.folder),
    c.muted('ID      ') + canvas.id
  ], { title });
}

// ── Commands ─────────────────────────────────────────────────────────────────
async function cmdInit(ctx, positional) {
  const target = positional[0] ?? ctx.flags.library ?? ctx.flags.vault;
  if (!target) {
    if (ctx.interactive) return setupWizard(ctx);
    throw new CliError('Specify a library folder: paper init <folder> [--default-path FOLDER] [--obsidian] [--lan].');
  }
  let library;
  try { library = await realpath(expandHome(target)); } catch { throw new CliError('Folder not found: ' + target); }
  const config = await saveConfig({
    ...ctx.config, library,
    defaultPath: ctx.flags['default-path'] ?? ctx.config.defaultPath,
    obsidian: ctx.flags.obsidian ? true : ctx.flags['no-obsidian'] ? false : ctx.config.obsidian,
    lan: ctx.flags.lan ? true : ctx.flags['no-lan'] ? false : ctx.config.lan,
    port: ctx.flags.port ? validPort(ctx.flags.port) : ctx.config.port
  });
  emit(ctx, { config, configPath: configPath() }, () => ok('Library set to ' + prettyPath(library)));
}

async function setupWizard(ctx) {
  ui.clearScreen();
  console.log(ui.banner());
  console.log(ui.card([
    'Paperlink keeps every canvas as a file in a folder you choose,',
    'your "library". Any folder works; an Obsidian vault is one option.'
  ], { title: 'Setup' }) + '\n');
  let library;
  for (;;) {
    const answer = await ui.input({
      message: 'Library folder', initial: ctx.config.library ? tilde(ctx.config.library) : '~/Documents/Paperlink',
      complete: completeDirectory, validate: value => value ? '' : 'Enter a folder.'
    });
    if (answer === null) return;
    const expanded = path.resolve(expandHome(answer));
    try {
      if ((await stat(expanded)).isDirectory()) { library = await realpath(expanded); break; }
      console.log('  ' + c.danger('✗ That is a file, not a folder.'));
    } catch {
      if (await ui.confirm({ message: 'Create ' + prettyPath(expanded) + '?' })) {
        await mkdir(expanded, { recursive: true });
        library = await realpath(expanded);
        break;
      }
    }
  }
  const looksLikeObsidian = (() => { try { return statSync(path.join(library, '.obsidian')).isDirectory(); } catch { return false; } })();
  const obsidian = await ui.confirm({
    message: looksLikeObsidian ? 'This is an Obsidian vault. Add Markdown previews for Obsidian?' : 'Add Markdown previews for Obsidian?',
    initial: looksLikeObsidian
  });
  if (obsidian === null) return;
  console.log('  ' + c.muted('Choose where new canvases go by default.'));
  const defaultPath = await pickFolder(library, ctx.config.library === library ? ctx.config.defaultPath : '.');
  if (defaultPath === null) return;
  const lan = await ui.confirm({ message: 'Allow your iPad and other devices on this Wi-Fi to connect?', initial: true });
  if (lan === null) return;
  await saveConfig({ ...ctx.config, library, defaultPath, obsidian, lan });
  console.log('\n' + ui.card([
    c.muted('Library   ') + prettyPath(library),
    c.muted('Saves to  ') + prettyFolder(defaultPath),
    c.muted('Obsidian  ') + (obsidian ? 'previews on' : 'off'),
    c.muted('Network   ') + (lan ? 'iPad can connect' : 'this computer only')
  ], { title: 'All set', tone: c.green }));
  console.log('  ' + c.muted('Saved to ' + configPath()) + '\n');
}

const RESTART_KEYS = ['lan', 'port', 'library', 'obsidian'];

async function cmdConfig(ctx, positional) {
  const [action, key, ...rest] = positional;
  if (!action || action === 'show') {
    return emit(ctx, { ...ctx.config, configPath: configPath() }, () => ui.card([
      c.muted('library      ') + prettyPath(ctx.config.library),
      c.muted('defaultPath  ') + prettyFolder(ctx.config.defaultPath),
      c.muted('obsidian     ') + ctx.config.obsidian,
      c.muted('lan          ') + ctx.config.lan,
      c.muted('port         ') + ctx.config.port,
      '', c.muted(configPath())
    ], { title: 'Config' }));
  }
  if (action !== 'set' || !key || !rest.length) throw new CliError('Use `paper config`, or `paper config set <library|defaultPath|obsidian|lan|port> <value>`.');
  const value = rest.join(' ');
  const parseBoolean = text => { if (/^(true|on|yes|1)$/i.test(text)) return true; if (/^(false|off|no|0)$/i.test(text)) return false; throw new CliError(key + ' must be true or false.'); };
  const update = {
    library: async () => { try { return await realpath(expandHome(value)); } catch { throw new CliError('Folder not found: ' + value); } },
    defaultPath: async () => { if (path.isAbsolute(value) || path.normalize(value).startsWith('..')) throw new CliError('defaultPath is relative to the library.'); return path.normalize(value); },
    obsidian: async () => parseBoolean(value),
    lan: async () => parseBoolean(value),
    port: async () => validPort(value)
  }[key];
  if (!update) throw new CliError('Unknown setting ' + key + '. Use library, defaultPath, obsidian, lan or port.');
  const config = await saveConfig({ ...ctx.config, [key]: await update() });
  emit(ctx, { ...config, configPath: configPath() }, () => ok(key + ' = ' + config[key] + (RESTART_KEYS.includes(key) ? c.muted('  · restart the server to apply') : '')) +
    (key === 'obsidian' && config.obsidian ? '\n  ' + c.muted('Run `paper preview` to add notes for existing canvases.') : ''));
}

async function cmdServe(ctx) {
  const library = ctx.libraryInput ? await requireLibrary(ctx) : null;
  const server = await serve({ port: ctx.port, lan: ctx.lan, obsidian: ctx.obsidian, library });
  if (!process.stdout.isTTY || process.env.PAPERLINK_BACKGROUND) {
    console.log('Paperlink → ' + server.links[0]);
    for (const link of server.links.slice(1)) console.log('Device link → ' + link);
    return;
  }
  console.log(ui.banner());
  console.log(ui.card([
    c.green('●') + ' running on port ' + ctx.port,
    c.muted('Library   ') + prettyPath(library),
    c.muted('Network   ') + (ctx.lan ? 'iPad can connect' : 'this computer only'),
    c.muted('Obsidian  ') + (ctx.obsidian ? 'previews on' : 'off')
  ], { title: 'Server' }));
  console.log(qrSection(ctx, server.links, 'Scan with your iPad to connect'));
  console.log('\n  ' + c.muted('Keep this window open · Ctrl-C stops the server · `paper start` runs it in the background') + '\n');
}

async function cmdStart(ctx) {
  const library = await requireLibrary(ctx);
  const status = await startBackground(ctx, library);
  jsonQr(ctx, status.links);
  emit(ctx, status, () => ok('Paperlink is running in the background ' + c.muted('· port ' + status.port + ' · pid ' + status.pid)) + '\n' + qrSection(ctx, status.links, 'Scan with your iPad to connect'));
}

async function cmdStop(ctx) {
  const library = await requireLibrary(ctx);
  const result = await callServer(ctx, library, 'stop', { anyLibrary: true });
  emit(ctx, { running: false, stopped: Boolean(result) }, () => result ? ok('Server stopped') : '  ' + c.muted('Paperlink was not running.'));
}

async function cmdStatus(ctx) {
  const library = await requireLibrary(ctx);
  const status = await callServer(ctx, library, 'status', { anyLibrary: true });
  const otherLibrary = status && status.library !== library ? status.library : null;
  emit(ctx, status ? { ...status, configuredLibrary: library } : { running: false, library, port: ctx.port }, () => statusCard(ctx, library, status) +
    (otherLibrary ? '\n  ' + c.danger('! ') + c.muted('The server still uses ' + prettyPath(otherLibrary) + '. Restart it with `paper stop` and `paper start`.') : ''));
}

function statusCard(ctx, library, status) {
  return ui.card([
    c.muted('Library   ') + prettyPath(library),
    c.muted('Saves to  ') + prettyFolder(ctx.config.defaultPath),
    ...(ctx.obsidian ? [c.muted('Obsidian  ') + 'previews on'] : []),
    c.muted('Server    ') + (status ? c.green('● running') + c.muted(' · port ' + status.port + (status.lan ? ' · iPad can connect' : ' · this computer only')) : c.muted('○ stopped'))
  ]);
}

async function cmdNew(ctx, positional) {
  const library = await requireLibrary(ctx);
  let title = positional.join(' ') || ctx.flags.title;
  let folder = ctx.flags.path ?? ctx.config.defaultPath;
  if (!title) {
    if (!ctx.interactive) throw new CliError('Specify a title: paper canvas new "<title>" [--path FOLDER].');
    title = await ui.input({ message: 'Title', placeholder: 'e.g. Analysis sheet 3', validate: value => value ? (value.length > 200 ? 'At most 200 characters.' : '') : 'Enter a title.' });
    if (title === null) return;
    if (!ctx.flags.path) { folder = await pickFolder(library, folder); if (folder === null) return; }
  }
  const canvas = await createCanvas(library, folder, title);
  const obsidian = ctx.obsidian ? await writeObsidianFiles(path.dirname(canvas.path), canvas) : null;
  // The canvas exists now; a missing or foreign server only means no link yet.
  const status = await (ctx.interactive ? requireServer(ctx, library) : callServer(ctx, library, 'status')).catch(() => null);
  const opened = status ? await callServer(ctx, library, 'open', { id: canvas.id }).catch(() => null) : null;
  jsonQr(ctx, opened?.links);
  emit(ctx, { id: canvas.id, title: canvas.title, folder: canvas.folder, path: canvas.path, note: obsidian?.note ?? null, links: opened?.links ?? [] }, () =>
    '\n' + canvasCard(canvas, 'Canvas created') + (obsidian ? '\n' + ok('Obsidian note ' + c.muted('· ' + path.basename(obsidian.note))) : '') + (opened ? qrSection(ctx, opened.links, 'Scan to start writing · saves automatically')
      : '\n  ' + c.muted('Start the server with `paper start` to get a QR code for this canvas.')));
}

async function findCanvas(ctx, library, query) {
  const canvases = await listCanvases(library, '.', { recursive: true });
  if (!query) {
    if (!ctx.interactive) throw new CliError('Specify a canvas ID or title: paper canvas open <id|title>.');
    if (!canvases.length) throw new CliError('No canvases yet. Create one with `paper canvas new`.');
    const recent = [...canvases].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return ui.select({
      message: 'Which canvas?',
      choices: recent.map(canvas => ({ label: canvas.title, value: canvas, hint: prettyFolder(canvas.folder).replace(/\x1b\[[0-9;]*m/g, '') + ' · ' + ago(canvas.updatedAt) }))
    });
  }
  const exact = canvases.find(canvas => canvas.id === query);
  if (exact) return exact;
  const lower = query.toLowerCase();
  const groups = [
    query.length >= 4 ? canvases.filter(canvas => canvas.id.startsWith(lower)) : [],
    canvases.filter(canvas => canvas.title.toLowerCase() === lower),
    canvases.filter(canvas => canvas.title.toLowerCase().includes(lower))
  ];
  for (const group of groups) if (group.length === 1) return group[0];
  const candidates = [...new Set(groups.flat())];
  if (!candidates.length) throw new CliError('No canvas matches "' + query + '". See `paper canvas list`.');
  if (ctx.interactive) return ui.select({ message: 'Several canvases match. Which one?', choices: candidates.map(canvas => ({ label: canvas.title, value: canvas, hint: canvas.folder + ' · ' + canvas.id.slice(0, 8) })) });
  throw new CliError('"' + query + '" matches several canvases: ' + candidates.map(canvas => canvas.id + ' (' + canvas.title + ')').join(', '));
}

async function cmdOpen(ctx, positional) {
  const library = await requireLibrary(ctx);
  const canvas = await findCanvas(ctx, library, positional.join(' '));
  if (!canvas) return;
  await requireServer(ctx, library);
  const opened = await callServer(ctx, library, 'open', { id: canvas.id });
  jsonQr(ctx, opened.links);
  emit(ctx, { ...opened, folder: canvas.folder, path: canvas.path }, () => '\n' + canvasCard(canvas) + qrSection(ctx, opened.links, 'Scan to open on your iPad'));
}

async function cmdList(ctx) {
  const library = await requireLibrary(ctx);
  const skipped = [];
  const canvases = await listCanvases(library, ctx.flags.path ?? '.', { recursive: true, onSkip: entry => skipped.push(entry) });
  for (const entry of skipped) process.stderr.write((ctx.json ? 'Skipped ' : '  ' + c.danger('! ') + c.muted('Skipped ')) + entry.path + ': ' + entry.reason + '\n');
  emit(ctx, canvases, () => {
    if (!canvases.length) return '  ' + c.muted('No canvases yet. Create one with `paper canvas new`.');
    const lines = [];
    let folder;
    for (const canvas of canvases) {
      if (canvas.folder !== folder) { folder = canvas.folder; lines.push((lines.length ? '\n' : '') + '  ' + c.accent('▪') + ' ' + c.bold(prettyFolder(folder))); }
      lines.push('    ' + canvas.title + '  ' + c.muted(canvas.id.slice(0, 8) + ' · rev ' + canvas.revision + ' · ' + ago(canvas.updatedAt)));
    }
    return '\n' + lines.join('\n') + '\n';
  });
}

async function cmdDrafts(ctx) {
  const library = await requireLibrary(ctx);
  await requireServer(ctx, library);
  const drafts = await callServer(ctx, library, 'drafts');
  emit(ctx, drafts, () => drafts.length ? '\n' + drafts.map(draft => '  ' + (draft.importedCanvas ? c.green('✓') : c.accent('▪')) + ' ' + draft.id + '  ' +
    c.muted(draft.importedCanvas ? 'imported · ' + draft.importedCanvas.slice(0, 8) : draft.strokes + ' strokes · ' + ago(draft.updatedAt))).join('\n') + '\n'
    : '  ' + c.muted('No browser drafts. Open the server link on a device and start writing.'));
}

async function cmdImport(ctx, positional) {
  const library = await requireLibrary(ctx);
  await requireServer(ctx, library);
  let id = ctx.flags['from-browser'];
  let title = positional.join(' ') || ctx.flags.title;
  let folder = ctx.flags.path ?? ctx.config.defaultPath;
  if (!id || !title) {
    if (!ctx.interactive) throw new CliError('Use: paper canvas import "<title>" --from-browser <draft-id> [--path FOLDER].');
    if (!id) {
      const drafts = (await callServer(ctx, library, 'drafts')).filter(draft => !draft.importedCanvas);
      if (!drafts.length) throw new CliError('No browser drafts to import.');
      id = await ui.select({ message: 'Which draft?', choices: drafts.map(draft => ({ label: draft.id.slice(0, 12) + '…', value: draft.id, hint: draft.strokes + ' strokes · ' + ago(draft.updatedAt) })) });
      if (!id) return;
    }
    if (!title) { title = await ui.input({ message: 'Title', validate: value => value ? '' : 'Enter a title.' }); if (!title) return; }
    if (!ctx.flags.path) { folder = await pickFolder(library, folder); if (folder === null) return; }
  }
  const imported = await callServer(ctx, library, 'import', { id, title, path: folder });
  emit(ctx, imported, () => '\n' + canvasCard(imported, 'Draft imported') + '\n  ' + c.muted('The browser tab switches to this canvas and saves automatically.'));
}

// Creates or refreshes Obsidian previews; notes are only added where missing.
async function cmdPreview(ctx, positional) {
  const library = await requireLibrary(ctx);
  const query = positional.join(' ');
  const canvases = query ? [await findCanvas(ctx, library, query)].filter(Boolean) : await listCanvases(library, ctx.flags.path ?? '.', { recursive: true });
  const results = [];
  for (const canvas of canvases) {
    const directory = path.dirname(canvas.path);
    const files = await writeObsidianFiles(directory, await readCanvas(directory, canvas.id));
    results.push({ id: canvas.id, title: canvas.title, folder: canvas.folder, ...files });
  }
  emit(ctx, results, () => {
    if (!results.length) return '  ' + c.muted('No canvases yet. Create one with `paper canvas new`.');
    const lines = results.map(result => ok(result.title + '  ' + c.muted(prettyFolder(result.folder).replace(/\x1b\[[0-9;]*m/g, '') + ' · ' +
      (result.noteCreated ? 'note created: ' : 'preview updated: ') + path.basename(result.note))));
    if (!ctx.obsidian) lines.push('  ' + c.muted('Automatic updates are off. Turn them on with `paper config set obsidian true`.'));
    return '\n' + lines.join('\n');
  });
}

// ── Interactive home ─────────────────────────────────────────────────────────
async function home(ctx) {
  if (!ctx.libraryInput) {
    await setupWizard(ctx);
    ctx = await context(ctx.flags);
    if (!ctx.libraryInput) return;
    await ui.pause('Press any key to open Paperlink');
  }
  for (;;) {
    ctx = await context(ctx.flags);
    const library = await requireLibrary(ctx);
    let status = null, problem = '';
    try { status = await callServer(ctx, library, 'status'); } catch (error) { problem = error.message; }
    ui.clearScreen();
    console.log(ui.banner());
    console.log(statusCard(ctx, library, status));
    if (problem) console.log('  ' + c.danger('! ') + c.muted(problem));
    console.log();
    const choice = await ui.select({
      message: 'What would you like to do?', quiet: true,
      choices: [
        { label: 'New canvas', value: 'new', hint: 'create it, scan, write' },
        { label: 'Open canvas', value: 'open', hint: 'QR code for an existing canvas' },
        { label: 'Browse canvases', value: 'list' },
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
      if (choice === 'list') await cmdList(ctx);
      if (choice === 'start') await cmdStart(ctx);
      if (choice === 'qr') console.log(qrSection(ctx, status.links, 'Scan with your iPad to connect'));
      if (choice === 'import') await cmdImport(ctx, []);
      if (choice === 'stop') await cmdStop(ctx);
      if (choice === 'settings') { await settings(ctx, library, status); continue; }
    } catch (error) {
      console.log('  ' + c.danger('✗ ' + error.message));
    }
    console.log();
    await ui.pause('Press any key to return to the menu');
  }
}

async function settings(ctx, library, status) {
  let config = ctx.config;
  for (;;) {
    ui.clearScreen();
    console.log(ui.banner('settings'));
    const choice = await ui.select({
      message: 'Settings', quiet: true,
      choices: [
        { label: 'Library', value: 'library', hint: prettyPath(config.library) },
        { label: 'Default folder', value: 'defaultPath', hint: (config.defaultPath || '.').split(path.sep).join(' › ') },
        { label: 'Obsidian previews', value: 'obsidian', hint: config.obsidian ? 'on' : 'off' },
        { label: 'iPad & network access', value: 'lan', hint: config.lan ? 'on' : 'off · this computer only' },
        { label: 'Port', value: 'port', hint: String(config.port) },
        { separator: '' },
        { label: 'Run setup again', value: 'wizard' },
        { label: 'Back', value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'wizard') { await setupWizard({ ...ctx, config }); config = await loadConfig(); continue; }
    let value;
    if (choice === 'library') {
      const answer = await ui.input({ message: 'Library folder', initial: config.library ? tilde(config.library) : '', complete: completeDirectory });
      if (answer) { try { value = await realpath(expandHome(answer)); } catch { console.log('  ' + c.danger('✗ Folder not found.')); await ui.pause(); continue; } }
    }
    if (choice === 'defaultPath') value = await pickFolder(library, config.defaultPath);
    if (choice === 'obsidian') value = await ui.confirm({ message: 'Add Markdown previews for Obsidian?', initial: config.obsidian });
    if (choice === 'lan') value = await ui.confirm({ message: 'Allow your iPad and other devices on this Wi-Fi to connect?', initial: config.lan });
    if (choice === 'port') {
      const answer = await ui.input({ message: 'Port', initial: String(config.port), validate: text => { try { validPort(text); return ''; } catch (error) { return error.message; } } });
      if (answer) value = validPort(answer);
    }
    if (value === null || value === undefined) continue;
    config = await saveConfig({ ...config, [choice]: value });
    if (choice === 'obsidian' && value) {
      const count = (await listCanvases(config.library, '.', { recursive: true })).length;
      if (count && await ui.confirm({ message: 'Add Obsidian notes for your ' + count + ' existing canvas' + (count === 1 ? '' : 'es') + ' now?', initial: true })) {
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
    '  ' + c.bold('Setup'),
    command('init [folder]', 'choose the library folder (wizard without folder)'),
    command('config', 'show settings'),
    command('config set <key> <value>', 'library, defaultPath, obsidian, lan, port'),
    '',
    '  ' + c.bold('Server'),
    command('start', 'run in the background and show the QR code'),
    command('serve', 'run in this terminal (Ctrl-C stops)'),
    command('status', 'is it running, on which port and links'),
    command('stop', 'stop the background server'),
    '',
    '  ' + c.bold('Canvases'),
    command('canvas new "<title>" [--path FOLDER]', 'create a canvas, print its QR code'),
    command('canvas list [--path FOLDER]', 'list canvases in the library'),
    command('canvas open <id|title>', 'print links and QR code for a canvas'),
    command('canvas drafts', 'unsaved drafts from connected tabs'),
    command('canvas import "<title>" --from-browser <id>', 'save a draft as a canvas'),
    command('preview [id|title] [--path FOLDER]', 'write Obsidian previews and missing notes'),
    '    ' + c.muted('Shortcuts: paper new, paper list, paper open, paper preview'),
    '',
    '  ' + c.bold('Options'),
    command('--library <folder>', 'use another library (alias --vault)'),
    command('--path <folder>', 'folder inside the library'),
    command('--port <n>', 'server port (default from config, 8080)'),
    command('--lan / --no-lan', 'allow devices on your network'),
    command('--obsidian / --no-obsidian', 'Obsidian previews for this command or server'),
    command('--json', 'machine-readable output'),
    command('--qr / --no-qr', 'force or hide QR codes'),
    command('--no-start', 'never offer to start the server'),
    '',
    '  ' + c.bold('Scripts and AI agents'),
    '    ' + c.muted('Outside a terminal every command prints JSON and never prompts. Errors go to'),
    '    ' + c.muted('stderr as {"error": "..."} with exit code 1. Settings come from flags, then'),
    '    ' + c.muted('PAPERLINK_LIBRARY / PAPERLINK_PORT, then ' + prettyPath(configPath()) + '.'),
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
    if (command === 'canvas') [command, ...rest] = rest.length ? ['canvas:' + rest[0], ...rest.slice(1)] : ['canvas:'];
    else if (['new', 'list', 'open', 'drafts', 'import', 'preview'].includes(command)) command = 'canvas:' + command;
    if (flags.help || command === 'help') return console.log(helpText());
    switch (command) {
      case undefined: return ctx.interactive ? await home(ctx) : console.log(helpText());
      case 'init': return await cmdInit(ctx, rest);
      case 'config': return await cmdConfig(ctx, rest);
      case 'serve': return await cmdServe(ctx);
      case 'start': return await cmdStart(ctx);
      case 'stop': return await cmdStop(ctx);
      case 'status': return await cmdStatus(ctx);
      case 'canvas:new': case 'canvas:create': return await cmdNew(ctx, rest);
      case 'canvas:list': return await cmdList(ctx);
      case 'canvas:open': return await cmdOpen(ctx, rest);
      case 'canvas:drafts': return await cmdDrafts(ctx);
      case 'canvas:import': return await cmdImport(ctx, rest);
      case 'canvas:preview': return await cmdPreview(ctx, rest);
      default: throw new CliError('Unknown command ' + (command.replace('canvas:', 'canvas ') || 'canvas') + '. See `paper help`.');
    }
  } catch (error) {
    if (ctx.json) process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    else console.error('  ' + c.danger('✗ ' + error.message));
    process.exitCode = 1;
  }
}
