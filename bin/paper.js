#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
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
