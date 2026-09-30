/**
 * overwatch/autonomy — the overwatch DECISION gate / autonomy envelope (D-002).
 * (overwatch-role-2026-06-15 B-06.)
 *
 * Overwatch is an always-on supervisor (a sibling to the Queen). It acts on
 * AGENTS, never on WORK placement (D-001): its only write-to-the-world verbs are
 * NUDGE (`coord:send`), OBSERVE (`improvements:capture`
 * lane:observation), and ESCALATE (`coord:escalate`). Everything else — restart a
 * routine, flip a flag, rebind the gateway, kill a process, spawn/place work — is
 * a STRUCTURAL change it must NOT perform; it ESCALATES instead.
 *
 * ── Two distinct gates (don't confuse them) ──────────────────────────────────
 * This is the DECISION gate, NOT the capability gate. B-01 already built the
 * capability wall: the `overwatch` role's tool allowlist + `ROLE_ENVELOPES`
 * (which DENIES `capability:fs-write` + `capability:bash`) make the structural
 * verbs literally uncallable. THIS gate is the policy/judgment layer the persona
 * consults BEFORE it acts — "may I auto-do this, or must I escalate?" — so the
 * answer is a deliberate, ledger-able verdict rather than a silent permission
 * error. The two layers agree by construction (the auto set is exactly the C-2
 * write surface), but they answer different questions.
 *
 * ── Why this is NOT a Queen autonomy category (D-002) ────────────────────────
 * The Queen autonomy model (queen-autonomy-policy-2026-06-13) is risk × ceiling
 * over a 13-category partition of the human-driving action surface, behavior-
 * neutral until the `papercusp-queen-autonomy-armed` flag and never-auto by
 * default. Overwatch's envelope is fundamentally different: a FIXED allowlist
 * that is auto by default (its "arming" is the `papercusp-overwatch` flag itself,
 * B-10 — if overwatch is running at all, observe+nudge+escalate is on). Folding
 * it into the Queen taxonomy would (a) need a migration + a 14th category, (b)
 * pollute the shared verb→category map (`coord:send` is also a Queen verb), and
 * (c) wrongly gate overwatch's nudges behind the Queen arming flag. So the gate
 * is its own small pure function; `autonomy:decide` DISPATCHES to it when the
 * caller's role is `overwatch` (one decision tool, two envelopes — no fork).
 *
 * Pure logic — no DB, no IO, exhaustively unit-testable.
 */

import type { AutonomyPosture } from '../autonomy/decider';

/**
 * How overwatch's action surface partitions. The first three are the C-2 write
 * verbs (nudge/observe/escalate); `lifecycle` is overwatch's OWN wake-scheduling
 * bookkeeping (EI-3588 — see below); `structural` is everything else — the
 * D-002 escalate-only bucket (a recognized structural verb OR an unmapped one;
 * both fail to gated).
 */
export type OverwatchActionClass = 'nudge' | 'observe' | 'escalate' | 'lifecycle' | 'structural';

/** Overwatch reuses the binary posture vocabulary: `auto` (do it) / `gated` (escalate). */
export type OverwatchPosture = AutonomyPosture;

/**
 * Action verb → class. Keyed on the MCP tool name (`group:verb`), the same key
 * the Queen decider's `categoryForAction` uses and the same `action` the
 * `autonomy:decide` tool already takes. The persona maps a C-1
 * `SuggestedAction.type` (nudge|observe|escalate) to its verb, then asks the gate.
 */
const NUDGE_VERBS: ReadonlySet<string> = new Set(['coord:send']);
const OBSERVE_VERBS: ReadonlySet<string> = new Set(['improvements:capture']);
const ESCALATE_VERBS: ReadonlySet<string> = new Set(['coord:escalate']);
/**
 * EI-3588: `kettle:declare-wake` schedules overwatch's OWN next wake (REPLACE
 * semantics) before it ends a turn. ⚠ The TOOL retired to
 * `_retired/mug-kettle-deciders/…/agent-tools/overwatch/declare_wake.ts`
 * (retire-mug-kettle-su-only-2026-08-09 P-059/D-080), so nothing can emit this verb
 * today; the entry stays because this set is keyed on a NAME STRING, not an import,
 * and dropping it would silently reclassify the verb to `structural` if the tool is
 * ever restored. `lib/overwatch/` is itself a later P-059 slice.
 * It never mutates agents, work placement, or shared infra (D-001's concern) — it
 * is pure self-scheduling bookkeeping the role brief mandates EVERY turn. Before
 * this fix it fell through to `structural` ⇒ gated ⇒ escalate-only, forcing
 * Overwatch to violate either the gate verdict or its own hard turn-completion
 * checklist every single turn. A distinct `lifecycle` class (not folded into
 * nudge/observe/escalate, which are genuinely different in kind) keeps the
 * classification honest.
 */
const LIFECYCLE_VERBS: ReadonlySet<string> = new Set(['kettle:declare-wake']);

/**
 * The verbs overwatch may AUTO-execute (its full write-to-the-world surface,
 * C-2 / D-001, plus its own lifecycle bookkeeping) — sorted, for the tool
 * description + the B-11 contract test. Anything NOT in this set is structural
 * ⇒ gated ⇒ escalate-only (D-002).
 */
export const OVERWATCH_AUTO_VERBS: readonly string[] = [
  ...NUDGE_VERBS,
  ...OBSERVE_VERBS,
  ...ESCALATE_VERBS,
  ...LIFECYCLE_VERBS,
].sort();

/** Normalize a verb for lookup: trim + lowercase + tolerate a `.` separator. */
function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace('.', ':');
}

/**
 * Classify an overwatch action by its verb. Unknown / structural verbs fall
 * through to `structural` (the fail-safe — overwatch performs only its four
 * allowlisted action classes; everything else it must escalate).
 */
export function classifyOverwatchAction(action: string): OverwatchActionClass {
  const a = normalizeAction(action);
  if (NUDGE_VERBS.has(a)) return 'nudge';
  if (OBSERVE_VERBS.has(a)) return 'observe';
  if (ESCALATE_VERBS.has(a)) return 'escalate';
  if (LIFECYCLE_VERBS.has(a)) return 'lifecycle';
  return 'structural';
}

/**
 * The overwatch decision verdict — mirrors the Queen `AutonomyDecision` enough to
 * flow through the same `autonomy:decide` response + the ledger (`posture`,
 * `action`, `reasons`), plus the overwatch-specific `actionClass` /
 * `escalateOnly`.
 */
export interface OverwatchDecision {
  /** `auto` ⇒ overwatch performs it itself; `gated` ⇒ it must escalate (never perform). */
  posture: OverwatchPosture;
  /** Which envelope class the action fell into. */
  actionClass: OverwatchActionClass;
  /** The action verb decided (echoed for the ledger / the "why" surface). */
  action: string;
  /**
   * True iff gated: a gated overwatch action is ESCALATE-ONLY (D-002) — overwatch
   * raises it for a human / the Queen, it never performs the structural change.
   */
  escalateOnly: boolean;
  /** The decisive reasons, for the ledger + the settings "why" surface. */
  reasons: string[];
}

/**
 * The overwatch autonomy gate (D-002). AUTO for nudge / observe / escalate /
 * lifecycle; GATED (escalate-only) for any structural or unmapped action. Pure —
 * the verdict depends only on the action verb.
 */
export function decideOverwatchAutonomy(input: { action: string }): OverwatchDecision {
  const action = input.action;
  const actionClass = classifyOverwatchAction(action);
  const auto = actionClass !== 'structural';
  const posture: OverwatchPosture = auto ? 'auto' : 'gated';
  const reasons = auto
    ? [`overwatch-auto:${actionClass}`]
    : ['overwatch-structural-action', 'escalate-only'];
  return {
    posture,
    actionClass,
    action,
    escalateOnly: !auto,
    reasons,
  };
}
