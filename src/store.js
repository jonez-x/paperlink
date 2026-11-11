import { readFile, rename, unlink, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validPdfName } from './pdf.js';
import { validStroke, validTemplate } from './ink.js';

const PAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;
const dimension = value => Number.isFinite(value) && value >= 50 && value <= 10000;

export function validateStrokes(strokes) {
  if (!Array.isArray(strokes) || strokes.length > 20000 || !strokes.every(validStroke)) {
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
        (page.pdfPage !== undefined && !(Number.isInteger(page.pdfPage) && page.pdfPage > 0)) || !validTemplate(page.template))) {
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
  if (document.inkRevision !== undefined && !(Number.isInteger(document.inkRevision) && document.inkRevision <= document.revision)) delete document.inkRevision;
  if (document.annotations !== undefined && (!Array.isArray(document.annotations) || !document.annotations.every(validAnnotation))) throw new Error('Unsupported document format: invalid annotations.');
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
    return existing ? { ...existing, strokes: page.strokes } : { id: page.id, width: page.width, height: page.height, ...(page.template && { template: page.template }), strokes: page.strokes };
  });
  const kept = new Set(pages.map(page => page.id));
  if (document.pages.some(page => page.pdfPage !== undefined && !kept.has(page.id))) throw Object.assign(new Error('PDF pages cannot be removed.'), { status: 400 });
  return pages;
}

function checkOperationId(request) {
  if (typeof request.operationId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.operationId)) {
    throw Object.assign(new Error('Invalid save request.'), { status: 400 });
  }
}

// An operation ID seen before returns its earlier result, so retries after a
// lost response never apply twice; reusing an ID for other content is refused.
function receiptFor(document, request) {
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const receipt = (document.receipts || []).find(r => r.id === request.operationId);
  if (receipt && receipt.hash !== hash) throw Object.assign(new Error('Operation ID reused.'), { status: 409 });
  return { hash, receipt };
}

// `inkRevision` is the last revision that changed pages or strokes, so notes
// only count as stale when the writing changed, not when other notes arrived.
async function commit(file, document, operationId, hash, { ink = true } = {}) {
  document.version = 2;
  // Files from before inkRevision: assume the writing changed last.
  if (!ink) document.inkRevision ??= document.revision;
  document.revision++;
  if (ink) document.inkRevision = document.revision;
  document.updatedAt = new Date().toISOString();
  document.receipts = [...(document.receipts || []), { id: operationId, hash, revision: document.revision }].slice(-200);
  const temporary = file + '.' + operationId + '.tmp';
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(document, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { revision: document.revision };
}

// Whole-document save with a revision check (single-device clients and imports).
export async function saveCanvas(file, id, request) {
  checkOperationId(request);
  if (!Number.isInteger(request.revision)) throw Object.assign(new Error('Invalid save request.'), { status: 400 });
  const document = await readCanvas(file, id);
  const { hash, receipt } = receiptFor(document, request);
  if (receipt) return { revision: receipt.revision };
  if (document.revision !== request.revision) {
    throw Object.assign(new Error('This canvas changed elsewhere. Your local changes are retained.'), { status: 409 });
  }
  document.pages = mergePages(document, request);
  return commit(file, document, request.operationId, hash);
}

// Annotations: notes from an assistant (or the CLI) on a separate layer, in
// page coordinates. They never touch the handwriting. `revision` is the canvas
// revision the author looked at; `stale` marks notes made before the writing last changed.
export function validAnnotation(note) {
  return note && typeof note === 'object' && PAGE_ID.test(note.id ?? '') && PAGE_ID.test(note.page ?? '') &&
    Number.isFinite(note.x) && Number.isFinite(note.y) && Math.abs(note.x) < 20000 && Math.abs(note.y) < 20000 &&
    (note.width === undefined || (Number.isFinite(note.width) && note.width >= 40 && note.width <= 2000)) &&
    typeof note.text === 'string' && note.text.length > 0 && note.text.length <= 4000 &&
    (note.author === undefined || (typeof note.author === 'string' && note.author.length <= 60)) &&
    (note.revision === undefined || Number.isInteger(note.revision)) && (note.stale === undefined || typeof note.stale === 'boolean');
}

// Edits as operations, so several devices can write at once without conflicts:
//   { type: 'add', page, stroke }       adds a stroke unless it is there
//   { type: 'remove', page, stroke }    removes it if it is there
//   { type: 'addPage', page: { id, width, height, template? }, after? }  after: the page it follows
//   { type: 'removePage', page }        empty blank pages only; PDF pages stay
//   { type: 'addAnnotation', annotation } / { type: 'removeAnnotation', id }
// Each one is idempotent, so replays and concurrent edits converge.
export function validateOperations(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 5000) throw Object.assign(new Error('Invalid operations.'), { status: 400 });
  for (const op of ops) {
    const valid = ['add', 'remove'].includes(op?.type) ? PAGE_ID.test(op.page ?? '') && typeof op.stroke === 'string'
      : op?.type === 'addPage' ? PAGE_ID.test(op.page?.id ?? '') && dimension(op.page.width) && dimension(op.page.height) && validTemplate(op.page.template) && (op.after === undefined || PAGE_ID.test(op.after))
      : op?.type === 'removePage' ? PAGE_ID.test(op.page ?? '')
      : op?.type === 'addAnnotation' ? validAnnotation(op.annotation)
      : op?.type === 'removeAnnotation' ? PAGE_ID.test(op.id ?? '') : false;
    if (!valid) throw Object.assign(new Error('Invalid operations.'), { status: 400 });
    if (op.type === 'add') validateStrokes([op.stroke]);
  }
}

export function applyOperations(pages, ops, annotations = []) {
  for (const op of ops) {
    if (op.type === 'addAnnotation') {
      if (!annotations.some(note => note.id === op.annotation.id) && annotations.length < 1000) annotations.push(op.annotation);
      continue;
    }
    if (op.type === 'removeAnnotation') {
      const at = annotations.findIndex(note => note.id === op.id);
      if (at >= 0) annotations.splice(at, 1);
      continue;
    }
    if (op.type === 'addPage') {
      if (!pages.some(page => page.id === op.page.id) && pages.length < 500) {
        // After the page it follows when that one still exists, else at the end.
        const after = op.after === undefined ? -1 : pages.findIndex(page => page.id === op.after);
        pages.splice(after < 0 ? pages.length : after + 1, 0, { id: op.page.id, width: op.page.width, height: op.page.height, ...(op.page.template && { template: op.page.template }), strokes: [] });
      }
      continue;
    }
    const index = pages.findIndex(page => page.id === op.page);
    if (index < 0) continue; // the page was removed elsewhere
    const page = pages[index];
    if (op.type === 'add' && !page.strokes.includes(op.stroke)) page.strokes.push(op.stroke);
    if (op.type === 'remove') { const at = page.strokes.indexOf(op.stroke); if (at >= 0) page.strokes.splice(at, 1); }
    if (op.type === 'removePage' && page.pdfPage === undefined && !page.strokes.length && pages.length > 1) pages.splice(index, 1);
  }
  return pages;
}

export async function saveOperations(file, id, request) {
  checkOperationId(request);
  validateOperations(request.ops);
  const document = await readCanvas(file, id);
  const { hash, receipt } = receiptFor(document, request);
  if (receipt) return { revision: receipt.revision, duplicate: true };
  document.annotations ??= [];
  applyOperations(document.pages, request.ops, document.annotations);
  if (!document.annotations.length) delete document.annotations;
  return commit(file, document, request.operationId, hash, { ink: request.ops.some(op => !/Annotation$/.test(op.type)) });
}
