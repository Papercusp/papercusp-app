# @papercusp/projection-index

A generic, **event-maintained** structured→index projection.

Feed it source records as they change; it keeps an inverted index `key → entries`
**incrementally**, computing the minimal delta against each source's prior
contributions — so a record that **drops**, **retags**, or **edits** an entry is
handled without the caller diffing anything. Query a key to get the aggregated
entries: **no full scan, no re-summarisation, no drift.**

The domain mapping (record → entries) and the persistence are **injected**; the
lib owns only the incremental-maintenance algorithm. Zero I/O, zero domain
coupling, zero runtime deps.

> Canonical consumer: the topic-keyed "what + why" projection over plans /
> work-items / insights in
> [docs-and-memory-as-projections-2026-06-05] — query a subsystem-topic, get its
> decisions + work-items + insights, kept fresh by the event engine. But the lib
> is consumer-agnostic. See [generalize-libs-to-generic-2026-06-05] D-003 #11.

## Shape

```ts
import { ProjectionIndex, InMemoryProjectionStore } from '@papercusp/projection-index';

// A source record (e.g. a plan) and the compact entry you index it into.
interface Plan { topics: string[]; decisions: { id: string; title: string }[] }
type Entry = { planId: string; decisionId: string; title: string };

const index = new ProjectionIndex<Plan, Entry>({
  store: new InMemoryProjectionStore<Entry>(), // or a host-injected backend
  // PURE: a record → the entries it contributes. One entry per (topic, decision).
  projector: (plan) =>
    plan.topics.flatMap((topic) =>
      plan.decisions.map((d) => ({
        key: topic,                     // the bucket (a subsystem-topic)
        entryId: `decision:${d.id}`,    // stable id within this source
        kind: 'decision',               // optional query-time discriminator
        sortKey: d.id,                  // optional ordering within the key
        entry: { planId: 'P-1', decisionId: d.id, title: d.title },
      })),
    ),
});

// Maintain it as records change — the event-maintenance entry points:
await index.index('P-1', plan);                          // upsert
await index.applyChange({ op: 'delete', sourceId: 'P-1' }); // delete
await index.remove('P-1');                                // == delete

// Query a key — aggregated across every source, no scan:
const decisions = await index.query('coordination', { kinds: ['decision'], limit: 20 });
```

## Why it doesn't drift

Re-indexing a source **re-projects it and diffs** against what it contributed
before:

- An entry the record no longer produces → **deleted** from its key.
- An entry whose `key` changed → **moved** (delete old key, put new key).
- An entry whose payload/`sortKey`/`kind` changed → **upserted** in place.
- An unchanged record → **idempotent** (no observable change).

So the index is always exactly the projection of the current records — there is
no separate "rebuild" step that can fall behind, and no LLM re-summarisation per
change. The maintenance is `O(entries-of-the-changed-record)`, not `O(corpus)`.

## The seam

Two injection points, nothing else:

### `Projector<S, E>` — the domain mapping (pure)

`(record) => Contribution<E>[]`. A `Contribution` is
`{ key, entryId, entry, sortKey?, kind? }`. The `(sourceId, key, entryId)` triple
is a contribution's identity. Returning `[]` removes everything the source had.
Must be deterministic and side-effect-free — the consumer loads the record, the
projector shreds it.

### `ProjectionStore<E>` — where the index lives

```ts
interface ProjectionStore<E> {
  contributionsOf(sourceId): Promise<IndexedEntry<E>[]>; // for the diff
  applyDelta(sourceId, { put, delete }): Promise<void>;  // ATOMIC per source
  byKey(key, opts?): Promise<IndexedEntry<E>[]>;          // the query
}
```

`InMemoryProjectionStore` ships as the default and the reference a real backend is
conformance-tested against. A Postgres backend maps onto **one table** keyed by
`(source_id, key, entry_id)`:

| port method        | SQL |
|--------------------|-----|
| `contributionsOf`  | `SELECT … WHERE source_id = $1` |
| `applyDelta`       | `DELETE … ` + `INSERT … ON CONFLICT (source_id,key,entry_id) DO UPDATE`, in one tx |
| `byKey`            | `SELECT … WHERE key = $1 [AND kind = ANY($2)] ORDER BY sort_key [DESC] [LIMIT $3]` |

`applyDelta` **must be atomic** for the source — a partial apply can leave the
index inconsistent with the record.

## Event-maintenance wiring

The lib is event-system-agnostic (same boundary as `@papercusp/rules`: it owns
the algorithm, the consumer owns the I/O and the trigger). Wire your event engine
to call `applyChange` when a source record settles:

```ts
// pseudo: on a plan/work-item/insight change event
onChange(async (e) => {
  if (e.deleted) await index.applyChange({ op: 'delete', sourceId: e.id });
  else await index.applyChange({ op: 'upsert', sourceId: e.id, record: await load(e.id) });
});
```

In Papercusp that trigger is the shipped event-reaction engine (a
`plans:add-decision` / work-item / insight change → re-index the touched source);
the projector reads the plan's own structure (`## Decisions`, `companion-to`,
topic tags). That wiring is the **adapter** and lives in the host — not in this
lib.

## Purity

No I/O, no async, no dispatch inside the core decision path (`computeDelta` is a
pure function; `ProjectionIndex` only awaits the injected store). No durability,
no loop-protection, no domain types — those are the consumer's concern. That
boundary is what keeps the lib borrowable.

[docs-and-memory-as-projections-2026-06-05]: ../../../docs/plans (plan slug)
[generalize-libs-to-generic-2026-06-05]: ../../../docs/plans (plan slug)
