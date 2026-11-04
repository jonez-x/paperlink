import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// `paper mcp`: a Model Context Protocol server on stdin/stdout for assistants
// without a terminal. Dependency-free JSON-RPC 2.0, one message per line. Each
// tool runs the matching CLI command with --json, so both share one behavior.

const BIN = fileURLToPath(new URL('../bin/paper.js', import.meta.url));
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const canvas = { type: 'string', description: 'Canvas file path, ID, ID prefix or title (see list_canvases).' };
const page = { type: 'integer', minimum: 1, description: 'Page number, starting at 1 (default 1).' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'list_canvases',
    description: 'Canvases created or opened on this computer, most recent first, with ID, title and file path.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    args: () => ['list']
  },
  {
    name: 'create_canvas',
    description: 'Create a .paperlink canvas file, optionally with the pages of a PDF worksheet to write on. Returns links to open it when the server runs.',
    inputSchema: schema({
      path: { type: 'string', description: 'Absolute path without extension, e.g. /Users/me/Uni/Analysis/Sheet 3. Relative paths start at the folder Paperlink was launched from.' },
      title: { type: 'string', description: 'Title, if different from the file name.' },
      pdf: { type: 'string', description: 'Path to a PDF whose pages become the canvas pages.' }
    }, ['path']),
    args: input => ['new', input.path, ...option('title', input.title), ...option('pdf', input.pdf)]
  },
  {
    name: 'open_canvas',
    description: 'Start the Paperlink server if needed and return links for a canvas: a localhost link for this computer and network links with a one-time pairing code for other devices.',
    inputSchema: schema({ canvas }, ['canvas']),
    before: ['start'],
    args: input => ['open', input.canvas]
  },
  {
    name: 'inspect_canvas',
    description: 'Pages with sizes and stroke counts, existing notes and the current revision. Page units: 900 wide, origin at the top left.',
    inputSchema: schema({ canvas }, ['canvas']),
    annotations: { readOnlyHint: true },
    args: input => ['inspect', input.canvas]
  },
  {
    name: 'snapshot_page',
    description: 'Image of a page, or of a region of it, with the PDF background and the handwriting, to read what was written.',
    inputSchema: schema({
      canvas, page,
      region: schema({ x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, ['x', 'y', 'width', 'height'])
    }, ['canvas']),
    annotations: { readOnlyHint: true },
    snapshot: true,
    args: (input, output) => ['snapshot', input.canvas, ...option('page', input.page),
      ...option('region', input.region && [input.region.x, input.region.y, input.region.width, input.region.height].join(',')), '--output', output]
  },
  {
    name: 'add_note',
    description: 'Add a note on the assistant layer of a page. It never changes the handwriting, appears live on every open device and can be removed there. Pass the revision you looked at, so a note on an outdated page is marked.',
    inputSchema: schema({
      canvas, page,
      text: { type: 'string', description: 'Note text, up to 4000 characters. Use \\n for line breaks.' },
      x: { type: 'number', description: 'Left edge in page units (default 40).' },
      y: { type: 'number', description: 'Top edge in page units (default 40).' },
      width: { type: 'number', description: 'Width in page units, 40 to 2000.' },
      revision: { type: 'integer', description: 'Canvas revision the note refers to (from inspect_canvas or snapshot_page).' },
      author: { type: 'string', description: 'Name shown on the note (default "Assistant").' }
    }, ['canvas', 'text']),
    args: input => ['annotate', input.canvas, '--text', input.text, ...option('page', input.page),
      ...option('at', input.x !== undefined || input.y !== undefined ? (input.x ?? 40) + ',' + (input.y ?? 40) : undefined),
      ...option('width', input.width), ...option('revision', input.revision), ...option('author', input.author)]
  },
  {
    name: 'remove_notes',
    description: 'Remove one note by ID (or ID prefix), or all notes of a canvas.',
    inputSchema: schema({ canvas, id: { type: 'string', description: 'Note ID from inspect_canvas.' }, all: { type: 'boolean', description: 'Remove every note.' } }, ['canvas']),
    annotations: { destructiveHint: true },
    args: input => {
      if (!input.id && !input.all) throw new Error('Pass id or all: true.');
      return ['annotate', input.canvas, ...(input.all ? ['--clear'] : ['--remove', input.id])];
    }
  },
  {
    name: 'export_pdf',
    description: 'Write a PDF with the handwriting drawn over the pages, for handing in. Default: "<Name> (annotated).pdf" next to the canvas.',
    inputSchema: schema({ canvas, output: { type: 'string', description: 'Output file or folder.' } }, ['canvas']),
    args: input => ['export', input.canvas, ...option('output', input.output)]
  }
];

function option(name, value) {
  return value === undefined || value === null || value === '' ? [] : ['--' + name, String(value)];
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, ...args, '--json'], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim() ? JSON.parse(stdout) : null);
      let message = error.message;
      try { message = JSON.parse(stderr.trim().split('\n').pop()).error; } catch { /* keep the process error */ }
      reject(new Error(message));
    });
  });
}

const text = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

async function callTool(name, input = {}) {
  const tool = TOOLS.find(entry => entry.name === name);
  if (!tool) throw Object.assign(new Error('Unknown tool ' + name + '.'), { code: -32602 });
  try {
    for (const args of tool.before ? [tool.before] : []) await runCli(args);
    if (!tool.snapshot) return { content: [text(await runCli(tool.args(input)))] };
    const work = await mkdtemp(path.join(tmpdir(), 'paperlink-mcp-'));
    try {
      const result = await runCli(tool.args(input, path.join(work, 'snapshot.png')));
      const data = (await readFile(result.path)).toString('base64');
      return { content: [{ type: 'image', data, mimeType: 'image/png' }, text({ ...result, path: undefined })] };
    } finally { await rm(work, { recursive: true, force: true }); }
  } catch (error) {
    return { content: [text(error.message)], isError: true };
  }
}

async function handle(message, version) {
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return {
        protocolVersion: VERSIONS.includes(requested) ? requested : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'paperlink', version },
        instructions: 'Paperlink canvases are handwritten notebooks (.paperlink files). To give feedback: inspect_canvas, snapshot_page to read the writing, then add_note next to it with the revision you saw. Coordinates are page units, 900 wide, origin top left.'
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations && { annotations }) })) };
    case 'tools/call': return callTool(message.params?.name, message.params?.arguments);
    default: throw Object.assign(new Error('Method not found: ' + message.method), { code: -32601 });
  }
}

export function serveMcp({ version, input = process.stdin, output = process.stdout } = {}) {
  const send = message => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    // Notifications (no id) need no answer.
    if (message.id === undefined || message.id === null) return;
    try { send({ id: message.id, result: await handle(message, version) }); }
    catch (error) { send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }); }
  });
  return new Promise(resolve => lines.once('close', resolve));
}
