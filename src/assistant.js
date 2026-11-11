import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
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
// claude: runs the Paperlink commands itself, limited to exactly those commands.
// codex:  read-only sandbox without network, without the user's Codex config,
//         web search, apps, plugins, browser and computer use; Paperlink renders
//         the snapshot, attaches it and adds the notes Codex returns as JSON.
export const PRESETS = { claude: { name: 'Claude Code', author: 'Claude' }, codex: { name: 'Codex', author: 'Codex' } };

// Codex features that reach beyond the sandbox (checked with codex-cli 0.157).
const CODEX_DISABLED = ['apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'hooks'];

export function validAssistant(setting) {
  return setting === null || Object.hasOwn(PRESETS, setting) ||
    (Array.isArray(setting) && setting.length > 0 && setting.every(part => typeof part === 'string') && setting.includes('{prompt}'));
}

export const assistantName = setting => PRESETS[setting]?.name ?? (setting ? 'custom command' : 'off');

export function assistantCommand(setting, prompt, files = {}) {
  if (setting === 'claude') {
    // Only the Paperlink commands it needs, and reading the snapshot image.
    return ['claude', ['-p', prompt, '--allowedTools', 'Bash(paper inspect *) Bash(paper snapshot *) Bash(paper annotate *) Read']];
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
const regionFlag = region => region ? ` --region ${regionList(region)}` : '';
const snapshotPath = document => path.join(stateDirectory(), 'snapshots', document.id.slice(0, 8) + '-feedback.png');

function introduction({ document, page, region, question }) {
  return [
    `You give feedback on handwritten work in Paperlink, a notebook the user writes in with an Apple Pencil.`,
    `Canvas "${document.title}" (ID ${document.id}) is at revision ${document.revision}. The user selected ${describeArea(page, region)}.`,
    `Coordinates are page units: pages are 900 wide, origin at the page's top left.`,
    question ? `Their question, quoted: """${question}"""` : `They asked no question: check the selected work and point out mistakes or the next step.`
  ];
}
const style = `Use one to three short notes, a few sentences each, in the language of the handwriting or question.`;

// For assistants that run the Paperlink commands themselves.
export function feedbackPrompt(request, author = 'Assistant') {
  const { document, page, region } = request;
  const snapshot = `paper snapshot ${document.id} --page ${page}${regionFlag(region)} --output ${snapshotPath(document)}`;
  return [
    ...introduction(request),
    ``,
    `1. Look at the selection: run \`${snapshot}\` and read the PNG it writes.`,
    `2. Optionally run \`paper inspect ${document.id} --json\` for page sizes and existing notes.`,
    `3. Answer only by adding notes on the assistant layer, placed next to the part they refer to (inside or just right of the selection):`,
    `   paper annotate ${document.id} --page ${page} --at X,Y --width 320 --revision ${document.revision} --author ${author} --text "…"`,
    `   ${style} Use \\n for line breaks.`,
    `Do not change anything else and do not print a long answer; the user only sees the notes.`
  ].join('\n');
}

// For assistants that get the snapshot attached and answer with JSON.
export function answerPrompt(request) {
  const { document, page, region } = request;
  const pageSize = document.pages[page - 1];
  const frame = region
    ? `The attached image shows exactly that region: its top left corner is page point (${Math.round(region.x)}, ${Math.round(region.y)}) and its width is ${Math.round(region.width)} page units.`
    : `The attached image shows the whole page, ${pageSize.width}×${pageSize.height} page units.`;
  return [
    ...introduction(request),
    frame,
    ``,
    `Answer only with JSON matching the given schema: {"notes": [{"x": …, "y": …, "text": "…"}]}.`,
    `Each note is placed at page point x, y (its top left corner, about 320 units wide), next to the part it refers to, inside or just right of the selection.`,
    `${style} You cannot run commands or change files, and you need not: everything is in the image.`
  ].join('\n');
}

export const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['notes'],
  properties: {
    notes: {
      type: 'array', maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['x', 'y', 'text'], properties: { x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } } }
    }
  }
};

// Notes from an answer, clamped to the page; anything malformed is dropped.
export function parseAnswer(text, pageSize) {
  let answer;
  try { answer = JSON.parse(text); } catch { throw new Error('The assistant did not answer with JSON.'); }
  if (!Array.isArray(answer?.notes)) throw new Error('The assistant answer has no notes.');
  const clamp = (value, max) => Math.min(Math.max(0, Math.round(value)), max);
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

// Runs one step and writes its output to the log; resolves with the exit code.
function step(command, args, { log, env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', log.fd, log.fd], windowsHide: true, env });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60 * 1000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
}

const notFound = command => command + ' was not found on this computer.' +
  // Without a shell Windows only starts .exe files, not npm's .cmd wrappers.
  (process.platform === 'win32' ? ' On Windows it must be an .exe on the PATH (for Claude Code, use the native installer).' : '');

export async function runAssistant({ setting, request, port, onExit }) {
  const shim = await shimDirectory();
  const cwd = stateDirectory();
  const logFile = path.join(cwd, 'assistant.log');
  const log = await open(logFile, 'a');
  const env = { ...process.env, PATH: shim + path.delimiter + (process.env.PATH || ''), PAPERLINK_PORT: String(port) };
  const paper = args => step(process.execPath, [BIN, ...args], { log, env, cwd });
  const stopped = name => name + ' stopped with code ';
  const run = async () => {
    const { document, page, region } = request;
    if (setting !== 'codex') {
      const prompt = feedbackPrompt(request, PRESETS[setting]?.author);
      const [command, args] = assistantCommand(setting, prompt);
      await log.write('\n--- ' + new Date().toISOString() + ' ' + command + '\n');
      const code = await step(command, args, { log, env, cwd }).catch(error => { throw new Error(error.code === 'ENOENT' ? notFound(command) : error.message); });
      if (code !== 0) throw new Error(stopped('The assistant') + code + '. See ' + logFile + '.');
      return;
    }
    await log.write('\n--- ' + new Date().toISOString() + ' codex\n');
    const work = path.join(cwd, 'snapshots', 'codex-' + document.id.slice(0, 8));
    await mkdir(work, { recursive: true });
    const files = { snapshot: snapshotPath(document), schema: path.join(work, 'schema.json'), answer: path.join(work, 'answer.json') };
    try {
      await rm(files.answer, { force: true });
      await writeFile(files.schema, JSON.stringify(ANSWER_SCHEMA));
      const rendered = await paper(['snapshot', document.id, '--page', String(page), ...(region ? ['--region', regionList(region)] : []), '--output', files.snapshot]);
      if (rendered !== 0) throw new Error('Could not render the snapshot. See ' + logFile + '.');
      const [command, args] = assistantCommand('codex', answerPrompt(request), files);
      const code = await step(command, args, { log, env, cwd }).catch(error => { throw new Error(error.code === 'ENOENT' ? notFound(command) : error.message); });
      if (code !== 0) throw new Error(stopped('Codex') + code + '. See ' + logFile + '.');
      const notes = parseAnswer(await readFile(files.answer, 'utf8').catch(() => ''), document.pages[page - 1]);
      await log.write(notes.length + ' note(s)\n');
      // Each note raises the revision, so the next one counts it as seen;
      // edits by anyone else in the meantime still mark the notes as stale.
      for (const [index, note] of notes.entries()) {
        const added = await paper(['annotate', document.id, '--page', String(page), '--at', note.x + ',' + note.y, '--width', '320',
          '--revision', String(document.revision + index), '--author', PRESETS.codex.author, '--text', note.text]);
        if (added !== 0) throw new Error('Could not add a note. See ' + logFile + '.');
      }
    } finally { await rm(work, { recursive: true, force: true }); }
  };
  run().then(() => onExit({ ok: true, message: '' }), error => onExit({ ok: false, message: error.message }))
    .finally(() => log.close().catch(() => {}));
}
