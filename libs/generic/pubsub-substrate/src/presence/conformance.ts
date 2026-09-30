/**
 * describePresenceConformance — the shared PresenceStore contract suite.
 *
 * The SAME assertions run against BOTH `InMemoryPresenceStore` (the test
 * double) and `PgPresenceStore` (production, over a live org PG). That
 * dual run is what actually proves the two impls are swappable (P-050) —
 * the presence analogue of `@papercusp/file-claim/conformance`. Before
 * this, only the in-mem double was asserted and the PG impl was merely
 * "exercised live in prod", so the swappability claim was unbacked.
 *
 * Two realities this suite is written to tolerate, so the SAME cases pass
 * for both backends:
 *   1. No injectable clock on PG — it stamps `now()`. So timing is asserted
 *      by ordering + monotonicity (with small real delays), never exact
 *      values. Exact stale-boundary assertions need a fake clock and stay
 *      in-mem-only (see presence.test.ts).
 *   2. The PG table is SHARED and non-empty (other agents' live rows). So
 *      every case mints unique owner ids + a unique workspace, filters
 *      global `list()` results to its own owners, and clears its rows after.
 *   3. Timestamp representation differs (postgres-js returns `Date`; the
 *      in-mem double returns ISO strings) — both are JSON-identical, so
 *      time is compared via `new Date(x).getTime()`, not string identity.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PresenceIdentity, PresenceStore } from './types';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ms = (t: string): number => new Date(t).getTime();

/**
 * Register the PresenceStore contract cases against `makeStore`.
 *
 * @param makeStore returns a store to test — a fresh one per case for the
 *   in-mem double; a shared handle for PG (isolation is by unique owner id).
 * @param opts.ready optional async gate; when it resolves `false` (e.g. PG
 *   unreachable) every case soft-skips instead of failing.
 */
export function describePresenceConformance(
  name: string,
  makeStore: () => PresenceStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`PresenceStore conformance — ${name}`, () => {
    let skip = false;
    const runPrefix = `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let n = 0;
    const created: Array<{ store: PresenceStore; ownerId: string }> = [];

    function ident(
      store: PresenceStore,
      suffix: string,
      workspaceId: string | null = 'w1',
    ): PresenceIdentity {
      const ownerId = `${runPrefix}-${n++}-${suffix}`;
      created.push({ store, ownerId });
      return { ownerId, ownerLabel: `lbl-${suffix}`, source: 'static-client', workspaceId };
    }

    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    afterEach(async () => {
      // Self-clean every owner this case minted — load-bearing on the
      // shared live PG table so cases don't see each other's rows.
      for (const { store, ownerId } of created.splice(0)) {
        try {
          await store.clear(ownerId);
        } catch {
          /* best-effort */
        }
      }
    });

    it('write upserts; get returns the written state and is fresh', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id, {
        intent: 'first',
        currentFiles: ['x.ts'],
        currentPlanSlug: 'p1',
        host: 'h',
        pid: 42,
      });
      const rec = await store.get(id.ownerId);
      expect(rec).not.toBeNull();
      expect(rec!.ownerId).toBe(id.ownerId);
      expect(rec!.ownerLabel).toBe('lbl-a');
      expect(rec!.source).toBe('static-client');
      expect(rec!.workspaceId).toBe('w1');
      expect(rec!.intent).toBe('first');
      expect(rec!.currentFiles).toEqual(['x.ts']);
      expect(rec!.currentPlanSlug).toBe('p1');
      expect(rec!.host).toBe('h');
      expect(rec!.pid).toBe(42);
      expect(rec!.stale).toBe(false);
    });

    it('get returns null for an unknown owner', async () => {
      if (skip) return;
      const store = makeStore();
      expect(await store.get(`${runPrefix}-missing`)).toBeNull();
    });

    it('write returns the prior intent atomically: null on insert, then the replaced value', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'prior-intent');
      expect(await store.write(id, { intent: 'first' })).toBeNull();
      expect(await store.write(id, { intent: 'second' })).toBe('first');
      expect((await store.get(id.ownerId))?.intent).toBe('second');
    });

    it('re-write preserves startedAt and advances heartbeatAt', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id, { intent: 'first' });
      const first = await store.get(id.ownerId);
      await delay(8);
      await store.write(id, { intent: 'second', currentFiles: ['y.ts'] });
      const second = await store.get(id.ownerId);
      expect(second!.intent).toBe('second');
      expect(second!.currentFiles).toEqual(['y.ts']);
      expect(ms(second!.startedAt)).toBe(ms(first!.startedAt));
      expect(ms(second!.heartbeatAt)).toBeGreaterThanOrEqual(ms(first!.heartbeatAt));
    });

    it('intent_declared_at (EI-8988) advances only when the intent TEXT changes', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id, { intent: 'first' });
      const first = await store.get(id.ownerId);
      expect(first!.intentDeclaredAt).not.toBeNull();

      // Re-write with the SAME intent text: heartbeat/lastActiveAt may move,
      // intentDeclaredAt must NOT (no injectable clock on PG, so assert equality
      // rather than "didn't move forward").
      await delay(8);
      await store.write(id, { intent: 'first', currentFiles: ['x.ts'] });
      const same = await store.get(id.ownerId);
      expect(ms(same!.heartbeatAt)).toBeGreaterThanOrEqual(ms(first!.heartbeatAt));
      expect(ms(same!.intentDeclaredAt!)).toBe(ms(first!.intentDeclaredAt!));

      // touchActivity never touches it either.
      await delay(8);
      await store.touchActivity(id.ownerId);
      const afterActivity = await store.get(id.ownerId);
      expect(ms(afterActivity!.intentDeclaredAt!)).toBe(ms(first!.intentDeclaredAt!));

      // A genuinely new intent string advances it.
      await delay(8);
      await store.write(id, { intent: 'second' });
      const second = await store.get(id.ownerId);
      expect(second!.intent).toBe('second');
      expect(ms(second!.intentDeclaredAt!)).toBeGreaterThan(ms(first!.intentDeclaredAt!));
    });

    it('touchHeartbeat bumps heartbeat and is a no-op on a missing owner', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id, { intent: 'keep' });
      const before = await store.get(id.ownerId);
      await delay(8);
      await store.touchHeartbeat(id.ownerId);
      await store.touchHeartbeat(`${runPrefix}-nobody`); // must not throw
      const after = await store.get(id.ownerId);
      expect(after!.intent).toBe('keep'); // only heartbeat moved
      expect(ms(after!.heartbeatAt)).toBeGreaterThanOrEqual(ms(before!.heartbeatAt));
    });

    it('touchHeartbeat liveness (WI-3898 P1): sets pid/host only when reported, never clobbers an omitted field', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'live');
      await store.write(id, { intent: 'keep' });

      // First beat reports both.
      await store.touchHeartbeat(id.ownerId, { pid: 4242, host: 'box-a' });
      let rec = await store.get(id.ownerId);
      expect(rec!.pid).toBe(4242);
      expect(rec!.host).toBe('box-a');

      // A later beat that reports NEITHER must leave both untouched (never
      // clobbered to null/'').
      await store.touchHeartbeat(id.ownerId);
      rec = await store.get(id.ownerId);
      expect(rec!.pid).toBe(4242);
      expect(rec!.host).toBe('box-a');

      // Reporting only one field updates just that one.
      await store.touchHeartbeat(id.ownerId, { pid: 5555 });
      rec = await store.get(id.ownerId);
      expect(rec!.pid).toBe(5555);
      expect(rec!.host).toBe('box-a'); // untouched

      // A missing owner with liveness passed must still no-op, not throw.
      await store.touchHeartbeat(`${runPrefix}-nobody-live`, { pid: 1, host: 'x' });
    });

    it('heartbeat creates a row if absent (empty intent) and never clobbers a declared intent', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'hb');
      // create-if-absent — no prior write
      await store.heartbeat(id);
      let rec = await store.get(id.ownerId);
      expect(rec).not.toBeNull();
      expect(rec!.intent).toBe('');
      expect(rec!.ownerLabel).toBe('lbl-hb');
      expect(rec!.stale).toBe(false);
      // declare a real intent, then heartbeat must PRESERVE it (unlike write)
      await store.write(id, { intent: 'doing X', currentFiles: ['a.ts'], currentPlanSlug: 'p9' });
      const before = await store.get(id.ownerId);
      await delay(8);
      await store.heartbeat(id);
      rec = await store.get(id.ownerId);
      expect(rec!.intent).toBe('doing X'); // preserved
      expect(rec!.currentFiles).toEqual(['a.ts']); // preserved
      expect(rec!.currentPlanSlug).toBe('p9'); // preserved
      expect(ms(rec!.heartbeatAt)).toBeGreaterThanOrEqual(ms(before!.heartbeatAt)); // bumped
    });

    it('D-003 split: touchActivity bumps last_active_at; touchHeartbeat (keepalive) does NOT', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'act');
      // A declared write IS activity → last_active_at is set.
      await store.write(id, { intent: 'work' });
      const w = await store.get(id.ownerId);
      expect(w!.lastActiveAt).not.toBeNull();

      // KEEPALIVE: heartbeat advances, last_active_at MUST stay put (the whole
      // point of D-003 — the 60s supervisor beat is "process alive", not active).
      await delay(8);
      await store.touchHeartbeat(id.ownerId);
      await store.touchHeartbeat(`${runPrefix}-nobody-hb`); // missing owner: no-op
      const hb = await store.get(id.ownerId);
      expect(ms(hb!.heartbeatAt)).toBeGreaterThanOrEqual(ms(w!.heartbeatAt));
      expect(ms(hb!.lastActiveAt!)).toBe(ms(w!.lastActiveAt!)); // UNCHANGED — the guard

      // ACTIVITY: touchActivity bumps BOTH.
      await delay(8);
      await store.touchActivity(id.ownerId);
      await store.touchActivity(`${runPrefix}-nobody-act`); // missing owner: no-op
      const act = await store.get(id.ownerId);
      expect(ms(act!.lastActiveAt!)).toBeGreaterThan(ms(hb!.lastActiveAt!)); // moved now
      expect(ms(act!.heartbeatAt)).toBeGreaterThanOrEqual(ms(hb!.heartbeatAt));
    });

    it('clear removes the row', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id);
      await store.clear(id.ownerId);
      expect(await store.get(id.ownerId)).toBeNull();
    });

    it('list returns rows in deterministic ownerId order', async () => {
      if (skip) return;
      const store = makeStore();
      // Written youngest-heartbeat-last to prove order is NOT heartbeat-driven.
      const a = ident(store, 'a');
      await store.write(a);
      await delay(8);
      const b = ident(store, 'b');
      await store.write(b);
      await delay(8);
      const c = ident(store, 'c');
      await store.write(c);
      const ids = [a.ownerId, b.ownerId, c.ownerId];
      const mine = (await store.list()).filter((r) => ids.includes(r.ownerId));
      // presence-v2 P-005 / D-006: list() is ordered by ownerId (cache- and
      // diff-stable), NOT heartbeat. Compute the expected order with the same
      // comparison the stores use so it holds regardless of how many owners
      // prior cases minted (the shared counter).
      const expected = [...ids].sort((x, y) => x.localeCompare(y));
      expect(mine.map((r) => r.ownerId)).toEqual(expected);
    });

    it('list filters by workspace', async () => {
      if (skip) return;
      const store = makeStore();
      const ws = `${runPrefix}-ws`; // unique → isolates this case on the shared table
      const a = ident(store, 'a', ws);
      await store.write(a);
      await delay(8);
      const other = ident(store, 'other', `${ws}-other`);
      await store.write(other);
      await delay(8);
      const c = ident(store, 'c', ws);
      await store.write(c);
      const inWs = await store.list({ workspaceId: ws });
      // ownerId order (P-005), not heartbeat — robust to the shared counter.
      const expected = [a.ownerId, c.ownerId].sort((x, y) => x.localeCompare(y));
      expect(inWs.map((r) => r.ownerId)).toEqual(expected);
    });

    it('capabilityTags (WI-1546) is populate-once-then-keep, like agentRole/potSlug', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'tags');
      // First write with no capabilityTags → defaults to [].
      await store.write(id, { intent: 'first' });
      const first = await store.get(id.ownerId);
      expect(first!.capabilityTags).toEqual([]);

      // A write that DOES carry tags populates them.
      await store.write(id, { intent: 'second', capabilityTags: ['node', 'docker', 'pg'] });
      const withTags = await store.get(id.ownerId);
      expect(withTags!.capabilityTags).toEqual(['node', 'docker', 'pg']);

      // A LATER write that omits capabilityTags entirely must PRESERVE them —
      // never clobber back to [] (the exact hazard the COALESCE(NULLIF(...))
      // pattern in PgPresenceStore.write guards against).
      await store.write(id, { intent: 'third' });
      const preserved = await store.get(id.ownerId);
      expect(preserved!.capabilityTags).toEqual(['node', 'docker', 'pg']);

      // An explicit empty array also does not clobber (same "nothing new
      // reported" semantics as omitting the field).
      await store.write(id, { intent: 'fourth', capabilityTags: [] });
      const stillPreserved = await store.get(id.ownerId);
      expect(stillPreserved!.capabilityTags).toEqual(['node', 'docker', 'pg']);
    });

    it('list filters by potSlug (P-004 hive-scoped read)', async () => {
      if (skip) return;
      const store = makeStore();
      const ws = `${runPrefix}-hws`;
      const hiveA = `${runPrefix}-hiveA`;
      const inHive = ident(store, 'inhive', ws);
      await store.write(inHive, { potSlug: hiveA });
      const otherHive = ident(store, 'otherhive', ws);
      await store.write(otherHive, { potSlug: `${runPrefix}-hiveB` });
      const noHive = ident(store, 'nohive', ws);
      await store.write(noHive, {}); // hive_slug null — excluded by a hive filter

      // hive filter → only the matching-hive row.
      const inHiveRows = await store.list({ workspaceId: ws, potSlug: hiveA });
      expect(inHiveRows.map((r) => r.ownerId)).toEqual([inHive.ownerId]);
      // no hive filter → all three in the workspace (hive_slug ignored).
      const allRows = await store.list({ workspaceId: ws });
      expect(allRows.map((r) => r.ownerId).sort((x, y) => x.localeCompare(y))).toEqual(
        [inHive.ownerId, otherHive.ownerId, noHive.ownerId].sort((x, y) => x.localeCompare(y)),
      );
    });
  });
}
