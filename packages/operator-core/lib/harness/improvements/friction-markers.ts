/**
 * friction-markers.ts — the SINGLE source of truth for the SUBJECTIVE friction
 * feed-in of the self-learning loop (self-learning-central-2026-06-06 Phase 1,
 * P-001 / P-002 / D-006).
 *
 * The OBJECTIVE channel is the shipped watchdog (4 collectors, event-driven,
 * capture-only). This module is its SUBJECTIVE sibling: the friction an agent
 * *feels* in its own loop that no external collector can see (a workaround it
 * just wrote, a doc that misled it, an awkward tool). Two light touches, never a
 * per-turn reflection pass (D-006):
 *
 *   (A) `renderFrictionTripwire()` — a near-zero one-liner injected into the
 *       SHARED prompt base (every operator-launched bee via `assembleRolePrompt`,
 *       and the Queen brain via the su base playbook). On a no-friction turn the
 *       model reads it, sees nothing matching, and moves on — it is a trip-wire,
 *       not a reflection step.
 *
 *   (B) `renderReflectStep()` — a STRUCTURED reflect-and-capture step rendered at
 *       the WORK-ITEM-COMPLETION boundary (lifecycle-invoked off
 *       `work_items:complete`, like `improvements:resolve` is invoked at the end
 *       of a dispatched fix). Fires ONCE per unit of work, when the agent has the
 *       full sub-arc in context — the moment the signal is densest and cheapest.
 *
 * THE MARKER SPLIT (P-002) — kept in two DISTINCT sets so the default
 * (harness-free) loop never references roles that don't exist outside a coding
 * harness:
 *
 *   - UNIVERSAL: visible to EVERY operator-launched bee, harness or not.
 *   - HARNESS-PIPELINE-ONLY: only meaningful once a bee has spun up the coding
 *     harness (so validator/reviewer roles exist). The default loop must not
 *     mention these.
 *
 * The quality bar (P-003) is authored alongside the markers: capture only a
 * GENUINE, REPEATABLE improvement — not a one-off, not a self-inflicted slip.
 * Sparseness is itself the quality filter (D-006).
 *
 * DRY across the two prompt bases: the one-line trip-wire STRING is owned by the
 * orchestrator (`FRICTION_TRIPWIRE` in prompt-build.ts) because it is emitted into
 * the SPAWNED-BEE base there, and operator-core depends on @papercusp/orchestrator
 * (not the reverse) — so the brain-side `renderFrictionTripwire()` here re-exports
 * that constant. The two bases therefore can't desync.
 */
import { FRICTION_TRIPWIRE } from '@papercusp/orchestrator/role-prompt';

/** A single friction marker the trip-wire fires on. */
export interface FrictionMarker {
  /** Short stable id (used in tests + docs). */
  id: string;
  /** One-line description of the signal as the agent would notice it. */
  signal: string;
}

/**
 * UNIVERSAL markers — every operator-launched bee, harness-free. These are
 * signals already visible in any agent's loop; no coding-harness role is named.
 */
export const UNIVERSAL_FRICTION_MARKERS: readonly FrictionMarker[] = [
  {
    id: 'retry-or-repeated-tool-error',
    signal: 'you retried a call, or the same tool errored more than once on the same input',
  },
  {
    id: 'workaround',
    signal: 'you wrote a workaround for an awkward tool / API / doc instead of using it as intended',
  },
  {
    id: 'confusing-failure-after-n-attempts',
    signal:
      'a task that should be trivial fought you past ~3 attempts on the same error class (the "web-search after 3 loops" point — the failure is confusing enough to suspect the tooling, not you)',
  },
  {
    id: 'lock-or-coord-contention',
    signal: 'lock or coord contention slowed you (a blocked edit, a stomped change, a presence/heartbeat surprise)',
  },
] as const;

/**
 * HARNESS-PIPELINE-ONLY markers — apply ONLY when a bee has spun up the coding
 * harness (these roles exist only then). Kept separate so the universal loop
 * never references them.
 */
export const HARNESS_PIPELINE_FRICTION_MARKERS: readonly FrictionMarker[] = [
  {
    id: 'validator-failed',
    signal: 'a validator failed on work you (or a peer) handed it — the validation contract is friction-prone',
  },
  {
    id: 'reviewer-returned-work',
    signal: 'a reviewer returned work — the brief / scoping / convention that produced it is friction-prone',
  },
] as const;

/** The shared quality bar (P-003) — one line, authored once, reused in (A) + (B). */
export const FRICTION_QUALITY_BAR =
  'Bar: capture only a GENUINE, REPEATABLE improvement (a friction the next agent would hit too), not a one-off or a self-inflicted slip.';

/**
 * (A) The one-line trip-wire for the SHARED prompt base. Near-zero cost on a
 * no-friction turn. NOT a reflection step — it just primes the model to file
 * salient friction the moment it hits it, via `improvements:capture`. Markers
 * are summarised inline (not the full split) to keep it to a couple of lines;
 * the full split + the reflect step carry the detail.
 *
 * Returns the SAME `FRICTION_TRIPWIRE` constant the spawned-bee base emits (owned
 * by the orchestrator's prompt-build.ts) so the brain base and the bee base are
 * one string, never two that drift.
 */
export function renderFrictionTripwire(): string {
  return FRICTION_TRIPWIRE;
}

/**
 * (B) The structured reflect-and-capture STEP for the work-item-completion
 * boundary. Rendered into the `work_items:complete` result so the lifecycle
 * (not a standing per-turn clause) prompts the reflection once, with the full
 * sub-arc in context. `harnessActive` gates the pipeline-only markers so a
 * harness-free unit of work never sees validator/reviewer language.
 */
export function renderReflectStep(opts: { harnessActive?: boolean } = {}): string {
  const lines: string[] = [
    'Reflect (once, now that this unit of work is done): did any of these bite you',
    'during it? If so, file it via `improvements:capture { kind, title, paths? }`.',
    '',
    'Universal:',
    ...UNIVERSAL_FRICTION_MARKERS.map((m) => `  - ${m.signal}`),
  ];
  if (opts.harnessActive) {
    lines.push('', 'Pipeline (you ran the coding harness):');
    lines.push(...HARNESS_PIPELINE_FRICTION_MARKERS.map((m) => `  - ${m.signal}`));
  }
  lines.push(
    '',
    FRICTION_QUALITY_BAR,
    'If nothing genuine bit you, capture nothing — sparseness keeps the queue clean.',
  );
  return lines.join('\n');
}
