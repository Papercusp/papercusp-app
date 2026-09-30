-- 589-releases-registry.sql — WI-4446. The release registry.
--
-- WHY THIS TABLE EXISTS
-- We had no answer to "what shipped between 0.0.7 and 0.0.8?" because we had no
-- record of a release ever being cut. Releases were implicit: a tag on GitHub, a
-- file on a host, a manifest. So:
--   * /api/updates/history (the in-app Update Center) discovered releases from the
--     GitHub Releases API — the ONLY source. Since releases went local-only
--     [owner 2026-07-08] we publish nothing there, so it returns an empty list
--     on the R2 rail. Same bug class as WI-4389: the rail moved, the discovery
--     didn't.
--   * "the full list of work items fixed between releases and plans implemented"
--     [owner 2026-07-12] has no boundary to compute BETWEEN without a cut_at.
--
-- A release is now a ROW, written at cut time. Both surfaces — the beta
-- release-history page (static, on the R2 secret path) and the in-app history
-- endpoint — read this one table, so they cannot disagree.
--
-- WHY THE WORK-ITEM / PLAN LISTS ARE SNAPSHOTTED, not re-derived on read:
-- "what shipped in 0.0.8" is a fact about the past. Re-deriving it later from a
-- live work_items query would let a retroactive edit (an item reopened, a plan
-- renamed) silently rewrite a published changelog. We freeze it at cut time.

CREATE TABLE IF NOT EXISTS harness_shared.releases (
  workspace_id     text        NOT NULL,
  version          text        NOT NULL,          -- semver, matches the Tauri updater's `version`
  channel          text        NOT NULL DEFAULT 'alpha',
  cut_at           timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,                   -- set when the artifacts + latest.json are LIVE
                                                  -- (uploaded != reachable — see WI-4364: a signed,
                                                  -- schema-valid manifest naming a 404 is still broken)
  changelog_md     text,                          -- the AGENT's high-level prose [owner 2026-07-12]
  work_item_ids    text[]      NOT NULL DEFAULT '{}',
  plan_slugs       text[]      NOT NULL DEFAULT '{}',
  artifacts        jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{product,platform,name,url,size,sha256}]
  git_sha          text,
  cut_by           text,                          -- the agent/session that cut it
  notes            text,
  PRIMARY KEY (workspace_id, channel, version)
);

-- The history page and the updater both want "newest first, in this channel".
CREATE INDEX IF NOT EXISTS releases_ws_channel_cut_at_idx
  ON harness_shared.releases (workspace_id, channel, cut_at DESC);

COMMENT ON TABLE  harness_shared.releases IS
  'WI-4446: one row per release cut. Source of truth for the beta release-history page and /api/updates/history. work_item_ids/plan_slugs are SNAPSHOTTED at cut time, never re-derived.';
COMMENT ON COLUMN harness_shared.releases.published_at IS
  'Set only once the manifest + artifacts are FETCHABLE at their advertised urls. NULL = cut but not live.';
