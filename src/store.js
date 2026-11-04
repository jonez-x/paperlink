import { readFile, rename, unlink, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validPdfName } from './pdf.js';

const PAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;
const dimension = value => Number.isFinite(value) && value >= 50 && value <= 10000;

export function validateStrokes(strokes) {
  if (!Array.isArray(strokes) || strokes.length > 20000 ||
      strokes.some(s => typeof s !== 'string' || s.length > 1000000 ||
        !/^M [-+\d.eE ,]+ l 0\.01 0(?: L [-+\d.eE ,]+)*$/.test(s))) {
    throw Object.assign(new Error('Invalid stroke data.'), { status: 400 });
  }
}

// Version 1 files hold one page; version 2 any number, optionally backed by
// pages of a PDF (`pdfPage`, 1-based, with `document.pdf` naming the file).
function validatePages(pages) {
  const ids = new Set();
  if (!Array.isArray(pages) || !pages.length || pages.length > 500 ||
      pages.some(page => !PAGE_ID.test(page?.id ?? '') || ids.has(page.id) || !ids.add(page.id) ||
        !dimension(page.width) || !dimension(page.height) ||
        (page.pdfPage !== undefined && !(Number.isInteger(page.pdfPage) && page.pdfPage > 0)))) {
    throw Object.assign(new Error('Invalid page data.'), { status: 400 });
  }
  for (const page of pages) validateStrokes(page.strokes);
}

// Reads a canvas file. With `id`, the file must still contain that canvas, so a
// file replaced or renamed behind Paperlink's back is never served by mistake.
export async function readCanvas(file, id) {
  if (id !== undefined && !/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error('Invalid canvas ID.'), { status: 400 });
  let document;
  try { document = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw error instanceof SyntaxError ? new Error('Not a readable canvas file: invalid JSON.') : error; }
  if (document?.format !== 'paperlink' || ![1, 2].includes(document.version) || !/^[a-f0-9-]{36}$/.test(document.id ?? '') ||
      typeof document.title !== 'string' || !Array.isArray(document.pages) || (document.version === 1 && document.pages.length !== 1) ||
      !Number.isInteger(document.revision)) {
    throw new Error('Unsupported document format.');
  }
  if (id !== undefined && document.id !== id) throw Object.assign(new Error('The file no longer contains this canvas.'), { code: 'ENOENT' });
  try { validatePages(document.pages); }
  catch { throw new Error('Unsupported document format: invalid pages.'); }
  if (document.pdf !== undefined && !validPdfName(document.pdf?.file)) throw new Error('Unsupported document format: invalid PDF reference.');
  return document;
}

// The browser sends all pages. Known pages keep their size and PDF backing
// from the file; new pages are blank; PDF pages cannot be removed.
function mergePages(document, request) {
  if (request.pages === undefined) {
    // Clients from before multi-page documents send the strokes of a single page.
    validateStrokes(request.strokes);
    if (document.pages.length !== 1) throw Object.assign(new Error('This canvas has several pages. Reload the page.'), { status: 409 });
    return [{ ...document.pages[0], strokes: request.strokes }];
  }
  validatePages(request.pages);
  const known = new Map(document.pages.map(page => [page.id, page]));
  const pages = request.pages.map(page => {
    const existing = known.get(page.id);
    if (!existing && page.pdfPage !== undefined) throw Object.assign(new Error('Unknown PDF page.'), { status: 400 });
    return existing ? { ...existing, strokes: page.strokes } : { id: page.id, width: page.width, height: page.height, strokes: page.strokes };
  });
  const kept = new Set(pages.map(page => page.id));
  if (document.pages.some(page => page.pdfPage !== undefined && !kept.has(page.id))) throw Object.assign(new Error('PDF pages cannot be removed.'), { status: 400 });
  return pages;
}

export async function saveCanvas(file, id, request) {
  if (!Number.isInteger(request.revision) || typeof request.operationId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(request.operationId)) {
    throw Object.assign(new Error('Invalid save request.'), { status: 400 });
  }
  const document = await readCanvas(file, id);
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const receipt = (document.receipts || []).find(r => r.id === request.operationId);
  if (receipt) {
    if (receipt.hash !== hash) throw Object.assign(new Error('Operation ID reused.'), { status: 409 });
    return { revision: receipt.revision };
  }
  if (document.revision !== request.revision) {
    throw Object.assign(new Error('This canvas changed elsewhere. Your local changes are retained.'), { status: 409 });
  }
  document.pages = mergePages(document, request);
  document.version = 2;
  document.revision++;
  document.updatedAt = new Date().toISOString();
  document.receipts = [...(document.receipts || []), { id: request.operationId, hash, revision: document.revision }].slice(-100);
  const temporary = file + '.' + request.operationId + '.tmp';
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(document, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { revision: document.revision };
}
