# A federated column silently never federates if the CDC capture trigger's WHEN clause doesn't watch it
URL: /internal/docs/agent-insights/cdc-capture-trigger-column-scope-trap

capture_substrate_outbox snapshots to_jsonb(NEW) AT FIRE TIME, and the per-table AFTER UPDATE capture trigger has a COLUMN-SCOPED WHEN clause. Add a new federated column but write it in a separate UPDATE that touches only that column, and the trigger never fires → the value is set locally but NEVER placed on the peer-log. Adding a federated column to an existing CDC table = also widen the trigger WHEN clause.

## The trap

Federated tables ride `harness_shared.capture_substrate_outbox()` — an `AFTER
INSERT/UPDATE/DELETE` trigger that, **at fire time**, does `to_jsonb(NEW)` and
INSERTs that **row snapshot** into `substrate_outbox` (drained onto the peer-log).
Two load-bearing facts:

1. **It snapshots the row AS IT IS WHEN THE TRIGGER FIRES.** A column written
   *after* the firing update is not in that snapshot.
2. **The per-table `AFTER UPDATE` capture trigger has a COLUMN-SCOPED `WHEN`
   clause** — it fires only when specific columns change (a deliberate
   noise-filter so unrelated updates don't federate). Example from mig 464
   (`gym_qd_archive`):

   ```sql
   WHEN ((NEW.federatable = true OR OLD.federatable = true)
     AND (OLD.fitness IS DISTINCT FROM NEW.fitness
       OR OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
       OR OLD.federatable IS DISTINCT FROM NEW.federatable))
   ```

So if you **add a new federated column** and write it in an `UPDATE` that touches
**only that column**, the `WHEN` clause is false → **the trigger never fires** →
the value lands in the local row but is **never captured onto the wire**. It looks
correct locally (the column is set; unit tests with a fake `sql` pass) and is
silently inert in federation.

## How it bit (F1-6 / P-014)

`markEliteFederatable`'s device-signing path stamps `federatable=true` in one
UPDATE, then writes the signed `outcome_record` in a **second** UPDATE touching
only `outcome_record`. mig 478 added the column and its comment *assumed* "the
archive's existing capture triggers" would carry it — but mig 464's trigger
predated the column and didn't watch it. Result: every elite federated
outcome-**UNVERIFIED** even when a signer was present. The whole signing layer was
inert on the wire, and nothing failed loudly.

## The rule

**Adding a federated column to an existing CDC-captured table is TWO changes, not
one:** add the column (migration) **and** widen the capture trigger's `WHEN`
clause to fire on that column
(`OR OLD.<col> IS DISTINCT FROM NEW.<col>`). mig 481 did exactly that. A
`CREATE OR REPLACE TRIGGER` migration is idempotent and additive.

## Verify it for real — not with a fake `sql`

A fake-`sql` unit test cannot catch this: the bug lives in the PG trigger, not the
TS. Prove it against real Postgres — hand-provision the table + `substrate_outbox`

* the capture fn + the trigger (the `_pg-helpers` subset-provisioning precedent),
  run the writer, and assert the captured `substrate_outbox.row->'…'` actually
  carries the new column. `elite-outcome-capture.integration.test.ts` provisions BOTH
  the old and fixed trigger and asserts old-misses / fixed-captures — the durable
  regression guard.
