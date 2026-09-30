-- Migration 737 — WI-6977: one-time BACKFILL for the gate→needsHuman mirror.
--
-- THE GAP -----------------------------------------------------------------------------------
-- `packages/operator-core/lib/harness/improvements/triage-core.ts:358` mirrors a `gate`
-- triage decision into `payload.needsHuman = true` (landed under EI-18812833212023413) — the
-- field the issue-family claim floor (and the SQL SSOT `harness_shared.work_item_claim_floors`,
-- migration 654, floor 6) actually reads. That mirror writes at TRIAGE TIME only, forward from
-- when it landed (~2026-07-20). Every issue-family row triaged `gate` BEFORE that fix landed
-- still carries `payload.ideaLifecycle.triageDecision = 'gate'` with no `payload.needsHuman` at
-- all — so the claim floor (which only fences on needsHuman === true) does not exclude them.
--
-- MEASURED (2026-08-02, live operator DB, this workspace's only tenant):
--   940 issue-family rows ever gated; 739 of them still missing needsHuman entirely, across
--   every lifecycle state (open/todo/blocked/resolved/done/closed/dropped) and both scopes in
--   use (`harness:papercusp`, the legacy `harness:papercup` scope name, and the `operator`
--   pseudo-scope). 53 of the 739 are currently `open` — i.e. actively mis-advertised as
--   claimable by `work_items:claimable` / a raw SQL read today, then correctly refused at
--   `work_items:claim` (fail-closed, but a wasted claim-turn each time; EI-16537 was one,
--   confirmed via work_items:claimable / work_items:claim / work_items:observe in WI-6977).
--
-- This is a pure DATA-CONSISTENCY backfill, not a logic change: the write-side mirror is
-- already correct (do not re-touch triage-core.ts), and the claim floor / SSOT view already
-- read the right field (do not touch work_item_claim_floors either — the
-- claim-ssot-agreement.integration.test.ts already pins needsHuman as floor 6 on both the
-- inline claim path and the SQL view, so once the data agrees, the floors already agree).
-- Backfilling every lifecycle state (not just `open`) is deliberate: a `resolved`/`done` row
-- that is later reopened must not silently regain claimability just because its needsHuman
-- flag was never written the first time.
--
-- Idempotent: the WHERE clause only ever touches rows still missing the flag, so a re-run
-- after a partial apply (or on a fresh box that already carries the flag on every row) is a
-- no-op. No workspace_id filter — the fix is a general invariant repair (gate ⇒ needsHuman),
-- not scoped to one tenant; on a shared multi-tenant box it correctly repairs every tenant
-- that carries the same stale data, and each row's own workspace_id is preserved untouched.

UPDATE harness_shared.work_items
SET payload = COALESCE(payload, '{}'::jsonb) || '{"needsHuman": true}'::jsonb
WHERE item_kind IN ('bug', 'change', 'task')
  AND payload -> 'ideaLifecycle' ->> 'triageDecision' = 'gate'
  AND NOT (COALESCE(payload, '{}'::jsonb) ? 'needsHuman');

-- Post-condition: fail loudly rather than leave a partial backfill undetected.
DO $post737$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
    FROM harness_shared.work_items
   WHERE item_kind IN ('bug', 'change', 'task')
     AND payload -> 'ideaLifecycle' ->> 'triageDecision' = 'gate'
     AND NOT (COALESCE(payload, '{}'::jsonb) ? 'needsHuman');
  IF remaining <> 0 THEN
    RAISE EXCEPTION '737: post-condition failed — % gated issue-family row(s) still missing payload.needsHuman after backfill', remaining;
  END IF;
END
$post737$;
