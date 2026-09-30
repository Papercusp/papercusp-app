-- 615: extend the 'pot-coordination-health' rubric from 14 → 15 criteria —
--      add the `context-burn` criterion (EI-8769 / EI-13241, cup s-1784255906289).
-- Number reserved via db:next-migration (harness_shared.migration_reservations).
--
-- WHY: the canonical first-party rubric bundle
-- (rubrics/pot-coordination-health/rubric.json) has declared 15 criteria since
-- EI-8769 (2026-07-08) — `context-burn` is the 15th (coord-layer context-injection
-- budget + compaction cadence health). The owner-mandated Kettle/Overwatch every-turn
-- scorecard contract (kettle-scorecard-persona.test.ts) pins 15 keys INCLUDING
-- context-burn, and improvements:capture's rubric-driven completeness gate reads the
-- criterion set from the LIVE rubric plan row. But NO migration ever added context-burn
-- to that DB row: mig 371 added the 14th (`scheduler-usage`); the 15th was only ever
-- added to rubric.json, never to the live plan. So the live row carried 14 criteria and
-- capture REJECTED a valid 15-key scorecard's `context-burn` rating as "unexpected",
-- blocking every Kettle scorecard emit (EI-13241 — flooded the escalation queue). This
-- migration syncs the live plan row to 15, matching rubric.json.
--
-- WHY A NEW MIGRATION (not editing rubric.json / 327 alone): a rubric is a PLAN now
-- (P-007). The v1 rubrics table (mig 326/327) was copied into a `template: rubric` plan
-- by mig 338 and the table dropped by mig 353, so the LIVE source of truth is the plan
-- row's template_data.criteria jsonb. This UPDATEs that directly (mirrors mig 371's
-- scheduler-usage amend + mig 412's tool-utilization amend). The 327 seed is ALSO updated
-- in the same commit so a fresh-DB replay (327 seed → 338 copy → 353 drop → 371/412/531 →
-- THIS) lands the same 15 criteria; this UPDATE is then idempotent on that replay (the
-- criterion is appended only when its key is absent — guarded below). The rubric.json
-- bundle is already correct at 15 (its first-party cold-start seeder lands 15 for a
-- MISSING id) — this migration reconciles an EXISTING drifted row the seeder skips.
--
-- SCOPE: matched by harness_slug='papercusp' + plan_slug='pot-coordination-health'
-- (the POST-mig-531 slug — 531 renamed 'hive-coordination-health' → 'pot-coordination-
-- health'; 615 > 531 so the row is already renamed here) + template='rubric', across ANY
-- workspace_id. NOTE: mig 371 filtered workspace_id='default' (the seed's documented
-- scope), but the LIVE plan is keyed 'papercusp-workspace' (rubricsScopeWorkspace()
-- resolves per-deployment), so that filter was inert here — mig 412 already dropped it for
-- exactly this reason. Verified against the live DB (dev:pg_query): the readable row
-- rubrics:get{rubricRef:'pot-coordination-health'} = workspace_id='papercusp-workspace',
-- 14 criteria, desc opens "The 14-criteria scorecard", overwatch method "all 14 criteria
-- rated". Dropping the workspace_id filter makes THIS amend hit that row regardless of
-- deployment scope (and any peer-workspace copies). The already-15 zz-* copy is skipped by
-- the idempotence guard.
--
-- LOCKSTEP CONTRACT: the criterion KEY set is a shared interface across the seeded rubric,
-- the capture completeness gate (rubric-driven — now requires 15 ratings), the Kettle
-- persona (blueprints/coding/prompts/kettle.md — already lists context-burn), and the
-- pinning tests (rubrics-seed.integration — moved 14→15 in this commit;
-- kettle-scorecard-persona — already pins 15). All read 15 after this.
--
-- The runner wraps each file in its own transaction + strips psql metacommands, so NO
-- top-level BEGIN;/COMMIT;. ADDITIVE + idempotent (appends only if the key is absent).

-- (1) Append the `context-burn` criterion (15th) — key/title/model/method/driftMarkers
-- copied VERBATIM from rubrics/pot-coordination-health/rubric.json. Dollar-quoted JSON
-- (double-quoted strings) so the apostrophe in "a session's context" needs no escaping.
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
   -- idempotent: append only when the key is not already present (re-run / fresh replay safe).
   AND NOT (template_data->'criteria') @> '[{"key":"context-burn"}]'::jsonb;

-- (2) The `overwatch-observation-quality` criterion's method text hard-codes
-- "all 14 criteria rated" — now stale (15). Patch it in the live plan's criteria jsonb
-- (a string replace inside the array, idempotent — no-op once it reads 15). The 327 seed
-- is updated to match for a clean fresh-DB replay.
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

-- (3) The plan's template_data.description opens "The 14-criteria scorecard …". Bump the
-- leading count so the prose metadata matches the 15 live criteria. Idempotent.
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
