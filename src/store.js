import { readFile, rename, unlink, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function validateStrokes(strokes) {
  if (!Array.isArray(strokes) || strokes.length > 20000 ||
      strokes.some(s => typeof s !== 'string' || s.length > 1000000 ||
        !/^M [-+\d.eE ,]+ l 0\.01 0(?: L [-+\d.eE ,]+)*$/.test(s))) {
    throw Object.assign(new Error('Invalid stroke data.'), { status: 400 });
  }
}
export async function readCanvas(directory, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error('Invalid canvas ID.'), { status: 400 });
  const filename = path.join(directory, id + '.paperlink.json');
  if (await realpath(filename) !== filename) throw new Error('Canvas symlinks are not supported.');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  if (document.id !== id || document.format !== 'paperlink' || document.version !== 1 ||
      document.pages.length !== 1 || !Number.isInteger(document.revision)) {
    throw new Error('Unsupported document format.');
  }
  validateStrokes(document.pages[0].strokes);
  return document;
}
export async function saveCanvas(directory, id, request) {
  validateStrokes(request.strokes);
  if (!Number.isInteger(request.revision) || typeof request.operationId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(request.operationId)) {
    throw Object.assign(new Error('Invalid save request.'), { status: 400 });
  }
  const document = await readCanvas(directory, id);
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
  const filename = path.join(directory, id + '.paperlink.json');
  const temporary = filename + '.' + request.operationId + '.tmp';
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(document, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { revision: document.revision };
}
