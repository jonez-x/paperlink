import { spawn } from 'node:child_process';
import { chmod, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDirectory } from './config.js';

// "Request feedback" from a page runs a locally configured assistant. The
// browser only supplies page, region and question; the command is fixed in
// the config on this computer and runs without a shell. The assistant answers
// through the CLI (snapshot to look, annotate to reply), so its notes arrive
// like any other edit.

const BIN = fileURLToPath(new URL('../bin/paper.js', import.meta.url));

// `claude`, or a custom argument list containing "{prompt}".
export function validAssistant(setting) {
  return setting === null || setting === 'claude' ||
    (Array.isArray(setting) && setting.length > 0 && setting.every(part => typeof part === 'string') && setting.includes('{prompt}'));
}

export function assistantCommand(setting, prompt) {
  if (setting === 'claude') {
    // Only the Paperlink commands it needs, and reading the snapshot image.
    return ['claude', ['-p', prompt, '--allowedTools', 'Bash(paper inspect *) Bash(paper snapshot *) Bash(paper annotate *) Read']];
  }
  const [command, ...args] = setting.map(part => part === '{prompt}' ? prompt : part);
  return [command, args];
}

export function feedbackPrompt({ document, page, region, question }) {
  const area = region
    ? `the region x=${Math.round(region.x)}, y=${Math.round(region.y)}, width=${Math.round(region.width)}, height=${Math.round(region.height)} of page ${page}`
    : `page ${page}`;
  const snapshot = `paper snapshot ${document.id} --page ${page}` +
    (region ? ` --region ${[region.x, region.y, region.width, region.height].map(Math.round).join(',')}` : '') +
    ` --output ${path.join(stateDirectory(), 'snapshots', document.id.slice(0, 8) + '-feedback.png')}`;
  return [
    `You give feedback on handwritten work in Paperlink, a notebook the user writes in with an Apple Pencil.`,
    `Canvas "${document.title}" (ID ${document.id}) is at revision ${document.revision}. The user selected ${area}.`,
    `Coordinates are page units: pages are 900 wide, origin at the page's top left.`,
    question ? `Their question, quoted: """${question}"""` : `They asked no question: check the selected work and point out mistakes or the next step.`,
    ``,
    `1. Look at the selection: run \`${snapshot}\` and read the PNG it writes.`,
    `2. Optionally run \`paper inspect ${document.id} --json\` for page sizes and existing notes.`,
    `3. Answer only by adding notes on the assistant layer, placed next to the part they refer to (inside or just right of the selection):`,
    `   paper annotate ${document.id} --page ${page} --at X,Y --width 320 --revision ${document.revision} --author Claude --text "…"`,
    `   Use one to three short notes, a few sentences each, in the language of the handwriting or question. Use \\n for line breaks.`,
    `Do not change anything else and do not print a long answer; the user only sees the notes.`
  ].join('\n');
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

export async function runAssistant({ setting, prompt, port, onExit }) {
  const [command, args] = assistantCommand(setting, prompt);
  const shim = await shimDirectory();
  const log = await open(path.join(stateDirectory(), 'assistant.log'), 'a');
  await log.write('\n--- ' + new Date().toISOString() + ' ' + command + '\n');
  const child = spawn(command, args, {
    cwd: stateDirectory(), stdio: ['ignore', log.fd, log.fd], windowsHide: true,
    env: { ...process.env, PATH: shim + path.delimiter + (process.env.PATH || ''), PAPERLINK_PORT: String(port) }
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60 * 1000);
  let reported = false;
  const finish = (ok, message) => {
    if (reported) return;
    reported = true;
    clearTimeout(timeout);
    log.close().catch(() => {});
    onExit({ ok, message });
  };
  child.once('error', error => finish(false, error.code === 'ENOENT' ? command + ' was not found on this computer.' +
    // Without a shell Windows only starts .exe files, not npm's .cmd wrappers.
    (process.platform === 'win32' ? ' On Windows it must be an .exe on the PATH (for Claude Code, use the native installer).' : '') : error.message));
  child.once('exit', code => finish(code === 0, code === 0 ? '' : 'The assistant stopped with code ' + code + '. See ' + path.join(stateDirectory(), 'assistant.log') + '.'));
}
