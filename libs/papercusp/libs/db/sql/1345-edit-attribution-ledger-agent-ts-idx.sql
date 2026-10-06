-- 1345-edit-attribution-ledger-agent-ts-idx.sql — WI-10005571
-- (plan personal-data-reader-set-labels-2026-10-01 P-014, D-006 point 3)
--
-- git-sync now holds every path an agent edited while it held an active personal
-- disclosure: its census reads the edit-attribution ledger rows of agents with an
-- unreleased disclosure, from that disclosure's delivered_at onward
-- (packages/operator-core/lib/personal-vault/git-sync-hold.ts). That read runs on
-- every git-sync tick and at every final-commit-seam refresh, and is keyed by
-- (agent_id, ts). The ledger's only indexes are (repo_root, file, ts) and
-- (work_item_id, ts), so without this index each read is a sequential scan of the
-- whole ledger (about 199k rows / 134 MB, measured 2026-10-02).
--
-- FORWARD-COMPAT: additive only (one new index). The currently deployed release never
-- reads by agent_id and is unaffected; its inserts simply maintain one more index.

CREATE INDEX IF NOT EXISTS edit_attribution_ledger_agent_ts_idx
  ON harness_shared.edit_attribution_ledger (agent_id, ts DESC);
