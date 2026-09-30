-- 327: seed the founding 'hive-coordination-health' rubric
--      (rubric-driven-observations-2026-06-20 P-003 / brief B6, su-5695e).
-- Number reserved via db:next-migration (harness_shared.migration_reservations).
--
-- WHY: 326-rubrics-store created harness_shared.rubrics (pure DDL, no content) and
-- explicitly deferred the seed to this follow-up migration (P-003's job). This file
-- seeds the FIRST live rubric: the 'hive-coordination-health' scorecard the
-- Overwatch must emit every turn (D-002, OWNER REQUIREMENT #1). It crystallizes the
-- owner's 13-question hive-coordination scorecard (hive-coordination-test-loop-2026-06-20
-- D-001, Q1-Q13) into a named, ratified rubric. (A 14th criterion, `scheduler-usage`,
-- was added by mig 371 — hybrid-bee-scheduler-work-stealing-2026-06-22 P-004 — and a
-- 15th, `context-burn`, by mig 615 — EI-8769/EI-13241, context-injection budget +
-- compaction cadence health — so the current rubric carries 15 criteria; this seed
-- includes both for a clean fresh-DB replay.)
--
-- SEEDED status='active' (not 'proposed'): the Queen-ratify gate (D-001) governs FUTURE
-- agent-proposed rubrics; THIS is the owner-authored founding rubric the owner required
-- Overwatch to grade against, so it is seeded ratified-active (ratified_by = the owner).
-- Mirrors proposeRubric({status:'active'}) — the documented programmatic-seed path.
--
-- SCOPE: workspace_id='default' (DEFAULT_COORD_WORKSPACE) — the single coordination
-- workspace the store reads/writes, so the rubric is visible to Overwatch/Scout wherever
-- they run. The criterion `key`s are the locked interface: a structured observation's
-- ratings are KEYED by criterion key (ratings[criteria[].key] = {rating, evidence} — the
-- Record shape per the reconciled D-003); they map 1:1 to the owner's Q1-Q13 and
-- match the Overwatch scorecard (P-004) + Scout grouping (P-006). The per-criterion
-- model/method/driftMarkers here are the TIGHT structured form; the long-form METHOD
-- lives in the method_ref runbook (agent-insights/hive-coordination-health).
--
-- The migration runner wraps each file in its own transaction and strips psql
-- metacommands, so this file carries NO top-level BEGIN;/COMMIT;/\set. ADDITIVE +
-- idempotent (ON CONFLICT re-seeds the founding rubric's content + active status).

-- NOTE: created_at/updated_at are omitted from this column list — both carry
-- `DEFAULT now()` (326-rubrics-store.sql), so the 12 VALUES below match the 12
-- columns. (Listing them without supplying values is the malformed-INSERT bug that
-- broke every testcontainer migrate + the live apply; ON CONFLICT below still bumps
-- updated_at = now() on a re-seed.)
INSERT INTO harness_shared.rubrics
  (workspace_id, rubric_id, characteristic, title, description, criteria, rating_scale,
   method_ref, status, created_by, proposed_by, ratified_by)
VALUES (
  'default',
  'hive-coordination-health',
  'hive-coordination',
  'Pot coordination health',
  $desc$The 15-criteria scorecard for whether the papercusp queen/bee/overwatch/scout self-improving loop is healthy — the WHOLE loop turning, not any one stage merely busy. Crystallized from the owner's 13-question hive-coordination scorecard (hive-coordination-test-loop-2026-06-20 D-001, Q1-Q13). Grade a STRUCTURED OBSERVATION against it: rate each criterion (healthy/degraded/broken/unknown) with MANDATORY evidence. Overwatch emits this scorecard every turn (OWNER REQUIREMENT #1). Source of truth is code + the live DB, never docs/tool-summaries. Three pitfalls that invalidate a naive read: (1) enumerate started hives across ALL workspace_ids first (multi-workspace); (2) idle is not dead and activity is not health — check WHY via the carryNote, not wake-count/spend; (3) silence is not health (the cursed-latch + stale alarms). Long-form per-criterion method: the agent-insights runbook named by method_ref.$desc$,
  $criteria$[
    {
      "key": "end-to-end-flow",
      "title": "End-to-end loop closure",
      "model": "The self-improving loop is a closed cycle (observe -> scout-ideate -> grade -> plan-start/promote -> queen-place -> bee-complete -> commit/git-sync -> observe). Health = the whole loop turning; each stage hands off to the next with no structural dead-end.",
      "method": "Enumerate started hives across ALL workspace_ids first, then walk every stage in the live DB: observations flowing (engineer_issues payload.lane=observation), scout_ticks with ideas>0, plans started+promoted to work_items, hive_placements with a completion in the last hour, recent git-sync commits. Broken vs merely-quiet: input present at stage N, output absent at N+1.",
      "driftMarkers": "A stage emits zero output for more than one cycle while upstream produces input: Scout 0 ideas/24h on a non-empty corpus; Queen 0 placements with a ready actionable frontier and idle bees; a bee claims an item but makes 0 tool calls (zombie)."
    },
    {
      "key": "ideation-quality",
      "title": "Scout ideation quality and diversity",
      "model": "Scout generates grounded, systemic, evidence-backed ideas spanning diverse themes — low duplication, broad coverage of the friction surface — not converging on one theme.",
      "method": "Read recent scout_ticks/routed_ideas; judge grounding (cites real evidence), systemic value (root-cause not symptom), and novelty. Cluster the batch by theme. 0 ideas with a non-empty corpus and zero budget spent is transport-death (a transport failure), distinct from low quality — check per-ideator ok/error.",
      "driftMarkers": "Thematic convergence (a majority of a batch on one theme; near-duplicate ideas); shallow symptom-only ideas; or a hard 0-ideas transport-death."
    },
    {
      "key": "queen-workitem-selection",
      "title": "Queen work-item selection",
      "model": "From the ready frontier the Queen places the most valuable ACTIONABLE items, HOLDS undecided/needs-design items, leaves cursed items alone, and refuses to place a vacuous/unpromoted frontier. Reasoned idleness is correct, not a failure.",
      "method": "Compare placements against the ready frontier (work_items todo/ready) — would you pick these? Read the carryNote (hive_wake.payload) for WHY she held or placed. Idle is not dead: holding undecided items, leaving cursed alone, and a long cadence on a vacuous frontier is GOOD. Distinguish by carryNote + actual completions, not wake-count/spend.",
      "driftMarkers": "Places low-value/cursed/needs-design items; or leaves clearly-actionable high-value items unplaced while idle with capacity; places into a vacuous frontier and manufactures zombies."
    },
    {
      "key": "queen-plan-selection",
      "title": "Queen plan selection",
      "model": "The Queen starts/pursues the right plans in priority order and does NOT auto-materialize plans that are not ready (does not force-start a draft).",
      "method": "Look at started plans across member harnesses and the Queen's plan-selection reasoning; she should respect plan readiness (draft vs ready) and not auto-start. Signal is limited when Scout is not routing plans.",
      "driftMarkers": "Starts unready/draft plans; ignores a high-priority ready plan; or churns on a dying system's plans. Low evidence is unknown, not broken."
    },
    {
      "key": "parallel-distribution",
      "title": "Parallel placement and distribution",
      "model": "When multiple independent items are ready, the Queen places a parallel BATCH (fleet:place_batch), distributes across bees by affinity (disjoint files/topics), and scopes each bee's topic-subscriptions tightly (its own item + plan topics).",
      "method": "Observe a parallel seed: did she batch-place concurrent bees on disjoint work? Is file/topic affinity overlap minimized? Are per-bee topic subscriptions narrow? Only observable when a parallel-ready frontier exists.",
      "driftMarkers": "Serializes genuinely-parallel work; places overlapping bees that collide on locks; over-broad topic subscriptions causing chatter. Idle is unknown, not broken."
    },
    {
      "key": "bee-execution",
      "title": "Bee execution quality",
      "model": "A bee boots with full MCP tools, claims its item, makes real tool calls, and completes a well-scoped, correct, VERIFIED change in one turn (tests run, not diagnosis-only), then commits.",
      "method": "For observable bees: did it boot clean (WaitForMcpServers; tools present, no zombie)? Did it make tool calls (a claim with 0 tool calls is the EI-1758 zombie)? Was the completion well-scoped + verified (tests run) vs diagnosis-only when a fix was scoped? Watch token-budget exhaustion truncating non-trivial fixes.",
      "driftMarkers": "Zombie bees (claim, 0 tool calls, no MCP tools at bootstrap); diagnosis-only completions where a fix was scoped; uncommitted/undeployed fixes (self-referential infra deadlock); token-budget truncation."
    },
    {
      "key": "bee-observation-quality",
      "title": "Bee observation quality",
      "model": "Bees emit specific, root-cause-oriented, quantified, actionable turn-end observations (payload.lane=observation) reliably — the raw material Scout ideates on.",
      "method": "Read recent payload.lane=observation entries by bee authors; judge specificity/root-cause/quantification and emission COVERAGE (every turn vs uneven). Emission is prompt-driven, not enforced, so under-emission is a known risk.",
      "driftMarkers": "Sparse/absent observations from active bees; vague symptom-only observations; no quantification or evidence."
    },
    {
      "key": "overwatch-observation-quality",
      "title": "Overwatch observations and the mandatory scorecard",
      "model": "Overwatch is the system's self-monitor: specific, self-aware observations AND (OWNER REQUIREMENT #1) ALWAYS a STRUCTURED scorecard against this rubric every turn (rate each criterion + cite evidence), in addition to free-form.",
      "method": "Read recent overwatch observations/escalations for specificity + self-awareness (catching stale panels, conflations, over-fires). Verify the structured scorecard is emitted EVERY turn against hive-coordination-health: rubricRef set, all 15 criteria rated, evidence non-empty on each.",
      "driftMarkers": "Free-form only, no structured scorecard (an owner #1 violation); a scorecard with missing criteria or empty evidence; stale/echoed observations that contradict live state."
    },
    {
      "key": "watchdog-determinism",
      "title": "Watchdog determinism and self-clearing",
      "model": "The watchdog fires deterministically and correctly on real conditions, and its alarms self-clear against live state rather than continuing to fire on a stale premise.",
      "method": "Check fires (watchdog_ticks) for determinism + correctness. Are they noisy (hundreds of 'no wake armed' fires in a reboot window)? Critically, do alarms self-clear when the premise is contradicted by live state (e.g. an 'EI-1758 fire-path down' echo contradicted by live completions)?",
      "driftMarkers": "Fires on stale premises that live state contradicts (alarms do not self-clear); excessive noise drowning real signal; or non-deterministic/missed fires."
    },
    {
      "key": "coordination-comms",
      "title": "Constructive communication",
      "model": "Agents communicate constructively — clean handoffs, evidence-citing messages, mutual correction — without re-litigation waste (many agents re-verifying the same thing).",
      "method": "Read the coord stream — handoffs accepted, evidence cited, peers correcting each other constructively? Look for re-litigation (N agents re-verifying the same reds; a stale echo re-broadcast as live).",
      "driftMarkers": "Re-litigation (duplicate verification of the same fact by many agents); stale claims re-broadcast as live; dropped handoffs; non-evidence-based assertions."
    },
    {
      "key": "chatter-economy",
      "title": "Chatter economy",
      "model": "Coordination volume is economical — structural mechanisms (a verify-already-done auto-resolver, self-clearing alarms, less watchdog spam) remove duplicate/ceremonial chatter rather than relying on agent discipline.",
      "method": "Measure coord volume and the duplicate fraction (e.g. 1650 messages, much dup verification). Identify chatter removable BY DESIGN (self-clearing alarms, auto-resolvers) vs irreducible. The trend should fall as structural fixes land.",
      "driftMarkers": "High dup-verification volume; ceremonial messages a structural fix could eliminate; watchdog-fire spam."
    },
    {
      "key": "coordination-utilization",
      "title": "Coordination-surface utilization",
      "model": "Coordination surfaces that exist are USED: turn-end observation emission (enforced, not merely prompt-driven), Scout reading coord at cycle-start, the grade-to-lens-weight learning loop actually moving weights.",
      "method": "For each built mechanism, check live USAGE: is turn-end observation emission actually happening (or unenforced and under-used)? Does Scout use coord at all? Is grade-to-lens-weight learning live (scout_lens_weights off uniform 0.25, decided>0) or dead?",
      "driftMarkers": "A built mechanism with near-zero usage (Scout uses no coord; grade-to-lens-weight dead with decided=0 and uniform weights; unenforced emission under-used)."
    },
    {
      "key": "tool-utilization",
      "title": "Tool utilization",
      "model": "Tools that exist are reached for when apt: scout:grade-idea used regularly, the queen-scout coord+wake channel used, the mcp-call.mjs fallback wired into the bee path.",
      "method": "Check usage counts + recency for key tools (scout:grade-idea grade count + last use; the queen-scout channel; the bee curl-fallback). A tool with near-zero lifetime use that should be hot is a gap. ALSO grade code:run ADOPTION: call dev:code_run_adoption (of the spawns that COULD batch — a same-tool burst or a fan-out — what percent folded into one code:run; returns the fleet adoptionRate + a graded rating). A persistent low rate (the baseline sits near 2 percent) is a tool-utilization gap, not healthy.",
      "driftMarkers": "A capability built but barely invoked (8 grades ever, none recent; an unused coord+wake channel); a fallback not wired into the path that needs it. code:run UNDER-ADOPTED: agents hand-loop the same tool or fan out one-at-a-time instead of folding into one code:run (the dev:code_run_adoption rate stuck low)."
    },
    {
      "key": "scheduler-usage",
      "title": "Within-hive scheduler usage",
      "model": "The within-hive deterministic scheduler is USED as designed: the Queen authors + VERSIONS a per-bee claim SPEC (a scoped view.filter + rank over the live work-item DAG, composed from the primitive vocabulary) and re-steers a running bee by bumping the spec revision — she does NOT micro-dispatch each item. Bees PULL their next item through the get_next claim path (global hard floors AND the spec filter, ORDER BY the spec rank, FOR UPDATE SKIP LOCKED) rather than self-scanning the raw frontier or hand-claiming. Resolution is deterministic, the plan-item dedup floor holds (ZERO duplicate-plan-item claims), and completions flow from pulled work. Model-routing (model_fit / per-model capability) is DESCOPED behind its own flag (plan D-010): its absence is NOT a drift.",
      "method": "Walk the live claim path: are bee claims stamped with a spec specId@revision (get_next records provenance), and do revisions bump when the Queen re-steers? Are there claims that did NOT go through get_next (a self-scanned/hand-claimed item, the bypass)? Query for duplicate-plan-item claims (two non-terminal claims sharing a source_plan_item_id — the dedup floor failing). Check that pulled items reach completion (claim -> working -> done) rather than zombie-holding. Signal is limited when no spec-driven hive is running (rate unknown). model_fit is neutral until its lane ships — do NOT flag its absence.",
      "driftMarkers": "Queen micro-dispatching item-by-item instead of issuing/versioning specs; bees bypassing the scheduler (self-prioritizing the raw frontier, hand-claiming) instead of pulling via get_next; non-deterministic or floor-violating resolution; duplicate-plan-item claims (dedup floor breached); pulled claims that never make progress (zombie holds). NOT a drift: model_fit being neutral (descoped). Low evidence (no spec-driven hive running) is unknown, not broken."
    },
    {
      "key": "context-burn",
      "title": "Context burn and compaction cadence",
      "model": "The coordination layer's own context injections stay on the post-diet budget: mean coord:inbox-wake delivery <= ~3000 chars, compaction cadence sane, and compactions never degrade work — ZERO post-compaction error markers (hallucinated-schema errors right after a session's context was rebuilt).",
      "method": "ACTIVITY GATE first (EI-7624): loop:soak-report contextBurn.loopWakes == 0 in the window -> rate unknown with `idle:` evidence (no loops ran). Then read contextBurn: meanWakeChars / estMeanWakeTokens against the WAKE_MEAN_CHAR_BUDGET (3000); requestedCompactions + compactionsPerSession for cadence; postCompactionErrorMarkers MUST be 0. The wake-template scaffold itself is unit-ratcheted (loop-fire.test.ts P-008 byte budgets) — this criterion watches the LIVE deliveries, catching content-side bloat the unit ratchet cannot see.",
      "driftMarkers": "Mean wake size drifting back toward full-boilerplate (>= 3000 chars — the pre-diet behavior burned ~200k tokens/session); postCompactionErrorMarkers > 0 (a compacted session immediately erring on hallucinated schema); compactionsPerSession spiking above its baseline."
    }
  ]$criteria$::jsonb,
  '["healthy","degraded","broken","unknown"]'::jsonb,
  'hive-coordination-health',
  'active',
  'su-5695e3da-622d-4cd2-ae65-75c70a2e71c1',
  'su-5695e3da-622d-4cd2-ae65-75c70a2e71c1',
  'ownerhandle@gmail.com'
)
ON CONFLICT (workspace_id, rubric_id) DO UPDATE SET
  characteristic = EXCLUDED.characteristic,
  title          = EXCLUDED.title,
  description    = EXCLUDED.description,
  criteria       = EXCLUDED.criteria,
  rating_scale   = EXCLUDED.rating_scale,
  method_ref     = EXCLUDED.method_ref,
  status         = EXCLUDED.status,
  proposed_by    = EXCLUDED.proposed_by,
  ratified_by    = EXCLUDED.ratified_by,
  updated_at     = now();
