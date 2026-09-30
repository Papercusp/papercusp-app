-- 181-hyperbee-projection-fed-ts-guard.sql
--
-- EI-79 residual, step 2 (the correctness partner of the incremental merge
-- cursor shipped in p2p-performance-suite-2026-06-07 P-013).
--
-- The incremental merge cursor (read-merge.ts `mergeAdmittedLogsIncremental`)
-- decodes only [cursor,length) of each grown peer log per pass instead of the
-- whole history. That is only correct if applying an OLD op to a row that
-- already holds a NEWER value is a no-op at the PG layer — otherwise a late /
-- out-of-order op (a backfilling new peer, an op replicated out of order, a
-- fold rebuilt from a fresh cursor) can clobber a newer projected row. The
-- in-process `cursor.winners` fold guards this within one process lifetime, but
-- the design (EI-79 scoping: "do BOTH or neither") requires the guard to live
-- at the PG layer so each writer is last-write-wins INDEPENDENT of fold state.
--
-- The guard field is the op's WIRE ts (epoch ms) — the same field the read-merge
-- LWW (`lwwPick`) orders on (HLC-or-ts; the ts is the dominant term and the only
-- one that can produce a STRICT older/newer clobber). Every federated op carries
-- it (`PeerLogOp.ts`). We persist it as a dedicated `fed_ts` column on every
-- federated table whose projection does a mutating `ON CONFLICT ... DO UPDATE`,
-- then guard the upsert with `WHERE EXCLUDED.fed_ts >= <table>.fed_ts` (the `>=`
-- mirrors lwwPick: a strictly-older op is dropped; an equal-or-newer op applies,
-- and on an exact ts tie lwwPick's del>put / source-key tiebreak is a valid LWW
-- outcome that loses no data whichever way it lands).
--
-- `fed_ts` is nullable + defaults NULL so the column add is instant and existing
-- rows backfill lazily: a NULL stored fed_ts is treated as "older than anything"
-- by the writers' `IS NULL OR ... ` guard, so the first federated write after
-- this migration always lands and stamps fed_ts. Append-only / DO NOTHING
-- projections (contributor_usage_events, feature_claims) need no guard and are
-- intentionally omitted.

ALTER TABLE harness_shared.harness_features_consolidated ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.harness_issues_consolidated   ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.harness_feature_prs           ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.shared_presence               ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.contributors                  ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.feature_queue                 ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.feature_working_set           ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.harness_plans                 ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_conversations           ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_event_log               ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_threads                 ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_thread_posts            ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.plan_item_assignments         ADD COLUMN IF NOT EXISTS fed_ts BIGINT;

-- ── fed_ts must NOT re-trigger CDC capture ─────────────────────────────────────
-- The substrate-outbox UPDATE triggers (mig 102/108/114) on the two consolidated
-- tables fire `WHEN (OLD.* IS DISTINCT FROM NEW.*)`. `fed_ts` is now part of the
-- row AND is stamped from each op's WIRE ts (a capture-time wall clock), so it
-- changes on every re-application of an own-log op — which would make a row
-- "distinct" on every merge-back pass and re-enqueue it forever (unbounded
-- intra-peer self-amplification, the exact failure feature-content-federation
-- guards against). Bookkeeping columns must not drive CDC, just as `origin` /
-- `author_pubkey` don't (the coord/plan triggers already use explicit federated
-- column lists; only these two consolidated tables use the broad row compare).
-- Recreate their UPDATE triggers to compare rows with `fed_ts` MASKED OUT.
-- (contributor_usage_events rows are immutable/append-only — its broad trigger
-- never fires on a real update, so it needs no change.)
CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_features_consolidated
  FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');

CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_issues_consolidated
  FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
