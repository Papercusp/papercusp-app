-- 237-git-sync-degeneralize-data.sql
-- git-sync-any-hive-2026-06-12 B-05 (P-006/P-007): two guarded data UPDATEs that
-- accompany the de-papercuping of git-sync-action.ts. (This file lives in the
-- main-db migrations, NOT next to the locks 015 migration, because the locks
-- package's sql/ applies to the separate `papercusp_su` database — these rows
-- live in harness_shared here.)
\set ON_ERROR_STOP on

-- 1) P-006: preserve papercup's documented lock back-off protocol. The action now
--    acquires the per-harness `git-sync:<slug>` resource instead of the global
--    `git-sync` + `libs-papercusp-submodule` pair; papercup's routine row lists
--    the two legacy names in trigger_config.extra_lock_resources so its tick
--    still holds them — peers acquiring exclusive(git-sync) keep making
--    papercup's git-sync back off, exactly as the registry rule_text promises
--    (locks sql/008, reworded in locks sql/015).
--    Guarded: only fires while the key is absent (idempotent; never clobbers a
--    later hand-curated value).
UPDATE harness_shared.routines
   SET trigger_config = trigger_config
                        || '{"extra_lock_resources": ["git-sync", "libs-papercusp-submodule"]}'::jsonb,
       updated_at = now()
 WHERE install_slug = 'papercup'
   AND target_role = 'system:git-sync'
   AND NOT (trigger_config ? 'extra_lock_resources');

-- 2) P-007: git-sync escalations now live at the CONSTANT phase 'git-sync'
--    instead of 'staging' (see the ESCALATION_PHASE doc-comment in
--    git-sync-action.ts: branch-derived phases would orphan open rows on a
--    branch change, and 'staging' shared its (harness_slug, phase) PK row with
--    auto-rebase's rebase_conflict — they clobbered each other). Move any OPEN
--    git-sync rows so the action's clear-on-clean-pass UPDATE still finds them.
--    The escalation column is text; git-sync bodies are JSON.stringify output
--    with `kind` as the first key, so the LIKE prefix match identifies them
--    without a ::jsonb cast (which would throw on the markdown-prose escalation
--    rows other writers produce). Guarded against a pre-existing
--    (slug, 'git-sync') row (PK) — idempotent: re-running matches zero rows.
UPDATE harness_shared.harness_escalations e
   SET phase = 'git-sync'
 WHERE e.phase = 'staging'
   AND (e.escalation LIKE '{"kind":"git-sync-conflict"%'
        OR e.escalation LIKE '{"kind":"git-sync-error"%')
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.harness_escalations g
      WHERE g.harness_slug = e.harness_slug AND g.phase = 'git-sync');
