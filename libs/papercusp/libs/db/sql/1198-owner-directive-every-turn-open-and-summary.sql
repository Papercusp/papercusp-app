-- 1198 — every owner turn is a directive; forced summary for long ones.
--
-- Plan owner-directive-delivery-redesign-2026-09-22, P-002 + P-003.
--
-- D-001 [owner 2026-09-22]: "a question should lead to answer directive actually" /
-- "make the turns the directive". The pending → promote/dismiss triage is removed:
-- a hook-captured owner turn is OPEN the moment it lands, and it ends only as
-- done or declined (+ reason). 102 of ~170 captures were dismissed in two days,
-- mostly long pastes, and the triage itself was sloppy (a pure question sat open).
--
-- D-004 [owner 2026-09-22]: no truncation anywhere. A directive over 500 chars is
-- rendered to other agents via an agent-written summary (≤ 200 chars), never a cut
-- fragment. summary_text/summary_by/summary_at hold that summary; verbatim_text is
-- never edited.
--
-- EXPAND / CONTRACT. The green release on :3070 keeps running older code that
-- still INSERTs capture_status = 'pending' (orders:capture-pending) and could
-- UPDATE it to 'dismissed' (orders:resolve-pending). The normalizing trigger below
-- makes those writes land in the new state space, so the redesign's store
-- invariant holds for every writer before and after the deploy. The capture_*
-- columns stay (read by the release, and they carry historical provenance); a
-- later migration drops capture_status once no deployed code reads it.
--
-- FORWARD-COMPAT: the capture_status CHECK is narrowed to 'open', but the deployed release's only writes of 'pending'/'dismissed' go through the BEFORE trigger added here, which rewrites them to 'open' (and a dismissal to a declined disposition) before the CHECK is evaluated; the release's reads of capture_status keep working because the column is kept; the dropped owner_directives_pending_idx is a partial index on capture_status = 'pending', which no row can satisfy any more, so no release query can lose a plan that used it.

-- ── P-003: the forced summary ──────────────────────────────────────────────────

ALTER TABLE harness_shared.owner_directives
  ADD COLUMN IF NOT EXISTS summary_text text,
  ADD COLUMN IF NOT EXISTS summary_by   text,
  ADD COLUMN IF NOT EXISTS summary_at   timestamptz;

ALTER TABLE harness_shared.owner_directives
  ADD CONSTRAINT owner_directives_summary_length_check
  CHECK (summary_text IS NULL OR (length(btrim(summary_text)) > 0 AND length(summary_text) <= 200));

ALTER TABLE harness_shared.owner_directives
  ADD CONSTRAINT owner_directives_summary_consistent
  CHECK (
    (summary_text IS NULL AND summary_by IS NULL AND summary_at IS NULL)
    OR
    (summary_text IS NOT NULL AND summary_by IS NOT NULL AND summary_at IS NOT NULL)
  );

COMMENT ON COLUMN harness_shared.owner_directives.summary_text IS
  'Agent-written summary (<= 200 chars) of a directive whose verbatim_text exceeds 500 chars. It is what OTHER agents see for a long open directive (D-004: full verbatim under the cap, forced summary over it, never a truncated fragment). Written with orders:summarize; verbatim_text is never edited and stays one orders:get away.';
COMMENT ON COLUMN harness_shared.owner_directives.summary_by IS
  'The coord ownerId that wrote summary_text. Renderers label the summary with it so a reader knows it is an agent paraphrase, not the owner''s words.';
COMMENT ON COLUMN harness_shared.owner_directives.summary_at IS
  'When summary_text was last written.';

-- ── P-002: every captured turn is a directive ─────────────────────────────────

-- Un-triaged captures become open directives. The promotion columns record that
-- this migration, not an agent's judgment, is what opened them.
UPDATE harness_shared.owner_directives
   SET capture_status = 'open',
       capture_promoted_at = COALESCE(capture_promoted_at, now()),
       capture_promoted_by = COALESCE(capture_promoted_by, 'migration-1198'),
       capture_promoted_note = COALESCE(
         capture_promoted_note,
         'opened by migration 1198: every owner turn is a directive (D-001), pending triage removed'
       )
 WHERE capture_status = 'pending';

-- A capture-time dismissal becomes a DECLINE carrying the dismissal reason, so a
-- directive has exactly one way to end besides done. Rows already dispositioned
-- keep their disposition. capture_dismissal_* stay populated as provenance.
UPDATE harness_shared.owner_directives
   SET capture_status = 'open',
       dispositioned_at = COALESCE(dispositioned_at, capture_dismissed_at, now()),
       disposition_status = COALESCE(disposition_status, 'declined'),
       disposition_note = COALESCE(
         disposition_note,
         'declined at capture triage (migration 1198 folded dismissal into decline): ' ||
           COALESCE(capture_dismissal_reason, 'no reason recorded')
       ),
       dispositioned_by = COALESCE(dispositioned_by, capture_dismissed_by, 'migration-1198')
 WHERE capture_status = 'dismissed';

CREATE OR REPLACE FUNCTION harness_shared.owner_directives_normalize_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.capture_status = 'pending' THEN
    NEW.capture_status := 'open';
  ELSIF NEW.capture_status = 'dismissed' THEN
    NEW.capture_status := 'open';
    IF NEW.dispositioned_at IS NULL THEN
      NEW.dispositioned_at := COALESCE(NEW.capture_dismissed_at, now());
      NEW.disposition_status := 'declined';
      NEW.disposition_note := 'declined at capture triage: ' ||
        COALESCE(NEW.capture_dismissal_reason, 'no reason recorded');
      NEW.dispositioned_by := COALESCE(NEW.capture_dismissed_by, 'capture-triage');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION harness_shared.owner_directives_normalize_capture() IS
  'Store invariant for D-001 (every owner turn is a directive; it ends only done or declined). Rewrites a pending capture to open and a capture dismissal to a declined disposition, so writers still running pre-1198 code (orders:capture-pending / orders:resolve-pending on the green release) land in the new state space.';

DROP TRIGGER IF EXISTS owner_directives_normalize_capture ON harness_shared.owner_directives;
CREATE TRIGGER owner_directives_normalize_capture
  BEFORE INSERT OR UPDATE OF capture_status ON harness_shared.owner_directives
  FOR EACH ROW EXECUTE FUNCTION harness_shared.owner_directives_normalize_capture();

ALTER TABLE harness_shared.owner_directives
  DROP CONSTRAINT IF EXISTS owner_directives_capture_status_check;
ALTER TABLE harness_shared.owner_directives
  ADD CONSTRAINT owner_directives_capture_status_check
  CHECK (capture_status = 'open');

DROP INDEX IF EXISTS harness_shared.owner_directives_pending_idx;

COMMENT ON COLUMN harness_shared.owner_directives.capture_status IS
  'Vestigial since migration 1198: always ''open''. The pending/dismissed capture triage was removed (D-001, every owner turn is a directive); a BEFORE trigger rewrites legacy writes. Scheduled to be dropped once no deployed release reads it. Lifecycle is open | done | declined, derived from dispositioned_at/disposition_status.';
