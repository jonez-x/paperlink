// In-memory snapshots of unsaved browser drafts, kept so the local CLI can import them.
export const DRAFT_LIMITS = {
  maxDrafts: 100,
  maxTotalBytes: 64 * 1024 * 1024,
  // Connected tabs republish every two seconds, so a quiet draft belongs to a closed tab.
  idleMilliseconds: 15 * 60 * 1000
};

const sizeOf = strokes => strokes.reduce((total, stroke) => total + stroke.length, 0);

export class DraftStore {
  constructor(limits = DRAFT_LIMITS, now = () => Date.now()) {
    this.limits = limits;
    this.now = now;
    this.drafts = new Map();
    this.totalBytes = 0;
  }

  prune() {
    const cutoff = this.now() - this.limits.idleMilliseconds;
    for (const [id, draft] of this.drafts) if (draft.touched < cutoff) this.remove(id);
  }

  remove(id) {
    const draft = this.drafts.get(id);
    if (!draft) return;
    this.totalBytes -= draft.bytes;
    this.drafts.delete(id);
  }

  get(id) {
    this.prune();
    return this.drafts.get(id);
  }

  // Store a tab's latest strokes. Returns the canvas it was imported into, if any.
  publish(id, strokes) {
    this.prune();
    const draft = this.drafts.get(id);
    if (draft?.document) {
      // The tab now adopts the imported canvas; free the strokes but keep the
      // binding so a retried CLI import stays idempotent until the entry expires.
      this.totalBytes -= draft.bytes;
      Object.assign(draft, { strokes: null, bytes: 0, touched: this.now() });
      return draft.document;
    }
    if (!draft && this.drafts.size >= this.limits.maxDrafts) {
      throw Object.assign(new Error('Too many browser drafts. Close unused tabs or wait a few minutes.'), { status: 429 });
    }
    const bytes = sizeOf(strokes);
    if (this.totalBytes - (draft?.bytes || 0) + bytes > this.limits.maxTotalBytes) {
      throw Object.assign(new Error('Browser drafts exceed the server memory limit. Import or close drafts first.'), { status: 429 });
    }
    this.totalBytes += bytes - (draft?.bytes || 0);
    this.drafts.set(id, { ...draft, strokes, bytes, touched: this.now(), updatedAt: new Date(this.now()).toISOString() });
    return null;
  }

  markImported(id, document) {
    const draft = this.drafts.get(id);
    if (draft) draft.document = document;
  }

  list() {
    this.prune();
    return [...this.drafts].map(([id, draft]) => ({
      id, strokes: draft.strokes ? draft.strokes.length : null, updatedAt: draft.updatedAt, importedCanvas: draft.document?.id
    }));
  }
}
