-- Migration 539 — session_archives: PG becomes the canonical archive of ended
-- CLI sessions (plan session-db-archive-retire-dirs-2026-07-10 P-001,
-- owner-approved 2026-07-10, route A).
--
-- INVERTS migration 501's storage contract. Until now: the on-disk JSONL was
-- the permanent archive and harness_shared.session_turns the bounded,
-- 45d-pruned recall INDEX ("the JSONL files remain the archive"). After this
-- migration the compressed per-file rows here are the ONE permanent canonical
-- copy of an ended claude/omp/codex session's irreplaceable bytes;
-- session_turns is UNCHANGED (still the derived index — zero long-run
-- duplication; the 45d window's ≤8k text subset is the only transient
-- overlap, by design — see plan D-001).
--
-- Written by archiveSession() (operator-core lib/session-archive/, P-002) at
-- session death: per-file rows FIRST, then the session-level stamp row in the
-- SAME transaction — a session is archived iff its session_archives row
-- exists; file rows without a stamp are a crashed attempt, re-written
-- idempotently on retry. On-disk files are deleted ONLY after the stamp row
-- commits and shas verify. Resume rematerializes from these rows on disk-miss
-- (wake-executor, P-008); the scheduled reconciler (P-006) archives sessions
-- that died without stamping ended_at (the idle-session-reaper ghost class).
--
-- Storage budget (measured live 2026-07-10 on 60 real session-claude
-- transcripts): mean 327KB raw / 69KB zstd per session (4.7x), projected
-- ~46MB/day stored at ~650 sessions/day ≈ 17GB/yr. blob storage is EXTERNAL —
-- bytes arrive pre-compressed (zstd), pglz re-compression is pure waste.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level
-- BEGIN/COMMIT — the migration runner wraps each file in its own transaction
-- (lint-migrations enforced-era contract).

-- Per-file compressed payloads: one row per irreplaceable file of the session
-- (claude: projects/<munged-cwd>/<uuid>.jsonl + todos/<uuid>*; codex: rollout
-- jsonl + memories/goals sqlite + config.toml from the per-session home,
-- archived OPAQUE per plan D-003; omp: the session jsonl). Symlinks and
-- regenerable launch scaffolding are never archived.
CREATE TABLE IF NOT EXISTS harness_shared.session_archive_files (
  workspace_id  TEXT        NOT NULL DEFAULT 'default',
  source_kind   TEXT        NOT NULL,            -- 'claude' | 'omp' | 'codex'
  session_id    TEXT        NOT NULL,            -- native CLI session id (jsonl/rollout uuid)
  relpath       TEXT        NOT NULL,            -- path relative to the session root
  codec         TEXT        NOT NULL DEFAULT 'zstd',
  blob          BYTEA       NOT NULL,            -- codec-compressed raw file bytes
  sha256        TEXT        NOT NULL,            -- hex sha256 of the RAW (uncompressed) bytes
  bytes_raw     BIGINT      NOT NULL,
  bytes_stored  BIGINT      NOT NULL,
  mtime         TIMESTAMPTZ,                     -- source file mtime at archive time
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_kind, session_id, relpath)
);
-- Pre-compressed payloads: EXTERNAL = TOAST out-of-line, skip pglz.
ALTER TABLE harness_shared.session_archive_files
  ALTER COLUMN blob SET STORAGE EXTERNAL;

-- Session-level stamp = the completeness contract. Row exists ⇒ the archive
-- is complete and verified; manifest lists every file row (relpath, sha256,
-- bytes_raw) so rematerialize + reconcile verify WITHOUT scanning blobs.
CREATE TABLE IF NOT EXISTS harness_shared.session_archives (
  workspace_id    TEXT        NOT NULL DEFAULT 'default',
  source_kind     TEXT        NOT NULL,
  session_id      TEXT        NOT NULL,
  owner           TEXT,                          -- agent ownerId when resolvable (su-…, role-…)
  harness_slug    TEXT,
  cwd             TEXT,                          -- the session's working directory
  adv_session_id  BIGINT,                        -- adv_sessions.id when we launched it (NULL = out-of-band)
  session_root    TEXT        NOT NULL,          -- abs root the relpaths resolved against at archive time
  file_count      INTEGER     NOT NULL,
  bytes_raw       BIGINT      NOT NULL,
  bytes_stored    BIGINT      NOT NULL,
  manifest        JSONB       NOT NULL,          -- [{ relpath, sha256, bytes_raw }]
  archived_by     TEXT,                          -- ownerId | 'exit-hook' | 'reconciler' provenance
  archived_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_kind, session_id)
);

CREATE INDEX IF NOT EXISTS session_archives_owner_idx
  ON harness_shared.session_archives (owner, archived_at);
CREATE INDEX IF NOT EXISTS session_archives_adv_idx
  ON harness_shared.session_archives (adv_session_id)
  WHERE adv_session_id IS NOT NULL;

-- adv_sessions gains the archive stamp the fast path + reconciler key on.
ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- The reconciler's scan (owner Q4 backstop): ended-but-unarchived sessions.
CREATE INDEX IF NOT EXISTS adv_sessions_ended_unarchived_idx
  ON harness_shared.adv_sessions (ended_at)
  WHERE ended_at IS NOT NULL AND archived_at IS NULL;
