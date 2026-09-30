-- 1125-frozen-repair-edit-ledger.sql
-- frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 P-019 — D-008 layer 1 (edit ledger).
--
-- WHY A LEDGER. Path-exact admission (D-002) guarantees no OTHER file enters the judged
-- lineage; it cannot guarantee a named file's blob is pure. On this shared tree two agents
-- routinely edit the same file for unrelated reasons, so staging's blob at admission time can
-- carry the fix AND a stranger's half-finished work. git blame and commit subjects are
-- meaningless under git-sync (one sweep identity, one subject per sweep), so the ONLY
-- attribution that works is the hook that sees the exact hunk at the moment it is made.
--
-- WHO WRITES. `posttooluse-frozen-candidate-edit-nudge.mjs` (PostToolUse on every
-- Edit/Write/MultiEdit) — ONLY while the frozen-repair marker file exists (the inverted
-- signal: nothing frozen ⇒ no marker ⇒ one failed stat and no database round-trip) — via
-- `release:repair-queue { op:'record-edit' }`. One row per hunk; a MultiEdit is N rows sharing
-- a tool_use_id with distinct edit_index.
--
-- WHO READS. `release:repair-queue { op:'admit' }` (P-020, hunk-exact by default) replays
-- ONLY the calling agent's rows for each admitted path onto repairHead's blob, and the
-- owner brief / repair manifest render "recorded N hunks by M agents" per subject path.
--
-- Additive only (new table + indexes): no currently-deployed code reads or writes it, so no
-- FORWARD-COMPAT acknowledgment is needed.

CREATE TABLE IF NOT EXISTS harness_shared.frozen_repair_edit_ledger (
  id            bigserial   PRIMARY KEY,
  workspace_id  text        NOT NULL,
  install_slug  text        NOT NULL,
  -- The immutable frozen candidate the hunk was made under (rows for a retired or
  -- promoted candidate simply stop being read; no cascade is needed).
  candidate     text        NOT NULL CHECK (candidate ~ '^[0-9a-f]{40,64}$'),
  -- The per-session lock owner (PAPERCUSP_LOCK_SID / PAPERCUSP_SID / session id), i.e. the
  -- SAME identity the lock hook and the agent's own tool calls resolve to.
  agent         text        NOT NULL CHECK (length(btrim(agent)) BETWEEN 1 AND 200),
  -- Repo-relative, forward-slash, normalized exactly as the gate normalizes
  -- (`normalizeRepoPath`).
  path          text        NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  -- { kind:'edit', old, new, replaceAll } | { kind:'write', body }
  -- | { kind:'oversize', of:'edit'|'write', bytes, sha256 } (the cap is enforced by the
  -- writer; an oversize row is attribution-only and can never be replayed hunk-exactly).
  hunk          jsonb       NOT NULL,
  hunk_kind     text        NOT NULL CHECK (hunk_kind IN ('edit', 'write', 'oversize')),
  hunk_sha256   text        NOT NULL CHECK (hunk_sha256 ~ '^[0-9a-f]{64}$'),
  at_ms         bigint      NOT NULL CHECK (at_ms > 0),
  -- The client's tool_use_id (or a hook-minted surrogate) + the edit's index within a
  -- MultiEdit: together the idempotency key, so a retried hook call cannot double-record.
  tool_use_id   text        NOT NULL CHECK (length(tool_use_id) BETWEEN 1 AND 200),
  edit_index    integer     NOT NULL DEFAULT 0 CHECK (edit_index >= 0),
  work_item     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT frozen_repair_edit_ledger_idempotent
    UNIQUE (workspace_id, install_slug, candidate, agent, path, tool_use_id, edit_index)
);

-- The replay read: every hunk for one path on one lineage, in the order it was made.
CREATE INDEX IF NOT EXISTS frozen_repair_edit_ledger_lineage_path_idx
  ON harness_shared.frozen_repair_edit_ledger (workspace_id, install_slug, candidate, path, at_ms, id);

-- The attribution read: what did THIS agent record under this candidate.
CREATE INDEX IF NOT EXISTS frozen_repair_edit_ledger_agent_idx
  ON harness_shared.frozen_repair_edit_ledger (candidate, agent, at_ms);

COMMENT ON TABLE harness_shared.frozen_repair_edit_ledger IS
  'P-019 (D-008 layer 1): the exact hunk of every Edit/Write made while a gate candidate is frozen, attributed to the per-session agent that made it. Written by the PostToolUse hook via release:repair-queue record-edit; read by hunk-exact admission (P-020) and the repair manifest.';
