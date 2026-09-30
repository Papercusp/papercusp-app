-- 682-shared-presence-runs-routines.sql
--
-- EI-18761517980514694: the per-Hive SINGLE-RUNNER election (lockAuthorityForHive,
-- D-005 argmin over live `shared_presence`) had no notion of whether the elected
-- node can actually RUN the cadence loop it is being elected for. On the papercusp
-- pot that meant a peer whose routine host never fires `gym-cycle` won the argmin on
-- every tick (its device_pubkey sorts lowest and it heartbeats every ~10s), so the
-- ONE node with the gym stack, the enabled autoloop and the budget stood down as
-- `remote-runner` ~89% of the time and the gym went dark for hours at a stretch.
--
-- `runs_routines` is the capability bit that makes the election mean what its
-- callers already assume it means. It is stamped by the presence PUBLISHER at
-- announce time (sync/hyperbee/presence-announce.ts) and consumed by the runner
-- election via LockAuthorityDeps.routineHostsOnly, which excludes non-capable
-- PEERS from candidacy. Semantics: "this node's routine host is live AND it has at
-- least one ACTIVE cadence-runner routine (gym-cycle / scout-cycle) for this
-- harness" — see packages/operator-core/lib/cadence-runner-capability.ts.
--
-- NULLABLE with no default, exactly like `pot_slug` (mig 187): a pre-upgrade peer's
-- federated presence record simply lacks the field, and the projection decodes it as
-- absent. Absent ⇒ that PEER is not a candidate for the runner election — which is
-- safe because selectAuthorityFromRows adds SELF unconditionally, so the worst case
-- is every peer excluded, self wins, and this node runs its own loop (the pre-P-020
-- behaviour). The gate can never go dark; during an upgrade window it can at worst
-- produce a duplicate cycle, which is precisely the trade D-004 already names ("a
-- rare duplicate cycle is the tolerated price; a permanently-dark learning loop is
-- not"), and it self-heals as peers publish the bit.
--
-- No new index: the runner election filters `runs_routines` in TS over rows already
-- fetched by the existing (workspace_id, pot_slug, last_seen_at DESC) /
-- (workspace_id, harness_slug, last_seen_at DESC) index paths, so this column is
-- never a query predicate.

ALTER TABLE harness_shared.shared_presence
  ADD COLUMN IF NOT EXISTS runs_routines boolean;

COMMENT ON COLUMN harness_shared.shared_presence.runs_routines IS
  'EI-18761517980514694 capability bit for the per-Hive runner election: TRUE when this node''s routine host is live AND it has an ACTIVE cadence-runner routine (gym-cycle / scout-cycle) for this harness. NULL = unknown/pre-upgrade peer, which is treated as NOT a runner candidate (self is always a candidate, so the election can never go dark).';
