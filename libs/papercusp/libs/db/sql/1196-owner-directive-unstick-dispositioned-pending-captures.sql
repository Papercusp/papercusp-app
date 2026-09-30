-- 1196 — Release owner-directive rows deadlocked at capture_status='pending' while
-- already dispositioned.
--
-- THE DEADLOCK. `deriveState()` gives capture_status priority over disposition, so any
-- row left at 'pending' renders as state='pending' no matter what its disposition says.
-- The obligation provider selects on capture_status alone, so such a row re-emits a
-- "[DUE] promote or dismiss: orders:resolve-pending" obligation into EVERY agent's
-- Orientation in the workspace, forever. And it cannot be cleared: promoteOwnerDirective
-- and dismissOwnerDirective BOTH carry `AND dispositioned_at IS NULL` in their WHERE
-- clause, so once dispositioned_at is set, the only two verbs that resolve a capture
-- match zero rows. Every agent that tried was told to run a tool that could not work.
--
-- Reached when orders:disposition closed a directive whose capture had never been
-- promoted — which was the whole of dispositionOwnerDirective's behaviour until the
-- accompanying fix, since it wrote only the disposition_* columns and never touched
-- capture_status. Observed on papercusp-workspace directives #86 and #87: genuine owner
-- turns, answered with substantive notes at 2026-09-22T14:58Z and 15:01Z, still nagging
-- 5.5h later.
--
-- WHY 'open' AND NOT 'dismissed': a dispositioned row was acted on — carried out (done)
-- or consciously refused (declined). Both assert it WAS a genuine owner order, which is
-- precisely what promotion means. 'dismissed' would claim the opposite (never a directive
-- at all) and would destroy the audit trail these rows exist to keep.
--
-- Attribution is the agent that dispositioned the row: acting on the directive is the
-- evidence that it was genuine, so that agent is the truthful promoter. Rows whose
-- dispositioned_by is somehow absent fall back to a self-describing marker rather than a
-- fabricated identity.
--
-- Idempotent: the WHERE clause excludes anything already resolved, so a re-run is a no-op.
-- Forward-compatible: data-only, no DDL, and it moves rows INTO the state the currently
-- deployed release already knows how to render.

UPDATE harness_shared.owner_directives
   SET capture_status = 'open',
       capture_promoted_at = COALESCE(capture_promoted_at, dispositioned_at, now()),
       capture_promoted_by = COALESCE(capture_promoted_by, dispositioned_by, 'migration-1196'),
       capture_promoted_note = COALESCE(
         capture_promoted_note,
         'auto-promoted by migration 1196: dispositioned (' ||
           COALESCE(disposition_status, 'unknown') ||
           ') while its capture was still pending, which no tool could clear'
       )
 WHERE capture_status = 'pending'
   AND dispositioned_at IS NOT NULL;
