import { copyFile, readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// PDF worksheets: pdf.js (vendored in public/vendor/pdfjs) reads page sizes
// here; the browser renders the pages. The PDF stays a separate, unchanged
// file next to the canvas, which names it in `document.pdf`.

const VENDOR = new URL('../public/vendor/pdfjs/', import.meta.url);
let library;

async function pdfjs() {
  if (library) return library;
  // Reading page sizes needs no rendering; this stub satisfies pdf.js's Node check.
  globalThis.DOMMatrix ??= class DOMMatrix { constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); } };
  // pdf.js reports missing optional canvas support on import; that is expected here.
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try { library = await import(new URL('pdf.min.mjs', VENDOR).href); }
  finally { Object.assign(console, { log, warn }); }
  library.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;
  return library;
}

// Page sizes in PDF points, rotation applied.
export async function pdfPageSizes(file) {
  const { getDocument } = await pdfjs();
  let document;
  try {
    document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, isEvalSupported: false }).promise;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('PDF not found: ' + file);
    if (['EPERM', 'EACCES'].includes(error.code)) {
      throw new Error('No permission to read ' + file + '. macOS asks each app before it may read Downloads, Desktop, Documents and iCloud Drive: allow your terminal app in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then try again.');
    }
    throw new Error('Not a readable PDF: ' + path.basename(file) + (error.message ? ' (' + error.message + ')' : ''));
  }
  try {
    const sizes = [];
    for (let number = 1; number <= document.numPages; number++) {
      const { width, height } = (await document.getPage(number)).getViewport({ scale: 1 });
      sizes.push({ width, height });
    }
    return sizes;
  } finally { await document.destroy(); }
}

// Every page is 900 units wide like blank pages; the height keeps the aspect.
export const pageSize = ({ width, height }) => ({ width: 900, height: Math.round(900 * height / width * 10) / 10 });

const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');

// Puts the PDF into the canvas folder: a PDF already there is used in place,
// otherwise it is copied (and later moved and deleted with the canvas).
export async function placePdf(source, directory, freeName) {
  const name = path.basename(source);
  if (path.resolve(path.dirname(source)) === path.resolve(directory)) return { file: name, copied: false };
  const target = path.join(directory, name);
  try {
    if (await digest(target) === await digest(source)) return { file: name, copied: false };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const destination = await freeName(directory, path.basename(name, path.extname(name)), path.extname(name));
  await copyFile(source, destination, 1); // 1 = COPYFILE_EXCL
  return { file: path.basename(destination), copied: true, path: destination };
}

export async function removePlacedPdf(placed) {
  if (placed?.copied) await unlink(placed.path).catch(() => {});
}

export const validPdfName = name => typeof name === 'string' && /\.pdf$/i.test(name) && path.basename(name) === name && !name.startsWith('.');
