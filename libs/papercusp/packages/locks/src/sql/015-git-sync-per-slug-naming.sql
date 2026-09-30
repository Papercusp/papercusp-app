-- git-sync-any-hive-2026-06-12 P-006 (B-05): git-sync lock resources are now
-- PER-HARNESS. Each harness's `system:git-sync` tick holds
-- `exclusive(git-sync:<slug>)` — the action auto-registers that name
-- (idempotent INSERT ... ON CONFLICT DO NOTHING, inside the same workspace txn
-- as the acquire) so an unregistered name can never again silently no-op the
-- sync forever (`tryAcquireResource` returns unknown_resource for unregistered
-- names, which the action reads as "skip this tick").
--
-- The legacy global `git-sync` name (registered in 008) is RETAINED, not
-- dropped: it is the documented back-off protocol for the papercup shared
-- checkout ("acquire exclusive(git-sync) to make git-sync back off"). papercup's
-- routine row lists it in trigger_config.extra_lock_resources (db migration
-- 237), so papercup's tick still acquires it and peers' back-off keeps working.
-- This migration only rewrites the registry row's prose to describe the new
-- naming. Idempotent: a plain UPDATE to fixed values.
UPDATE agent_resource_registry
   SET description =
         'The automated git-sync pipeline (commit + submodule push + merge + push to origin). '
         || 'LEGACY GLOBAL NAME: since git-sync-any-hive (2026-06-12) each harness''s tick holds its own '
         || 'git-sync:<slug> resource (auto-registered by the action); this unsuffixed name is retained for the '
         || 'papercup shared checkout''s back-off protocol via trigger_config.extra_lock_resources.',
       rule_text =
         'Each harness''s system:git-sync routine action holds exclusive(git-sync:<slug>) for the whole '
         || 'commit -> submodule-push -> pointer-bump -> push sequence (the per-slug name is auto-registered on '
         || 'first acquire). A peer doing manual whole-tree git work acquires exclusive(git-sync:<slug>) for that '
         || 'harness to make its git-sync back off that tick. For the papercup shared checkout, this legacy '
         || 'unsuffixed git-sync name still works: papercup''s routine lists it (plus libs-papercusp-submodule) in '
         || 'trigger_config.extra_lock_resources, so acquiring exclusive(git-sync) makes papercup''s git-sync back '
         || 'off exactly as before. Names in extra_lock_resources are never auto-registered — an unknown name '
         || 'makes the tick skip with a logged warning.'
 WHERE resource = 'git-sync';
