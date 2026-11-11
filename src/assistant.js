import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDirectory } from './config.js';

// "Request feedback" from a page runs a locally configured assistant. The
// browser only supplies page, region and question; the command is fixed in
// the config on this computer and runs without a shell. The assistant answers
// through the CLI (snapshot to look, annotate to reply), so its notes arrive
// like any other edit.

const BIN = fileURLToPath(new URL('../bin/paper.js', import.meta.url));

// Presets for assistants Paperlink knows, or a custom argument list containing "{prompt}".
// For both presets Paperlink renders the snapshot first and attaches or names it.
// claude: may only read that snapshot and run `paper annotate` for this canvas and page.
// codex:  read-only sandbox without network, without the user's Codex config,
//         web search, apps, plugins, browser and computer use; it answers with
//         JSON and Paperlink adds the notes.
export const PRESETS = { claude: { name: 'Claude Code', author: 'Claude' }, codex: { name: 'Codex', author: 'Codex' } };

// Codex features that reach beyond the sandbox (checked with codex-cli 0.157).
const CODEX_DISABLED = ['apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'hooks'];

export function validAssistant(setting) {
  return setting === null || isPreset(setting) ||
    (Array.isArray(setting) && setting.length > 0 && setting.every(part => typeof part === 'string') && setting.includes('{prompt}'));
}

export const isPreset = setting => typeof setting === 'string' && Object.hasOwn(PRESETS, setting);
export const assistantName = setting => isPreset(setting) ? PRESETS[setting].name : setting ? 'custom command' : 'off';

export function assistantCommand(setting, prompt, files = {}, request) {
  if (setting === 'claude') {
    // Reading the snapshot and adding notes to this page; no other tools, no MCP servers.
    const annotate = `Bash(paper annotate ${request.document.id} --page ${request.page} --at *)`;
    // "//" makes the Read rule an absolute path; it also runs in the folder of the snapshot.
    const snapshot = files.snapshot.split(path.sep).join('/');
    return ['claude', ['-p', prompt, '--tools', 'Read,Bash', '--allowedTools', `Read(/${snapshot.startsWith('/') ? '' : '/'}${snapshot})`, annotate,
      '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']];
  }
  if (setting === 'codex') {
    // --image takes several files, so it comes last, after the prompt.
    const disabled = CODEX_DISABLED.flatMap(feature => ['--disable', feature]);
    return ['codex', ['exec', prompt, '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '-c', 'web_search="disabled"', ...disabled,
      '--output-schema', files.schema, '--output-last-message', files.answer, '--image', files.snapshot]];
  }
  const [command, ...args] = setting.map(part => part === '{prompt}' ? prompt : part);
  return [command, args];
}

const describeArea = (page, region) => region
  ? `the region x=${Math.round(region.x)}, y=${Math.round(region.y)}, width=${Math.round(region.width)}, height=${Math.round(region.height)} of page ${page}`
  : `page ${page}`;
const regionList = region => [region.x, region.y, region.width, region.height].map(Math.round).join(',');

function introduction({ document, page, region, question }) {
  return [
    `You give feedback on handwritten work in Paperlink, a notebook the user writes in with an Apple Pencil.`,
    `Canvas "${document.title}" (ID ${document.id}) is at revision ${document.revision}. The user selected ${describeArea(page, region)}.`,
    `Coordinates are page units: pages are 900 wide, origin at the page's top left.`,
    question ? `Their question, quoted: """${question}"""` : `They asked no question: check the selected work and point out mistakes or the next step.`
  ];
}
const style = `Use one to three short notes, a few sentences each, in the language of the handwriting or question.`;

// For assistants that run `paper annotate` themselves. With a snapshot the
// image is already rendered; custom commands render it themselves.
export function feedbackPrompt(request, author = 'Assistant', snapshot) {
  const { document, page, region } = request;
  const look = snapshot
    ? `1. Look at the selection: read the PNG at ${snapshot}. ${imageFrame(request, 'PNG')} Notes use page units, not image pixels.`
    : `1. Look at the selection: run \`paper snapshot ${document.id} --page ${page}${region ? ' --region ' + regionList(region) : ''} --output ${path.join(stateDirectory(), 'snapshots', document.id.slice(0, 8) + '-feedback.png')}\` and read the PNG it writes.`;
  return [
    ...introduction(request),
    ``,
    look,
    ...(snapshot ? [] : [`2. Optionally run \`paper inspect ${document.id} --json\` for page sizes and existing notes.`]),
    `${snapshot ? 2 : 3}. Answer only by adding notes on the assistant layer, placed next to the part they refer to (inside or just right of the selection):`,
    `   paper annotate ${document.id} --page ${page} --at X,Y --width 320 --revision ${document.revision} --author ${author} --text "…"`,
    `   ${style} Use \\n for line breaks.`,
    `Do not change anything else and do not print a long answer; the user only sees the notes.`
  ].join('\n');
}

// For assistants that get the snapshot attached and answer with JSON.
export function answerPrompt(request) {
  const { document, page, region } = request;
  return [
    ...introduction(request),
    imageFrame(request, 'attached'),
    ``,
    `Answer only with JSON matching the given schema: {"notes": [{"x": …, "y": …, "text": "…"}]}.`,
    `Each note is placed at page point x, y (its top left corner, about 320 units wide), next to the part it refers to, inside or just right of the selection.`,
    `x and y are page units as above, not image pixels: convert from the image by its scale.`,
    `${style} You cannot run commands or change files, and you need not: everything is in the image.`
  ].join('\n');
}

// Where the snapshot lies on the page, so notes land in page units, not pixels.
function imageFrame({ document, page, region }, which) {
  const pageSize = document.pages[page - 1];
  return region
    ? `The ${which} image shows exactly that region: its top left corner is page point (${Math.round(region.x)}, ${Math.round(region.y)}), it covers ${Math.round(region.width)}×${Math.round(region.height)} page units.`
    : `The ${which} image shows the whole page, ${pageSize.width}×${pageSize.height} page units.`;
}

export const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['x', 'y', 'text'], properties: { x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } } }
    }
  }
};

// Notes from an answer, clamped to the page; anything malformed is dropped.
export function parseAnswer(text, pageSize) {
  let answer;
  try { answer = JSON.parse(text); } catch { throw new Error('The assistant did not answer with JSON.'); }
  if (!Array.isArray(answer?.notes)) throw new Error('The assistant answer has no notes.');
  const clamp = (value, max) => Math.max(0, Math.min(Math.round(value), max));
  return answer.notes
    .filter(note => Number.isFinite(note?.x) && Number.isFinite(note?.y) && typeof note.text === 'string' && note.text.trim())
    .slice(0, 5)
    .map(note => ({ x: clamp(note.x, pageSize.width - 40), y: clamp(note.y, pageSize.height - 20), text: note.text.trim().slice(0, 4000) }));
}

// A `paper` command for the assistant even when Paperlink is not installed with npm link.
async function shimDirectory() {
  const directory = path.join(stateDirectory(), 'bin');
  await mkdir(directory, { recursive: true });
  const shim = path.join(directory, 'paper');
  // Forward slashes, so Git Bash (Claude Code's shell on Windows) reads the paths too.
  const unix = file => file.split(path.sep).join('/');
  await writeFile(shim, `#!/bin/sh\nexec "${unix(process.execPath)}" "${unix(BIN)}" "$@"\n`);
  await chmod(shim, 0o755);
  // cmd.exe and PowerShell look for paper.cmd.
  if (process.platform === 'win32') await writeFile(path.join(directory, 'paper.cmd'), `@"${process.execPath}" "${BIN}" %*\r\n`);
  return directory;
}

const LIMIT = 5 * 60 * 1000;

// Runs one step and writes its output to the log; resolves with the exit
// code, or rejects when the run's deadline passed.
function step(command, args, { log, env, cwd, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('timeout'));
    const child = spawn(command, args, { cwd, stdio: ['ignore', log.fd, log.fd], windowsHide: true, env, signal, killSignal: 'SIGTERM' });
    child.once('error', error => reject(error.name === 'AbortError' ? new Error('timeout') : error));
    child.once('exit', code => resolve(code));
  });
}

function stepError(command, error) {
  if (error.message === 'timeout') return new Error('The assistant took longer than ' + LIMIT / 60000 + ' minutes and was stopped.');
  if (error.code !== 'ENOENT') return error;
  // Without a shell Windows only starts .exe files, not npm's .cmd wrappers.
  const hint = process.platform !== 'win32' ? ''
    : command === 'claude' ? ' On Windows it must be claude.exe on the PATH (use the native installer).'
    : ' On Windows it must be an .exe on the PATH; npm\'s .cmd wrappers cannot start without a shell.';
  return new Error(command + ' was not found on this computer.' + hint);
}

export async function runAssistant({ setting, request, port, onExit }) {
  const shim = await shimDirectory();
  const cwd = stateDirectory();
  const logFile = path.join(cwd, 'assistant.log');
  const log = await open(logFile, 'a');
  const env = { ...process.env, PATH: shim + path.delimiter + (process.env.PATH || ''), PAPERLINK_PORT: String(port) };
  // One deadline for the whole run, so the canvas is free again after LIMIT.
  const signal = AbortSignal.timeout(LIMIT);
  const run = (command, args, folder = cwd) => step(command, args, { log, env, cwd: folder, signal }).catch(error => { throw stepError(command, error); });
  const paper = args => run(process.execPath, [BIN, ...args]);
  const { document, page, region } = request;
  const preset = isPreset(setting) ? setting : null;
  const work = path.join(cwd, 'snapshots', 'run-' + randomBytes(6).toString('hex'));
  const files = { snapshot: path.join(work, 'selection.png'), schema: path.join(work, 'schema.json'), answer: path.join(work, 'answer.json') };
  const attempt = async () => {
    await log.write('\n--- ' + new Date().toISOString() + ' ' + (preset ?? setting[0]) + '\n');
    if (preset) {
      await mkdir(work, { recursive: true });
      const rendered = await paper(['snapshot', document.id, '--page', String(page), ...(region ? ['--region', regionList(region)] : []), '--output', files.snapshot]);
      if (rendered !== 0) throw new Error('Could not render the snapshot. See ' + logFile + '.');
    }
    if (preset !== 'codex') {
      const prompt = feedbackPrompt(request, preset ? PRESETS[preset].author : undefined, preset ? files.snapshot : undefined);
      const [command, args] = assistantCommand(setting, prompt, files, request);
      // Claude Code may read its working folder, so that is the folder with only the snapshot.
      const code = await run(command, args, preset ? work : cwd);
      if (code !== 0) throw new Error('The assistant stopped' + (code === null ? '' : ' with code ' + code) + '. See ' + logFile + '.');
      return;
    }
    await writeFile(files.schema, JSON.stringify(ANSWER_SCHEMA));
    const [command, args] = assistantCommand('codex', answerPrompt(request), files);
    const code = await run(command, args);
    if (code !== 0) throw new Error('Codex stopped' + (code === null ? '' : ' with code ' + code) + '. See ' + logFile + '.');
    const notes = parseAnswer(await readFile(files.answer, 'utf8').catch(() => ''), document.pages[page - 1]);
    await log.write(notes.length + ' note(s)\n');
    for (const [index, note] of notes.entries()) {
      // --text= and --literal: the text may start with "--" or contain backslashes.
      const added = await paper(['annotate', document.id, '--page', String(page), '--at', note.x + ',' + note.y, '--width', '320',
        '--revision', String(document.revision), '--author', PRESETS.codex.author, '--literal', '--text=' + note.text]);
      if (added !== 0) throw new Error((index ? 'Added ' + index + ' of ' + notes.length + ' notes; the next one failed.' : 'Could not add the notes.') + ' See ' + logFile + '.');
    }
  };
  attempt()
    .finally(() => rm(work, { recursive: true, force: true }).catch(() => {}))
    .then(() => onExit({ ok: true, message: '' }), error => onExit({ ok: false, message: error.message }))
    .finally(() => log.close().catch(() => {}));
}
