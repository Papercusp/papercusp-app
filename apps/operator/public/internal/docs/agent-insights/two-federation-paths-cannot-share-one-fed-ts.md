# Two federation paths for the same row can't coexist — cut over with mutual exclusion, not parallel writes
URL: /internal/docs/agent-insights/two-federation-paths-cannot-share-one-fed-ts

Re-graining a federated table (e.g. whole-blob plan → per-part) does NOT just mean "add the new path behind a flag". Both paths write the same row's content under ONE fed_ts LWW clock, so running them in parallel CLOBBERS. The flag must make them mutually exclusive (one sole writer when ON), and mig-214's "did fed_ts move?" heuristic forces the remote-apply to set origin='remote' + move fed_ts. Plus the restart-free deterministic-fed_ts=0 baseline.

## What

When you re-grain a federated table — replace a coarse path with a finer one
(the case: `harness_plans` whole-blob `plans-by-slug` → per-part `plan-parts`,
plan `plan-federation-regrain-2026-06-13`) — the obvious plan is "build the new
path alongside the old, flag-gated, flip when ready." **That plan is wrong if
both paths write the same column.** Flipping the flag with both paths live does
NOT fix the bug it was meant to fix — it reintroduces it.

## Why (the trap)

Both paths LWW-write `harness_plans.content` keyed on the row's single `fed_ts`.
With the flag ON and the whole-blob path still live, a local edit emits BOTH a
whole-blob op (a full stale snapshot of the *other* peer's items) AND the per-part
op. On a remote peer the whole-blob projection still applies the stale snapshot →
**clobbers the per-part merge** — the exact concurrent-different-item clobber the
re-grain exists to kill. Mutual exclusion was the *intent* ("flag ON → per-part
authoritative") but was never implemented as code; "registered both projections
unconditionally" reads as done but isn't.

You cannot fix this by splitting columns across the two paths either: there is
**one `fed_ts` column**, and `mig-214` (`stamp_local_federated_write`) re-stamps it
on *any* content change, so two writers fight over one LWW clock — a content
recompose bumps `fed_ts` and starts dropping legitimate scalar updates.

## The shape that works (one sole writer when the flag is ON)

* **Whole-blob projection → bootstrap-only.** When the flag is ON, `INSERT … ON
  CONFLICT DO NOTHING`: it can create a never-seen plan but never UPDATE an
  existing row. A stale snapshot can't clobber. (`projections/harness-plans.ts`)
* **The fine-grained recompose is the SOLE writer.** It writes content **and**
  re-derives every scalar column the whole-blob path used to federate
  (title/status/owner/… from the recomposed frontmatter — they are NOT
  trigger-derived). One writer ⇒ one `fed_ts` stream ⇒ no interference.
  (`projections/harness-plan-parts.ts`)
* **Make the recompose look like a remote apply to the triggers.** Set
  `origin='remote'` + a *moved* `fed_ts` (the op's wire ts). mig-214's UPDATE
  branch only respects a remote apply when `NEW.fed_ts IS DISTINCT FROM
  OLD.fed_ts` — so a moved fed\_ts → "RETURN NEW verbatim" (no re-stamp), and
  origin='remote' → the mig-125 capture trigger skips re-federating it (no echo
  storm). Guard the UPDATE on `content_hash IS DISTINCT FROM` to skip no-op
  recomposes.

## Restart-free activation (don't rely on a boot backfill)

A once-per-boot backfill means the flip needs an operator restart on every peer,
and post-boot edits wouldn't capture. Instead wire capture where edits actually
happen and self-baseline on both sides:

* **Send side:** a flag-gated, best-effort, **post-commit** hook in the write
  chokepoint (`with-plan-lock`) — baseline from the *pre-edit* body, then diff the
  new body so only the changed part federates. Post-commit + own-try/catch so a
  capture failure can never roll back the committed write.
* **Receive side:** before applying the FIRST incoming part for a plan, seed the
  full baseline from the local `harness_plans.content`, else recompose produces a
  broken `join({one part})`.
* **Deterministic baseline `fed_ts=0`, `origin='remote'`** (non-federating): every
  peer self-seeds the SAME baseline from the same pre-cutover content, so unchanged
  parts TIE (identical body+ts) instead of racing, and any real edit (`fed_ts=now`)
  wins. No coordinated restart needed.

## Tells / how to verify

* A flip that "does nothing" or intermittently loses edits ⇒ suspect two live
  paths sharing one clock.
* Prove it on real PG with both real projections + real triggers (mig 102/125/214
  * the new table's capture): a flag-OFF **clobber control** (shows the gate is
    load-bearing), a flag-ON concurrent-different-item **merge**, a **two-instance**
    (two separate DBs) byte-identical convergence, and a **parts-empty peer** merging
    a lone incoming op. See `__tests__/plan-part-federation-cutover.integration.test.ts`.

Related: [retire-or-add-a-federated-table](/internal/docs/agent-insights/retire-or-add-a-federated-table)
(the coupled op-key / register-all / table-registry edits must land atomically or
the P-011 capture-coverage guard goes red).
