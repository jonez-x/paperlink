#!/usr/bin/env node
import { serve } from '../src/server.js';
import { createCanvas, listCanvases, documentFolder } from '../src/documents.js';
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
      result = await listCanvases(vault, folder, { onSkip: ({ path, reason }) => console.error('Skipped ' + path + ': ' + reason) });
    } else if (['open', 'drafts', 'import'].includes(args[1])) {
      const port = Number(option('--port', '8080'));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      const directory = await documentFolder(vault, folder);
      const command = args[1];
      const input = { directory };
      if (command === 'open') input.id = args[2];
      if (command === 'import') {
        input.title = args[2];
        input.id = option('--from-browser');
        if (!input.id) throw new Error('Specify --from-browser with an ID from canvas drafts.');
      }
      const response = await fetch('http://127.0.0.1:' + port + '/cli/' + command, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
      });
      result = await response.json();
      if (!response.ok) throw new Error(result.error);
    } else {
      throw new Error('Use canvas create <title>, list, open <id>, drafts, or import <title> --from-browser <id>.');
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] !== 'serve') {
  console.log('Paperlink\nUsage: paper serve [--port 8080] [--lan] [--vault PATH] [--path FOLDER]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const portIndex = args.indexOf('--port');
const port = portIndex < 0 ? 8080 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
try {
  await serve({ port, lan: args.includes('--lan'), vault: option('--vault'), folder: option('--path', '.') });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
