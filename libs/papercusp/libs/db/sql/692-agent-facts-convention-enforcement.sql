-- 692-agent-facts-convention-enforcement.sql
--
-- unified-agent-state-plane-2026-07-27, P-018 (D-075 R2/R3): `agent_facts` gains
-- the ENFORCEMENT TIER D-016 specifies, so a declared convention carries HOW it
-- is enforced rather than only WHAT it says.
--
--   enforcement jsonb — { tier, floor?, reviewBy? }
--
-- ── WHY A COLUMN ON THIS TABLE AND NOT A CONVENTIONS TABLE ───────────────────
--
-- D-004: collapse the CONTRACT, not the STORAGE — and P-018 states it directly
-- ("do NOT build a third store"). A convention already IS an `agent_facts` row:
-- mig 690 made `kind='convention'` a first-class modality with its own partial
-- index. The tier is one more modality-scoped attribute of that row, exactly
-- like `depends_on`/`claim` are modality-scoped attributes of an assumption.
-- Nullable for the same reason `kind` is: every existing row predates it, and
-- backfilling a tier nobody declared would invent an enforcement story — the
-- manufactured-certainty defect mig 671 (`confidence`) and mig 690 (`kind`) both
-- deliberately avoided.
--
-- ── THE VOCABULARY IS D-016's, AND `prompt` IS NOT IN IT ─────────────────────
--
--   structural — impossible to do wrong; no agent decision is involved.
--   gate       — refused at a chokepoint.
--   detector   — measured and reported, never silently tolerated.
--
-- D-016 is explicit that "the prompt/playbook is NOT a tier. Adding 'agents
-- should declare assumptions' to the su playbook is precisely the 47.1→34.9
-- mechanism." So `prompt` is absent from the CHECK by design: a convention whose
-- only enforcement is documentation must be unable to CLAIM a tier, because
-- claiming one is how prose exhortation passes itself off as structure. Such a
-- convention is still perfectly declarable — it simply leaves `enforcement` NULL
-- and reads as untiered, which is the honest record.
--
-- ── WHY floor/reviewBy ARE NOT SEPARATE COLUMNS ──────────────────────────────
--
-- They are meaningless without the tier and only ever read on the same path that
-- reads it, so they are one value, not three (the same reasoning that made
-- `depends_on` jsonb in mig 690 rather than a side table). The CROSS-FIELD rule
-- — a `gate`/`detector` REQUIRES both, a `structural` refuses both (D-075 R3) —
-- is enforced in `validateConventionEnforcement` rather than here: it depends on
-- `kind` as well as `enforcement`, and a CHECK spanning two nullable columns
-- would still be silent about WHICH clause failed. D-016's whole point is that
-- the floor rule must be a typed refusal an agent can read, not a constraint
-- violation. The CHECK below closes the tier VOCABULARY (the part a future
-- out-of-band write could corrupt); the tool layer owns the cross-field logic.

-- NOTE: no top-level BEGIN/COMMIT here. The migration runner already wraps every
-- file in BEGIN … <ddl> … <schema_migrations INSERT> … COMMIT
-- (embedded-postgres-server/src/migration-runner.js), so an inner COMMIT ends that
-- transaction EARLY and the ledger INSERT then lands outside it — the migration can
-- apply without being recorded and re-runs on every boot. Enforced by
-- `lint:migrations` check 2.

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS enforcement jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_facts_enforcement_tier_check'
       AND conrelid = 'harness_shared.agent_facts'::regclass
  ) THEN
    ALTER TABLE harness_shared.agent_facts
      ADD CONSTRAINT agent_facts_enforcement_tier_check
      CHECK (
        enforcement IS NULL
        OR enforcement->>'tier' IN ('structural', 'gate', 'detector')
      );
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.agent_facts.enforcement IS
  'P-018 / D-016 / D-075 R2 — HOW a convention is enforced: '
  '{tier: structural|gate|detector, floor?: number in (0,1], reviewBy?: ISO date}. '
  'A gate/detector tier REQUIRES both floor and reviewBy (D-016: "a detector without a '
  'floor is prose exhortation in a costume"); structural takes neither, because there is '
  'no behaviour to measure. `prompt` is deliberately NOT a tier — D-016 rules the '
  'playbook out as an enforcement mechanism, so a documentation-only convention leaves '
  'this NULL and reads as untiered. NULL = not declared; never backfilled.';
