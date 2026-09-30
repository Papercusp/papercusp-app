# Work-item checkpoints: write and read must key by the item's OWN harness
URL: /internal/docs/agent-insights/checkpoint-harness-key-must-match-write-and-read

EI-8805 — a harness-null work-item's checkpoint was silently lost because the write keyed the carry-note scope by the session harness while the read keyed by the item's own (null) harness.

# Work-item checkpoints: write and read must key by the item's OWN harness

A work-item checkpoint (`work_items:checkpoint` → `setWorkItemCheckpoint`) is a
carry-note stored under the scope key `workitem:<harness>:<id>`. The re-injection
/ recovery seams (`work_items:get`, spawn-hydration, the compaction recovery
block) read it back. **Write and read MUST resolve `<harness>` to the same value
or the write silently orphans the checkpoint** — the write returns `ok` + a byte
length, but the read returns `null`. The loss is invisible until a successor (or a
post-compaction resume) needs the state and finds nothing.

## The bug (EI-8805)

The write keyed by the **session/arg** harness: `it.harness ?? args.harness ??
ctx.harnessSlug ?? …`. For a **harness-null item** — an issue-family EI filed
from an *unscoped* su session (`ctx.harnessSlug === '*'`), or worked from a
*scoped* session (`'papercup'`) — that resolves to a *non-null* harness. But
`work_items:get` reads the checkpoint keyed by the **item's own** harness
(`workItem.harness`), which is `null`. `workitem:*:EI-x` (written) ≠
`workitem:<null>:EI-x` (read) → every read-back is `null`.

Harness-null EIs are the common case (any improvement filed from an unscoped
session), and the checkpoint is exactly the state compaction recovery depends on.

## The contract (the fix)

1. **Key by the item's canonical harness on BOTH sides.** The read side already
   did (`workItem.harness`); the write side (`work_items:checkpoint`, `park`) now
   looks the item up and keys by `item.harness` (arg/ctx is only a
   disambiguation *hint* for a feature id that repeats across harnesses; `'*'` is
   sanitized to no hint). Never substitute the session harness for the item's own.
2. **Canonicalize null in the store.** `null` / `''` / the `'*'` wildcard all
   collapse to one namespace (`checkpointScopeHarness`), so a harness-null item
   has one stable key and `null`/`'*'` written by an unscoped session round-trip.

## The general lesson

Any keyed store whose **write key** and **read key** are computed at *different*
call sites (here: a tool handler vs. the item's DB row) is a silent-data-loss
trap when a value can be absent (`null`) on one path and defaulted (session
context) on the other. Derive the key from the **entity's own identity**, not the
caller's ambient context — and add a **write-then-read-back** test covering the
null/absent case (the recurrence guard here lives in
`work-item-checkpoint.integration.test.ts`).
