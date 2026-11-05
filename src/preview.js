import { access, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canvasBase, obsidianVault, safeFileName } from './documents.js';
import { stateDirectory } from './config.js';
import { HIGHLIGHT_OPACITY, parseStroke, strokeBounds as boundsOf, strokePath, textLines } from './ink.js';

// Inside an Obsidian vault, "<Name>.paperlink" gets two companions:
//   <Name>.md        – a note next to it embedding the preview, created once and
//                      then left to the user, so their own text survives.
//   Paperlink Previews/<id>.svg – the handwriting on light paper, refreshed
//                      after saves. One folder per vault keeps canvas folders
//                      clean; the ID keeps names unique and stable on renames.

const PAPER = '#fffdf5';
const INK = '#24231f';
const BORDER = '#dedbd0';
const PAGE_WIDTH = 900;
const PADDING = 40;
const MIN_HEIGHT = 240;

export const PREVIEW_FOLDER = 'Paperlink Previews';
// Earlier versions put "<id>.preview.svg" next to the canvas.
export const legacyPreviewName = id => id + '.preview.svg';
const embed = id => '![[' + id + '.svg]]';

export const previewPath = (vault, id) => path.join(vault, PREVIEW_FOLDER, id + '.svg');

const escapeXml = text => text.replace(/[<>&"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char]);

function strokeBounds(strokes) {
  const boxes = strokes.map(parseStroke).filter(Boolean).map(boundsOf).filter(Boolean);
  return boxes.length ? {
    minX: Math.min(...boxes.map(box => box.minX)), minY: Math.min(...boxes.map(box => box.minY)),
    maxX: Math.max(...boxes.map(box => box.maxX)), maxY: Math.max(...boxes.map(box => box.maxY))
  } : null;
}

// SVG elements for a page's strokes, highlighters first so they lie below the ink.
function strokeElements(strokes) {
  const parsed = strokes.map(parseStroke).filter(Boolean);
  return [...parsed.filter(stroke => stroke.highlighter), ...parsed.filter(stroke => !stroke.highlighter)].map(stroke => {
    const color = stroke.color ?? INK;
    if (stroke.kind === 'text') {
      return `<text font-family="Arial, Helvetica, sans-serif" font-size="${stroke.width}" fill="${color}">` +
        textLines(stroke).map(line => `<tspan x="${line.x}" y="${line.y}">${escapeXml(line.text)}</tspan>`).join('') + '</text>';
    }
    const opacity = stroke.highlighter ? ` opacity="${HIGHLIGHT_OPACITY}"` : '';
    if (stroke.kind === 'pressure') return `<path d="${strokePath(stroke)}" fill="${color}"${opacity}/>`;
    return `<path d="${strokePath(stroke)}" fill="none" stroke="${color}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"${opacity}/>`;
  });
}

// Keeps the page width so handwriting has the same scale in every preview;
// the height follows the content. Writing beyond the page edges widens it.
export function renderPreview(document, { backgrounds = {} } = {}) {
  if (document.pages.length > 1 || document.pages[0].pdfPage !== undefined) return renderPages(document, backgrounds);
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
    ...strokeElements(strokes),
    '</svg>',
    ''
  ].join('\n');
}

// Several pages (or PDF pages): every page in full, stacked as in the browser.
// `backgrounds` maps page IDs to image data URLs of their PDF pages.
const PAGE_GAP = 40;
function renderPages(document, backgrounds) {
  const parts = [];
  let top = 0, width = 0;
  for (const page of document.pages) {
    const background = backgrounds[page.id];
    parts.push(`<g transform="translate(0 ${top})">`,
      `<rect width="${page.width}" height="${page.height}" fill="${background ? '#ffffff' : PAPER}" stroke="${BORDER}" stroke-width="2"/>`,
      ...(background ? [`<image href="${background}" width="${page.width}" height="${page.height}" preserveAspectRatio="none"/>`] : []),
      ...strokeElements(page.strokes),
      '</g>');
    top += page.height + PAGE_GAP;
    width = Math.max(width, page.width);
  }
  const height = top - PAGE_GAP;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${width + 4} ${height + 4}" width="${width + 4}" height="${height + 4}">`,
    `<title>${escapeXml(document.title)}</title>`,
    ...parts,
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

const openLine = link => '[Open in Paperlink](' + link + ')';

// Small JPEG renderings of PDF pages, sent by the browser (Node cannot render
// PDFs without native modules). Kept outside the vault, keyed by canvas.
export const backgroundDirectory = id => path.join(stateDirectory(), 'backgrounds', id);
export const backgroundPath = (id, pageId) => path.join(backgroundDirectory(id), pageId + '.jpg');

async function loadBackgrounds(document) {
  const backgrounds = {};
  for (const page of document.pages) {
    if (page.pdfPage === undefined) continue;
    const image = await readFile(backgroundPath(document.id, page.id)).catch(() => null);
    if (image) backgrounds[page.id] = 'data:image/jpeg;base64,' + image.toString('base64');
  }
  return backgrounds;
}

// `link` is the canvas link for the note (see devices.js); null when unknown.
export async function writePreview(file, document, { link = null } = {}) {
  const vault = await obsidianVault(file);
  if (!vault) return null;
  const filename = previewPath(vault, document.id);
  await mkdir(path.dirname(filename), { recursive: true });
  await replaceFile(filename, renderPreview(document, { backgrounds: await loadBackgrounds(document) }));
  await upgradeNote(file, document.id, link);
  return filename;
}

// Notes from earlier versions: the embed moves to the preview folder and the
// `paper open` hint becomes a link. Only those exact lines change.
async function upgradeNote(file, id, link) {
  const legacy = path.join(path.dirname(file), legacyPreviewName(id));
  const hasLegacy = await access(legacy).then(() => true, () => false);
  const note = await findNote(path.dirname(file), id);
  if (note) {
    const text = await readFile(note, 'utf8');
    let updated = text.replace('![[' + legacyPreviewName(id) + ']]', embed(id));
    if (link) updated = updated.replace('Open on your iPad: `paper open ' + id.slice(0, 8) + '`', openLine(link));
    if (updated !== text) await replaceFile(note, updated);
  }
  if (hasLegacy) await unlink(legacy).catch(() => {});
}

const FRONTMATTER_ID = /^---\r?\n(?:.*\r?\n)*?paperlink: *([a-f0-9-]{36}) *\r?\n/;

async function noteId(filename) {
  const head = (await readFile(filename, 'utf8').catch(() => '')).slice(0, 512);
  return FRONTMATTER_ID.exec(head)?.[1];
}

// Finds the note for a canvas in its folder, even after the user renamed it.
export async function findNote(directory, id) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (await noteId(path.join(directory, entry.name)) === id) return path.join(directory, entry.name);
  }
  return null;
}

// Searches a whole vault, for notes the user moved in Obsidian.
export async function findNoteInVault(vault, id, depth = 0) {
  let entries;
  try { entries = await readdir(vault, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(vault, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md') && await noteId(full) === id) return full;
    if (entry.isDirectory() && depth < 16) {
      const found = await findNoteInVault(full, id, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// "Sheet.md", or "Sheet (2).md" when that is taken.
export async function freeName(directory, base, extension, taken = name => access(name).then(() => true, () => false)) {
  for (let attempt = 1; attempt < 100; attempt++) {
    const filename = path.join(directory, base + (attempt > 1 ? ' (' + attempt + ')' : '') + extension);
    if (!(await taken(filename))) return filename;
  }
  throw new Error('Cannot find a free name for ' + base + extension + ' in ' + directory + '.');
}

export async function ensureNote(file, document, { link = null } = {}) {
  const directory = path.dirname(file);
  const existing = await findNote(directory, document.id);
  if (existing) return { path: existing, created: false };
  const content = [
    '---', 'paperlink: ' + document.id, '---', '',
    embed(document.id), '',
    link ? openLine(link) : 'Open with `paper open ' + document.id.slice(0, 8) + '`', ''
  ].join('\n');
  // Files from earlier versions are named by ID; their note takes the title.
  const base = safeFileName(/^[a-f0-9-]{36}$/.test(canvasBase(file)) ? document.title : canvasBase(file));
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
export async function writeObsidianFiles(file, document, options = {}) {
  const note = await ensureNote(file, document, options);
  const preview = await writePreview(file, document, options);
  return { preview, note: note.path, noteCreated: note.created };
}
