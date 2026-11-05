import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addToConfigFile, mcpServer } from '../src/setup.js';
const exec = promisify(execFile);

test('connecting an assistant app keeps its other settings and refuses broken files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-setup-'));
  try {
    const file = path.join(root, 'Claude', 'claude_desktop_config.json');
    await addToConfigFile(file);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mcpServers: { paperlink: mcpServer() } });
    await writeFile(file, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' }, paperlink: { command: 'old' } } }));
    await addToConfigFile(file);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { theme: 'dark', mcpServers: { other: { command: 'x' }, paperlink: mcpServer() } });
    await writeFile(file, '{ "theme": "dark", }');
    await assert.rejects(addToConfigFile(file), /not valid JSON/);
    assert.equal(await readFile(file, 'utf8'), '{ "theme": "dark", }');
    // The registered command starts the MCP server directly, without the PATH.
    const { command, args } = mcpServer();
    assert.ok(path.isAbsolute(command) && path.isAbsolute(args[0]));
    const { stdout } = await exec(command, [args[0], '--version']);
    assert.match(stdout, /0\.\d+\.\d+/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup needs a terminal and says so to scripts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperlink-setup-'));
  try {
    const env = { ...process.env, PAPERLINK_CONFIG: path.join(root, 'config.json'), PAPERLINK_LOCK_DIR: path.join(root, 'locks') };
    const failed = await exec(process.execPath, [path.resolve('bin/paper.js'), 'setup'], { env }).catch(error => error);
    assert.equal(failed.code, 1);
    assert.match(JSON.parse(failed.stderr).error, /needs a terminal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
