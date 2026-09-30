/**
 * conformance.ts — the ONE WatermarkStore contract suite, exported so every
 * backend proves swappability against the SAME assertions (the P-050 gate),
 * mirroring presence/conformance.ts and event-log/conformance.ts.
 *
 * Consumed by:
 *   - `watermark-store.test.ts` (package): InMemoryWatermarkStore.
 *   - the operator's live-PG integration test: PgWatermarkStore.
 *
 * Cases use unique owner ids per case (a `runPrefix`), so the SAME suite is
 * safe against a SHARED live PG table (read is per-owner, so accumulation
 * never pollutes another case — no cleanup hook needed, unlike presence's
 * global `list()`). `opts.ready` soft-skips the whole suite when PG is
 * unreachable.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { emptyWatermark } from '../core/watermark';
import type { WatermarkStore } from './types';

export function describeWatermarkStoreConformance(
  name: string,
  makeStore: () => WatermarkStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`WatermarkStore conformance — ${name}`, () => {
    let skip = false;
    const runPrefix = `wmconf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let n = 0;
    const owner = (): string => `${runPrefix}-${n++}`;

    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('read of an unknown owner returns an empty watermark', async () => {
      if (skip) return;
      const store = makeStore();
      expect(await store.read(owner())).toEqual(emptyWatermark());
    });

    it('write persists and is returned merged; read sees it', async () => {
      if (skip) return;
      const store = makeStore();
      const o = owner();
      const written = await store.write(o, { messages_since_ts: '2026-01-01T00:00:00.000Z' });
      expect(written.messages_since_ts).toBe('2026-01-01T00:00:00.000Z');
      const read = await store.read(o);
      expect(read.messages_since_ts).toBe('2026-01-01T00:00:00.000Z');
    });

    it('write is a partial merge — omitted fields keep their value', async () => {
      if (skip) return;
      const store = makeStore();
      const o = owner();
      await store.write(o, { messages_since_ts: 'm1', plan_events_since_ts: 'p1' });
      const after = await store.write(o, { messages_since_ts: 'm2' });
      expect(after.messages_since_ts).toBe('m2'); // updated
      expect(after.plan_events_since_ts).toBe('p1'); // preserved
      expect((await store.read(o)).plan_events_since_ts).toBe('p1');
    });

    it('subscriptions_fired is replaced, not appended', async () => {
      if (skip) return;
      const store = makeStore();
      const o = owner();
      await store.write(o, { subscriptions_fired: ['a', 'b'] });
      const after = await store.write(o, { subscriptions_fired: ['c'] });
      expect(after.subscriptions_fired).toEqual(['c']);
      expect((await store.read(o)).subscriptions_fired).toEqual(['c']);
    });
  });
}
