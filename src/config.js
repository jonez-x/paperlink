import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Paperlink stores canvases in a "library": any existing folder. An Obsidian
// vault is one option; Obsidian-specific output is opt-in via `obsidian`.
export const DEFAULTS = Object.freeze({
  library: null,
  defaultPath: 'Paperlink',
  obsidian: false,
  port: 8080,
  lan: false
});

export function configPath() {
  if (process.env.PAPERLINK_CONFIG) return process.env.PAPERLINK_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'paperlink', 'config.json');
}

export const stateDirectory = () => path.dirname(configPath());

export async function loadConfig() {
  try {
    const stored = JSON.parse(await readFile(configPath(), 'utf8'));
    return { ...DEFAULTS, ...stored };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error('Cannot read the Paperlink config at ' + configPath() + ': ' + error.message);
  }
}

export async function saveConfig(config) {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  const stored = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, config[key] ?? DEFAULTS[key]]));
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(stored, null, 2) + '\n');
  await rename(temporary, file);
  return stored;
}

export function expandHome(input) {
  if (input === '~') return homedir();
  if (input?.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return input;
}

export function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port: ' + value);
  return port;
}
