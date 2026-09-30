-- 621-repair-pot-coordination-health-rubric-row.sql
--
-- DML repair for the live 'pot-coordination-health' first-party rubric row (WI-3617
-- follow-through; the store-side residue of the hive→pot rename, WI-3618 / mig 531).
--
-- WHAT WENT WRONG (forensics from the live DB, 2026-07-17):
--   * mig 531 (07-09 21:19) renamed the real historical row hive→pot correctly.
--   * 20 min later (07-09 21:39) a process still running pre-rename constants
--     re-created a stray 'hive-coordination-health' row (14 criteria, no revision row).
--   * During the 2026-07-17 WI-5244 PG-discovery hijack + recovery window
--     (10:02–14:35Z, "3 re-baselines"), the real pot row was deleted TWICE: the
--     first-party seeder legitimately re-seeded it in full at 09:49Z (plan_revisions
--     seq-1 'rubrics:propose (active)' by 'first-party-bundle' survives), then the row
--     was deleted again and re-created at 14:51Z with template_data NULL and NO
--     plan_revisions audit row — i.e. NOT via proposeRubric (whose body+template_data
--     write is atomic). Net live state: the readable pot row is INVALID (no criteria —
--     planRowToRubric nulls it, so rubrics:get returns nothing) yet its raw slug BLOCKS
--     the no-clobber seeder from ever repairing it. The EI-13241 scorecard-blocking
--     class, wedged permanently.
--
-- WHAT THIS DOES (idempotent, tenant-scoped; a healthy fresh-DB replay no-ops):
--   (1) delete WEDGED seeder-owned pot placeholders (owner='first-party-bundle' with
--       missing/invalid criteria). A valid seeded row is untouched.
--   (2) rename a leftover 'hive-coordination-health' rubric row into place where its
--       tenant has no pot row (531's rename, re-run with per-tenant scoping — 531's
--       NOT EXISTS was workspace-blind), fixing methodRef + the stale title.
--   (3) delete a stray hive duplicate where its tenant already holds a VALID pot row.
--   (4) re-apply mig 615's content amendments to the (possibly just-renamed, pre-615)
--       row: append the 'context-burn' 15th criterion, and bump the two "14 criteria"
--       prose references — all copied verbatim from 615, all guarded/idempotent.
--
-- The companion CODE fix (same change): ensureFirstPartyRubricsSeeded now treats an
-- INVALID row owned by 'first-party-bundle' as needing seed, so this wedge class
-- self-heals in every install instead of requiring a repair migration next time.
-- Runbook: agent-insights/renaming-a-first-party-rubric-races-the-cold-start-seeder.
--
-- The runner wraps each file in its own transaction and strips psql metacommands, so
-- NO top-level BEGIN;/COMMIT;.

-- (1) Clear wedged seeder-owned placeholders: seeder-owned + no valid criteria array.
-- (template_data NULL ⇒ template_data->'criteria' NULL ⇒ jsonb_typeof NULL ⇒ deleted.)
DELETE FROM harness_shared.harness_plans
 WHERE plan_slug = 'pot-coordination-health'
   AND template  = 'rubric'
   AND owner     = 'first-party-bundle'
   AND jsonb_typeof(template_data->'criteria') IS DISTINCT FROM 'array';

-- (2) Rename a leftover hive row into place where its tenant has no pot row.
UPDATE harness_shared.harness_plans p
   SET plan_slug = 'pot-coordination-health',
       template_data = jsonb_set(
         COALESCE(p.template_data, '{}'::jsonb),
         '{methodRef}', '"pot-coordination-health"', true
       ),
       updated_at = now()
 WHERE p.plan_slug = 'hive-coordination-health'
   AND p.template  = 'rubric'
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.harness_plans q
      WHERE q.workspace_id = p.workspace_id
        AND q.harness_slug = p.harness_slug
        AND q.plan_slug    = 'pot-coordination-health');

-- (3) Delete a stray hive duplicate where its tenant already holds a VALID pot row
-- (the stray was re-created by pre-rename code; the pot row is the live identity).
-- Historical scorecards / plan_events reference the old slug as a loose string and
-- stay put — they are the immutable log of what happened under that id (per 531).
DELETE FROM harness_shared.harness_plans p
 WHERE p.plan_slug = 'hive-coordination-health'
   AND p.template  = 'rubric'
   AND EXISTS (
     SELECT 1 FROM harness_shared.harness_plans q
      WHERE q.workspace_id = p.workspace_id
        AND q.harness_slug = p.harness_slug
        AND q.plan_slug    = 'pot-coordination-health'
        AND jsonb_typeof(q.template_data->'criteria') = 'array');

-- (4a) Append the `context-burn` criterion (15th) — copied VERBATIM from mig 615,
-- which itself copied it from rubrics/pot-coordination-health/rubric.json. Idempotent.
UPDATE harness_shared.harness_plans
   SET template_data = jsonb_set(
         template_data,
         '{criteria}',
         (template_data->'criteria') || $cb$[
           {
             "key": "context-burn",
             "title": "Context burn and compaction cadence",
             "model": "The coordination layer's own context injections stay on the post-diet budget: mean coord:inbox-wake delivery <= ~3000 chars, compaction cadence sane, and compactions never degrade work — ZERO post-compaction error markers (hallucinated-schema errors right after a session's context was rebuilt).",
             "method": "ACTIVITY GATE first (EI-7624): loop:soak-report contextBurn.loopWakes == 0 in the window -> rate unknown with `idle:` evidence (no loops ran). Then read contextBurn: meanWakeChars / estMeanWakeTokens against the WAKE_MEAN_CHAR_BUDGET (3000); requestedCompactions + compactionsPerSession for cadence; postCompactionErrorMarkers MUST be 0. The wake-template scaffold itself is unit-ratcheted (loop-fire.test.ts P-008 byte budgets) — this criterion watches the LIVE deliveries, catching content-side bloat the unit ratchet cannot see.",
             "driftMarkers": "Mean wake size drifting back toward full-boilerplate (>= 3000 chars — the pre-diet behavior burned ~200k tokens/session); postCompactionErrorMarkers > 0 (a compacted session immediately erring on hallucinated schema); compactionsPerSession spiking above its baseline."
           }
         ]$cb$::jsonb
       ),
       updated_at = now()
 WHERE harness_slug = 'papercusp'
   AND plan_slug    = 'pot-coordination-health'
   AND template     = 'rubric'
   AND jsonb_typeof(template_data->'criteria') = 'array'
   -- idempotent: append only when the key is not already present (re-run / fresh replay safe).
   AND NOT (template_data->'criteria') @> '[{"key":"context-burn"}]'::jsonb;

-- (4b) "all 14 criteria rated" → 15 in the overwatch-observation-quality method (615 §2).
UPDATE harness_shared.harness_plans
   SET template_data = jsonb_set(
         template_data,
         '{criteria}',
         replace(
           (template_data->'criteria')::text,
           'all 14 criteria rated',
           'all 15 criteria rated'
         )::jsonb
       ),
       updated_at = now()
 WHERE harness_slug = 'papercusp'
   AND plan_slug    = 'pot-coordination-health'
   AND template     = 'rubric'
   AND (template_data->'criteria')::text LIKE '%all 14 criteria rated%';

-- (4c) description "The 14-criteria scorecard …" → 15 (615 §3).
UPDATE harness_shared.harness_plans
   SET template_data = jsonb_set(
         template_data,
         '{description}',
         to_jsonb(replace(
           (template_data->>'description'),
           'The 14-criteria scorecard',
           'The 15-criteria scorecard'
         ))
       ),
       updated_at = now()
 WHERE harness_slug = 'papercusp'
   AND plan_slug    = 'pot-coordination-health'
   AND template     = 'rubric'
   AND (template_data->>'description') LIKE 'The 14-criteria scorecard%';

-- (4d) Stale display title from the pre-rename lexicon (the bundle's rubric.json /
-- listing.json + the 327 seed are fixed in this same change for fresh replays).
UPDATE harness_shared.harness_plans
   SET title = 'Pot coordination health',
       updated_at = now()
 WHERE plan_slug = 'pot-coordination-health'
   AND template  = 'rubric'
   AND title     = 'Hive coordination health';
