import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Connects Paperlink's MCP server to the assistant apps found on this computer.
// The server is registered with the absolute path of this Node and paper.js, so
// it starts even when an app does not see the user's PATH (Claude Desktop).

const BIN = fileURLToPath(new URL('../bin/paper.js', import.meta.url));
export const mcpServer = () => ({ command: process.execPath, args: [BIN, 'mcp'] });

function appData() {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
}

// On Windows npm installs `claude` as claude.cmd, which only a shell can run.
// The arguments are fixed words and absolute paths, so quoting them is enough.
export const shellCommand = (command, args) => [command, ...args].map(part => '"' + part + '"').join(' ');
const run = (command, args) => new Promise(resolve => {
  const options = { windowsHide: true, timeout: 30000 };
  const done = (error, stdout, stderr) => resolve({ ok: !error, missing: error?.code === 'ENOENT', output: (stderr || stdout || error?.message || '').trim() });
  if (process.platform === 'win32') execFile(shellCommand(command, args), [], { ...options, shell: true }, done);
  else execFile(command, args, options, done);
});

// Adds or replaces mcpServers.paperlink and keeps everything else in the file.
// A file that is not valid JSON is left alone.
export async function addToConfigFile(file, server = mcpServer()) {
  let config = {};
  try { config = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(file + ' is not valid JSON, so it was left unchanged.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(file + ' is not a JSON object, so it was left unchanged.');
  config.mcpServers = { ...config.mcpServers, paperlink: server };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n');
  await rename(temporary, file);
}

// Apps that are installed here, each with a connect() that registers Paperlink.
export async function assistantApps() {
  const apps = [];
  const desktop = path.join(appData(), 'Claude');
  if (process.platform !== 'linux' && existsSync(desktop)) {
    const file = path.join(desktop, 'claude_desktop_config.json');
    apps.push({ id: 'claude-desktop', name: 'Claude Desktop', note: 'restart Claude Desktop afterwards', connect: () => addToConfigFile(file) });
  }
  if ((await run('claude', ['--version'])).ok) {
    apps.push({
      id: 'claude-code', name: 'Claude Code', connect: async () => {
        const { command, args } = mcpServer();
        await run('claude', ['mcp', 'remove', '--scope', 'user', 'paperlink']);
        const added = await run('claude', ['mcp', 'add', '--scope', 'user', 'paperlink', '--', command, ...args]);
        if (!added.ok) throw new Error('claude mcp add failed: ' + added.output);
      }
    });
  }
  if ((await run('codex', ['--version'])).ok) {
    apps.push({
      id: 'codex', name: 'Codex', connect: async () => {
        const { command, args } = mcpServer();
        await run('codex', ['mcp', 'remove', 'paperlink']);
        const added = await run('codex', ['mcp', 'add', 'paperlink', '--', command, ...args]);
        if (!added.ok) throw new Error('codex mcp add failed: ' + added.output);
      }
    });
  }
  const cursor = path.join(homedir(), '.cursor');
  if (existsSync(cursor)) apps.push({ id: 'cursor', name: 'Cursor', connect: () => addToConfigFile(path.join(cursor, 'mcp.json')) });
  return apps;
}
