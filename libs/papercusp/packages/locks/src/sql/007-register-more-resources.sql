-- Register more shared resources, from observed parallelism pain in the coord
-- history (plan named-resource-locks-drain follow-up):
--   shop                     — shop build + :4321 preview (stale-server e2e
--                              false-positives + concurrent dist clobbers)
--   desktop-sidecar          — papercusp-desktop sidecar/embedded-pg bundle
--                              build (the recurring 0-byte-binary clobber)
--   libs-papercusp-submodule — commit on the submodule + bump the superproject
--                              pointer (+ push) — the heavy manual "owner-sync
--                              UPDATE" coord broadcasts
-- Idempotent; ON CONFLICT DO NOTHING so a human-edited row is never clobbered.
-- match_patterns target only DESTRUCTIVE commands (builds/restarts), never
-- reads (a tester's curl :4321 must not be gated).
INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('shop',
   'The shop app build + :4321 preview. Rebuilding/restarting it while a peer is testing serves stale bytes (a recurring e2e false-positive); two concurrent dist builds clobber each other.',
   'Acquire shared(shop) before testing against the running shop (:4321). To rebuild or restart it, acquire exclusive(shop) with a drain so testers + any concurrent build finish first, then build/restart and release (which broadcasts "back up").',
   'enforced',
   ARRAY['astro build', 'astro preview', 'overmind.*restart.*shop']),
  ('desktop-sidecar',
   'The papercusp-desktop sidecar + embedded-pg bundle build. Concurrent builds clobber the bundle (the recurring 0-byte-binary defect).',
   'Acquire exclusive(desktop-sidecar) before building the desktop sidecar / embedded-pg bundle so a concurrent build cannot clobber it; release when the build is done.',
   'enforced',
   ARRAY['build-desktop-sidecar', 'release-local', 'npm.*run.*build.*desktop']),
  ('libs-papercusp-submodule',
   'The libs/papercusp submodule pointer. Concurrent commits + superproject pointer bumps race (last-writer-wins), driving the heavy manual "owner-sync" coord broadcasts.',
   'Acquire exclusive(libs-papercusp-submodule) across the whole sequence: commit on the submodule main, bump the superproject pointer, (push). Releasing broadcasts the new tip — replacing the manual "owner-sync UPDATE" messages.',
   'advisory',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
