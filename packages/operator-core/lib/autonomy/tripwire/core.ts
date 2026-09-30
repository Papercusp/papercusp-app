/**
 * tripwire/core.ts — the PURE core of the auto-revert tripwire
 * (queen-autonomy-policy-2026-06-13 B-16 / P-080, P-081; D-006).
 *
 * The tripwire is what makes aggressive auto-decide on REVERSIBLE actions safe:
 * the track record (graduation) gates *whether* the Queen may auto-decide; the
 * reversibility axis + this tripwire bound *the damage if wrong*. On each AUTO
 * decision of a reversible action the Queen records a revert-handle and arms a
 * short WATCH; if an outcome signal (EKG drift · validator bounce · gym
 * regression · owner thumbs-down) lands inside the window, the tripwire TRIPS →
 * auto-revert + demote the category one step (D-006 / D-005).
 *
 * This module owns three pure decisions, no IO:
 *   1. {@link armTripwire}        — may this decision be watched, and with what window?
 *   2. {@link evaluateTripwire}   — given the watch signals, did an armed row trip / clear?
 *   3. {@link demoteGraduatedLevel} — the one-step demotion applied on a trip.
 *
 * The PG glue (store.ts) and the sweep orchestration (scan.ts) build on these;
 * the graduation engine (graduation.ts) reads the same rows as evidence.
 *
 * Pure logic — no DB, no IO, no Date.now() — exhaustively unit-testable.
 */

import { AUTONOMY_CEILINGS, type AutonomyCeiling, type RiskTier } from '@papercusp/plan-parser';
import { type AutonomyCategory, isProtectedCategory } from '../categories';
import type { AutonomyDecision } from '../decider';

/** The watch signals that can trip a tripwire inside its window (D-006). */
export type TripwireSignalKind =
  | 'ekg-drift' // a major fleet-EKG behavioral shift
  | 'validator-bounce' // a validator rejected work the auto-decision touched
  | 'gym-regression' // a gym champion regressed
  | 'owner-thumbs-down'; // the owner explicitly reverted this auto-decision (P-031)

export const TRIPWIRE_SIGNAL_KINDS: readonly TripwireSignalKind[] = [
  'ekg-drift',
  'validator-bounce',
  'gym-regression',
  'owner-thumbs-down',
];

/** A tripwire's lifecycle status (mirrors the `status` column). */
export type TripwireStatus = 'armed' | 'cleared' | 'tripped' | 'reverted';

/**
 * How to UNDO an auto-decided action. Opaque to the tripwire core — the revert
 * executor interprets `kind` (e.g. 'config-edit' → a git sha to revert;
 * 'flag-flip' → the prior value; 'placement' → a placement id to unplace). The
 * shape is open so new reversible action families don't need a core change.
 */
export interface RevertHandle {
  kind: string;
  [field: string]: unknown;
}

/**
 * One outcome signal observed on the rails. A signal trips an armed tripwire when
 * it (a) matches the row's scope and (b) landed inside the watch window. Scope:
 *   - `global: true`     — a fleet-wide event (gym/EKG regression) implicating
 *                          EVERY auto-decision whose window contains it.
 *   - `category` match   — a category-scoped signal (e.g. a validator bounce on
 *                          that category's work).
 *   - `findingClass` match — the finest, a single (category, class) signal.
 *   - `tripwireId` match — a signal aimed at one specific row (owner thumbs-down).
 */
export interface TripwireWatchSignal {
  kind: TripwireSignalKind;
  atMs: number;
  label: string;
  global?: boolean;
  category?: AutonomyCategory;
  findingClass?: string;
  tripwireId?: string;
}

/** The minimal shape {@link evaluateTripwire} reads off an armed row. */
export interface ArmedTripwire {
  id: string;
  category: AutonomyCategory;
  findingClass: string;
  armedAtMs: number;
  windowUntilMs: number;
  status: TripwireStatus;
}

/** The arming a successful {@link armTripwire} produces — the row to persist. */
export interface TripwireArming {
  category: AutonomyCategory;
  /** The (category, class) sub-key graduation counts on — the action slug, or 'unclassified'. */
  findingClass: string;
  action?: string;
  riskTier: RiskTier;
  revertHandle: RevertHandle;
  /** The AutonomyDecision snapshot, persisted for the ledger / "why" surface. */
  decision: AutonomyDecision;
  /**
   * The shared id linking this tripwire to its decision-ledger disposition row
   * (B-13) so the recent-auto-decisions feed can join + surface the undo. Minted
   * by the Queen execution layer per auto-decision; omitted when uncorrelated.
   */
  decisionId?: string;
  armedAtMs: number;
  windowUntilMs: number;
}

export type ArmTripwireResult = { armed: TripwireArming } | { refused: string };

export interface ArmTripwireInput {
  decision: AutonomyDecision;
  /** How to undo the action if it trips — required (no revert-handle ⇒ no watch). */
  revertHandle: RevertHandle;
  /** The (category, class) sub-key. Default: the decision's action slug, else 'unclassified'. */
  findingClass?: string;
  /** The decision-ledger link id (B-13), if the caller correlated it. */
  decisionId?: string;
  /** Watch-window length in hours (D-006 "a short watch"). */
  windowHours: number;
  nowMs: number;
}

/** Default watch window — long enough for the decay/validator/gym rails to speak. */
export const DEFAULT_TRIPWIRE_WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;

/**
 * Resolve the (category, class) sub-key for a decision. The action verb is the
 * class; absent one, 'unclassified'. Kept narrower than the category so one
 * narrow action's clean record never graduates the whole category off alone.
 */
export function findingClassForDecision(decision: AutonomyDecision, override?: string): string {
  if (override && override.trim()) return override.trim();
  if (decision.action && decision.action.trim()) return decision.action.trim();
  return 'unclassified';
}

/**
 * Decide whether an auto-decision earns a tripwire WATCH, and with what window.
 * A row is armed ONLY when every safety precondition holds — this is the second
 * line after the gate (the gate already enforced them to reach posture 'auto',
 * but the tripwire re-checks so a bad caller can never arm a watch on an
 * un-revertable or un-auto action):
 *   - posture must be 'auto' (a gated decision was never taken — nothing to watch);
 *   - reversibility must be 'reversible' (irreversible never auto, B-02 — and you
 *     cannot arm a revert on something you cannot revert);
 *   - the category must resolve and NOT be protected (a protected category can
 *     never auto, D-005 — belt-and-braces).
 * Refusals return a reason (for the caller's log), not a throw.
 */
export function armTripwire(input: ArmTripwireInput): ArmTripwireResult {
  const { decision } = input;
  if (decision.posture !== 'auto') {
    return { refused: `decision posture is '${decision.posture}', not 'auto' — nothing was auto-taken to watch` };
  }
  if (decision.reversibility !== 'reversible') {
    return { refused: `action is '${decision.reversibility}' — irreversible actions never auto, cannot arm a revert` };
  }
  if (decision.category == null) {
    return { refused: 'decision has no resolved category (unmapped → never-auto) — cannot arm' };
  }
  if (isProtectedCategory(decision.category)) {
    return { refused: `category '${decision.category}' is protected (never-auto) — must not have auto-decided` };
  }
  const windowHours = input.windowHours > 0 ? input.windowHours : DEFAULT_TRIPWIRE_WINDOW_HOURS;
  return {
    armed: {
      category: decision.category,
      findingClass: findingClassForDecision(decision, input.findingClass),
      ...(decision.action !== undefined ? { action: decision.action } : {}),
      riskTier: decision.riskTier,
      revertHandle: input.revertHandle,
      decision,
      ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
      armedAtMs: input.nowMs,
      windowUntilMs: input.nowMs + windowHours * HOUR_MS,
    },
  };
}

/** Does a signal match an armed row's scope? (independent of timing) */
export function signalMatchesRow(signal: TripwireWatchSignal, row: ArmedTripwire): boolean {
  if (signal.tripwireId !== undefined) return signal.tripwireId === row.id;
  if (signal.global) return true;
  if (signal.findingClass !== undefined) return signal.findingClass === row.findingClass;
  if (signal.category !== undefined) return signal.category === row.category;
  return false;
}

export type TripwireVerdict =
  | { outcome: 'tripped'; reason: TripwireSignalKind; signal: TripwireWatchSignal }
  | { outcome: 'cleared' } // window closed with no matching signal — one clean pass
  | { outcome: 'still-armed' }; // window open, no signal yet — neither counts nor resets

/**
 * Evaluate one armed tripwire against the observed signals at `nowMs`:
 *   - the FIRST matching signal inside [armedAt, min(windowUntil, nowMs)] trips it
 *     (earliest wins — the soonest evidence of harm);
 *   - else if the window has closed (nowMs ≥ windowUntil) it CLEARS (a clean pass);
 *   - else it stays armed (the window is still open).
 * A non-armed row is a no-op ('still-armed' sentinel — the caller skips it).
 */
export function evaluateTripwire(
  row: ArmedTripwire,
  signals: readonly TripwireWatchSignal[],
  nowMs: number,
): TripwireVerdict {
  if (row.status !== 'armed') return { outcome: 'still-armed' };
  const windowEnd = Math.min(row.windowUntilMs, nowMs);
  const hits = signals
    .filter((s) => s.atMs >= row.armedAtMs && s.atMs <= windowEnd && signalMatchesRow(s, row))
    .sort((a, b) => a.atMs - b.atMs);
  const first = hits[0];
  if (first) return { outcome: 'tripped', reason: first.kind, signal: first };
  if (nowMs >= row.windowUntilMs) return { outcome: 'cleared' };
  return { outcome: 'still-armed' };
}

/**
 * The one-step demotion applied on a trip (P-081 / D-005): lower the category's
 * graduated level by one rank on the autonomy scale, flooring at never-auto.
 * Demotion is AUTOMATIC and needs no owner — it only ever shrinks autonomy (the
 * safe direction). The trip row itself also resets the graduation streak (the
 * engine counts it as a dirty pass), so a re-graduation must re-earn the streak.
 */
export function demoteGraduatedLevel(current: AutonomyCeiling): AutonomyCeiling {
  const rank = AUTONOMY_CEILINGS.indexOf(current);
  if (rank <= 0) return 'never-auto';
  return AUTONOMY_CEILINGS[rank - 1]!;
}
