-- 783 — per-client projection record for composed docs.
--
-- EI-20055472930397669. `scripts/project-doc-parts.mjs` projects ONE doc row into N
-- client files (claude -> CLAUDE.md, codex -> AGENTS.md). Before this column the only
-- record of "what did we last write" was `harness_docs.content_hash`, which is the hash
-- of the PRIMARY client's composition — so the projector's overwrite guard compared
-- AGENTS.md's bytes against CLAUDE.md's hash, could never match, and refused to update
-- AGENTS.md forever. The refusal also suppressed the cache write, so the recorded state
-- fell further behind on every run.
--
-- The fix is a record per client rather than one hash for the primary:
--
--   {"claude": {"file": "CLAUDE.md",  "sha": "<sha256 of the bytes we wrote>",
--               "chars": 59377, "written_at": "2026-08-10T09:00:00.000Z"},
--    "codex":  {"file": "AGENTS.md",  "sha": "...", "chars": 59386, "written_at": "..."}}
--
-- Shallow-merged with `||` on write, so one client's refusal cannot clobber another
-- client's record — the coupling that made the original drift compound.
--
-- `content_hash` keeps its documented meaning (the hash of the cached `content`) and is
-- unchanged; this column is additive. Empty `{}` reads as "no client has been projected
-- since this column existed", which the projector treats as unknown and falls back to
-- its pre-existing checks, so no backfill is required.

ALTER TABLE harness_shared.harness_docs
  ADD COLUMN IF NOT EXISTS projected_clients jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN harness_shared.harness_docs.projected_clients IS
  'Per-client projection record for content_mode=''composed'' docs: {client: {file, sha, chars, written_at}}. Written by scripts/project-doc-parts.mjs after each successful client file write, shallow-merged so one client''s refusal cannot clobber another''s record. The projector''s overwrite guard reads it to decide whether a given file on disk is still ITS OWN last output (EI-20055472930397669).';
