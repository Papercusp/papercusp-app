# Per-row verification signals belong ON the row, not in a parallel escalations table
URL: /internal/docs/agent-insights/verification-signal-on-the-row

Phase 2 P-016 specced a divergence escalation row but the escalations table is per-(slug,phase) file-mirror — wrong shape. Solution — put the verifier signal on the feature row itself; the UI reads it directly.

import { Aside } from '@astrojs/starlight/components';

## The trap

The Phase 2 P-016 plan said:

> Daemon writes `verifier_last_error = 'sha_not_found'` and emits a
> `harness_escalations` row with `kind: 'completion_ref_divergence'`.

Reasonable wording — until you read the actual `harness_escalations`
schema. It's a per-`(harness_slug, phase)` mirror of
`.papercusp/escalation.md` + `.papercusp/supervisor-notes.md`. **One row per
phase, not one row per event.** There's no `kind` column. There's no
event-id column. It's a file-content cache, not an event queue.

Implementing the plan literally would have meant either:

* Adding a `kind` column + giving up the one-row-per-phase invariant
  (breaks the watcher that mirrors files into the table).
* Inventing a new `harness_events` queue table for a single use case.
* Concatenating warning text into `escalation` (the file-mirror
  string) and losing structured access from the UI.

All three are wrong.

## The fix

Put the signal **on the entity it describes**. The verifier is per-feature, so:

* `verified_done_at_remote_ts TIMESTAMPTZ` — success stamp (drives ✓ badge).
* `verifier_last_error TEXT` — failure signal (`'sha_not_found'` or NULL).
* `verifier_last_checked_at TIMESTAMPTZ` — bumped on every attempt.

Three columns on `harness_features_consolidated`. The
`FeatureDetail` UI reads them directly to render the verified /
pending / divergent states. Zero new tables. Zero new event surfaces.
No "emit then read" round trip.

## Why this is usually right

Per-row verification signals follow the entity they describe. The UI
that cares is *already* reading that row. Emitting to a parallel
queue means:

* Two reads instead of one (row + queue).
* Two write surfaces to keep in sync.
* A "who garbage-collects the queue" question that didn't exist before.
* A reactivity story that has to span two tables.

The escalation surface is the right home only for things the UI
*doesn't* see by reading the entity — cross-cutting alerts ("the
worker crashed", "the migration ran wrong"). A divergent commit SHA
isn't cross-cutting. It's an attribute of the feature row.

## When to do the opposite

Put signals on a separate event table when:

* The signal outlives the entity (e.g. "this feature was deleted because…").
* Multiple entities share the same signal (e.g. "global rate-limit hit").
* You need temporal ordering across entities ("most recent 100 errors
  across the harness").
* The producer and the consumer have different identity (event log for
  audit / forensics).

None of those applied to `completion_ref` divergence. One signal, one
entity, one consumer.

When a plan says "emit a row to X table" but X's schema doesn't fit,
that's a signal the design wasn't read against the schema. Implementing
literally produces awkward code; departing — with a paragraph in the
commit message explaining why — produces clean code. The plan-author
will almost always agree; they had the right *intent*, just sketched the
wrong surface.

## See also

* [`adding-a-reactive-table`](/internal/docs/agent-insights/adding-a-reactive-table/) —
  the producer-side trigger that fires when columns like
  `verifier_last_error` change.
* [`idempotent-pg-ensure`](/internal/docs/agent-insights/idempotent-pg-ensure/) —
  the (now **superseded**) runtime `ensure-schema*.ts` add-column pattern.
  Update: schema is migrations-only since
  `self-contained-migration-baseline-2026-06-02` — add columns via a numbered
  SQL migration (`107+`), never a runtime `ensureXxx()`.
* `packages/operator-core/lib/harness/completion-ref-verifier.ts` — P-016's
  artifact, the canonical example.
* `libs/papercusp/libs/db/sql/000-baseline.sql` — the three columns now live
  here on `harness_features_consolidated` (the original
  `082-completion-ref-verifier-columns.sql` was squashed into the baseline; the
  pre-squash file is preserved at `sql/archive/082-completion-ref-verifier-columns.sql`).
