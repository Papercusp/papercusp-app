-- 605-session-turn-journal.sql — deterministic-context-carry-2026-07-14 P-012.
--
-- session_turn_journal — one row per completed agent TURN: the 1–3-sentence
-- journal note written by the ACTING agent at turn end (plan D-003: written by
-- the acting LLM, never a separate reader-LLM). Collection is client-neutral
-- (predecessor agent-managed-compaction D-002 control tiers):
--   * Claude / Codex — the cc/ Stop hook (stop-turn-journal.sh) pings
--     journal:record-turn with the transcript path; the SERVER extracts.
--   * OMP — the in-process coord-hook turn_end port pings the same tool.
--   * anything else — mechanical fallback only, flagged.
-- `source` records authorship: 'agent' = the agent wrote a ⟦journal⟧ line in
-- its final message; 'mechanical' = first line of the last assistant message
-- (flagged=true — the reader must know nobody wrote this on purpose).
--
-- `tripwire` is the claim-vs-ledger honesty diff seed (P-012 minimal case:
-- note claims tests/build pass while the same turn's agent_activity ledger
-- shows an error — "note says pass, ledger says exit 1"). The journal is a
-- CLAIM, the tool ledger is TRUTH; the diff audits honesty so journals are
-- never graded (ambient-semantic-push D-008 anti-Goodhart). P-029 broadens it.
--
-- Consumers: the ambient-semantic-push cursor is built from journal notes ONLY
-- (ambient D-001); fleet members may PULL each other's journals (ambient D-008).
--
-- Conventions mirror session_turns (501): workspace_id defaults 'default'
-- (transcript files carry no workspace identity), no RLS, bounded index — the
-- transcript remains the archive; rows past retention are pruned code-side.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level
-- BEGIN/COMMIT — the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.session_turn_journal (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id TEXT        NOT NULL DEFAULT 'default',
  owner_id     TEXT,                  -- coord identity (PAPERCUSP_SID) when known
  agent        TEXT,                  -- 'claude' | 'codex' | 'omp' (best-effort)
  source_kind  TEXT        NOT NULL DEFAULT 'claude',  -- transcript adapter kind
  session_id   TEXT        NOT NULL,  -- native client session id
  turn_ts      TIMESTAMPTZ,           -- the journaled assistant message's own ts
  note         TEXT        NOT NULL,  -- the 1–3 sentence journal note
  source       TEXT        NOT NULL CHECK (source IN ('agent', 'mechanical')),
  flagged      BOOLEAN     NOT NULL DEFAULT false,  -- true = mechanical fallback
  tripwire     JSONB,                 -- claim-vs-ledger mismatch evidence, when tripped
  harness_slug TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One journal row per (session, assistant-message ts): the hook and any
-- server-mediated sweep both extract from the SAME message, so the first
-- writer wins and the second INSERT ... ON CONFLICT DO NOTHING is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS session_turn_journal_turn_uq
  ON harness_shared.session_turn_journal (session_id, COALESCE(turn_ts, 'epoch'::timestamptz));

-- The ambient cursor + fleet pulls read per-owner, newest first.
CREATE INDEX IF NOT EXISTS session_turn_journal_owner_ts_idx
  ON harness_shared.session_turn_journal (owner_id, created_at DESC);

-- Retention prune scans by age.
CREATE INDEX IF NOT EXISTS session_turn_journal_created_idx
  ON harness_shared.session_turn_journal (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.session_turn_journal TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_turn_journal TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
