import { readFile, rename, unlink, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function validateStrokes(strokes) {
  if (!Array.isArray(strokes) || strokes.length > 20000 ||
      strokes.some(s => typeof s !== 'string' || s.length > 1000000 ||
        !/^M [-+\d.eE ,]+ l 0\.01 0(?: L [-+\d.eE ,]+)*$/.test(s))) {
    throw Object.assign(new Error('Invalid stroke data.'), { status: 400 });
  }
}

// Reads a canvas file. With `id`, the file must still contain that canvas, so a
// file replaced or renamed behind Paperlink's back is never served by mistake.
export async function readCanvas(file, id) {
  if (id !== undefined && !/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error('Invalid canvas ID.'), { status: 400 });
  let document;
  try { document = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw error instanceof SyntaxError ? new Error('Not a readable canvas file: invalid JSON.') : error; }
  if (document?.format !== 'paperlink' || document.version !== 1 || !/^[a-f0-9-]{36}$/.test(document.id ?? '') ||
      typeof document.title !== 'string' || !Array.isArray(document.pages) || document.pages.length !== 1 ||
      !Number.isInteger(document.revision)) {
    throw new Error('Unsupported document format.');
  }
  if (id !== undefined && document.id !== id) throw Object.assign(new Error('The file no longer contains this canvas.'), { code: 'ENOENT' });
  validateStrokes(document.pages[0].strokes);
  return document;
}

export async function saveCanvas(file, id, request) {
  validateStrokes(request.strokes);
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
  document.pages[0].strokes = request.strokes;
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
