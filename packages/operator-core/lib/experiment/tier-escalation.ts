/**
 * Fidelity-tier escalation discipline (`experiment-registry-invocation-api-2026-06-14`
 * P-040/P-041, consuming `test-gym-apiary-framework` D-005/D-007). The PURE gate that
 * decides whether a requested tier is allowed — the cost-discipline complement to the
 * knob-space safety gate (P-021): the knob gate stops you varying the wrong thing, this
 * gate stops you spending before a cheap screen justifies it.
 *
 * The rules (D-004 — the single rate-limited account is the binding constraint, EI-315
 * lineage):
 *   - **offline** (replay, ~$0, deterministic) is the DEFAULT front door — always
 *     allowed, never gated. Screen every knob change here first.
 *   - **shadow / live** (real spend) escalate ONLY on a positive offline signal
 *     (`offlineSignalRunId` — a prior offline run that showed a measurable effect) OR a
 *     written "couldn't-isolate" trigger (`couldntIsolate` — why the cheap tier can't
 *     answer the question). Neither ⇒ refuse, with NO spend.
 *   - the **whole-instance** and **whole-Hive** tiers are the GATED COST-EXCEPTION
 *     (D-002): even with a signal/trigger they additionally require an explicit
 *     `costException` acknowledgment — they are reachable through the API but NEVER the
 *     default, and never a standing breeding loop.
 *
 * This is intentionally pure + dependency-free so it is unit-tested with no PG/LLM and
 * pinned by the recursion-safety invariants (P-060).
 */
import type { FidelityTier, TestKind } from '@papercusp/eval-battery';

/** The kinds whose tier is the gated cost-exception (D-002) — never the default,
 *  and they require an explicit cost-exception acknowledgment to run. */
export const COST_EXCEPTION_KINDS: readonly TestKind[] = ['whole-instance', 'whole-hive'] as const;

export function isCostExceptionKind(kind: TestKind): boolean {
  return COST_EXCEPTION_KINDS.includes(kind);
}

/**
 * The caller's escalation justification for leaving the offline tier. At least one of
 * `offlineSignalRunId` / `couldntIsolate` is required to escalate; `costException` is
 * additionally required for the whole-instance / whole-Hive kinds.
 */
export interface TierEscalation {
  /** A prior OFFLINE experiment run (the `experiment_runs` ledger runId/batteryId) whose
   *  result is the positive signal that justifies spending. The "escalate on signal" half. */
  offlineSignalRunId?: string;
  /** A written reason the cheap offline tier cannot isolate the variable — the
   *  "couldn't-isolate" trigger (D-005/D-007). Must be a non-trivial sentence. */
  couldntIsolate?: string;
  /** Explicit acknowledgment of the whole-instance / whole-Hive cost exception (D-002).
   *  Required (in ADDITION to a signal/trigger) for those two kinds. */
  costException?: boolean;
}

export interface TierEscalationVerdict {
  ok: boolean;
  /** Why the escalation was refused (set only when `ok` is false). */
  reason?: string;
}

/** A `couldntIsolate` trigger must be a real written justification, not a rubber-stamp. */
const MIN_TRIGGER_CHARS = 12;

/**
 * Decide whether a run at `requestedTier` for a test of `kind` is allowed given the
 * caller's `escalation` justification. PURE — no spend, no IO. (P-041)
 */
export function evaluateTierEscalation(input: {
  requestedTier: FidelityTier;
  kind: TestKind;
  escalation?: TierEscalation;
}): TierEscalationVerdict {
  const { requestedTier, kind, escalation } = input;

  // offline is the default front door — always allowed (P-040/D-004).
  if (requestedTier === 'offline') return { ok: true };

  // Escalating off offline requires a positive offline signal OR a written
  // couldn't-isolate trigger (the "escalate only on signal" rule, D-004/D-005).
  const hasSignal = typeof escalation?.offlineSignalRunId === 'string' && escalation.offlineSignalRunId.trim().length > 0;
  const trigger = escalation?.couldntIsolate?.trim() ?? '';
  const hasTrigger = trigger.length >= MIN_TRIGGER_CHARS;
  if (!hasSignal && !hasTrigger) {
    return {
      ok: false,
      reason:
        `escalating to the ${requestedTier} tier requires a positive offline signal ` +
        `(escalation.offlineSignalRunId — a prior offline run that showed a measurable effect) ` +
        `OR a written couldn't-isolate trigger (escalation.couldntIsolate, ≥${MIN_TRIGGER_CHARS} chars) — ` +
        `screen the knob change on the ~$0 offline replay tier first (P-040/D-004).`,
    };
  }

  // The whole-instance / whole-Hive tiers are the gated cost-exception (D-002): even
  // with a signal/trigger, they require an explicit cost-exception acknowledgment and
  // are never the default.
  if (isCostExceptionKind(kind) && escalation?.costException !== true) {
    return {
      ok: false,
      reason:
        `the ${kind} tier is the gated cost-exception (D-002) — reachable through the API but never the ` +
        `default. Pass escalation.costException:true to acknowledge the whole-instance/whole-Hive spend ` +
        `(a component or offline eval is preferred whenever it can isolate the variable).`,
    };
  }

  return { ok: true };
}
