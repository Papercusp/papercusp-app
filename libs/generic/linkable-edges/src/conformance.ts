/**
 * linkable-edges/conformance.ts — the ONE contract suite for LinkableStore, so
 * every backend (the in-memory double + any persistent store) proves
 * swappability against the SAME assertions. Imports vitest, so it lives behind
 * the dedicated `@papercusp/linkable-edges/conformance` subpath, NOT the package
 * barrel.
 *
 * Cases mint unique ids per run (a `runPrefix`) so the suite is safe against a
 * SHARED live table without a cleanup hook — every query filters by an id that
 * no other run uses.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { type LinkableStore, type ObjectRef } from './types';

function prefix(tag: string): { runPrefix: string; uid: () => string } {
  const runPrefix = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let n = 0;
  return { runPrefix, uid: () => `${runPrefix}-${n++}` };
}

export function describeLinkableStoreConformance(
  name: string,
  makeStore: () => LinkableStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`LinkableStore conformance — ${name}`, () => {
    let skip = false;
    const { uid } = prefix('linkconf');
    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('link is idempotent; listOut + listIn find the edge; rel filter works', async () => {
      if (skip) return;
      const store = makeStore();
      const src: ObjectRef = { kind: 'issue', ref: uid() };
      const dst: ObjectRef = { kind: 'plan', ref: uid() };
      await store.link(src, dst, 'blocks', { created_by: 'me', created_ts: '2026-01-01T00:00:00.000Z' });
      await store.link(src, dst, 'blocks', { created_ts: '2026-01-02T00:00:00.000Z' }); // dup → no-op
      const out = await store.listOut(src);
      expect(out).toHaveLength(1);
      expect(out[0].dst).toEqual(dst);
      expect(out[0].rel).toBe('blocks');
      expect(await store.listIn(dst)).toHaveLength(1);
      expect(await store.listOut(src, { rel: 'relates' })).toEqual([]);
      expect(await store.listOut(src, { rel: 'blocks' })).toHaveLength(1);
    });

    it('listOutMany batches: returns edges across many srcs, groups + filters by rel', async () => {
      if (skip) return;
      const store = makeStore();
      const a: ObjectRef = { kind: 'conversation', ref: uid() };
      const b: ObjectRef = { kind: 'conversation', ref: uid() };
      const c: ObjectRef = { kind: 'conversation', ref: uid() }; // no edges → absent
      const t1: ObjectRef = { kind: 'topic', ref: uid() };
      const t2: ObjectRef = { kind: 'topic', ref: uid() };
      await store.link(a, t1, 'tagged', { created_ts: '2026-01-01T00:00:00.000Z' });
      await store.link(a, t2, 'tagged', { created_ts: '2026-01-02T00:00:00.000Z' });
      await store.link(b, t1, 'tagged', { created_ts: '2026-01-01T00:00:00.000Z' });
      await store.link(a, b, 'relates', { created_ts: '2026-01-03T00:00:00.000Z' });

      expect(await store.listOutMany([])).toEqual([]);

      const tagged = await store.listOutMany([a, b, c], { rel: 'tagged' });
      // a→t1, a→t2, b→t1 (the 'relates' edge is filtered out by rel)
      expect(tagged).toHaveLength(3);
      const aTags = tagged.filter((l) => l.src.ref === a.ref).map((l) => l.dst.ref);
      expect(aTags).toEqual([t1.ref, t2.ref]); // oldest-first, like listOut
      expect(tagged.filter((l) => l.src.ref === b.ref).map((l) => l.dst.ref)).toEqual([t1.ref]);
      expect(tagged.some((l) => l.src.ref === c.ref)).toBe(false);

      // Without a rel filter, the 'relates' edge comes back too.
      const all = await store.listOutMany([a]);
      expect(all.map((l) => l.rel).sort()).toEqual(['relates', 'tagged', 'tagged']);
    });

    it('listInMany batches: returns edges into many dsts, groups + filters by rel', async () => {
      if (skip) return;
      const store = makeStore();
      const x: ObjectRef = { kind: 'issue', ref: uid() };
      const y: ObjectRef = { kind: 'issue', ref: uid() };
      const z: ObjectRef = { kind: 'issue', ref: uid() }; // no in-edges → absent
      const p: ObjectRef = { kind: 'plan', ref: uid() };
      const q: ObjectRef = { kind: 'feature', ref: uid() };
      await store.link(p, x, 'blocks', { created_ts: '2026-01-01T00:00:00.000Z' });
      await store.link(q, x, 'relates', { created_ts: '2026-01-02T00:00:00.000Z' });
      await store.link(p, y, 'blocks', { created_ts: '2026-01-01T00:00:00.000Z' });

      expect(await store.listInMany([])).toEqual([]);

      const blocks = await store.listInMany([x, y, z], { rel: 'blocks' });
      // p→x, p→y (the 'relates' edge is filtered out by rel)
      expect(blocks).toHaveLength(2);
      expect(blocks.filter((l) => l.dst.ref === x.ref).map((l) => l.src.ref)).toEqual([p.ref]);
      expect(blocks.filter((l) => l.dst.ref === y.ref).map((l) => l.src.ref)).toEqual([p.ref]);
      expect(blocks.some((l) => l.dst.ref === z.ref)).toBe(false);

      // Without a rel filter, the 'relates' edge comes back too.
      const all = await store.listInMany([x]);
      expect(all.map((l) => l.rel).sort()).toEqual(['blocks', 'relates']);
    });

    it('unlink removes the edge (idempotent)', async () => {
      if (skip) return;
      const store = makeStore();
      const src: ObjectRef = { kind: 'feature', ref: uid() };
      const dst: ObjectRef = { kind: 'topic', ref: uid() };
      await store.link(src, dst, 'tagged', { created_ts: '2026-01-01T00:00:00.000Z' });
      await store.unlink(src, dst, 'tagged');
      await store.unlink(src, dst, 'tagged'); // idempotent
      expect(await store.listOut(src)).toEqual([]);
    });
  });
}
