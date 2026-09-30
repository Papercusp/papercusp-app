-- git-sync-auto-commit P-009: register the `git-sync` resource so the
-- `system:git-sync` routine action can hold it exclusively across the whole
-- commit -> submodule-push -> pointer-bump -> push sequence. Two git-sync runs,
-- or a git-sync run racing a peer's manual whole-tree git work, would otherwise
-- race the index/refs. Advisory (like libs-papercusp-submodule) — no destructive
-- command patterns to gate; this is a coordination lock the action holds itself.
-- Idempotent; ON CONFLICT DO NOTHING so a human-edited row is never clobbered.
INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('git-sync',
   'The automated git-sync pipeline for a harness (commit + submodule push + merge + push to origin/main). Concurrent git-sync runs, or a run racing a peer''s manual git work on the shared checkout, race the index/refs.',
   'The system:git-sync routine action holds exclusive(git-sync) for the whole commit -> submodule-push -> pointer-bump -> push sequence. A peer doing manual whole-tree git work can acquire exclusive(git-sync) to make git-sync back off that tick.',
   'advisory',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
