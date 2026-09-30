/**
 * action-surface.ts — the AUTHORITATIVE inventory of the human-driving action
 * surface (queen-autonomy-policy-2026-06-13 B-04 / P-015; the data behind D-010's
 * completeness invariant).
 *
 * D-010 (owner): "all the things a human does to drive it must be accessible to
 * the Queen." That is a CLAIM, and a claim is only worth what verifies it. This
 * module is the verification substrate: every place an agent or the pipeline
 * currently asks the human to act, enumerated as a typed row carrying its
 * { category, reversibility, authority, the Queen verb(s) that realize it, the
 * human surface it appears on today, and a coverage verdict }. With the surface
 * as data:
 *   • the COMPLETENESS invariant (D-010 / P-090) — every human-driving action
 *     maps to exactly one category — is a unit assertion, not a hope;
 *   • the MAP↔AUDIT consistency invariant — each covered action's Queen verb
 *     resolves (via {@link ./capability-category-map}) to the SAME category the
 *     audit assigned — keeps the taxonomy and the runtime map from drifting;
 *   • the COVERAGE gaps (P-016) — human-driving actions with no Queen verb — are
 *     a queryable list ({@link coverageGaps}), each filed as a build item.
 *
 * ── Accessible ≠ auto (D-010) ────────────────────────────────────────────────
 * Every row gets a Queen-accessible verb + a category, so the Queen can always at
 * least PROPOSE / decide-and-await-ratification. The category ceiling governs only
 * whether she may EXECUTE without asking. `authority: 'owner'` rows always gate
 * (the owner's by right, D-002), and PROTECTED-category rows are never auto —
 * both stay accessible as propose→ratify.
 *
 * ── Reversibility / authority vocab ──────────────────────────────────────────
 * `reversibility` uses B-02's three-valued {@link Reversibility} (`unknown` fails
 * safe to irreversible at the gate). `authority` mirrors B-01's axis
 * (`owner` always gates regardless of computed risk; `system` is gateable by the
 * category ceiling). These are FIXED properties of the action TYPE here (a deploy
 * is irreversible whatever its payload); the per-candidate classifiers
 * (reversibility.ts, the B-01 schema) compute the same axes for a concrete item.
 *
 * Pure data — no DB, no IO.
 */

import type { AutonomyCategory } from './categories';
import type { Reversibility } from '../harness/improvements/reversibility';

/**
 * The decision-authority axis (B-01). `owner` = the owner's by right — always
 * gates regardless of computed risk or category ceiling (D-002). `system` = the
 * Queen may auto-decide it within the category ceiling.
 */
export type Authority = 'owner' | 'system';

/**
 * Coverage verdict for the completeness audit (P-016):
 *   • `covered` — ≥1 Queen-accessible verb fully realizes the action.
 *   • `partial` — a verb touches the action but the full human capability isn't
 *     yet expressible by the Queen (a narrower gap; a build item refines it).
 *   • `gap`     — human-only today; NO Queen verb exists (a build item adds one).
 */
export type Coverage = 'covered' | 'partial' | 'gap';

export interface HumanDrivingAction {
  /** Stable audit id (`<category-stem>.<verb>`), referenced by build items + the ledger. */
  id: string;
  /** Short human label. */
  label: string;
  /** The one category this action belongs to (D-009 partition). */
  category: AutonomyCategory;
  /** Reversibility of the action TYPE (B-02 vocab; `unknown` → irreversible at the gate). */
  reversibility: Reversibility;
  /** Decision authority (B-01): `owner` always gates; `system` is ceiling-gated. */
  authority: Authority;
  /**
   * The Queen-accessible MCP verb(s) (`group:verb`) that realize this action.
   * Empty ⇔ `coverage: 'gap'`. Each listed verb MUST resolve to `category` via
   * {@link ./capability-category-map} (pinned by the consistency invariant test).
   */
  queenVerbs: readonly string[];
  /** Where the human performs this action today (inbox, settings, a gate, a card…). */
  humanSurface: string;
  coverage: Coverage;
  /** Optional clarifying note (e.g. why partial/gap, or a fuzzy-boundary call). */
  notes?: string;
}

/**
 * THE AUDIT. Grouped by category in the D-009 table order. This is the
 * authoritative list D-009 says "is produced + pinned by the P-015 audit"; the
 * owner may adjust it. Adding/removing a human-driving action ⇒ edit here and the
 * invariants re-verify completeness.
 */
export const ACTION_SURFACE: readonly HumanDrivingAction[] = [
  // ── inbox-triage ───────────────────────────────────────────────────────────
  {
    id: 'inbox.triage-item',
    label: 'Tier / downgrade an inbox item',
    category: 'inbox-triage',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['inbox:triage'],
    humanSurface: 'Inbox (plans:attention) — tier/severity controls',
    coverage: 'covered',
  },
  // inbox.dismiss-message (messages:dismiss) RETIRED 2026-07-26 —
  // retire-work-item-mail-surface-2026-07-26 P-007. See
  // _retired/work-item-mail/RESTORE.md.

  // ── escalations & agent-questions ────────────────────────────────────────────
  {
    id: 'escalations.resolve',
    label: 'Resolve a blocker/question/advisory escalation',
    category: 'escalations',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['coord:resolve', 'coord:escalations'],
    humanSurface: 'Inbox / escalations queue — resolve-with-choice',
    coverage: 'covered',
    notes:
      'Authority is per-escalation: an escalation that asks an owner-authority question still gates even when the category ceiling would allow auto.',
  },
  {
    id: 'escalations.answer-question',
    label: 'Answer an agent question / conversation',
    category: 'escalations',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['conversations:answer', 'conversations:resolve', 'conversations:post'],
    humanSurface: 'Conversations / agent-questions',
    coverage: 'covered',
  },
  {
    id: 'escalations.answer-card',
    label: 'Answer a ctx.askUser decision card',
    category: 'escalations',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['coord:resolve', 'coord:escalations'],
    humanSurface: 'In-tool decision card (ctx.askUser) surfaced to the owner-decision-queue',
    coverage: 'covered',
    notes:
      'EI-458: re-audited — a card-linked escalation (chat:ask_choice\'s onCard hook stashes cardCorrelationId/cardWorkspaceId on the escalation record) is ALREADY a first-class, ledgered "answer card N" action: coord:escalations lists the open record (cardCorrelationId included), and coord:resolve { msg_id, choice } both records the append-only escalation_resolved event AND (card-link.ts unblockLinkedCard) resolves the SAME live ctx.askUser card in one write. The prior partial verdict undercounted coord:resolve\'s card-unblock side-effect; conversations:answer was never the right verb here (that answers a question conversation, not a click-card) and is removed from this row.',
  },
  {
    id: 'escalations.cross-hive-ask',
    label: 'Ask another hive a question / request work',
    category: 'escalations',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['pot:ask', 'pot:request_work', 'pot:asks'],
    humanSurface: 'Cross-hive asks board',
    coverage: 'covered',
  },

  // ── plan-governance ───────────────────────────────────────────────────────────
  {
    id: 'plan.ratify-needs-human-item',
    label: 'Ratify a needs-human plan item / milestone gate',
    category: 'plan-governance',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['plans:set-status'],
    humanSurface: 'Plan view — needs-human item gate',
    coverage: 'covered',
    notes:
      "authority=owner: a milestone/design gate is the owner's to clear. The Mug can propose (flip wip→done with rationale) but the gate stays owner-authority unless graduated.",
  },
  {
    id: 'plan.ratify-decision',
    label: 'Ratify a D-NNN plan decision',
    category: 'plan-governance',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['plans:add-decision', 'plans:ratify-decision'],
    humanSurface: 'Plan view — decision ratification ("Ratified: <by> on <date>")',
    coverage: 'covered',
    notes:
      'EI-458: plans:ratify-decision adds a distinct, idempotent ratify verb (appends a `Ratified: <by> on <date>` line to the decision body) so "propose a decision" (plans:add-decision) and "ratify it" are separately governable, ledgered actions — no more free-prose "RATIFIED by owner".',
  },
  {
    id: 'plan.set-status-now',
    label: 'Set plan status / Now / priority',
    category: 'plan-governance',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['plans:set-plan-status', 'plans:set-now', 'plans:set-priority', 'plans:set-importance'],
    humanSurface: 'Plan view — status / Now / priority controls',
    coverage: 'covered',
  },
  {
    id: 'plan.promote-to-features',
    label: 'Promote a plan → features / waves',
    category: 'plan-governance',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['plans:promote'],
    humanSurface: 'Plan view — promote',
    coverage: 'covered',
  },
  {
    id: 'plan.convert-item-to-work',
    label: 'Convert a plan item → work-item (the decision↔execution boundary)',
    category: 'plan-governance',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['plan_items:convert'],
    humanSurface: 'Plan view — convert (D-013 boundary)',
    coverage: 'covered',
  },

  // ── work-prioritization ──────────────────────────────────────────────────────
  {
    id: 'work.set-priority',
    label: 'Set work-item priority / importance',
    category: 'work-prioritization',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['work_items:set_priority'],
    humanSurface: 'Work tab / backlog — priority control',
    coverage: 'covered',
  },
  {
    id: 'work.reorder-backlog',
    label: 'Reorder the backlog',
    category: 'work-prioritization',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['work_items:reorder'],
    humanSurface: 'Work tab — drag-reorder',
    coverage: 'covered',
  },
  {
    id: 'work.set-state',
    label: 'Set / steer work-item state',
    category: 'work-prioritization',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['work_items:set_state', 'work_items:promote'],
    humanSurface: 'Work tab — state controls',
    coverage: 'covered',
  },

  // ── ideation & intake ──────────────────────────────────────────────────────────
  {
    id: 'ideation.grade-scout-idea',
    label: 'Grade a Scout idea',
    category: 'ideation-intake',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['blender:grade-idea'],
    humanSurface: 'Scout ideas board',
    coverage: 'covered',
  },
  {
    id: 'ideation.triage-improvement',
    label: 'Triage / resolve an improvement',
    category: 'ideation-intake',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['improvements:triage', 'improvements:resolve'],
    humanSurface: 'Improvements digest',
    coverage: 'covered',
  },
  // (ideation.triage-promote-issue REMOVED — coordination-unification-2026-06-23 D-011:
  //  issues:* retired; promoting/closing a bug/change is now a work_items op, already
  //  covered by work.set-state. Issue-triage folds into work-prioritization — ideation-intake
  //  stays covered by grade-scout-idea + triage-improvement.)
  {
    id: 'ideation.promote-conversation',
    label: 'Promote a conversation → tracked work',
    category: 'ideation-intake',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['conversations:promote'],
    humanSurface: 'Conversations',
    coverage: 'covered',
  },

  // ── implementation ──────────────────────────────────────────────────────────────
  {
    id: 'implementation.dispatch-auto-implement',
    label: 'Approve / dispatch an auto-implement code change',
    category: 'implementation',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['improvements:set-auto-policy'],
    humanSurface: 'Improvement digest — auto-implement policy (autoKinds graduation, dispatch ceilings)',
    coverage: 'covered',
    notes:
      'WI-5252 (EI-458 follow-up, resolved): re-audited — the design question was "what does approve mean distinct from create+triage?". Answer: per-idea create+triage is NOT a separate approval — it is already fully realized by ideation.triage-improvement\'s decision (improvements:triage{decision:"place"}) plus the mechanical work_items:create realization, the same decision→execution-boundary pattern plan.convert-item-to-work already covers with one verb. The GENUINE distinct "approve auto-implement" action is the one a human/Mug actually exercises with no per-item review at all: improvements:set-auto-policy (autoKinds graduation, maxPerRun/maxAttempts, tighten-only protected-path/keyword additions) — already Queen-accessible (mug/architect/operator roles), audited + one-call-revertible. It was simply missing from this audit; capability-category-map.ts now carries a specific override (cat:improvements-auto-policy, before the generic improvements: → ideation-intake rule) so it resolves to `implementation`, matching this row.',
  },

  // ── review & merge ───────────────────────────────────────────────────────────────
  {
    id: 'review.judge-gym-candidate',
    label: 'Judge a gym candidate (quality verdict)',
    category: 'review-merge',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['gym:judge'],
    humanSurface: 'Gym judging',
    coverage: 'covered',
  },
  {
    id: 'review.record-design-review',
    label: 'Record a design-phase reviewer verdict',
    category: 'review-merge',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['design-phase:record_review'],
    humanSurface: 'Design phase — reviewer verdict',
    coverage: 'covered',
  },
  {
    id: 'review.approve-code-review-merge',
    label: 'Approve a code review / merge to staging',
    category: 'review-merge',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['review:approve', 'merge:approve'],
    humanSurface: 'Pipeline reviewer role / git-sync merge; now also review:approve / merge:approve',
    coverage: 'covered',
    notes:
      'EI-457: review:approve wraps POST /harness/:slug/reviews/:id/resolve (approve/answer a pending review, unblocking its feature); merge:approve wraps POST /harness/:slug/promote/:id/confirm (confirm a promotion, merging a phase forward). Together they make review&merge a governable category.',
  },

  // ── release & deploy (PROTECTED) ──────────────────────────────────────────────────
  {
    id: 'release.deploy-harness',
    label: 'Approve / run a deploy',
    category: 'release-deploy',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: ['deploy:harness', 'deploy:pot'],
    humanSurface: 'Deploy controls / /admin/git',
    coverage: 'covered',
    notes: 'PROTECTED: ceiling locked at never-auto. Accessible as propose→owner-ratifies; never auto.',
  },
  {
    id: 'release.teardown',
    label: 'Tear down a deploy target',
    category: 'release-deploy',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: ['deploy:teardown', 'deploy:teardown_pot'],
    humanSurface: 'Deploy controls',
    coverage: 'covered',
    notes: 'PROTECTED.',
  },
  {
    id: 'release.promote-to-green',
    label: 'Promote staging → green (main)',
    category: 'release-deploy',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: [],
    humanSurface: 'green-checkpoint automation (FF main); no manual Mug verb',
    coverage: 'partial',
    notes:
      'Promotion to green is automation-only (green-checkpoint FFs main on a passing suite); a pre-push hook blocks manual pushes. The Mug influences it only via deploy:* + the staging suite. Intentionally near-uncovered — promotion to green stays automation/owner. Noted, not necessarily a build item.',
  },

  // ── spend & budget (PROTECTED) ────────────────────────────────────────────────────
  {
    id: 'spend.set-budget',
    label: 'Approve spend / set a budget',
    category: 'spend-budget',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: ['operator:budget'],
    humanSurface: 'Operator budget settings',
    coverage: 'covered',
    notes: 'PROTECTED. Spend is irreversible (money/credits consumed).',
  },
  {
    id: 'spend.scale-accounts',
    label: 'Scale out accounts (provisioning spend)',
    category: 'spend-budget',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: ['accounts:scale_out'],
    humanSurface: 'Accounts settings',
    coverage: 'covered',
    notes: 'PROTECTED.',
  },

  // ── agent-lifecycle ───────────────────────────────────────────────────────────────
  {
    id: 'lifecycle.spawn-agent',
    label: 'Spawn an agent / bee',
    category: 'agent-lifecycle',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['capability:launch-agent', 'fleet:launch-on-plan'],
    humanSurface: 'Fleet controls',
    coverage: 'covered',
    notes:
      'Reversible: a spawned agent can be cancelled/drained. Cost is governed separately by spend-budget. ' +
      '(Was cup:spawn until P-059 retired the nursery-cup tier; these are the surviving spawn doors.)',
  },
  {
    id: 'lifecycle.cancel-drain-agent',
    label: 'Cancel / drain an agent',
    category: 'agent-lifecycle',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['fleet:cancel', 'fleet:drain'],
    humanSurface: 'Fleet controls',
    coverage: 'covered',
  },
  {
    id: 'lifecycle.admit-supervise',
    label: 'Admit / supervise / govern the fleet',
    category: 'agent-lifecycle',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['fleet:admit', 'fleet:supervise', 'fleet:governor'],
    humanSurface: 'Fleet governor controls',
    coverage: 'covered',
  },
  {
    id: 'lifecycle.hive-lifecycle',
    label: 'Create / start / pause / dissolve a hive',
    category: 'agent-lifecycle',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['pot:create', 'pot:start', 'pot:pause', 'pot:dissolve', 'pot:update'],
    humanSurface: 'Hive controls',
    coverage: 'covered',
  },
  {
    id: 'lifecycle.approve-new-subagent',
    label: 'Approve a new subagent request',
    category: 'agent-lifecycle',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['new_subagent:approve'],
    humanSurface: 'New-subagent approval prompt',
    coverage: 'covered',
  },
  {
    id: 'lifecycle.model-tier',
    label: 'Choose the model tier for a spawn',
    category: 'agent-lifecycle',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['capability:launch-agent', 'fleet:launch-on-plan'],
    humanSurface: 'Spawn settings (queen-model-tier-selection)',
    coverage: 'partial',
    notes:
      'Model tier is a parameter on the spawn verbs rather than a standalone verb; finer per-spawn tier control may warrant a dedicated knob. Reversible (next spawn can differ). ' +
      '(Was cup:spawn until P-059 retired the nursery-cup tier.)',
  },

  // ── credentials & auth (PROTECTED) ────────────────────────────────────────────────
  {
    id: 'credentials.register',
    label: 'Register / remove a credential-bearing account',
    category: 'credentials-auth',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: ['accounts:register', 'accounts:remove'],
    humanSurface: 'Accounts / credentials settings',
    coverage: 'covered',
    notes: 'PROTECTED. Credential changes are irreversible (a removed/rotated secret cannot be recovered).',
  },
  {
    id: 'credentials.cross-grant',
    label: 'Grant cross-hive authorization',
    category: 'credentials-auth',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['pot:cross_grant'],
    humanSurface: 'Hive network grants',
    coverage: 'covered',
    notes: 'PROTECTED. A grant is revocable (reversible) but authorization changes stay owner-authority + protected.',
  },
  {
    id: 'credentials.auth-flag',
    label: 'Flip an auth-affecting flag',
    category: 'credentials-auth',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['flags:set'],
    humanSurface: '/admin/features (auth-affecting flags)',
    coverage: 'partial',
    notes:
      'flags:set is one verb spanning system-control and credentials-auth; the category-map sends flags:set → system-control (also protected). Distinguishing auth-affecting flags would need per-flag metadata. Both targets are protected, so the gate is never-auto either way — recorded as partial, not a true gap.',
  },
  {
    id: 'credentials.trust-author',
    label: 'Trust / un-trust a GitHub author for auto-run',
    category: 'credentials-auth',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['trust:add', 'trust:remove'],
    humanSurface: 'Trust list (trust:list) — owner trust grants',
    coverage: 'covered',
    notes:
      'PROTECTED. trust:add grants a VERIFIED remote author auto-run privilege (the admission gate trust leg, shared-hive-trust-admission P-010); trust:remove revokes it (reversible). Owner-authority security grant, off the Mug autonomous surface — mirrors policy_set (D-006). trust:list is read-only (not a governed action).',
  },

  // ── knowledge-curation ────────────────────────────────────────────────────────────
  {
    id: 'knowledge.memory-curate',
    label: 'Approve / forget / update a memory',
    category: 'knowledge-curation',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['memory:remember', 'memory:forget', 'memory:update'],
    humanSurface: 'Memory settings / audit',
    coverage: 'covered',
  },
  {
    id: 'knowledge.publish-knowledge-pack',
    label: 'Publish / install a knowledge pack',
    category: 'knowledge-curation',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['knowledge_packs:publish', 'knowledge_packs:install', 'knowledge_packs:decide_candidate'],
    humanSurface: 'Knowledge packs',
    coverage: 'covered',
  },
  {
    id: 'knowledge.author-blueprint',
    label: 'Author / extend a blueprint',
    category: 'knowledge-curation',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['blueprint:create', 'blueprint:extend'],
    humanSurface: 'Blueprint catalog',
    coverage: 'covered',
  },
  {
    id: 'knowledge.publish-docs',
    label: 'Publish documentation / insights',
    category: 'knowledge-curation',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['docs:write'],
    humanSurface: 'Docs editor',
    coverage: 'covered',
  },

  // ── schedule-arm ──────────────────────────────────────────────────────────────
  {
    id: 'schedule.arm-plan-schedule',
    label: 'Arm / disarm a scheduled plan',
    category: 'schedule-arm',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['plans:arm-schedule', 'plans:disarm-schedule'],
    humanSurface: 'Calendar / plan schedule controls',
    coverage: 'covered',
    notes:
      'Arming makes a scheduled plan start firing runs; reversible (disarm). NON-protected so it can graduate per plan risk (scheduled-recurring-plans-2026-06-16 D-017) — seeded never-auto, distinct from system-control’s permanently-protected SYSTEM loops.',
  },
  {
    id: 'schedule.arm-goal-schedule',
    label: 'Arm / pause a scheduled goal activation',
    category: 'schedule-arm',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['goals:arm-schedule'],
    humanSurface: 'Goal schedule controls',
    coverage: 'covered',
    notes:
      'Arming makes a goal start its holder on a cadence (system:goal-start → startGoalById, whose already-held/not-active guards prevent double-spawn); reversible (disarm:true). Same graduatable seeding as plan schedule arming (work-on-everything-goal-2026-08-23 P-020, D-006 ruling 3).',
  },
  {
    id: 'schedule.arm-external-trigger',
    label: 'Arm / disarm an external-event plan binding',
    category: 'schedule-arm',
    reversibility: 'reversible',
    authority: 'system',
    queenVerbs: ['triggers:arm', 'triggers:disarm'],
    humanSurface: 'Admin → Triggers and the per-plan Triggers panel',
    coverage: 'covered',
    notes:
      'Installed is not armed. Arming lets provider events start autonomous plan runs, so it shares the schedule-arm ceiling and remains one-call reversible.',
  },

  // ── system-control (PROTECTED) ──────────────────────────────────────────────────────
  {
    id: 'system.arm-loop',
    label: 'Arm / disarm the autoloop / learning loop',
    category: 'system-control',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['autoloop:control'],
    humanSurface: 'Autoloop controls',
    coverage: 'covered',
    notes: 'PROTECTED. Arming the loop is the recursion-safety crux — never auto (cannot graduate, P-090).',
  },
  {
    id: 'system.flip-flag',
    label: 'Flip a feature flag',
    category: 'system-control',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['flags:set'],
    humanSurface: '/admin/features',
    coverage: 'covered',
    notes: 'PROTECTED.',
  },
  {
    id: 'system.control-routine',
    label: 'Activate / pause a background routine',
    category: 'system-control',
    reversibility: 'reversible',
    authority: 'owner',
    queenVerbs: ['routines:write'],
    humanSurface: 'Routines admin',
    coverage: 'covered',
    notes: 'PROTECTED.',
  },
  {
    id: 'system.backup',
    label: 'Snapshot / restore / rollback system state',
    category: 'system-control',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: ['backup:snapshot_create', 'backup:restore', 'backup:rollback', 'backup:promote'],
    humanSurface: 'Backup admin',
    coverage: 'covered',
    notes: 'PROTECTED. Restore/rollback are irreversible (they overwrite live state).',
  },
  {
    id: 'system.kill-process',
    label: 'Kill a runaway process',
    category: 'system-control',
    reversibility: 'irreversible',
    authority: 'owner',
    queenVerbs: ['processes:kill'],
    humanSurface: 'Process admin',
    coverage: 'covered',
    notes: 'PROTECTED. A killed process cannot be un-killed (it can be relaunched, but the interrupted work is lost).',
  },
];

/** The coverage gaps (P-016): human-driving actions with NO Queen verb yet. */
export function coverageGaps(): readonly HumanDrivingAction[] {
  return ACTION_SURFACE.filter((a) => a.coverage === 'gap');
}

/** The partially-covered actions (a narrower coverage concern than a full gap). */
export function partialCoverage(): readonly HumanDrivingAction[] {
  return ACTION_SURFACE.filter((a) => a.coverage === 'partial');
}

/** All distinct categories the audit assigns (should equal the full taxonomy). */
export function categoriesInAudit(): readonly AutonomyCategory[] {
  return [...new Set(ACTION_SURFACE.map((a) => a.category))];
}
