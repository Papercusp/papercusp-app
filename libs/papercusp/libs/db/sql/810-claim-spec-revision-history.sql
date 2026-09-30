-- 810-claim-spec-revision-history.sql
--
-- EI-18677010014746233 gap 2 — MAKE A DESTRUCTIVE CLAIM-SPEC WRITE REVERTIBLE.
--
-- THE BUG (happened live 2026-07-26): a Mug wanting to READ fleet
-- `nonp2p-bug-drain-0725`'s claim spec called `scheduler:set_claim_spec { fleet, spec:{...probe...} }`.
-- That is a WRITE. It overwrote the authored lane (revision 6 -> 7) and widened it from
-- matched:31 to matched:1185, deleting the p2p/federation title-glob exclusion that keeps that
-- fleet off the p2p-release fleet's lane. `cup_claim_specs` upserts IN PLACE behind a single
-- `revision` integer column, with no history table and no soft-delete, so the authored spec
-- BYTES WERE GONE. Recovery was luck: the write response happened to echo
-- `poolEffect.previousMatched:31`, which let a hand-rebuilt spec be validated against that one
-- number. Nothing in the system could answer "what was this lane 5 minutes ago".
--
-- WHY HISTORY RATHER THAN ANOTHER CONFIRMATION PROMPT. The sibling gap in that item asks for
-- an extended `confirmCollapse`. Deliberately NOT doing that here, because the evidence says a
-- confirmation would not have helped: EI-18655873409999215 records that `confirmCollapse` was
-- passed `true` on this very rev-7 write, and EI-18653814284166347 reports the guard already
-- over-refuses SAFE edits — which trains the override. A guard that must be overridden on the
-- happy path is not protecting anything. Worse, set_claim_spec's pool-effect guard FAILS OPEN
-- (set_claim_spec.ts: "pool-effect preview failed OPEN (spec stored; collapse guard not
-- evaluated)"), so on a preview error the spec is written with no guard evaluated at all.
-- Retention is the only remedy that still works when the guard is overridden OR fails open.
--
-- WHY A TRIGGER RATHER THAN CAPTURE IN setClaimSpec(). There are THREE write paths that can
-- destroy a spec today — the ON CONFLICT upsert, the scope-change DELETE+INSERT txn (L9
-- tombstone-on-scope-downgrade), and clearClaimSpec()'s DELETE — and adding a fourth is a
-- normal thing for a future change to do. Capturing in TS means patching every path and
-- trusting the next author to remember; capturing in the trigger means the row cannot leave
-- the table unrecorded regardless of which statement removed it. Same reasoning the repo
-- applies to confining process ROOTS rather than accounting for every descendant: guard the
-- choke point and the coverage is structural instead of remembered.
--
-- PURELY ADDITIVE: one new table, one new function, two new triggers. No DROP / RENAME /
-- SET NOT NULL / partial UNIQUE INDEX, and nothing the currently-deployed :3070 release reads
-- or writes, so no FORWARD-COMPAT acknowledgment is required (npm run lint:migration-forward-compat).
--
-- No top-level BEGIN/COMMIT — the migration runner wraps each file in its own transaction
-- (lint:migrations), mirroring mig 488's note.

CREATE TABLE IF NOT EXISTS harness_shared.cup_claim_spec_revisions (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id  text        NOT NULL,
    bee_id        text        NOT NULL,
    -- The revision of the spec being RETAINED (i.e. the one that was just superseded or
    -- deleted), NOT the revision that replaced it. A surrogate `id` is the PK rather than
    -- (workspace_id, bee_id, revision) because revisions are NOT globally unique per lane:
    -- clearClaimSpec deletes the row, after which a fresh set_claim_spec restarts the counter,
    -- so the same (bee_id, revision) legitimately recurs and a natural PK would reject the
    -- second one — silently losing exactly the history this table exists to keep.
    revision      integer     NOT NULL,
    -- The prior spec BYTES — the thing that was unrecoverable in the 2026-07-26 incident.
    spec          jsonb       NOT NULL,
    harness_slug  text,
    id_only       boolean,
    updated_by    text,
    -- Raw TG_OP, lowercased: 'update' (superseded in place) or 'delete' (cleared, or the
    -- DELETE half of a scope-change re-home). Deliberately the raw operation rather than an
    -- interpreted label like 'clear' vs 're-home': the trigger genuinely cannot distinguish a
    -- clearClaimSpec DELETE from the DELETE that opens a scope-change txn, and inventing a
    -- label it cannot verify would put a confident wrong value in an audit surface. A reader
    -- that needs the distinction can see whether an 'update'/'delete' pair shares a
    -- transaction timestamp.
    cause         text        NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cup_claim_spec_revisions_cause_known CHECK (cause IN ('update', 'delete')),
    CONSTRAINT cup_claim_spec_revisions_bee_nonempty CHECK (bee_id <> ''),
    CONSTRAINT cup_claim_spec_revisions_ws_nonempty  CHECK (workspace_id <> '')
);

COMMENT ON TABLE harness_shared.cup_claim_spec_revisions IS
  'Append-only history of superseded/deleted cup_claim_specs rows (EI-18677010014746233). Claim lanes are load-bearing fleet-safety state but were stored as an in-place upsert with no undo, so a probe-shaped write destroyed an authored lane irrecoverably (2026-07-26, fleet nonp2p-bug-drain-0725, rev 6->7, matched 31->1185). Written by the capture_cup_claim_spec_revision trigger on UPDATE and DELETE, so every write path is covered structurally rather than by each caller remembering to record.';

-- The read this table exists to serve: "what was this lane, most recently, before now".
CREATE INDEX IF NOT EXISTS cup_claim_spec_revisions_lookup_idx
    ON harness_shared.cup_claim_spec_revisions (workspace_id, bee_id, superseded_at DESC);

CREATE OR REPLACE FUNCTION harness_shared.capture_cup_claim_spec_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $capture_cup_claim_spec_revision$
BEGIN
    -- OLD is the row being destroyed. AFTER-trigger, so this only records writes that
    -- actually committed their change to cup_claim_specs.
    INSERT INTO harness_shared.cup_claim_spec_revisions
        (workspace_id, bee_id, revision, spec, harness_slug, id_only, updated_by, cause)
    VALUES
        (OLD.workspace_id, OLD.bee_id, OLD.revision, OLD.spec, OLD.harness_slug,
         OLD.id_only, OLD.updated_by, lower(TG_OP));
    -- AFTER ... FOR EACH ROW ignores the return value; NULL is the conventional form.
    RETURN NULL;
END;
$capture_cup_claim_spec_revision$;

COMMENT ON FUNCTION harness_shared.capture_cup_claim_spec_revision() IS
  'Retains the prior cup_claim_specs row into cup_claim_spec_revisions before it is lost (EI-18677010014746233). Fires on UPDATE and DELETE so the ON CONFLICT upsert, the scope-change DELETE+INSERT txn, and clearClaimSpec are all covered without any caller opting in.';

CREATE OR REPLACE TRIGGER capture_cup_claim_spec_revision_upd_trg
    AFTER UPDATE ON harness_shared.cup_claim_specs
    FOR EACH ROW
    -- Only when something a reader would want back actually changed. A no-op re-write of an
    -- identical spec at an identical revision is not a lost version, and recording it would
    -- dilute the history with rows that restore nothing.
    WHEN (OLD.spec IS DISTINCT FROM NEW.spec OR OLD.revision IS DISTINCT FROM NEW.revision)
    EXECUTE FUNCTION harness_shared.capture_cup_claim_spec_revision();

CREATE OR REPLACE TRIGGER capture_cup_claim_spec_revision_del_trg
    AFTER DELETE ON harness_shared.cup_claim_specs
    FOR EACH ROW
    EXECUTE FUNCTION harness_shared.capture_cup_claim_spec_revision();

-- Workspace isolation, mirroring mig 488's canonical shape verbatim (defense-in-depth for
-- harness_app connections). This table is workspace-partitioned exactly like its parent, so
-- omitting the policy would make the HISTORY of a spec readable across a boundary its own
-- current row is protected from.
ALTER TABLE harness_shared.cup_claim_spec_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cup_claim_spec_revisions_workspace_isolation ON harness_shared.cup_claim_spec_revisions;
CREATE POLICY cup_claim_spec_revisions_workspace_isolation ON harness_shared.cup_claim_spec_revisions
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
