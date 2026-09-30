-- 967-operator-session-confinements.sql — directed-pair-work-items-2026-08-25 P-004 (D-015/D-016/D-017).
--
-- operator_session_confinements — one JSONB row per workspace backing the launch-declared SESSION
-- tool confinement. payload = { sessions: { <coordOwnerId>: { confinement: {denyTools, reason,
-- imposedBy}, expiresAt: <ISO>, declaredAt: <ISO> } } }, read into a D-010-style SYNC cache so the
-- dispatch hot path stays zero-await (see lib/capability-envelope/session-confinement-store.ts).
--
-- WHY ITS OWN TABLE AND NOT session_briefs.control_state (D-017 §3): control_state is rewritten
-- WHOLESALE by other writers (mode:set, orient). A security rail living inside a document someone
-- else replaces is a clobber-shaped fail-open — the confinement would vanish with nothing thrown.
--
-- The key is the coord ownerId from resolveAgentIdentity (transport-resolved: Mcp-Session-Id for a
-- superuser session, HMAC-verified client= for a spawn), never a value the caller supplies. Rows
-- keyed on a POPULATION id (SUPERUSER_FALLBACK_CLIENT_ID 'su-loopback', mcp-call-<pid>) are refused
-- on write and ignored on read — such a key would confine every client-less su session on the box,
-- the owner's own included (D-017 §2).
--
-- Empty payload (the default, and the state of every workspace until a paired fleet launches) ⇒ the
-- resolver returns null for every session ⇒ the gate is byte-identical to no gate at all.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe; no destructive DDL.

CREATE TABLE IF NOT EXISTS harness_shared.operator_session_confinements (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_session_confinements TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_session_confinements TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_session_confinements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_session_confinements_workspace_isolation ON harness_shared.operator_session_confinements;
CREATE POLICY operator_session_confinements_workspace_isolation ON harness_shared.operator_session_confinements
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
