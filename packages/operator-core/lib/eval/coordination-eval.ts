/**
 * The coordination eval — the FIRST deterministic eval on the substrate
 * (test-gym-apiary-framework-2026-06-09 P-006).
 *
 * Proves the whole eval framework (variant knob → compare/select → ranked
 * verdict) on the cheapest possible subject, with ZERO LLM involvement (D-002:
 * an LLM must never judge a number you can count):
 *
 *   - the SCENARIO is a deterministic, tick-based multi-agent simulation of
 *     the shared-tree editing workflow — N agents work through file-edit
 *     schedules, every edit acquires a REAL multi-granularity lock set
 *     (@papercusp/locks-core's Gray IS/IX/S/SIX/X matrix — the same engine the
 *     production granular-lock store layers on);
 *   - the VARIANT is the coordination policy under evaluation: lock
 *     granularity (leaf file vs whole directory) × blocked-behavior (hammer
 *     retry vs queue-and-wait) × message-size knobs;
 *   - the METRICS are counted, not judged: lock-block rate, coordination
 *     traffic (chars — the token-cost proxy), ticks-to-complete;
 *   - the VERDICT comes from the shared compare/select core (`compareArms`,
 *     via @papercusp/eval-battery) — baseline vs candidates, diffed, ranked,
 *     selected only on strict primary-metric improvement.
 *
 * Everything is pure and deterministic: same scenario + same policy → the
 * identical metrics, so the eval is replayable and CI-stable.
 */

import { findConflicts, lockSetFor, type HeldNodeLock } from '@papercusp/locks-core';
import {
  BASELINE_ID,
  compareArms,
  type CompareArm,
  type CompareSelectResult,
} from '@papercusp/eval-battery';

// =============================================================================
// Scenario + variant
// =============================================================================

/** One agent's deterministic work schedule: repo-relative file paths, in order. */
export interface AgentSchedule {
  agentId: string;
  edits: string[];
}

export interface CoordScenario {
  agents: AgentSchedule[];
  /** Hard tick cap — an unfinished run records ticksToComplete = maxTicks, completed = false. */
  maxTicks: number;
}

/**
 * The coordination-policy variant under evaluation (the eval's variant knob —
 * a config delta in ScenarioVariant terms).
 */
export interface CoordPolicyVariant {
  /** Stamped on the arm ('baseline' is reserved for the baseline policy's arm). */
  id: string;
  /** What an edit locks: its leaf file (IX ancestors) or its whole parent directory. */
  granularity: 'file' | 'directory';
  /** Blocked behavior: re-attempt every tick (hammer) or wait silently until free. */
  onBlock: 'retry' | 'queue';
  /** Chars of coord traffic per declared edit intent (declare-intent cost). */
  intentChars: number;
  /** Chars of coord traffic per queue-wait registration (queue policy only). */
  queueChars: number;
}

/** Deterministic counted signals of one scenario run under one policy. */
export interface CoordRunMetrics {
  /** Real acquisition attempts (a queued agent waits without attempting). */
  attempts: number;
  /** Attempts refused by the lock matrix. */
  blocked: number;
  /** blocked / attempts (0 when no attempts). */
  lockBlockRate: number;
  /** Total coordination traffic in chars — the coord-token-cost proxy. */
  coordChars: number;
  /** First tick by which every agent finished (maxTicks when capped). */
  ticksToComplete: number;
  completed: boolean;
}

/** The parent directory of a repo-relative path ('' = tree root). */
function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// =============================================================================
// The deterministic scenario runner
// =============================================================================

interface AgentState {
  schedule: AgentSchedule;
  editIdx: number;
  /** Locks held for the edit performed this tick (released on the agent's next turn). */
  holding: HeldNodeLock[] | null;
  /** queue policy: blocked and waiting silently (no attempts, no extra messages). */
  queued: boolean;
  /** Whether this edit's declare-intent message was already emitted. */
  intentSent: boolean;
}

/**
 * Run one scenario under one policy. Tick-based and strictly deterministic:
 * agents act in schedule order each tick; an edit holds its locks until the
 * agent's next turn (1 tick of work), then releases and moves on.
 */
export function runCoordinationScenario(scenario: CoordScenario, policy: CoordPolicyVariant): CoordRunMetrics {
  const states: AgentState[] = scenario.agents.map((schedule) => ({
    schedule,
    editIdx: 0,
    holding: null,
    queued: false,
    intentSent: false,
  }));
  const held: HeldNodeLock[] = [];

  let attempts = 0;
  let blocked = 0;
  let coordChars = 0;
  let ticksToComplete = scenario.maxTicks;
  let completed = false;

  const release = (owner: string) => {
    for (let i = held.length - 1; i >= 0; i--) {
      if (held[i]!.owner === owner) held.splice(i, 1);
    }
  };

  for (let tick = 1; tick <= scenario.maxTicks; tick++) {
    for (const s of states) {
      const { agentId } = s.schedule;
      if (s.holding) {
        // Last tick's edit is done — release and advance.
        release(agentId);
        s.holding = null;
        s.editIdx += 1;
        s.intentSent = false;
      }
      if (s.editIdx >= s.schedule.edits.length) continue;

      const edit = s.schedule.edits[s.editIdx]!;
      const target = policy.granularity === 'file' ? edit : parentDir(edit);
      const requested = lockSetFor(target, 'X');

      const conflicts = findConflicts(held, requested, agentId);
      if (s.queued) {
        // Waiting silently: no attempt is counted until the path is free.
        if (conflicts.length > 0) continue;
        s.queued = false;
      }

      if (!s.intentSent) {
        coordChars += policy.intentChars;
        s.intentSent = true;
      }

      attempts += 1;
      if (conflicts.length > 0) {
        blocked += 1;
        if (policy.onBlock === 'queue') {
          coordChars += policy.queueChars;
          s.queued = true;
        }
        continue;
      }

      const granted = requested.map((l) => ({ ...l, owner: agentId }));
      held.push(...granted);
      s.holding = granted;
    }

    if (states.every((s) => s.editIdx >= s.schedule.edits.length && !s.holding)) {
      ticksToComplete = tick;
      completed = true;
      break;
    }
  }

  return {
    attempts,
    blocked,
    lockBlockRate: attempts === 0 ? 0 : blocked / attempts,
    coordChars,
    ticksToComplete,
    completed,
  };
}

// =============================================================================
// Workload + the eval
// =============================================================================

/**
 * A deterministic contended workload: every agent's files are UNIQUE (leaf
 * locks never collide) but agents rotate through SHARED directories in phase
 * (directory locks collide heavily) — so the granularity knob has a real,
 * counted effect that the lock matrix (IX-vs-IX compatible, X-vs-IX not)
 * decides, not the test author.
 */
export function contendedWorkload(opts: { agents: number; editsPerAgent: number; dirs: number }): AgentSchedule[] {
  const schedules: AgentSchedule[] = [];
  for (let a = 0; a < opts.agents; a++) {
    const edits: string[] = [];
    for (let e = 0; e < opts.editsPerAgent; e++) {
      const dir = `dir-${(a + e) % opts.dirs}`;
      edits.push(`${dir}/agent${a}-edit${e}.ts`);
    }
    schedules.push({ agentId: `agent-${a}`, edits });
  }
  return schedules;
}

/** Metric ids (Scorer-id vocabulary) of the coordination eval. */
export const COORD_METRICS = [
  { id: 'lock-block-rate', direction: 'lower-better' } as const,
  { id: 'coord-chars', direction: 'lower-better' } as const,
  { id: 'ticks-to-complete', direction: 'lower-better' } as const,
];

function armOf(variantId: string, m: CoordRunMetrics): CompareArm {
  return {
    variantId,
    metrics: {
      'lock-block-rate': m.lockBlockRate,
      'coord-chars': m.coordChars,
      'ticks-to-complete': m.ticksToComplete,
    },
  };
}

export interface CoordinationEvalOpts {
  scenario: CoordScenario;
  /** The incumbent policy — runs as the baseline arm. */
  baseline: CoordPolicyVariant;
  candidates: CoordPolicyVariant[];
  /** Required lock-block-rate improvement to select a candidate (default 0). */
  minDelta?: number;
}

/**
 * Run the coordination eval comparatively: baseline + every candidate policy
 * over the SAME scenario, scored deterministically, ranked + selected by the
 * shared compare/select core. Primary metric: lock-block rate.
 */
export function runCoordinationEval(opts: CoordinationEvalOpts): CompareSelectResult {
  const baseline = armOf(BASELINE_ID, runCoordinationScenario(opts.scenario, opts.baseline));
  const candidates = opts.candidates.map((policy) =>
    armOf(policy.id, runCoordinationScenario(opts.scenario, policy)),
  );
  const compared = compareArms({
    baseline,
    candidates,
    scorers: COORD_METRICS,
    primary: 'lock-block-rate',
    ...(opts.minDelta !== undefined && { minDelta: opts.minDelta }),
  });
  return { scenarioId: 'coordination-eval', ...compared };
}
