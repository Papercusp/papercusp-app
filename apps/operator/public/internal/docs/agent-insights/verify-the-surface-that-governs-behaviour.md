# Verify the surface that governs behaviour, not the one you wrote
URL: /internal/docs/agent-insights/verify-the-surface-that-governs-behaviour

Four live cases where a read or write returned ok, changed the surface you were looking at, and did not reflect the surface that actually governs what an agent or the runtime can do. Includes the exact queries that return the inverse of the truth.

## The shape

A read or write returns `ok`. It changes — or accurately describes — **the surface you are
looking at**. It does *not* reflect the surface that actually governs what an agent or the
runtime can do.

The reason this is dangerous rather than merely annoying: each surface is *individually
convincing*. Nothing errors. A verification step that consults the wrong object returns a
confident, specific, wrong answer — and because you *checked*, you stop looking.

Four instances surfaced in a single afternoon leading one fleet
(`stop-discarded-dedup-and-audit-server-polling-2026-07-26`). They are unrelated
subsystems with the same failure shape, which is why this is written as a habit rather
than four bug notes.

## 1. A composed-await leaf row is not self-describing

`harness_shared.event_awaits` rows belonging to a **composed** await (`events:await { spec }`) carry `expires_ts: NULL` and `timeout_behavior: 'expire'` **by design**. The
leaves do not own the deadline. The parent does:

```sql
-- MISLEADING: leaves of a composed await always look deadline-less
SELECT id, event_key, expires_ts, timeout_behavior
  FROM harness_shared.event_awaits
 WHERE subscriber_id = '<owner>' AND fired_at IS NULL;

-- AUTHORITATIVE: the root node owns the deadline AND the any/all semantics
SELECT id, required_count, fired_count, expires_ts, timeout_behavior
  FROM harness_shared.event_await_nodes
 WHERE id = <root_id>;
```

**Rule:** any `event_awaits` row with a non-null `root_id` must be interpreted against its
root node. `required_count` is what tells you whether the wait is `any` or `all`.

Reading the leaves alone once produced a confident report of a permanent, unbreakable
fleet deadlock. The reality was an `any`-of-two wait with a 30-minute `wake` deadline —
three exits, self-resolving. The `NULL` was normal bookkeeping, not a missing timeout.

> A related trap in the same table: `expires_ts: NULL` + `timeout_behavior: 'expire'` is
> also the **standard `coord:inbox-wake:<owner>` idiom** and entirely deliberate. Do not
> "fix" it.

`fleet:leader-brief` compounds this by rendering a composed park as flat leaf keys with the
root listed as a sibling of its own leaves — filed as `EI-18732218464905145`.

## 2. Clearing a plan `blocked-by` does not unblock the work-item

`plans:set-item-blocked-by { item, blockedBy: [] }` returns `ok` and correctly rewrites the
plan file. The **linked work-item stays blocked**: its `plan-lane:<slug>#<item>`
externalBlocker remains `status: 'active'` and its state remains `blocked`, so the item is
unclaimable — with no error on either side.

The lane-sync re-runs when a blocking item **completes**, not when the edge is removed
directly. So the completion path propagates and the manual path does not.

```
work_items:set_blocker { id, ref: 'plan-lane:<slug>#<item>', clear: true }
work_items:set_state   { id, state: 'open' }
```

Filed as `EI-18732669095544832`. Symptom to recognise: you "unblocked" something and a
member sits idle anyway.

## 3. Work-item and plan-item claims can diverge at a compaction boundary

A member that compacts mid-work can release its **work-item** claim while its
**plan-item lane** claim survives. The two surfaces then contradict each other:

* `work_items:get` → `assignee: NONE` ("unowned, take it")
* `plans:set-status` → `claim_conflict`, live peer holds the lane

Both describe the same work at the same moment. An agent acting on either alone behaves
reasonably and still collides. Check both before claiming *or* closing. Filed as
`EI-18734870651452334`.

## 4. Code in the tree is not a working feature

A migration can be written, committed, tested, and **never applied**. Every artifact check
passes; the feature throws `relation does not exist` the first time it runs.

Two effect checks settle it, and they are different questions — run both:

```sql
-- Does the thing the code needs actually EXIST?
SELECT to_regclass('harness_shared.<table>');
```

```
db:migrations { like: "<nnn>" }
```

The second asks whether the migration is **ledgered**. Without that row every deploy
re-runs the DDL, and a lock-contending re-run can trip the deploy's `lock_timeout`.

Ask it with the verb rather than a hand-written `schema_migrations` query, because the
answer you are chasing here is an *absence*, and a bare zero rows is the one result you
cannot interpret: `db:migrations` returns a verdict instead — applied, pending,
draft-not-armed, or no-such-migration. A `.DRAFT`-suffixed file is invisible to the runner
by design, so "the file is there and nothing applied it" is a state you will actually hit.

Grepping for the symbols and `ls`-ing the migration *file* is an artifact check and it
passes on a dead feature. Both checks above are effect checks.

## The habit

**For anything with a runtime effect, name what would BREAK if the change were incomplete,
then check THAT.**

| Artifact check (weak)         | Effect check (what to run)                                    |
| ----------------------------- | ------------------------------------------------------------- |
| the migration file exists     | `to_regclass(...)` **and** the `db:migrations` ledger verdict |
| my write returned ok          | can the work actually be **claimed** now?                     |
| the symbols are in the file   | does the wired timer/handler actually fire without throwing?  |
| the leaf row says no deadline | what does the **root node** say?                              |

Two corollaries earned the same afternoon:

* **Read the source before implementing anything a task says to "add."** On a fleet where
  peers compact mid-work, *already-built-but-unrecorded* is an expected state, not an
  exotic one — it happened twice in one plan. The cheapest first step for "add X" is
  checking whether X exists.
* **Record uncertainty as uncertainty in carry notes.** Writing `PICKUP UNCONFIRMED`
  instead of `dispatched` is the only reason case 2 was caught at all; a confident note
  would have hidden it until wind-down.

And the sharpest version, because it is counter-intuitive: **when a cheap check CONFIRMS an
alarming reading, that is exactly when to ask what the check assumes about the data model.**
A confirming check ends inquiry. A wrong confirming check ends it in the wrong place.
