/**
 * capability-category-map.ts — resolve a Queen action (the tool/verb it uses) to
 * its autonomy CATEGORY (queen-autonomy-policy-2026-06-13 B-04 / P-020, map half;
 * D-003 "category is derived from the capability/tool an action uses"; D-009).
 *
 * The autonomy gate (B-12) governs a category at a time: the owner sets a per-
 * category risk ceiling, and the gate needs, for the action about to run, WHICH
 * category's ceiling applies. This module is that lookup.
 *
 * ── Why it keys on the TOOL NAME, not the capability string ──────────────────
 * The natural guess — "derive the category from the `capability` RBAC string" —
 * is WRONG, and dangerously so. The capability string is a coarse RBAC bucket;
 * many distinct governance actions across DIFFERENT categories and posture
 * levels share ONE capability. Under `harness:write` alone:
 *     deploy:harness        → release-deploy   (PROTECTED)
 *     accounts:scale_out    → spend-budget     (PROTECTED)
 *     accounts:register     → credentials-auth (PROTECTED)
 *     pot:create           → agent-lifecycle
 *     blender:grade-idea      → ideation-intake  (low-risk)
 *     knowledge_packs:publish→ knowledge-curation
 * Keying on `capability` would collapse a low-risk grade and a PROTECTED deploy
 * to the same category — exactly the confident-but-catastrophic ≡ shaky-but-
 * trivial collapse D-002 forbids. So the rules match the stable MCP tool **name**
 * (`group:verb`), which the dispatch chokepoint already has in hand. D-009's
 * phrasing is "the capability/**tool**" — the tool name is the authoritative key;
 * the capability string is only a coarse last-resort fallback (protected-direction
 * only — see CAPABILITY_FALLBACK_RULES).
 *
 * ── Fail-safe (D-009 / P-090) ────────────────────────────────────────────────
 * No rule matches ⇒ `null`. The gate treats a `null` category on a GOVERNED
 * action as **never-auto** (the most conservative posture) — "we can't name the
 * category, so don't auto-run it." Non-governance tool calls (reads, coordination
 * plumbing, locks) are also `null` here, but those never reach the decision gate
 * (the cheap capability *envelope* governs them — confinement-plan D-003), so a
 * `null` there is correct, not a gap. The P-090 coverage invariant pins that
 * every HUMAN-DRIVING action in {@link ./action-surface} resolves NON-null.
 *
 * Built as a declarative `@papercusp/rules` RulesEngine, mirroring
 * `operator-cap-tier-heuristic.ts` (the capability→tier sibling): the rules are
 * inspectable (`categoryMapRules()` / `engine.describe()`) so the settings UI
 * (B-15) and the decision ledger (P-110) can show WHY a category was chosen.
 *
 * Pure logic — no DB, no IO — exhaustively unit-testable.
 */

import { RulesEngine, type Rule } from '@papercusp/rules';
import type { AutonomyCategory } from './categories';

/** The event matched against the category rules: the tool name + its capability. */
interface ActionEvent {
  /** The MCP tool name, `group:verb` (e.g. `deploy:harness`, `cup:spawn`). */
  action: string;
  /** The tool's coarse RBAC capability string — last-resort fallback only. */
  capability?: string;
}

/** Every rule fires on this one trigger key (the table is regex-matched in order). */
const TRIGGER = 'action';

/**
 * Tool-name → category rules, in PRIORITY order (first match wins). Specific
 * overrides precede their group's generic prefix so a verb that belongs to a
 * different category than its group default (e.g. `pot:cross_grant`, which is a
 * credentials grant, not agent-lifecycle) classifies correctly. The four
 * PROTECTED categories never depend on ordering for safety (an unmatched action
 * is never-auto by the fail-safe anyway) — order is for correctness, not safety.
 */
const CATEGORY_RULES: Rule<ActionEvent, AutonomyCategory>[] = [
  // ── release & deploy (PROTECTED) ──
  {
    id: 'cat:deploy',
    on: TRIGGER,
    when: { action: { matches: '^deploy:' } },
    fire: 'release-deploy',
    meta: { reason: 'ships / tears down a deploy target' },
  },

  // ── spend & budget (PROTECTED) ──
  {
    id: 'cat:budget',
    on: TRIGGER,
    when: { action: { matches: '^operator:budget' } },
    fire: 'spend-budget',
    meta: { reason: 'sets a spend budget' },
  },
  {
    id: 'cat:rate-limit',
    on: TRIGGER,
    when: { action: { matches: '^operator:rate_limit' } },
    fire: 'spend-budget',
    meta: { reason: 'governs rate / throughput spend' },
  },
  {
    id: 'cat:voice-spend',
    on: TRIGGER,
    when: { action: { matches: '^operator:voice_spend' } },
    fire: 'spend-budget',
    meta: { reason: 'voice spend accounting' },
  },
  {
    id: 'cat:scale-out',
    on: TRIGGER,
    when: { action: { matches: '^accounts:scale_out' } },
    fire: 'spend-budget',
    meta: { reason: 'account scaling = provisioning spend' },
  },

  // ── credentials & auth (PROTECTED) — specific overrides BEFORE accounts:/hive: groups ──
  {
    id: 'cat:accounts-cred',
    on: TRIGGER,
    when: { action: { matches: '^accounts:(register|remove)' } },
    fire: 'credentials-auth',
    meta: { reason: 'registers/removes a credential-bearing account' },
  },
  {
    id: 'cat:operator-credentials',
    on: TRIGGER,
    when: { action: { matches: '^operator:credentials' } },
    fire: 'credentials-auth',
    meta: { reason: 'credential status / management' },
  },
  {
    id: 'cat:hive-cross-grant',
    on: TRIGGER,
    when: { action: { matches: '^pot:cross_grant' } },
    fire: 'credentials-auth',
    meta: { reason: 'grants cross-hive authorization' },
  },
  {
    id: 'cat:substrate-revoke',
    on: TRIGGER,
    when: { action: { matches: '^substrate:revoke' } },
    fire: 'credentials-auth',
    meta: { reason: 'revokes a substrate contributor/device' },
  },
  {
    id: 'cat:trust',
    on: TRIGGER,
    when: { action: { matches: '^trust:(add|remove)' } },
    fire: 'credentials-auth',
    meta: { reason: 'grants/revokes owner trust — auto-run authorization for a verified GitHub author' },
  },

  // ── system-control (PROTECTED) ──
  {
    id: 'cat:autoloop',
    on: TRIGGER,
    when: { action: { matches: '^autoloop:' } },
    fire: 'system-control',
    meta: { reason: 'arms / disarms the autoloop' },
  },
  {
    id: 'cat:flags',
    on: TRIGGER,
    when: { action: { matches: '^flags:' } },
    fire: 'system-control',
    meta: { reason: 'flips a feature flag' },
  },
  {
    id: 'cat:routines',
    on: TRIGGER,
    when: { action: { matches: '^routines:' } },
    fire: 'system-control',
    meta: { reason: 'controls a background routine' },
  },
  {
    id: 'cat:backup',
    on: TRIGGER,
    when: { action: { matches: '^backup:' } },
    fire: 'system-control',
    meta: { reason: 'snapshot / restore / rollback of system state' },
  },
  {
    id: 'cat:db-migrate',
    on: TRIGGER,
    when: { action: { matches: '^db:migrate' } },
    fire: 'system-control',
    meta: { reason: 'applies a schema migration' },
  },
  {
    id: 'cat:processes',
    on: TRIGGER,
    when: { action: { matches: '^processes:' } },
    fire: 'system-control',
    meta: { reason: 'process control (kill, etc.)' },
  },
  {
    id: 'cat:dev-restart',
    on: TRIGGER,
    when: { action: { matches: '^dev:restart' } },
    fire: 'system-control',
    meta: { reason: 'restarts a dev service' },
  },
  {
    id: 'cat:wake-mode',
    on: TRIGGER,
    when: { action: { matches: '^coord:wake-mode' } },
    fire: 'system-control',
    meta: { reason: 'changes fleet wake mode' },
  },
  {
    id: 'cat:hive-declare-wake',
    on: TRIGGER,
    when: { action: { matches: '^pot:declare-wake' } },
    fire: 'system-control',
    meta: { reason: 'declares a wake routine' },
  },

  // ── agent-lifecycle — hive: overrides (cross_grant/declare-wake/ask*) handled above/below ──
  {
    id: 'cat:hive-ask',
    on: TRIGGER,
    when: { action: { matches: '^pot:(ask|request_work|asks)' } },
    fire: 'escalations',
    meta: { reason: 'asks another hive (a cross-hive question)' },
  },
  {
    id: 'cat:launch-agent',
    on: TRIGGER,
    when: { action: { matches: '^capability:launch-agent$' } },
    fire: 'agent-lifecycle',
    meta: { reason: 'launches an ad-hoc agent or resumes/forks an existing agent' },
  },
  {
    id: 'cat:fleet',
    on: TRIGGER,
    when: { action: { matches: '^fleet:' } },
    fire: 'agent-lifecycle',
    meta: { reason: 'spawn / cancel / drain / admit / supervise an agent' },
  },
  // cup:spawn (WI-1764 #3 renamed fleet:spawn → cup:spawn) placed a background
  // autonomous-loop bee — same agent-lifecycle category as the fleet: verbs it split from.
  // ⚠ KEPT DELIBERATELY THOUGH NO `cup:*` TOOL REMAINS (P-059 retired cup:spawn,
  // the last one). This rule is matched against the `action` STRING, and the
  // decision ledger holds historical rows stamped `cup:spawn`; deleting the rule
  // would re-categorize those to null, which the gate reads as never-auto. A rule
  // that matches no LIVE verb still classifies the past correctly.
  {
    id: 'cat:bee',
    on: TRIGGER,
    when: { action: { matches: '^cup:' } },
    fire: 'agent-lifecycle',
    meta: { reason: 'spawn a background autonomous-loop bee (nursery placement)' },
  },
  {
    id: 'cat:hive',
    on: TRIGGER,
    when: { action: { matches: '^pot:' } },
    fire: 'agent-lifecycle',
    meta: { reason: 'hive (swarm of agents) lifecycle' },
  },
  {
    id: 'cat:new-subagent-approve',
    on: TRIGGER,
    when: { action: { matches: '^new_subagent:approve' } },
    fire: 'agent-lifecycle',
    meta: { reason: 'approves a new subagent spawn' },
  },
  {
    id: 'cat:new-subagent-request',
    on: TRIGGER,
    when: { action: { matches: '^new_subagent:request' } },
    fire: 'escalations',
    meta: { reason: 'requests approval for a new subagent (an ask)' },
  },
  {
    id: 'cat:intel-spawn-tree',
    on: TRIGGER,
    when: { action: { matches: '^intel:spawn_tree' } },
    fire: 'agent-lifecycle',
    meta: { reason: 'agent spawn-tree view' },
  },
  {
    id: 'cat:agents',
    on: TRIGGER,
    when: { action: { matches: '^agents:' } },
    fire: 'agent-lifecycle',
    meta: { reason: 'agent roster' },
  },

  // ── inbox-triage — plans:attention override BEFORE the plans: group ──
  {
    id: 'cat:plans-attention',
    on: TRIGGER,
    when: { action: { matches: '^plans:attention' } },
    fire: 'inbox-triage',
    meta: { reason: 'the inbox / attention view' },
  },
  {
    id: 'cat:inbox',
    on: TRIGGER,
    when: { action: { matches: '^inbox:' } },
    fire: 'inbox-triage',
    meta: { reason: 'inbox triage' },
  },
  // cat:messages-dismiss (messages:dismiss) RETIRED 2026-07-26 —
  // retire-work-item-mail-surface-2026-07-26 P-007.

  // ── plan-governance ──
  {
    id: 'cat:plan-reviews',
    on: TRIGGER,
    when: { action: { matches: '^harness:(plan_reviews|pending_reviews)' } },
    fire: 'plan-governance',
    meta: { reason: 'plan-review queue' },
  },
  // schedule-arm: activating any trigger that may start unattended plan runs is its OWN
  // graduatable category. These overrides MUST precede the generic plans: rule (D-017).
  {
    id: 'cat:trigger-arm',
    on: TRIGGER,
    when: { action: { matches: '^triggers:(arm|disarm)$' } },
    fire: 'schedule-arm',
    meta: { reason: 'arms / disarms an external-event binding that can start autonomous plan runs' },
  },
  {
    id: 'cat:schedule-arm',
    on: TRIGGER,
    when: { action: { matches: '^plans:(arm|disarm)-schedule' } },
    fire: 'schedule-arm',
    meta: { reason: 'arms / disarms a scheduled plan’s recurrence (start/stop autonomous runs)' },
  },
  {
    id: 'cat:goal-schedule-arm',
    on: TRIGGER,
    when: { action: { matches: '^goals:arm-schedule' } },
    fire: 'schedule-arm',
    meta: { reason: 'arms / pauses a goal’s activation recurrence (starts unattended goal holders — work-on-everything-goal-2026-08-23 P-020)' },
  },
  {
    id: 'cat:plans',
    on: TRIGGER,
    when: { action: { matches: '^plans:' } },
    fire: 'plan-governance',
    meta: { reason: 'ratify / promote / set plan state' },
  },
  {
    id: 'cat:plan-items',
    on: TRIGGER,
    when: { action: { matches: '^plan_items:' } },
    fire: 'plan-governance',
    meta: { reason: 'plan-item governance (claim / convert / status)' },
  },
  {
    id: 'cat:goals',
    on: TRIGGER,
    when: { action: { matches: '^goals:' } },
    fire: 'plan-governance',
    meta: { reason: 'plan-level objectives' },
  },

  // ── work-prioritization ──
  {
    id: 'cat:work-items',
    on: TRIGGER,
    when: { action: { matches: '^work_items:' } },
    fire: 'work-prioritization',
    meta: { reason: 'work-item priority / reorder / state' },
  },

  // ── implementation — improvements:set-auto-policy override BEFORE improvements: group ──
  // (WI-5252: the auto-implement risk-policy/graduation dial is a DISTINCT human-driving
  // action from generic idea triage — it governs WHICH changes dispatch with no per-item
  // review at all, so it belongs to `implementation`, not `ideation-intake`.)
  {
    id: 'cat:improvements-auto-policy',
    on: TRIGGER,
    when: { action: { matches: '^improvements:set-auto-policy' } },
    fire: 'implementation',
    meta: {
      reason:
        'graduates/tunes the auto-implement dispatch policy (autoKinds, dispatch ceilings, protected-path/keyword tightening) — the actual "approve auto-implement" lever, distinct from per-idea triage',
    },
  },

  // ── ideation & intake — conversations:promote override BEFORE conversations: group ──
  {
    id: 'cat:conversations-promote',
    on: TRIGGER,
    when: { action: { matches: '^conversations:promote' } },
    fire: 'ideation-intake',
    meta: { reason: 'promotes a conversation to tracked work' },
  },
  {
    id: 'cat:scout',
    on: TRIGGER,
    when: { action: { matches: '^blender:' } },
    fire: 'ideation-intake',
    meta: { reason: 'grades a Scout idea' },
  },
  {
    id: 'cat:improvements',
    on: TRIGGER,
    when: { action: { matches: '^improvements:' } },
    fire: 'ideation-intake',
    meta: { reason: 'triage / promote an improvement' },
  },
  {
    id: 'cat:issues',
    on: TRIGGER,
    when: { action: { matches: '^issues:' } },
    fire: 'ideation-intake',
    meta: { reason: 'triage / promote an issue' },
  },

  // ── review & merge ──
  {
    id: 'cat:gym',
    on: TRIGGER,
    when: { action: { matches: '^gym:' } },
    fire: 'review-merge',
    meta: { reason: 'judges a gym candidate (a quality verdict)' },
  },
  {
    id: 'cat:design-review',
    on: TRIGGER,
    when: { action: { matches: '^design-phase[.:]record_review' } },
    fire: 'review-merge',
    meta: { reason: 'records a design reviewer verdict' },
  },
  {
    id: 'cat:review-approve',
    on: TRIGGER,
    when: { action: { matches: '^review:approve' } },
    fire: 'review-merge',
    meta: { reason: 'approves a pending code review' },
  },
  {
    id: 'cat:merge-approve',
    on: TRIGGER,
    when: { action: { matches: '^merge:approve' } },
    fire: 'review-merge',
    meta: { reason: 'confirms a promotion / merge to a later phase' },
  },

  // ── escalations & agent-questions ──
  {
    id: 'cat:coord-escalate',
    on: TRIGGER,
    when: { action: { matches: '^coord:(escalate|escalations|resolve|ack|deliberate|vote)' } },
    fire: 'escalations',
    meta: { reason: 'raises / resolves an escalation' },
  },
  {
    id: 'cat:harness-escalation',
    on: TRIGGER,
    when: { action: { matches: '^harness:escalation' } },
    fire: 'escalations',
    meta: { reason: 'harness escalation queue' },
  },
  {
    id: 'cat:conversations',
    on: TRIGGER,
    when: { action: { matches: '^conversations:' } },
    fire: 'escalations',
    meta: { reason: 'answer / resolve an agent question' },
  },
  {
    id: 'cat:chat-ask-choice',
    on: TRIGGER,
    when: { action: { matches: '^chat[:_]?ask_choice' } },
    fire: 'escalations',
    meta: { reason: 'answers a decision card' },
  },

  // ── knowledge-curation ──
  {
    id: 'cat:memory',
    on: TRIGGER,
    when: { action: { matches: '^memory:' } },
    fire: 'knowledge-curation',
    meta: { reason: 'remember / forget / update a memory' },
  },
  {
    id: 'cat:knowledge-packs',
    on: TRIGGER,
    when: { action: { matches: '^knowledge_packs:' } },
    fire: 'knowledge-curation',
    meta: { reason: 'publish / install a knowledge pack' },
  },
  {
    id: 'cat:blueprint',
    on: TRIGGER,
    when: { action: { matches: '^blueprint:' } },
    fire: 'knowledge-curation',
    meta: { reason: 'authors / extends a blueprint' },
  },
  {
    id: 'cat:docs',
    on: TRIGGER,
    when: { action: { matches: '^docs:' } },
    fire: 'knowledge-curation',
    meta: { reason: 'publishes documentation' },
  },
  {
    id: 'cat:curation',
    on: TRIGGER,
    when: { action: { matches: '^curation:' } },
    fire: 'knowledge-curation',
    meta: { reason: 'hive knowledge curation' },
  },
  {
    id: 'cat:wiki',
    on: TRIGGER,
    when: { action: { matches: '^wiki:' } },
    fire: 'knowledge-curation',
    meta: { reason: 'wiki / backlinks' },
  },
  {
    id: 'cat:rationale',
    on: TRIGGER,
    when: { action: { matches: '^rationale:' } },
    fire: 'knowledge-curation',
    meta: { reason: 'rationale projection' },
  },
];

/**
 * Coarse CAPABILITY-string fallbacks — last resort, PROTECTED-DIRECTION ONLY.
 * Used only when no tool-name rule matched. Limited to capability prefixes that
 * are UNAMBIGUOUSLY sensitive, so the coarse signal can only route TOWARD a
 * protected category (never relaxing). Anything else stays `null` (fail-safe).
 * Kept tiny on purpose: the capability string's coarseness is the very hazard
 * this module exists to avoid (see module doc).
 */
const CAPABILITY_FALLBACK_RULES: Rule<ActionEvent, AutonomyCategory>[] = [
  {
    id: 'cap:secrets',
    on: TRIGGER,
    when: { capability: { matches: '^secrets:' } },
    fire: 'credentials-auth',
    meta: { reason: 'capability reads/writes secret material' },
  },
  {
    id: 'cap:compute-exec',
    on: TRIGGER,
    when: { capability: { matches: '^compute:exec:' } },
    fire: 'system-control',
    meta: { reason: 'capability runs arbitrary code' },
  },
];

const ENGINE = new RulesEngine<ActionEvent, AutonomyCategory>({ keyOf: () => TRIGGER })
  .addAll(CATEGORY_RULES)
  .addAll(CAPABILITY_FALLBACK_RULES);

export interface CategoryResult {
  category: AutonomyCategory;
  /** Human-readable justification (for the ledger + the settings "why" surface). */
  reason: string;
}

/**
 * Classify an action by its tool name (and, last-resort, capability). Returns
 * `null` when no rule matches — the gate's fail-safe treats a `null` on a
 * governed action as never-auto (D-009). `capability` is optional and only
 * consulted by {@link CAPABILITY_FALLBACK_RULES}.
 */
export function classifyActionCategory(action: string, capability?: string): CategoryResult | null {
  const [first] = ENGINE.match({ action, capability });
  if (!first) return null;
  return { category: first.fire, reason: (first.rule.meta as { reason: string }).reason };
}

/** Thin accessor: the category for an action, or `null` (fail-safe → never-auto). */
export function categoryForAction(action: string, capability?: string): AutonomyCategory | null {
  return classifyActionCategory(action, capability)?.category ?? null;
}

/** Inspectability: the reactive graph of category rules (for the settings UI / ledger). */
export function categoryMapRules(): ReturnType<RulesEngine<ActionEvent, AutonomyCategory>['describe']> {
  return ENGINE.describe();
}
