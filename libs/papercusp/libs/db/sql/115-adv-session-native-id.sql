-- 115-adv-session-native-id.sql
--
-- Record the agent's NATIVE session id on a tracked psu session, so
-- `psu --resume <native-uuid>` can correlate that id back to its
-- harness_shared.adv_sessions row.
--
-- THE BUG THIS FIXES: resume-by-id matched ONLY the integer adv_sessions
-- primary key (`String(s.id) === String(resumeId)`), and the native session
-- UUID was never recorded anywhere. claude/codex mint their own session UUID
-- at launch, which psu never learned. So resuming a psu-launched claude
-- session by its native UUID could never match a tracked row — it always fell
-- through to the "untracked / a vanilla session NOT started by psu" path,
-- a false positive (the warning is fabricated from an int-vs-uuid mismatch).
--
-- psu now mints + forces the claude session id (`claude --session-id <uuid>`)
-- at launch and records it here; the launcher matches resume ids against this
-- column as well as the integer id, and resumes the EXACT session.
--
-- Nullable: pre-existing rows carry NULL (they predate this), and so do omp
-- (whose native id is omp_thread_id) and codex (whose resume is keyed by its
-- per-session CODEX_HOME, not a forced session id). Idempotent.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS session_id text;

-- Resume-by-native-uuid looks a row up by this id.
CREATE INDEX IF NOT EXISTS adv_sessions_session_id_idx
  ON harness_shared.adv_sessions (session_id);
