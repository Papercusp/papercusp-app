/**
 * linkable-edges/memory-store.ts — an in-memory LinkableStore double. Mirrors a
 * persistent backend's semantics exactly (idempotency on (src,dst,rel), sort by
 * (created_ts, id) ascending) so both pass ONE conformance suite
 * (conformance.ts) — the swappability proof. Zero I/O, useful as a test double
 * or a process-local graph.
 */

import { type LinkableStore, type LinkRow, type ObjectRef, objectKey } from './types';
import { LinkBackedTaggable } from './taggable';

export class InMemoryLinkStore implements LinkableStore {
  private rows: LinkRow[] = [];
  private seq = 0;

  async link(src: ObjectRef, dst: ObjectRef, rel: string, opts: { created_by?: string; created_ts: string }): Promise<void> {
    const exists = this.rows.some((r) => sameRef(r.src, src) && sameRef(r.dst, dst) && r.rel === rel);
    if (exists) return;
    this.rows.push({
      id: ++this.seq,
      src: { ...src },
      dst: { ...dst },
      rel,
      created_by: opts.created_by ?? null,
      created_ts: opts.created_ts,
    });
  }

  async unlink(src: ObjectRef, dst: ObjectRef, rel: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(sameRef(r.src, src) && sameRef(r.dst, dst) && r.rel === rel));
  }

  async listOut(src: ObjectRef, opts: { rel?: string } = {}): Promise<LinkRow[]> {
    return this.rows
      .filter((r) => sameRef(r.src, src) && (opts.rel == null || r.rel === opts.rel))
      .sort((a, b) => a.created_ts.localeCompare(b.created_ts) || a.id - b.id)
      .map(cloneLink);
  }

  async listIn(dst: ObjectRef, opts: { rel?: string } = {}): Promise<LinkRow[]> {
    return this.rows
      .filter((r) => sameRef(r.dst, dst) && (opts.rel == null || r.rel === opts.rel))
      .sort((a, b) => a.created_ts.localeCompare(b.created_ts) || a.id - b.id)
      .map(cloneLink);
  }

  async listOutMany(srcs: ObjectRef[], opts: { rel?: string } = {}): Promise<LinkRow[]> {
    if (srcs.length === 0) return [];
    const want = new Set(srcs.map(objectKey));
    return this.rows
      .filter((r) => want.has(objectKey(r.src)) && (opts.rel == null || r.rel === opts.rel))
      .sort((a, b) => a.created_ts.localeCompare(b.created_ts) || a.id - b.id)
      .map(cloneLink);
  }

  async listInMany(dsts: ObjectRef[], opts: { rel?: string } = {}): Promise<LinkRow[]> {
    if (dsts.length === 0) return [];
    const want = new Set(dsts.map(objectKey));
    return this.rows
      .filter((r) => want.has(objectKey(r.dst)) && (opts.rel == null || r.rel === opts.rel))
      .sort((a, b) => a.created_ts.localeCompare(b.created_ts) || a.id - b.id)
      .map(cloneLink);
  }
}

function sameRef(a: ObjectRef, b: ObjectRef): boolean {
  return a.kind === b.kind && a.ref === b.ref;
}
function cloneLink(r: LinkRow): LinkRow {
  return { ...r, src: { ...r.src }, dst: { ...r.dst } };
}

/** Taggable over the in-memory link store. */
export class InMemoryTaggableStore extends LinkBackedTaggable {
  constructor(links: InMemoryLinkStore) {
    super(links);
  }
}
