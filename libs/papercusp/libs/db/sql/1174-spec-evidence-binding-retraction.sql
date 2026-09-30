-- 1174 — a recorded-retraction path for harness_shared.spec_evidence_bindings.
--
-- WI-10001850. Plan managed-agent-capability-contract-and-native-cutover-2026-09-13,
-- decision D-011.
--
-- WHY THIS EXISTS. spec_evidence_bindings is append-only and carries no way to
-- withdraw a row. The spec-test-adequacy evaluator scans EVERY bound row for a
-- (spec, revision) cohort — execution-integrity fails the clause if ANY binding
-- names a run that was never collected or executed, and freshness fails it if ANY
-- binding has gone stale — so ONE malformed binding permanently bricks its clause.
-- Appending a corrected row cannot outrank the bad one (the loader has no
-- DISTINCT ON; both rows are read), and spec_revision is the only partitioning
-- dimension, so the only escape was to bump the clause revision purely to shed the
-- failing evidence. D-011 rules that out as gate evasion: a bar whose hash moved
-- has genuinely different meaning and must be re-proved, so a revision bump is a
-- statement about the SPEC, never a way to launder an authoring error.
--
-- The repair is therefore a RECORDED retraction, mirroring the shape scorecards
-- already expose (scorecards:list { includeRetracted } returns "deliberately
-- retracted scorecards and their withdrawal metadata"). The row is never deleted
-- and never edited: it acquires an immutable, one-way withdrawal stamp that says
-- who withdrew it and why, and readers exclude it by default while an audit read
-- still returns it in full.
--
-- FORWARD-COMPAT: expand-only. The three columns are nullable with no default, so
-- every currently-deployed reader keeps seeing exactly the rows it saw before. The
-- append-only trigger is REPLACED rather than dropped, and its replacement is
-- strictly a superset of the old behaviour: DELETE stays forbidden, every
-- substantive column stays immutable, and the only newly-permitted write is a
-- complete NULL -> NOT NULL retraction stamp. The release checkout serving :3070
-- issues no UPDATE against this table at all, so it cannot be affected either way.

ALTER TABLE harness_shared.spec_evidence_bindings
  ADD COLUMN IF NOT EXISTS retracted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS retracted_by      text,
  ADD COLUMN IF NOT EXISTS retraction_reason text;

-- A withdrawal is all-or-nothing: a row is either live proof, or it carries a
-- complete, attributable, reasoned retraction. A half-written stamp would let a
-- reader's default filter hide a binding with no recorded author or cause, which
-- is precisely the unaccountable disappearance append-only exists to prevent.
ALTER TABLE harness_shared.spec_evidence_bindings
  DROP CONSTRAINT IF EXISTS spec_evidence_bindings_retraction_complete;
ALTER TABLE harness_shared.spec_evidence_bindings
  ADD CONSTRAINT spec_evidence_bindings_retraction_complete CHECK (
    (retracted_at IS NULL AND retracted_by IS NULL AND retraction_reason IS NULL)
    OR (
      retracted_at IS NOT NULL
      AND retracted_by IS NOT NULL AND length(btrim(retracted_by)) > 0
      AND retraction_reason IS NOT NULL AND length(btrim(retraction_reason)) > 0
    )
  );

COMMENT ON COLUMN harness_shared.spec_evidence_bindings.retracted_at IS
  'When this binding was deliberately withdrawn. NULL means live proof. Set exactly once and never cleared; the row itself is never deleted or edited, so the withdrawn claim stays auditable. Readers exclude retracted rows by default and an audit read returns them with this withdrawal metadata.';
COMMENT ON COLUMN harness_shared.spec_evidence_bindings.retracted_by IS
  'Identity that recorded the withdrawal. Required whenever retracted_at is set, so a binding can never vanish from the default read without an attributable author.';
COMMENT ON COLUMN harness_shared.spec_evidence_bindings.retraction_reason IS
  'Why this proof was withdrawn (for example: the bound run was never collected or executed). Required whenever retracted_at is set: a retraction with no stated cause is indistinguishable from evidence-shedding, which decision D-011 forbids.';

-- The append-only guard was shared with work_item_spec_revision_edges, which stays
-- FULLY immutable. Give the bindings table its own guard rather than weakening the
-- shared one, so the edges table's contract is untouched by this change.
CREATE OR REPLACE FUNCTION harness_shared.guard_spec_evidence_binding_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only; append a new exact evidence binding', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  -- One-way and final. Re-retracting would let the recorded author or reason be
  -- rewritten after the fact, turning the audit trail into mutable prose.
  IF OLD.retracted_at IS NOT NULL THEN
    RAISE EXCEPTION
      '% row % is already retracted; a retraction is one-way and its recorded reason is final',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF NEW.retracted_at IS NULL OR NEW.retracted_by IS NULL OR NEW.retraction_reason IS NULL THEN
    RAISE EXCEPTION
      '% is append-only; the only permitted update is a complete retraction stamp (retracted_at, retracted_by, retraction_reason)',
      TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  -- Everything except the retraction stamp must be byte-identical. Compared as
  -- jsonb minus the three stamp keys rather than against a hand-written column
  -- list, so a column added to this table in a later migration is protected the
  -- day it is added instead of silently falling outside the guard.
  IF (to_jsonb(NEW) - 'retracted_at' - 'retracted_by' - 'retraction_reason')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'retracted_at' - 'retracted_by' - 'retraction_reason') THEN
    RAISE EXCEPTION
      '% is append-only; a retraction may not alter any other column of row %',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.guard_spec_evidence_binding_mutation() IS
  'Append-only guard for spec_evidence_bindings that admits exactly one mutation: a complete, one-way NULL -> NOT NULL retraction stamp that changes nothing else. DELETE remains forbidden. work_item_spec_revision_edges keeps the stricter shared guard, reject_spec_evidence_history_mutation.';

DROP TRIGGER IF EXISTS spec_evidence_bindings_immutable
  ON harness_shared.spec_evidence_bindings;
CREATE TRIGGER spec_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON harness_shared.spec_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION harness_shared.guard_spec_evidence_binding_mutation();

-- Defence in depth beneath the trigger. MEASURED FIRST, not assumed: both roles
-- currently hold table-wide UPDATE on this table (information_schema.column_privileges
-- returns all 22 columns for each), so ADDING a column-level grant would restrict
-- nothing — it is additive, and a comment claiming otherwise would be false. The
-- narrowing therefore has to REVOKE first, after which the three stamp columns are the
-- only ones the database will accept an UPDATE against, and a raw writer cannot rewrite
-- proof even if the trigger above is later relaxed.
--
-- Safe by construction: the trigger already rejects every UPDATE except a complete
-- retraction stamp, so no legitimate writer can be exercising the privilege being
-- revoked. The trigger remains the authoritative guard — a future blanket
-- `GRANT ALL ON ALL TABLES IN SCHEMA harness_shared` would silently re-widen this
-- grant, which is exactly why correctness does not rest on it.
REVOKE UPDATE ON harness_shared.spec_evidence_bindings FROM harness_app, harness_admin;
GRANT UPDATE (retracted_at, retracted_by, retraction_reason)
  ON harness_shared.spec_evidence_bindings TO harness_app, harness_admin;
