-- 629-derived-read-snapshots.sql
--
-- The generic precompute surface for expensive DERIVED sync-resolver reads
-- (WI-5460 / precompute-derived-sync-reads-2026-07-19 P-001, D-002).
--
-- WHY THIS EXISTS
-- An audit timed all 200 registered sync `queryName`s: three exceeded 12s
-- (learning.soakReport 27.3s, storage.usage 20.0s, plans.lint 13.8s) while pure
-- DB reads on the same host were 3-20ms. Every one of them ran expensive derived
-- work -- a `journalctl` subprocess, a recursive du-style disk walk, a
-- full-corpus plan lint -- SYNCHRONOUSLY on a user-facing read, per page load.
--
-- The fix is to move that work OFF the read path: a scheduled routine
-- (`system:precompute-derived-reads`) computes each registered producer and
-- writes its result here; the resolver becomes a plain SELECT against this
-- table. Cost moves to write-time, where nobody is waiting on it.
--
-- Deliberately NOT a cache (D-001, owner-chosen): a cache still pays the full
-- cost on cold load, so the first user of each TTL window eats the 20s. More
-- decisively, the shipped desktop app runs embedded Postgres on hosts where
-- `journalctl`/systemd do not exist at all -- a read path that shells out to a
-- host binary does not degrade there, it fails permanently.
--
-- ONE table serves every consumer rather than three bespoke ones (D-002), so
-- the next slow derived read registers a producer instead of re-solving this.
--
-- Shape follows the house convention for operator snapshot tables
-- (cf. harness_shared.operator_idle_snapshot): workspace-scoped, jsonb payload,
-- bigint epoch-ms timestamps.

CREATE TABLE IF NOT EXISTS harness_shared.derived_read_snapshots (
    -- Scope. harness_slug is '' for workspace-global producers (storage.usage)
    -- rather than NULL, so it participates in the primary key without needing
    -- NULLS NOT DISTINCT (which needs PG15+ and we support older).
    workspace_id      text   NOT NULL,
    harness_slug      text   NOT NULL DEFAULT '',

    -- The producer key, e.g. 'storage.usage' / 'plans.lint' / 'learning.soakReport'.
    key               text   NOT NULL,

    -- The precomputed result the resolver returns verbatim.
    payload           jsonb  NOT NULL,

    -- Epoch ms the payload was computed, and how long the compute took. The
    -- resolver surfaces computed_at as a staleness marker so a panel can say
    -- "as of HH:MM" instead of silently showing stale numbers as live ones.
    computed_at       bigint NOT NULL DEFAULT 0,
    compute_ms        integer,

    -- Bumped by a producer when its payload SHAPE changes, so a resolver can
    -- ignore a snapshot written by an older build instead of feeding a stale
    -- shape to a client that no longer understands it.
    producer_version  integer NOT NULL DEFAULT 1,

    -- Last compute failure, if any. A failed refresh NEVER clears a good
    -- payload -- the last-known-good result keeps serving while the error is
    -- recorded here for the routine's own logging/alerting.
    error             text,
    error_at          bigint,

    updated_at        bigint NOT NULL DEFAULT 0,

    PRIMARY KEY (workspace_id, harness_slug, key)
);

-- Idempotent column adds, matching this repo's migration convention (a table
-- created by an earlier partial run still converges to the full shape).
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS harness_slug text NOT NULL DEFAULT '';
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS computed_at bigint NOT NULL DEFAULT 0;
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS compute_ms integer;
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS producer_version integer NOT NULL DEFAULT 1;
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS error_at bigint;
ALTER TABLE harness_shared.derived_read_snapshots ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT 0;

-- The routine's own sweep: "which producers are due / stalest first".
CREATE INDEX IF NOT EXISTS derived_read_snapshots_staleness_idx
    ON harness_shared.derived_read_snapshots (workspace_id, computed_at);
