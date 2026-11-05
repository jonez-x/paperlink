#!/usr/bin/env node
// Builds dist/paperlink-<version>-installer.zip: the installers plus the app
// as paperlink.tgz, ready to send. Needs npm and zip.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const name = `paperlink-${version}-installer`;
const work = await mkdtemp(path.join(tmpdir(), 'paperlink-bundle-'));
try {
  const folder = path.join(work, name);
  await cp(path.join(ROOT, 'install'), folder, { recursive: true });
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', folder], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }));
  await rename(path.join(folder, packed.filename), path.join(folder, 'paperlink.tgz'));
  await writeFile(path.join(folder, 'README.txt'), [
    `Paperlink ${version}`,
    '',
    'macOS:   double-click "Install Paperlink.command".',
    '         If macOS refuses to open it: right-click it, choose Open, then Open again',
    '         (on macOS 15 and later: System Settings > Privacy & Security > Open Anyway).',
    '         Or in Terminal: sh <drag install.sh here>',
    'Windows: double-click "Install Paperlink.cmd".',
    'Linux:   sh install.sh',
    '',
    'The installer downloads Node.js from nodejs.org for Paperlink alone (no admin rights),',
    'installs the `paper` command and starts a short setup. Run it again to update.',
    ''
  ].join('\n'));
  const out = path.join(ROOT, 'dist');
  await mkdir(out, { recursive: true });
  const zip = path.join(out, name + '.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qry', zip, name], { cwd: work });
  console.log(zip);
} finally { await rm(work, { recursive: true, force: true }); }
