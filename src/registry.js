import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDirectory } from './config.js';

// Canvases this computer has created or opened through the CLI, by ID.
// The server serves exactly these files to devices, so nobody on the network
// can ask for arbitrary paths. Only the local CLI adds entries.

export const registryPath = () => path.join(stateDirectory(), 'canvases.json');

export async function loadRegistry() {
  try {
    const stored = JSON.parse(await readFile(registryPath(), 'utf8'));
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Cannot read the canvas list at ' + registryPath() + ': ' + error.message);
  }
}

async function saveRegistry(registry) {
  const file = registryPath();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n');
  await rename(temporary, file);
}

export async function remember(documents) {
  const registry = await loadRegistry();
  const now = new Date().toISOString();
  for (const { id, title, path: file } of [documents].flat()) registry[id] = { path: file, title, openedAt: now };
  await saveRegistry(registry);
  return registry;
}

// Keeps title and history, only the place changes.
export async function relocate(id, file) {
  const registry = await loadRegistry();
  if (!registry[id]) return;
  registry[id] = { ...registry[id], path: file };
  await saveRegistry(registry);
}

export async function forget(id) {
  const registry = await loadRegistry();
  const existed = id in registry;
  delete registry[id];
  if (existed) await saveRegistry(registry);
  return existed;
}
