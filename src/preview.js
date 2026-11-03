import { open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Obsidian output (opt-in): next to each <id>.paperlink.json the library gets
//   <id>.preview.svg  – the handwriting on light paper, refreshed after saves
//   <Title>.md        – a note embedding the preview, created once and then left
//                       to the user, so their own text below the embed survives.

const PAPER = '#fffdf5';
const INK = '#24231f';
const PAGE_WIDTH = 900;
const PADDING = 40;
const MIN_HEIGHT = 240;

export const previewName = id => id + '.preview.svg';

const escapeXml = text => text.replace(/[<>&"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char]);

// Strokes are "M x y l 0.01 0 L x y …"; the relative dot segment is not a point.
function strokeBounds(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const stroke of strokes) {
    const numbers = stroke.replace(/ l 0\.01 0/, '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const x = Number(numbers[i]), y = Number(numbers[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// Keeps the page width so handwriting has the same scale in every preview;
// the height follows the content. Writing beyond the page edges widens it.
export function renderPreview(document) {
  const strokes = document.pages[0].strokes;
  const bounds = strokeBounds(strokes);
  const round = value => Math.round(value * 10) / 10;
  const x = bounds ? Math.min(0, bounds.minX - PADDING) : 0;
  const y = bounds ? Math.min(0, bounds.minY - PADDING) : 0;
  const width = (bounds ? Math.max(PAGE_WIDTH, bounds.maxX + PADDING) : PAGE_WIDTH) - x;
  const height = Math.max(MIN_HEIGHT, (bounds ? bounds.maxY + PADDING : 0) - y);
  const viewBox = [x, y, width, height].map(round).join(' ');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${round(width)}" height="${round(height)}">`,
    `<title>${escapeXml(document.title)}</title>`,
    `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" fill="${PAPER}"/>`,
    `<g fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">`,
    ...strokes.map(stroke => `<path d="${stroke}"/>`),
    '</g>',
    '</svg>',
    ''
  ].join('\n');
}

// Atomic replacement, so Obsidian and sync services never see a half-written file.
async function replaceFile(filename, content) {
  const temporary = filename + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function writePreview(directory, document) {
  const filename = path.join(directory, previewName(document.id));
  await replaceFile(filename, renderPreview(document));
  return filename;
}

const noteName = title => title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Canvas';
const FRONTMATTER_ID = /^---\r?\n(?:.*\r?\n)*?paperlink: *([a-f0-9-]{36}) *\r?\n/;

// Finds the note for a canvas in its folder, even after the user renamed it.
export async function findNote(directory, id) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filename = path.join(directory, entry.name);
    const head = (await readFile(filename, 'utf8').catch(() => '')).slice(0, 512);
    if (FRONTMATTER_ID.exec(head)?.[1] === id) return filename;
  }
  return null;
}

export async function ensureNote(directory, document) {
  const existing = await findNote(directory, document.id);
  if (existing) return { path: existing, created: false };
  const content = [
    '---', 'paperlink: ' + document.id, '---', '',
    '![[' + previewName(document.id) + ']]', '',
    'Open on your iPad: `paper open ' + document.id.slice(0, 8) + '`', ''
  ].join('\n');
  const base = noteName(document.title);
  for (let attempt = 1; attempt < 100; attempt++) {
    const filename = path.join(directory, base + (attempt > 1 ? ' (' + attempt + ')' : '') + '.md');
    try {
      await writeFile(filename, content, { flag: 'wx' });
      return { path: filename, created: true };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Cannot find a free note name for ' + document.title + '.');
}

// Preview and note together, for canvases created or refreshed through the CLI.
export async function writeObsidianFiles(directory, document) {
  const preview = await writePreview(directory, document);
  const note = await ensureNote(directory, document);
  return { preview, note: note.path, noteCreated: note.created };
}
