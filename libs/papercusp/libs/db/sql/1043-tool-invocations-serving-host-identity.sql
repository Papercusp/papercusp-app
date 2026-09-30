-- 1043: record WHICH HOST PROCESS served each tool call, and what code it had loaded (WI-1565914).
--
-- `harness_shared.tool_invocations` identifies the CALLER (`coord_owner_id`) and records nothing
-- about the SERVER. Measured cost of that gap: host processes running code from before
-- 2026-08-09T23:08Z served live agent calls as late as 2026-08-27T12:00:17Z — ≥17.5 days stale —
-- concurrently with current-code hosts, every day from 08-16 to 08-27. `pot:wake` returned `ok`
-- on 297 of 468 calls because those hosts predated the retirement gate entirely. Nothing in the
-- ledger could say so: the finding took nine queries partitioning the table by proxies until
-- `coord_owner_id` happened to split the populations — and it split them only because sessions
-- are host-sticky, a property of the fleet rather than a guarantee of this schema.
--
-- ⚠ `spawn_id` is NOT that identity, though it reads like one. It is a LABEL: all 490
-- subscription-driven `pot:wake` rows carry the literal 'event-reaction', so `GROUP BY spawn_id`
-- returns ONE mixed bucket — indistinguishable from "a single process produced both outcomes"
-- when it really means the field cannot see processes at all.
--
-- Three columns, because they answer three different questions and collapsing them would
-- reintroduce the ambiguity this fixes:
--   serving_host        — WHICH SERVICE ('port-3070'). Stable across restarts, so it is the
--                         GROUP BY for "does :3070 behave differently from :3170?".
--   serving_process_id  — WHICH RUN of it ('linux:<boot-id>:<start-ticks>'). Kernel-backed and
--                         therefore immune to PID reuse, which happens ~daily here under fleet
--                         load; a bare pid would silently merge two processes into one.
--   serving_build_sha   — WHAT CODE it loaded. The load-bearing one: a stale host is defined by
--                         its code, not by its address.
--
-- Boot time deliberately gets no column: `min(invoked_at) GROUP BY serving_process_id` bounds it
-- from the ledger itself.
--
-- NULL is a real, meaningful value in all three and must never be backfilled with a guess. For
-- rows predating this migration it reads as "recorded before serving-host was tracked". For
-- `serving_build_sha` it additionally means the process could not PROVE what bytes it loaded (a
-- bundled artifact with no baked sha — see lib/build-info.ts, which refuses to report the current
-- checkout's HEAD in that case). Substituting a plausible sha there would recreate precisely the
-- false-confidence failure these columns exist to end.
--
-- Additive only: three nullable columns, no default, no backfill. ADD COLUMN without a default is
-- O(1) in PG11+ and this table takes ~800K inserts/day, so it must stay that way.
--
-- One partial index, mirroring the shape of tool_invocations_coord_owner_idx: the whole point is
-- that `SELECT serving_host, status, count(*) … GROUP BY 1,2` is CHEAP, since an expensive
-- forensic query is one nobody runs during an incident.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS serving_host text,
  ADD COLUMN IF NOT EXISTS serving_process_id text,
  ADD COLUMN IF NOT EXISTS serving_build_sha text;

COMMENT ON COLUMN harness_shared.tool_invocations.serving_host IS
  'WHICH SERVICE served this call: the host label ''port-<n>'' (else ''pid-<n>'' when no port is resolvable), stable across restarts of the same logical service. Same vocabulary as stale-routine-executor''s condition keys, so pages and calls join. NULL = row predates migration 1043. See lib/serving-host-identity.ts.';

COMMENT ON COLUMN harness_shared.tool_invocations.serving_process_id IS
  'WHICH RUN of that service: kernel-backed per-process identity ''linux:<boot-id>:<start-ticks>'', immune to the ~daily PID reuse on this box. Process boot time needs no column — it is min(invoked_at) GROUP BY this. NULL = unreadable, or row predates migration 1043.';

COMMENT ON COLUMN harness_shared.tool_invocations.serving_build_sha IS
  'WHAT CODE that process had LOADED: short git sha, resolved once at boot. NULL means the row predates migration 1043 OR the process could not PROVE its loaded bytes (bundled artifact with no baked sha) — it is never the current checkout''s HEAD standing in for an unknown. Compare against tree HEAD to compute absolute code age; this is what makes host staleness measurable from the LEDGER, without cooperation from the stale process.';

CREATE INDEX IF NOT EXISTS tool_invocations_serving_host_idx
  ON harness_shared.tool_invocations (serving_host, invoked_at DESC)
  WHERE serving_host IS NOT NULL;
