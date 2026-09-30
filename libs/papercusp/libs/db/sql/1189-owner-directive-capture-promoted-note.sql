-- 1189: owner directives — persist the promote-time note.
--
-- P-005 / plan turn-start-memory-two-class-2026-09-21, decision D-014.
--
-- D-014 ratified shipping ONE resolve verb (orders:resolve-pending { id, action, reason })
-- instead of the two the item names, but explicitly did NOT waive the `note?` parameter on
-- promote: "Per the measurement above it has no storage, so it is a migration, not a
-- signature change ... implement it or explicitly drop it before the plan ships".
--
-- Measured before writing this: orders:resolve-pending accepts `reason` for BOTH actions
-- (zod: reason optional, min 4), but promoteOwnerDirective({ id, promotedBy }) never receives
-- it — so a note supplied alongside action:'promote' validates and is then silently
-- discarded. That is quiet data loss, which is why this is implemented rather than dropped.
--
-- Shape mirrors the dismissal side exactly: capture_dismissal_reason stores the dismiss
-- reason, capture_promoted_note stores the promote note. Deliberately NOT reusing
-- disposition_note — that column belongs to a later lifecycle stage (orders:disposition,
-- done/declined), so sharing it would let a disposition note overwrite a promote note.
--
-- Additive and nullable: existing rows keep NULL (they were promoted before a note could be
-- recorded), and no currently-deployed code reads or writes this column, so the older
-- release serving :3070 is unaffected while this applies.

ALTER TABLE harness_shared.owner_directives
  ADD COLUMN IF NOT EXISTS capture_promoted_note text;

COMMENT ON COLUMN harness_shared.owner_directives.capture_promoted_note IS
  'Optional free-text note supplied when a hook-captured pending directive was promoted to open via orders:resolve-pending { action: ''promote'', reason }. NULL when promoted without a note, or promoted before migration 1189. Counterpart to capture_dismissal_reason on the dismiss path; distinct from disposition_note, which records the later done/declined disposition.';
