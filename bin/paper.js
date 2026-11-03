#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createCanvas, listCanvases } from '../src/documents.js';
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value for ' + name);
  return args[index + 1];
}
if (args[0] === 'canvas') {
  try {
    const vault = option('--vault');
    if (!vault) throw new Error('Specify --vault with an existing vault directory.');
    const folder = option('--path', '.');
    let result;
    if (args[1] === 'create') {
      if (!args[2] || args[2].startsWith('--')) throw new Error('Specify a canvas title.');
      result = await createCanvas(vault, folder, args[2]);
    } else if (args[1] === 'list') {
      result = await listCanvases(vault, folder);
    } else {
      throw new Error('Use canvas create <title> or canvas list.');
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] !== 'serve') {
  console.log('Paperlink\nUsage: paper serve [--port 8080] [--lan]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const portIndex = args.indexOf('--port');
const port = portIndex < 0 ? 8080 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const server = http.createServer(async (req, res) => {
  if (req.url !== '/') { res.writeHead(404); res.end(); return; }
  try {
    const html = await readFile(new URL('../public/index.html', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch { res.writeHead(500); res.end('Unable to load Paperlink'); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, args.includes('--lan') ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('Paperlink → http://localhost:' + port);
});
