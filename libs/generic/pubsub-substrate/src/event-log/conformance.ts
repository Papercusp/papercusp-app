/**
 * conformance.ts — the ONE CoordEventLog contract suite, exported so every
 * backend proves swappability against the SAME assertions (the P-050 gate),
 * mirroring `@papercusp/file-claim/conformance`.
 *
 * Consumed by:
 *   - `event-log.test.ts` (package): InMemoryCoordLog + FsCoordLog.
 *   - the operator's live-PG integration test: PgCoordLog.
 *
 * `describeFn` lets a caller pass `describe.skipIf(noPg)` so the PG run is
 * skipped when no database is reachable, without forking the assertions.
 */

import { afterEach, beforeEach, describe as vitestDescribe, expect, it } from 'vitest';
import type { CoordEnvelope } from '../core/envelope';
import type { CoordEventLog } from './types';

export interface CoordEventLogHarness {
  log: CoordEventLog;
  cleanup: () => Promise<void>;
}

export function envelope(
  p: Partial<CoordEnvelope> & Pick<CoordEnvelope, 'msg_id' | 'kind' | 'from'>,
): CoordEnvelope {
  return { ts: '2026-01-01T00:00:00.000Z', to: ['*'], ...p } as CoordEnvelope;
}

type DescribeFn = typeof vitestDescribe | typeof vitestDescribe.skip;

export function describeCoordEventLogConformance(
  name: string,
  make: () => Promise<CoordEventLogHarness>,
  describeFn: DescribeFn = vitestDescribe,
): void {
  describeFn(name, () => {
    let log: CoordEventLog;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      ({ log, cleanup } = await make());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('messages: per-writer append + union read', async () => {
      await log.appendLine('messages', 'A', envelope({ msg_id: 'a1', kind: 'message', from: 'A', to: ['B'] }));
      await log.appendLine('messages', 'B', envelope({ msg_id: 'b1', kind: 'message', from: 'B', to: ['A'] }));
      const lines = await log.readLines('messages');
      expect(lines.map((l) => l.msg_id).sort()).toEqual(['a1', 'b1']);
    });

    it('plan-events: append + read', async () => {
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'p1', kind: 'plan_event', from: 'system', plan_slug: 'x' }));
      const lines = await log.readLines('plan-events');
      expect(lines.map((l) => l.msg_id)).toEqual(['p1']);
    });

    it('bounded cursor timestamp filters retain boundary rows only when a composite tie-break is pending', async () => {
      const boundary = '2026-01-01T00:00:00.000Z';
      await log.appendLine('messages', 'cursor-test', envelope({ msg_id: 'line-before', kind: 'message', from: 'A', ts: '2025-12-31T23:59:00.000Z' }));
      await log.appendLine('messages', 'cursor-test', envelope({ msg_id: 'line-at', kind: 'message', from: 'A', ts: boundary }));
      await log.appendLine('messages', 'cursor-test', envelope({ msg_id: 'line-after', kind: 'message', from: 'A', ts: '2026-01-01T00:01:00.000Z' }));
      const strictLines = await log.readLinesBoundedCursor('messages', { limit: 10, beforeTs: boundary });
      expect(strictLines.rows.map((r) => r.envelope.msg_id)).toEqual(['line-before']);
      const tiedLines = await log.readLinesBoundedCursor('messages', { limit: 10, beforeTs: boundary, beforeMsgId: 'line-at' });
      expect(tiedLines.rows.map((r) => r.envelope.msg_id).sort()).toEqual(['line-at', 'line-before']);

      await log.putEvent('handoffs', 'event-before', envelope({ msg_id: 'event-before', kind: 'handoff', from: 'A', ts: '2025-12-31T23:59:00.000Z' }));
      await log.putEvent('handoffs', 'event-at', envelope({ msg_id: 'event-at', kind: 'handoff', from: 'A', ts: boundary }));
      await log.putEvent('handoffs', 'event-after', envelope({ msg_id: 'event-after', kind: 'handoff', from: 'A', ts: '2026-01-01T00:01:00.000Z' }));
      const strictEvents = await log.readEventsBoundedCursor('handoffs', { limit: 10, beforeTs: boundary });
      expect(strictEvents.rows.map((r) => r.envelope.msg_id)).toEqual(['event-before']);
      const tiedEvents = await log.readEventsBoundedCursor('handoffs', { limit: 10, beforeTs: boundary, beforeMsgId: 'event-at' });
      expect(tiedEvents.rows.map((r) => r.envelope.msg_id).sort()).toEqual(['event-at', 'event-before']);
    });

    it('handoffs: putEvent + getEvent + readEvents', async () => {
      await log.putEvent('handoffs', 'h1', envelope({ msg_id: 'h1', kind: 'handoff', from: 'A' }));
      expect((await log.getEvent('handoffs', 'h1'))?.msg_id).toBe('h1');
      expect((await log.readEvents('handoffs')).map((r) => r.msg_id)).toEqual(['h1']);
    });

    it('escalations: putEvent round-trips and getEvent misses null', async () => {
      await log.putEvent('escalations', 'e1', envelope({ msg_id: 'e1', kind: 'escalation', from: 'A', to: ['human'] }));
      expect((await log.getEvent('escalations', 'e1'))?.kind).toBe('escalation');
      expect(await log.getEvent('escalations', 'nope')).toBeNull();
    });

    // ── putEventIfAbsent: the CLAIM contract (WI-10769) ──────────────────────
    // Every backend must elect exactly ONE winner, because callers use the return
    // value to decide whether to act exactly once (announce a recovery, page a
    // human). A backend that returns `true` twice re-creates the duplicate-
    // announcement storm this primitive was added to end.

    it('putEventIfAbsent: first call creates and returns true', async () => {
      const created = await log.putEventIfAbsent('escalations', 'c1', envelope({ msg_id: 'c1', kind: 'escalation_resolved', from: 'A' }));
      expect(created).toBe(true);
      expect((await log.getEvent('escalations', 'c1'))?.msg_id).toBe('c1');
    });

    it('putEventIfAbsent: a second call returns false and does NOT overwrite', async () => {
      await log.putEventIfAbsent('escalations', 'c2', envelope({ msg_id: 'c2', kind: 'escalation_resolved', from: 'first', summary: 'original' }));
      const second = await log.putEventIfAbsent('escalations', 'c2', envelope({ msg_id: 'c2', kind: 'escalation_resolved', from: 'second', summary: 'overwrite attempt' }));
      expect(second).toBe(false);
      // Unlike putEvent (which upserts), a lost claim must leave the winner's row intact.
      const row = await log.getEvent('escalations', 'c2');
      expect(row?.from).toBe('first');
      expect(row?.summary).toBe('original');
      expect((await log.readEvents('escalations')).filter((r) => r.msg_id === 'c2')).toHaveLength(1);
    });

    it('putEventIfAbsent: N concurrent claims on one key elect EXACTLY ONE winner', async () => {
      // The actual defect shape: N request workers resolving the same escalation
      // in the same instant. Sequential calls cannot catch a read-then-write race;
      // only firing them together can.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          log.putEventIfAbsent('escalations', 'race', envelope({ msg_id: 'race', kind: 'escalation_resolved', from: `w${i}` })),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await log.readEvents('escalations')).filter((r) => r.msg_id === 'race')).toHaveLength(1);
    });

    it('putEventIfAbsent does not disturb putEvent: a prior putEvent row blocks the claim', async () => {
      await log.putEvent('escalations', 'c3', envelope({ msg_id: 'c3', kind: 'escalation', from: 'A' }));
      expect(await log.putEventIfAbsent('escalations', 'c3', envelope({ msg_id: 'c3', kind: 'escalation_resolved', from: 'B' }))).toBe(false);
      expect((await log.getEvent('escalations', 'c3'))?.kind).toBe('escalation');
    });

    it('putEvent is keyed: re-put on same msg_id overwrites, not duplicates', async () => {
      await log.putEvent('handoffs', 'k1', envelope({ msg_id: 'k1', kind: 'handoff', from: 'A' }));
      await log.putEvent('handoffs', 'k1', envelope({ msg_id: 'k1', kind: 'handoff', from: 'B' }));
      const all = await log.readEvents('handoffs');
      expect(all.filter((r) => r.msg_id === 'k1')).toHaveLength(1);
      expect((await log.getEvent('handoffs', 'k1'))?.from).toBe('B');
    });

    it('putEvents: batch write round-trips every record, empty is a no-op (WI-346)', async () => {
      // Empty batch must not throw and must write nothing.
      await log.putEvents('escalations', []);
      expect(await log.readEvents('escalations')).toEqual([]);
      // A batch of distinct records all round-trip — same keying as putEvent.
      await log.putEvents('escalations', [
        { msgId: 'b1', record: envelope({ msg_id: 'b1', kind: 'escalation', from: 'A', to: ['human'] }) },
        { msgId: 'b2', record: envelope({ msg_id: 'b2', kind: 'escalation', from: 'A', to: ['human'] }) },
        { msgId: 'b3', record: envelope({ msg_id: 'b3', kind: 'escalation_resolved', from: 'A', to: ['human'], related_msg_id: 'b1' }) },
      ]);
      expect((await log.readEvents('escalations')).map((r) => r.msg_id).sort()).toEqual(['b1', 'b2', 'b3']);
      expect((await log.getEvent('escalations', 'b2'))?.kind).toBe('escalation');
    });

    it('readLinesBounded: newest-first, limit, since_ts + plan_slug pushdown (plan-events, EI-1737)', async () => {
      // Append five plan_event lines across two plans, ascending ts.
      const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q1', kind: 'plan_event', from: 'system', plan_slug: 'alpha', ts: at(1) }));
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q2', kind: 'plan_event', from: 'system', plan_slug: 'beta', ts: at(2) }));
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q3', kind: 'plan_event', from: 'system', plan_slug: 'alpha', ts: at(3) }));
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q4', kind: 'plan_event', from: 'system', plan_slug: 'beta', ts: at(4) }));
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q5', kind: 'plan_event', from: 'system', plan_slug: 'alpha', ts: at(5) }));

      // newest-first, bounded
      expect((await log.readLinesBounded('plan-events', { limit: 2 })).map((r) => r.msg_id)).toEqual(['q5', 'q4']);
      // since_ts pushdown: strictly later than at(3) → q4, q5 (newest-first)
      expect((await log.readLinesBounded('plan-events', { limit: 10, sinceTs: at(3) })).map((r) => r.msg_id)).toEqual(['q5', 'q4']);
      // plan_slug pushdown: only alpha, newest-first
      expect((await log.readLinesBounded('plan-events', { limit: 10, planSlug: 'alpha' })).map((r) => r.msg_id)).toEqual(['q5', 'q3', 'q1']);
      // combined since_ts + plan_slug
      expect((await log.readLinesBounded('plan-events', { limit: 10, planSlug: 'alpha', sinceTs: at(1) })).map((r) => r.msg_id)).toEqual(['q5', 'q3']);
      // empty surface → []
      expect(await log.readLinesBounded('messages', { limit: 5 })).toEqual([]);
    });

    it('putEvents: a re-put on an existing msg_id upserts, not duplicates (WI-346)', async () => {
      await log.putEvent('handoffs', 'u1', envelope({ msg_id: 'u1', kind: 'handoff', from: 'A' }));
      await log.putEvents('handoffs', [
        { msgId: 'u1', record: envelope({ msg_id: 'u1', kind: 'handoff', from: 'B' }) },
        { msgId: 'u2', record: envelope({ msg_id: 'u2', kind: 'handoff', from: 'C' }) },
      ]);
      const all = await log.readEvents('handoffs');
      expect(all.filter((r) => r.msg_id === 'u1')).toHaveLength(1);
      expect((await log.getEvent('handoffs', 'u1'))?.from).toBe('B');
      expect(all.map((r) => r.msg_id).sort()).toEqual(['u1', 'u2']);
    });

    it('empty surfaces read as []', async () => {
      expect(await log.readLines('messages')).toEqual([]);
      expect(await log.readEvents('handoffs')).toEqual([]);
    });

    it('readEventsBounded: newest-first, limit, and kind filter (EI-1548)', async () => {
      // Distinct ascending ts so every backend agrees on newest-first: PG/InMemory
      // by append order, Fs by the ts approximation.
      await log.putEvent('escalations', 'e1', envelope({ msg_id: 'e1', kind: 'escalation', from: 'A', to: ['human'], ts: '2026-01-01T00:00:01.000Z' }));
      await log.putEvent('escalations', 'e2', envelope({ msg_id: 'e2', kind: 'escalation', from: 'A', to: ['human'], ts: '2026-01-01T00:00:02.000Z' }));
      await log.putEvent('escalations', 'r1', envelope({ msg_id: 'r1', kind: 'escalation_resolved', from: 'A', to: ['human'], ts: '2026-01-01T00:00:03.000Z' }));
      // Newest-first (append order), bounded to the limit.
      expect((await log.readEventsBounded('escalations', { limit: 2 })).map((r) => r.msg_id)).toEqual(['r1', 'e2']);
      expect((await log.readEventsBounded('escalations', { limit: 1 })).map((r) => r.msg_id)).toEqual(['r1']);
      // Kind filter selects only matching envelopes.
      const opens = await log.readEventsBounded('escalations', { limit: 10, kinds: ['escalation'] });
      expect(opens.map((r) => r.msg_id).sort()).toEqual(['e1', 'e2']);
      // Empty surface → [].
      expect(await log.readEventsBounded('handoffs', { limit: 5 })).toEqual([]);
    });

    it('readEventsBoundedCursor: newest-first, id cursor pages deep + exhausted flag (WI-3880)', async () => {
      await log.putEvent('escalations', 'e1', envelope({ msg_id: 'e1', kind: 'escalation', from: 'A', to: ['human'], ts: '2026-01-01T00:00:01.000Z' }));
      await log.putEvent('escalations', 'e2', envelope({ msg_id: 'e2', kind: 'escalation', from: 'A', to: ['human'], ts: '2026-01-01T00:00:02.000Z' }));
      await log.putEvent('escalations', 'e3', envelope({ msg_id: 'e3', kind: 'escalation', from: 'A', to: ['human'], ts: '2026-01-01T00:00:03.000Z' }));

      // Page 1: newest 2, not exhausted (e1 still older).
      const page1 = await log.readEventsBoundedCursor('escalations', { limit: 2 });
      expect(page1.rows.map((r) => r.envelope.msg_id)).toEqual(['e3', 'e2']);
      expect(page1.exhausted).toBe(false);
      const cursor = page1.rows[page1.rows.length - 1]!.id;

      // Page 2: walk past the first page via beforeId — reaches e1, now exhausted.
      const page2 = await log.readEventsBoundedCursor('escalations', { limit: 2, beforeId: cursor });
      expect(page2.rows.map((r) => r.envelope.msg_id)).toEqual(['e1']);
      expect(page2.exhausted).toBe(true);

      // A re-put keeps the SAME id (upsert, not a new append) — the cursor a
      // caller already holds still walks past it correctly.
      const beforePut = (await log.readEventsBoundedCursor('escalations', { limit: 10 })).rows;
      const e2IdBefore = beforePut.find((r) => r.envelope.msg_id === 'e2')!.id;
      await log.putEvent('escalations', 'e2', envelope({ msg_id: 'e2', kind: 'escalation', from: 'B', to: ['human'], ts: '2026-01-01T00:00:02.000Z' }));
      const afterPut = (await log.readEventsBoundedCursor('escalations', { limit: 10 })).rows;
      expect(afterPut.find((r) => r.envelope.msg_id === 'e2')!.id).toBe(e2IdBefore);

      // Empty surface → no rows, exhausted.
      const empty = await log.readEventsBoundedCursor('handoffs', { limit: 5 });
      expect(empty.rows).toEqual([]);
      expect(empty.exhausted).toBe(true);
    });

    it('readLinesBoundedCursor: newest-first, id cursor pages deep + exhausted flag (WI-3880)', async () => {
      const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q1', kind: 'plan_event', from: 'system', plan_slug: 'alpha', ts: at(1) }));
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q2', kind: 'plan_event', from: 'system', plan_slug: 'beta', ts: at(2) }));
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'q3', kind: 'plan_event', from: 'system', plan_slug: 'alpha', ts: at(3) }));

      const page1 = await log.readLinesBoundedCursor('plan-events', { limit: 2 });
      expect(page1.rows.map((r) => r.envelope.msg_id)).toEqual(['q3', 'q2']);
      expect(page1.exhausted).toBe(false);
      const cursor = page1.rows[page1.rows.length - 1]!.id;

      const page2 = await log.readLinesBoundedCursor('plan-events', { limit: 2, beforeId: cursor });
      expect(page2.rows.map((r) => r.envelope.msg_id)).toEqual(['q1']);
      expect(page2.exhausted).toBe(true);

      // planSlug pushdown composes with the cursor.
      const alphaOnly = await log.readLinesBoundedCursor('plan-events', { limit: 10, planSlug: 'alpha' });
      expect(alphaOnly.rows.map((r) => r.envelope.msg_id)).toEqual(['q3', 'q1']);

      // Empty surface → no rows, exhausted.
      const empty = await log.readLinesBoundedCursor('messages', { limit: 5 });
      expect(empty.rows).toEqual([]);
      expect(empty.exhausted).toBe(true);
    });
  });
}
