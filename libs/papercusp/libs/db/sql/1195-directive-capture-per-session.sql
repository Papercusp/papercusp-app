-- 1195-directive-capture-per-session.sql
--
-- P-008 of plan `directive-visibility-and-ownership-2026-09-22`, under D-008.
--
-- ============================================================================
-- WHAT THIS FIXES, AND WHY A NEW TABLE IS THE FIX RATHER THAN A GUARD
-- ============================================================================
--
-- `harness_shared.owner_directives.capture_status` is ONE directive-scoped
-- column. It is written by any agent that dismisses the row. So a foreign
-- agent's entirely correct "not my lane" dismissal clears the directive for
-- EVERY session in the workspace, including the one the owner was actually
-- addressing. Measured existence proof (su-ebc936c4, WI-10002437): directive
-- #96 — the owner's own pause order, typed into su-ebc936c4's lane — was
-- dismissed by su-c03852cb at 15:12:43Z with correct reasoning and global
-- effect. It is now absent from `orders:list { open: true }` while
-- `orders:get { id: 96 }` still reports `open: true`, and
-- `orders:resolve-pending promote` returns `not_pending`: irreversible.
--
-- The obvious remedy — refuse a foreign dismissal — is WRONG, and D-008 exists
-- because it is wrong. su-14342fa6 measured the other horn: refusing foreign
-- RESOLUTION strands every foreign row in every agent's Orientation forever,
-- because a foreign row is precisely the row you can never clear. Under one
-- shared column the two findings have opposite remedies and no setting
-- satisfies both. P-008 as originally authored took the first horn and would
-- have shipped the second defect fleet-wide.
--
-- The resolution is structural, and it is worth stating exactly why it is
-- stronger than a guard: the bug is possible today only because the dismisser's
-- identity (`capture_dismissed_by`) is a SEPARATE FIELD from the row's
-- identity. The row belongs to nobody, so the dismisser has to be recorded
-- alongside it, and the dismissal necessarily applies to everybody. Making the
-- agenda row per-(directive, session) collapses those two facts into one: the
-- session that dismissed it IS the row's key. A global dismissal stops being
-- something we forbid and becomes something that CANNOT BE EXPRESSED. That is
-- the difference between a rail and a schema, and it is why this is a migration
-- rather than a check in a verb.
--
-- ============================================================================
-- WHAT STAYS WHERE: VALIDITY IS GLOBAL, AGENDA IS PER-SESSION
-- ============================================================================
--
-- The capture lifecycle was overloaded and is being split along the seam it was
-- already straining against. Two genuinely different questions shared one
-- column:
--
--   1. IS THIS REALLY AN OWNER DIRECTIVE?  The UserPromptSubmit hook captures
--      owner turns optimistically as `pending`; an agent confirms (`promote`)
--      or rejects (`dismiss`) that classification. This is a fact about the
--      DIRECTIVE and is correctly GLOBAL. It stays on `owner_directives`.
--
--   2. HAS *THIS SESSION* DISCHARGED THIS ROW FROM ITS OWN AGENDA?  A fact
--      about a session, which is what this table adds.
--
-- The measured evidence that the overload is real, not theoretical: the 47
-- foreign dismissals below carry "not my lane" reasoning. That is answer (2)
-- being written into storage that means (1). Agents were not misusing the
-- verb; the verb was the only one they had.
--
-- Directive rows remain immutable owner speech in the sense D-005 requires:
-- `recorded_by`, `verbatim_text` and `source_turn_ref` are never rewritten.
--
-- ============================================================================
-- ABSENCE IS THE DEFAULT, AND THAT IS WHAT MAKES THE REPAIR FREE
-- ============================================================================
--
-- A row here records a session's DEVIATION from the default, never the default
-- itself. A (directive, session) pair with no row has simply not acted, and its
-- state derives from the directive: `pending` while the capture is unconfirmed,
-- otherwise `open`. This is deliberate and load-bearing in three ways:
--
--   * It keeps the table proportional to actions taken, not to
--     sessions × directives — the latter grows without bound as sessions are
--     minted, for a table that would be almost entirely default rows.
--   * A NEW session inherits the correct agenda with no backfill, forever.
--   * It makes the repair of the 47 damaged rows a matter of ABSENCE. The
--     addressee of a foreign-dismissed directive never acted, so it has no row,
--     so it derives the default — restored, without this migration having to
--     reconstruct a pre-dismissal state that was overwritten and is strictly
--     speaking unrecoverable.
--
-- ============================================================================
-- THE BACKFILL, AND WHY IT IS 52 ROWS RATHER THAN 41 OR 106
-- ============================================================================
--
-- Measured by su-9390fc63 at 2026-09-22T16:29Z against this workspace, as an
-- exhaustive partition that sums (54 + 47 + 5 = 106 of 106, zero NULL
-- fall-through — `dev:pg_query` forces the partition form precisely because a
-- scalar FILTER census hides rows that satisfy no branch):
--
--     total directives ........................... 106
--     dismissed (any) ............................  52
--       foreign  (dismissed_by <> recorded_by) ...  47   <- the damaged set
--       self     (dismissed_by  = recorded_by) ...   5   <- legitimate
--     never dismissed ............................  54
--
-- ⚠ An earlier census on WI-10002437 reported 41 dismissed and ZERO
-- self-dismissals. The population delta (105 -> 106) is ordinary drift; the
-- 0 -> 5 is not, and it inverts a decision. A backfill written against
-- "every dismissal was foreign" would resurrect 5 directives that their
-- RIGHTFUL ADDRESSEE had correctly cleared, re-nagging the one session
-- entitled to dismiss them — the original harm, pointed the other way. The two
-- censuses are not reconciled; this migration uses the predicate, not either
-- headline number, so it stays correct whichever was right and however the
-- population has moved since.
--
-- So the backfill inserts one `dismissed` agenda row per REAL dismissal,
-- attributed to the session that actually performed it — foreign and self
-- alike, because both are correct statements about that session's own agenda.
-- The 47 addressees get nothing, which is exactly the repair.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES *NOT* DO
-- ============================================================================
--
-- It does not restore `owner_directives.capture_status` for the 47. That repair
-- is correct but MUST NOT ship here, and the reason is a live-traffic hazard
-- rather than a schema one:
--
--   The currently-deployed :3070 release still reads the single global column
--   and knows nothing about this table. Restoring 46 rows to `pending` and 1 to
--   `open` while that reader is live would resurrect them into EVERY agent's
--   Orientation banner simultaneously, as [DUE] imperatives, with no
--   per-session dismissal available to clear them — because the code that
--   honours this table would not be deployed yet. That converts a silent
--   erasure into a fleet-wide nag storm, and it would arrive hours after the
--   DDL applied, which is the same delayed blast radius the FORWARD-COMPAT
--   rule exists to prevent for destructive DDL.
--
-- This is expand/contract applied to DATA, not just to schema. EXPAND (this
-- migration): create the rail, backfill attribution; nothing reads it, so it is
-- inert. Then land the reader/writer split. Only THEN, in a later numbered
-- migration, restore the 47 — at which point a session that genuinely wants the
-- row off its banner has a per-session dismissal to do it with.
--
-- No destructive DDL here (one new table, no DROP / RENAME / SET NOT NULL on an
-- existing object, no partial UNIQUE index on existing data), so no
-- FORWARD-COMPAT acknowledgment line is required: the deployed release simply
-- does not select this table.

CREATE TABLE IF NOT EXISTS harness_shared.owner_directive_agenda (
  workspace_id     text        NOT NULL,
  directive_id     bigint      NOT NULL,
  owner_id         text        NOT NULL,
  state            text        NOT NULL,
  reason           text,
  acted_at         timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, directive_id, owner_id),
  CONSTRAINT owner_directive_agenda_state_check
    CHECK (state = ANY (ARRAY['open'::text, 'dismissed'::text])),
  -- A dismissal without a reason is how the original defect stayed invisible:
  -- nobody could tell an "unreadable, not a directive" from a "not my lane".
  -- Mirrors the existing mandatory `capture_dismissal_reason`.
  CONSTRAINT owner_directive_agenda_dismissal_reason_required
    CHECK (state <> 'dismissed' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

COMMENT ON TABLE harness_shared.owner_directive_agenda IS
  'Per-(directive, session) agenda state for owner directives — "has THIS session discharged this row from ITS OWN banner". Split out of the single global harness_shared.owner_directives.capture_status column, which made any agent''s correct "not my lane" dismissal erase the directive for its rightful addressee too (plan directive-visibility-and-ownership-2026-09-22, D-008; measured on directive #96). The dismisser is the row KEY rather than a separate field, which makes a global dismissal unrepresentable rather than merely forbidden. ABSENCE is the default and the common case: a pair with no row has not acted and derives its state from the directive, so new sessions need no backfill and a wrongly-cleared addressee is repaired by having no row at all. Directive VALIDITY (is this really an owner order: pending/open/dismissed) stays global on owner_directives; only agenda lives here.';

COMMENT ON COLUMN harness_shared.owner_directive_agenda.owner_id IS
  'The coord ownerId whose agenda this row describes. This is a LIVE per-session claim, not telemetry: unlike orientation_obligation_action.owner_id and orientation_class_reach.owner_id (migration 1192), which measure what a historical id actually saw and are therefore correctly stranded on rebind, this row must FOLLOW the agent across a rebind — otherwise a respawned session is re-nagged with directives it already dismissed. Registered `covered` in identity-keyed-state-inventory.';

COMMENT ON COLUMN harness_shared.owner_directive_agenda.state IS
  'open = explicitly re-opened on this session''s agenda after a dismissal. dismissed = cleared from THIS session''s banner only; never affects any other session, and never affects the directive''s own validity. There is deliberately no `pending` member: pending is a property of the CAPTURE (is this really a directive), which is global and stays on owner_directives.capture_status.';

COMMENT ON COLUMN harness_shared.owner_directive_agenda.reason IS
  'Mandatory when state = dismissed. The 47 measured foreign dismissals carried "not my lane" reasoning written into a column that meant "this is not a directive" — the overload this table resolves. Keeping the reason makes the distinction legible in the data going forward.';

-- The hot read is "which directives has THIS session cleared", evaluated per
-- session while rendering the Orientation banner. The primary key leads with
-- workspace_id + directive_id, which serves the per-directive direction; this
-- serves the per-session direction without duplicating the full key.
CREATE INDEX IF NOT EXISTS owner_directive_agenda_owner_idx
  ON harness_shared.owner_directive_agenda (workspace_id, owner_id, directive_id);

-- ---------------------------------------------------------------------------
-- BACKFILL — one row per real dismissal, attributed to whoever performed it.
--
-- Predicate-driven, never count-driven: it selects the rows that ARE dismissed
-- with a known dismisser at apply time, so it stays correct regardless of which
-- census headline was right and of how the population has moved since it was
-- measured. `capture_dismissed_by IS NOT NULL` is required rather than assumed
-- — measured 0 NULLs at authoring time, but a NULL would silently produce a row
-- attributed to nobody, which is the shape of the bug being fixed.
--
-- Both foreign AND self dismissals are carried across, because both are true
-- statements about the dismissing session's own agenda. The difference between
-- them is not in what we write here; it is that a self-dismisser is also the
-- addressee, so its row lands on the addressee, whereas a foreign dismisser's
-- row lands on the foreigner and the addressee is left with none.
-- ---------------------------------------------------------------------------
INSERT INTO harness_shared.owner_directive_agenda
  (workspace_id, directive_id, owner_id, state, reason, acted_at, created_at)
SELECT
  d.workspace_id,
  d.id,
  d.capture_dismissed_by,
  'dismissed',
  COALESCE(
    NULLIF(btrim(d.capture_dismissal_reason), ''),
    'backfilled from the pre-1195 global capture_status: original dismissal reason not recorded'
  ),
  COALESCE(d.capture_dismissed_at, d.created_at),
  now()
FROM harness_shared.owner_directives AS d
WHERE d.capture_status = 'dismissed'
  AND d.capture_dismissed_by IS NOT NULL
ON CONFLICT (workspace_id, directive_id, owner_id) DO NOTHING;
