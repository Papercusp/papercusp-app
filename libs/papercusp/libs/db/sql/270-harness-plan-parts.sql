-- 270: harness_plan_parts — per-PART federated state for the plan-federation
-- re-grain (plan-federation-regrain-2026-06-13 P-002 / shared-hive-hardening D-009).
--
-- WHY: today a plan federates as the WHOLE harness_plans.content blob (LWW keyed
-- by plan_slug, mig 122/125), so two peers editing DIFFERENT items each produce a
-- divergent whole-document and the substrate LWW silently drops one peer's entire
-- edit — and plans have no git backstop. This table holds the plan decomposed into
-- stably-keyed PARTS (frontmatter / preamble / section:<slug> / item:P-NNN /
-- decision:D-NNN — see libs/generic/plan-parser/parts.ts), so each part federates
-- as its own LWW key and concurrent edits to DIFFERENT parts MERGE.
--
-- DARK: this table is NOT wired into the live plan capture/projection. The live
-- whole-blob path (harness_plans, mig 125) is untouched. The capture trigger +
-- the 'plan-parts' projection + the existing-plan backfill are the FLAG-GATED
-- cutover (papercusp-plan-part-federation; plan P-005/P-006/P-007), so this
-- migration is an additive, unused table until then — safe to land + auto-apply.
--
-- KEYING: (workspace_id, harness_slug, plan_slug, part_key). `fed_ts` is the LWW
-- ordering field (ties broken by `author`); `tombstone` is a SOFT delete so a late
-- op for a removed key is still LWW-ordered (the LWW guard lives in the store's
-- ON CONFLICT … WHERE — plan-parts/store.ts PgPlanPartsStore). Idempotent; RLS
-- workspace isolation mirrors hive_settings (mig 186).
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set — an inner
-- COMMIT would end the runner's wrapper txn early and break apply+ledger atomicity
-- (migration-runner.js contract; lint:migrations).

CREATE TABLE IF NOT EXISTS harness_shared.harness_plan_parts (
    workspace_id  text NOT NULL,
    harness_slug  text NOT NULL,
    plan_slug     text NOT NULL,
    part_key      text NOT NULL,          -- frontmatter | preamble | section:<slug> | item:<P-NNN> | decision:<D-NNN>
    kind          text NOT NULL,          -- PlanPartKind
    body          text NOT NULL DEFAULT '', -- the part's raw markdown (empty for a tombstone)
    ordinal       integer NOT NULL DEFAULT 0, -- document order, for deterministic reassembly
    fed_ts        bigint NOT NULL,        -- LWW ordering field (epoch ms / HLC)
    author        text,                   -- LWW tie-break (author device pubkey)
    tombstone     boolean NOT NULL DEFAULT false,
    -- Echo-loop guard (mirrors hive_settings/harness_plans): the capture trigger
    -- (mig 271) skips a write whose origin <> 'local', so the projection's OWN
    -- writes (applied remote ops, stamped origin='remote') are NOT re-federated.
    -- Local writes (the flag-gated reconcile) default 'local' and DO federate.
    origin        text NOT NULL DEFAULT 'local',
    -- The Hyperbee/peer-log key for a part: plan_slug + part_key. capture_substrate_outbox
    -- keys on a SINGLE column (v_row ->> TG_ARGV[0]), and part_key is unique only WITHIN a
    -- plan, so the federated key must combine both. The projection's composeKey returns the
    -- identical `${plan_slug}/${part_key}` (projections/harness-plan-parts.ts).
    part_fed_key  text GENERATED ALWAYS AS (plan_slug || '/' || part_key) STORED,
    created_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    updated_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'harness_plan_parts_pkey') THEN
    ALTER TABLE ONLY harness_shared.harness_plan_parts
      ADD CONSTRAINT harness_plan_parts_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, part_key);
  END IF;
END
$body$;

-- Read path: all parts for one plan (the store's getParts).
CREATE INDEX IF NOT EXISTS harness_plan_parts_by_plan
  ON harness_shared.harness_plan_parts (workspace_id, harness_slug, plan_slug);

ALTER TABLE harness_shared.harness_plan_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS harness_plan_parts_workspace_isolation ON harness_shared.harness_plan_parts;
CREATE POLICY harness_plan_parts_workspace_isolation ON harness_shared.harness_plan_parts USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- NO capture trigger here (deliberately): federation capture + the 'plan-parts'
-- projection are the flag-gated cutover, so nothing writes/reads this table on the
-- live path until papercusp-plan-part-federation is flipped on.
