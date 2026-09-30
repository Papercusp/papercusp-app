# A readOnly corestore open is a point-in-time snapshot — refresh BEFORE you open
URL: /internal/docs/agent-insights/readonly-corestore-open-is-a-point-in-time-snapshot

rocksdb-native readOnly:true means RocksDB OpenForReadOnly: the handle is frozen at open() and never observes another process's later writes. So any refresh whose appends are performed by a DIFFERENT process (the live operator draining its outbox) must FULLY COMPLETE before the read-only open, not after. Open first and you replicate state frozen at open, silently omitting every op the refresh produced — while exiting 0 and printing a green 'drained to zero'. Also: observing that a store 'grew' never discriminates snapshot-at-open from tracks-live; only a held-open-vs-fresh-open A/B does.

## The mistake this doc prevents

You need to read a corestore that a **live process already holds** — on this box, the
release cut (`cut-seed`) reading the hive corestore the running operator has locked.
`readOnly: true` gets you in without a quiesce, which is genuinely the right call.

Then you write the obvious sequence:

```ts
// ❌ WRONG — ships stale state, exits 0, prints green
const store = new Corestore(dir, { readOnly: true, wait: false });
await store.ready();
await backfillLocalState(handle, pg, { force: true });   // enqueues ~8k ops
await waitForOperatorDrain({ pg, workspaceId, hive });   // operator appends them
await replicate(store);                                  // ← sees NONE of them
```

This looks airtight. The backfill runs, the drain completes, the log says
`operator drained to zero in 413514ms`, the process exits 0 — **and the artifact is
missing every single op the drain produced.**

## Why

`readOnly: true` is forwarded Corestore → hypercore-storage → `new RocksDB(dbPath, { ...opts, lock: this.deviceFile })` → `binding.init(readOnly, ...)`, and in
rocksdb-native that means RocksDB's **`OpenForReadOnly`**. That API opens a
**point-in-time snapshot**: the handle is frozen at `open()` and *never* observes
another process's subsequent writes. It is not a stale cache you can flush, and no
re-`get()` of the core refreshes it — the frozen view is below the hypercore layer.

RocksDB does have a mechanism for tracking a live primary — a **secondary** instance
plus explicit `TryCatchUpWithPrimary()` calls. **Corestore does not use it.** So there
is no "read-only but follows along" mode available here.

The consequence is a strict ordering rule:

> **Any refresh whose writes are performed by another process must FULLY COMPLETE
> before you take the read-only open.**

```ts
// ✅ RIGHT — refresh first, hold NOTHING open across it, then snapshot
let store = new Corestore(dir);           // try writable first
try { await store.ready(); }
catch (e) {
  if (!isCorestoreLockedError(e)) throw;  // don't silently degrade
  await store.close().catch(() => {});    // hold NOTHING across the refresh
  store = undefined;
}
if (locked) {
  await backfillLocalState(handle, pg, { force: true });
  await waitForOperatorDrain({ pg, workspaceId, hive });
  store = new Corestore(dir, { readOnly: true, wait: false });  // ← strictly after
  await store.ready();
}
```

What makes refresh-before-open possible at all is that **the refresh is not our
write**: `backfillLocalState` only touches Postgres (it enqueues outbox rows), and the
**live operator** is what appends to the store as it drains. We never need the write
lock — we just need to not look until it's done.

## `wait: false` is load-bearing

In hypercore-storage the `|| this.wait` clause binds **after** the `readOnly` clause, so
a truthy `wait` re-arms the DeviceFile lock **even under `readOnly: true`** — and fails
with a `File descriptor could not be locked` error identical to the one you were avoiding.
Pin it explicitly: `{ readOnly: true, wait: false }`.

(Related: that error comes from `fd-lock` (POSIX `fcntl`) via `device-file` — it is the
**corestore device file**, built in the `CorestoreStorage` constructor *before*
`_migrateStore`. It is **not** RocksDB's `db/LOCK`, which is where this bug is usually
mis-attributed.)

## The diagnostic — "it grew" proves nothing

The trap that makes this bug survive review: **observing that the store grew does not
discriminate** "snapshot at open" from "tracks live." A growing store is consistent with
both. An earlier pass here cited *"own-log grew 71,164 → 71,273"* as proof the wait-for-drain
worked. It proved nothing, and the claim had to be retracted.

The only test that discriminates is a **held-open-vs-fresh-open A/B**, while a writer is
actively appending:

```ts
const store = new Corestore(STORE, { readOnly: true, wait: false });
await store.ready();
const c0 = store.get({ key }); await c0.ready();
const L0 = c0.length;                       // T0 via the HELD open

await sleep(45_000);                        // let the live writer append

const c1 = store.get({ key }); await c1.ready();
const L1 = c1.length;                       // same held open, FRESH core handle
                                            // (defeats hypercore's length cache)

const store2 = new Corestore(STORE, { readOnly: true, wait: false });
await store2.ready();
const c2 = store2.get({ key }); await c2.ready();
const L2 = c2.length;                       // CONTROL: brand-new open, right now

// L1 > L0            → TRACKS_LIVE
// L1 === L0 && L2 > L0 → STALE_SNAPSHOT  ← what actually happens
```

Measured against the live operator on 2026-07-15:

```
T0 length=83311
T1 length=83311   (same held RO open, fresh core handle)  ← FROZEN
T1 length=84872   (FRESH RO open)                         ← sees growth
RESULT=STALE_SNAPSHOT
```

The dual of this A/B is how you prove the *fix*: a **delta against a known pre-cut
baseline**. Baseline own-log 87,662 (undrained 0) → backfill enqueued 8,092 → drained to
zero → seed manifest `coreLengths` **95,812**. `95,812 > 87,662` is only reachable if the
drain landed *before* the snapshot; the old ordering yields ≈87,662.

## Why this is worth a doc

The failure is in the **ships-green-does-nothing** class: a correct-looking sequence, an
exit code of 0, and a log line that actively asserts success (`drained to zero`) over an
artifact that is silently incomplete. Releases 0.0.9 and 0.0.10 both shipped seeds that
failed the same *class* of check, and this instance appeared **inside the fix for it** —
the ordering bug was introduced by the very patch that added the drain.

Guard it with a test that asserts **order**, not just outcome, and inject the steps so the
sequence is observable:

```ts
expect(calls).toEqual(['open:rw', 'backfill', 'drain', 'open:ro(wait=false)']);
expect(calls.indexOf('open:ro(wait=false)')).toBeGreaterThan(calls.indexOf('drain'));
```

The old ordering produces `['open:rw','open:ro','backfill','drain']` and fails both
assertions. An outcome-only test passes under both orderings — which is exactly how this
shipped in the first place.

## Sparse degrades correctly — leave it

A `--sparse` cut wants to append a fresh head snapshot (`produceLogSnapshot`) so it can
trim history. That is a **write**, so it is impossible under a read-only open. The correct
behavior is what the code already does: warn, and ship **FULL** history — larger, but
complete and correct. Do not try to reclaim sparse on the read-only path; sparse is a size
optimization, never a correctness requirement.

## Rule of thumb

* Need a consistent read of a store another process owns? `readOnly: true, wait: false`.
* Need it to be **current**? Do every refresh **first**, hold **nothing** open across it,
  and open **last**.
* Proving a live-store read is fresh? Never cite growth. Cite a **delta against a
  baseline**, or run the **held-vs-fresh A/B**.
