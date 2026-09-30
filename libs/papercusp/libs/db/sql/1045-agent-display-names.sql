-- 1045 — agent_display_names: the owner-keyed MANUAL name for an agent session.
--
-- Plan hud-session-display-names-2026-08-31, P-001, ruled by D-003.
--
-- WHY A NEW TABLE, and why the grain is load-bearing (D-003, measured):
--   A display name is an attribute of the AGENT, and ownerId is what all three
--   surfaces that must show it are keyed by — the HUD card, the conversation
--   popup (`hudsession=<ownerId>`), and the OS terminal title.
--
--   The first draft put a `display_name` column on harness_shared.adv_sessions
--   and was RETRACTED on measurement: 77 of 19,806 owners hold 2–4 adv_sessions
--   rows, and the two readers resolve differently — coord:glance has only an
--   ownerId in hand, while adv-roster picks an adv_sessions row through its own
--   join. For those owners the terminal and the HUD could select different rows
--   and show DIFFERENT NAMES, which is exactly the divergence this feature
--   exists to end.
--
--   coord_presence has the right grain (owner_id PK) and even an owner_label
--   column, but is TTL-reaped — its own owner_id column comment says so — so a
--   name parked there silently evaporates. agent_modes / session_briefs /
--   owner_directives are owner-keyed but purpose-specific rows, not attribute
--   bags. The operator_* tables are single-row-per-WORKSPACE JSONB payloads:
--   wrong grain, not batch-joinable, and a write-contention point.
--
-- Additive only: CREATE TABLE IF NOT EXISTS. Nothing currently deployed reads
-- or writes this relation, so no FORWARD-COMPAT acknowledgment is required —
-- there is no destructive DDL here.

CREATE TABLE IF NOT EXISTS harness_shared.agent_display_names (
  -- Multi-tenant, like every other harness_shared relation: a bare owner_id
  -- filter must never reach across workspaces.
  workspace_id  text        NOT NULL,
  -- The coord ownerId (e.g. su-b2572cce-…). Deliberately NOT a foreign key to
  -- coord_presence: that table is TTL-reaped, and the whole point of this row
  -- is to outlive the presence row it describes.
  owner_id      text        NOT NULL,
  -- The name a human (or the agent itself) chose. NOT NULL because "no name"
  -- is expressed by the ABSENCE of a row, not by a null: a null here and a
  -- missing row would be two encodings of the same state, and the resolver
  -- would have to handle both. Clearing a name DELETEs the row.
  display_name  text        NOT NULL,
  -- WHO set it, so a surface can distinguish an owner's name from one an agent
  -- gave itself (sessions:rename). Free text: a coord ownerId, or 'owner'.
  set_by        text,
  set_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id)
);

-- The name is trimmed and non-empty at the write path; the constraint makes an
-- empty name unrepresentable rather than merely discouraged, so a future writer
-- cannot reintroduce the blank-headline state R6 forbids.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_display_names_display_name_nonempty'
  ) THEN
    ALTER TABLE harness_shared.agent_display_names
      ADD CONSTRAINT agent_display_names_display_name_nonempty
      CHECK (length(btrim(display_name)) > 0);
  END IF;
END $$;

COMMENT ON TABLE harness_shared.agent_display_names IS
  'Owner-keyed manual display name for an agent session (plan hud-session-display-names-2026-08-31, D-003). Read by BOTH coord:glance (OS terminal title, via renderStatusDisplay) and adv-roster (HUD session cards) so the two surfaces cannot disagree. Absence of a row means "no manual name" — the display name then falls back to the objective, then to the short owner id. Durable by design: unlike coord_presence, this table is never TTL-reaped.';

COMMENT ON COLUMN harness_shared.agent_display_names.owner_id IS
  'The coord ownerId this name belongs to. Not a foreign key: coord_presence is TTL-reaped and this row must outlive it.';

COMMENT ON COLUMN harness_shared.agent_display_names.set_by IS
  'Who set the name — a coord ownerId when an agent named itself via sessions:rename, or ''owner'' when a human set it from the conversation popup header.';
