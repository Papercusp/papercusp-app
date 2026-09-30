-- 642-unify-claim-spec-states-todo-to-open
--
-- work-item-status-full-unify (2026-07-19) P-004/P-005: `todo` is retired as a claimable
-- status token — `open` is the SINGLE unified claimable token for BOTH work-item families
-- (the feature `todo`→`open` mapping D-001). Migration 638 backfilled the bulk, but feature
-- rows kept accruing at `todo` because the create-path was not flipped until THIS pass — so
-- this migration ALSO sweeps the residual `todo` work-item rows to `open` (idempotent) BEFORE
-- the narrowed claim floor (['open']) goes live, or those rows would be stranded un-claimable.
--
-- Two coordinated backfills, both idempotent, both run at deploy BEFORE the new floor-narrow
-- code serves:
--   (1) work_items rows: status 'todo' → 'open' (the residual features).
--   (2) cup_claim_specs.spec.states: 'todo' → 'open' (dedup) — see below.
--
-- This pass narrows CLAIM_STATES_ALLOWLIST from ['todo','open','failing'] to ['open','failing'].
-- A stored claim spec is RE-VALIDATED against that allowlist on the READ path
-- (claim-spec-store.getClaimSpec → validateClaimSpec): a spec whose `states` array still
-- lists 'todo' would now fail validation and SILENTLY degrade that bee to DEFAULT_CLAIM_SPEC,
-- dropping its leader-configured lane (view.filter / rank / limits) mid-drain. Rewrite every
-- stored spec's `states` array todo→open (de-duplicating, preserving 'open'/'failing') so it
-- validates unchanged. This ALSO revives the specs currently pinned to states:['todo'] alone,
-- which match zero rows now that the backfill left no 'todo' rows (a latent starvation).
--
-- `cup_claim_specs` is the base table (relkind 'r'); `bee_claim_specs` is a view over it —
-- rewriting the base is sufficient. Multi-tenant: every workspace's specs share this one
-- vocabulary, so the rewrite is intentionally global (no workspace_id predicate).
--
-- Idempotent: the WHERE clause matches only rows whose `states` array still contains 'todo';
-- after the rewrite none do, so a re-run (every deploy) is a no-op.

-- (1) Residual work-item rows: the unified mapping todo→open (D-001). 'todo' only ever
-- occurs in the feature family (issues use open|resolved|closed|unified); mapping it to the
-- single claimable token keeps every such row claimable under the narrowed ['open'] floor.
-- Idempotent: no 'todo' rows remain after this runs.
UPDATE harness_shared.work_items
   SET status = 'open', updated_ts = (extract(epoch from now()) * 1000)::bigint
 WHERE status = 'todo';

UPDATE harness_shared.cup_claim_specs
   SET spec = jsonb_set(
         spec,
         '{states}',
         (SELECT jsonb_agg(DISTINCT CASE WHEN e = 'todo' THEN 'open' ELSE e END)
            FROM jsonb_array_elements_text(spec -> 'states') AS e)
       )
 WHERE jsonb_typeof(spec -> 'states') = 'array'
   AND spec -> 'states' @> '["todo"]'::jsonb;
