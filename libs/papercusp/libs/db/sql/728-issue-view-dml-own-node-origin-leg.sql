-- 728-issue-view-dml-own-node-origin-leg.sql
--
-- WI-7096 — give `engineer_issues_view_dml`'s EI-7833 remote-skip the OWN-NODE leg the
-- TypeScript claim floors have had since work-item-status-full-unify (owner 2026-07-20).
--
-- THE DEFECT. The issue-family origin floor has three implementations and only one is
-- own-node aware:
--
--   1. isIssueLocallyClaimableWhereSql (work-items-admission.ts:197)  own-node ✅
--        used by work_items:claimable / scheduler:get_next (get-next.ts:832),
--        claim_next self-select (work-items.ts:4578), the READY diagnose (:4202)
--   2. isIssueLocallyClaimableWithOwn  (work-items-admission.ts:207)  own-node ✅ but
--        ZERO production call sites — written as the JS counterpart, never wired up
--   3. isIssueLocallyClaimable(origin) (work-items-admission.ts:90)   own-node ❌
--        used by observeWorkItem (work-items.ts:4787)
--
--   ...and THIS trigger, whose skip is a bare `cur.origin = 'remote'`, own-node ❌.
--
-- Consequence: a row this node AUTHORED that round-tripped federation (origin='remote'
-- but carrying OUR OWN substrate author key) is SERVED as claimable by the queue and
-- REFUSED by claim-by-id, because the single-id work_items:claim path writes through the
-- engineer_issues view and this trigger RETURN NULLs it to 0-rows-affected. Measured on
-- papercusp-workspace 2026-08-02: 11,537 such issue-family rows, 9,143 of them still
-- open — including the owner-reported release-gate bug WI-6503.
--
-- The rationale for the leg is already written into work-items.ts:4573-4577: "a
-- self-authored row that round-tripped federation IS self-selectable ... without it,
-- node-identity drift permanently strands this box's own bugs." This migration applies
-- that same rule at the last chokepoint that never got it.
--
-- NOT A RELAXATION OF EI-7833. A TRUE-PEER remote row — one whose author_pubkey is not
-- among this workspace's own-node keys — is still skipped exactly as before, so the
-- "authoring peer's core owns it" LWW invariant is untouched. Only rows we authored
-- ourselves become writable again. The predicate below is a literal plpgsql transcription
-- of issueOwnAuthorWhereSql (work-items-admission.ts:181): workspace-scoped, non-empty
-- key, membership in the set of author_pubkeys used by local-origin rows.
--
-- WHY THIS PATCHES RATHER THAN RE-DECLARES THE FUNCTION. The body is ~8.6KB and has been
-- amended by migrations 516, 641, 655, 679, 711 and 725. Re-typing it here would silently
-- revert any amendment that lands between authoring and apply time — the exact failure
-- this file exists to fix, with the sign flipped. So we derive from the live definition
-- and assert our way through it: the guard must be present EXACTLY once, the new marker
-- must be absent (idempotency), and the marker must be present when we are done. Any
-- deviation RAISEs and rolls the transaction back rather than half-applying.

DO $migration$
DECLARE
  v_def       text;
  v_new       text;
  v_hits      int;
  -- Dollar-quoted on purpose: this text is itself SQL full of single quotes, and
  -- backslash/quote-doubling it into ordinary literals is how a patch like this acquires a
  -- silent transcription bug.
  v_old_guard constant text := $frag$AND cur.origin = 'remote'$frag$;
  v_marker    constant text := $frag$WI-7096 own-node leg$frag$;
  v_new_guard constant text := $frag$AND cur.origin = 'remote'
       -- WI-7096 own-node leg: a row WE authored that round-tripped federation
       -- (origin='remote' but carrying one of THIS workspace's own author keys) is ours
       -- to write. Mirrors issueOwnAuthorWhereSql. A true-peer remote row still skips.
       AND NOT (
         cur.author_pubkey IS NOT NULL AND cur.author_pubkey <> ''
         AND EXISTS (
           SELECT 1 FROM harness_shared.work_items own
            WHERE own.workspace_id = cur.workspace_id
              AND (own.origin = 'local' OR own.origin IS NULL)
              AND own.author_pubkey = cur.author_pubkey
         )
       )$frag$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      '728: harness_shared.engineer_issues_view_dml() not found — migration 516 must run first';
  END IF;

  -- Idempotent: already carries the leg (re-run, or a later migration folded it in).
  IF position(v_marker IN v_def) > 0 THEN
    RAISE NOTICE '728: own-node leg already present — nothing to do';
    RETURN;
  END IF;

  -- The guard must be unambiguous. Zero hits means the EI-7833 skip was renamed or
  -- removed; more than one means an ambiguous target. Either way, refuse rather than
  -- guess — a silently mis-patched DML trigger is worse than a failed migration.
  v_hits := (length(v_def) - length(replace(v_def, v_old_guard, ''))) / length(v_old_guard);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '728: expected exactly 1 occurrence of the EI-7833 remote-skip guard in engineer_issues_view_dml(), found %. The function shape changed — re-derive the patch before re-running.',
      v_hits;
  END IF;

  v_new := replace(v_def, v_old_guard, v_new_guard);

  IF position(v_marker IN v_new) = 0 THEN
    RAISE EXCEPTION '728: patch did not apply — marker absent after replace';
  END IF;

  EXECUTE v_new;

  -- Read back from the catalog: prove the deployed function is the patched one, rather
  -- than trusting that EXECUTE did what the local string says.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF v_def IS NULL OR position(v_marker IN v_def) = 0 THEN
    RAISE EXCEPTION '728: post-apply verification failed — own-node leg not present in the stored definition';
  END IF;

  RAISE NOTICE '728: engineer_issues_view_dml() now admits own-node round-tripped rows';
END
$migration$;
