/**
 * Pure policy for routing a HELD frozen-candidate repair to agents.
 *
 * WHY THIS EXISTS (WI-2141736 P-003, measured 2026-09-02)
 * -------------------------------------------------------
 * Freeze-and-converge has exactly two repair paths: an auto-dispatched release-fixer,
 * and agents converging fixes onto `repairHead`. When the fixer's provider is usage-walled
 * the first path is unavailable — on 2026-09-02 for SIX DAYS — and the queue is now HELD
 * rather than retired (`wait-for-dispatch-capacity` with `zeroAttemptStalled`, see
 * frozen-candidate-repair-queue.ts). A held queue with no fixer and no owner converges
 * nowhere: it simply waits out its hold budget and is then retired, which is the same
 * treadmill by a slower route.
 *
 * So the hold has to ROUTE the repair. This module builds the alarm that mints exactly one
 * claimable convergence work-item (via the condition bridge — the same substrate as
 * `gate-red-streak:<pipeline>`), naming the three things a claimant otherwise reconstructs
 * by hand: WHICH sha is frozen, WHAT is failing on it, and the EXACT converge call that
 * admits a fix to it.
 *
 * The alarm names the frozen candidate deliberately, because the default behaviour it
 * corrects is agents fixing the red AT TIP: a fix at tip is not in the frozen candidate,
 * so the gate re-reds on the same file and the fix looks like it did not work.
 *
 * This module performs no git, filesystem, database, or process work.
 */

/**
 * Condition family. One open condition per pipeline; the bridge mints its owning work-item.
 *
 * RE-EXPORTED, not re-declared: the literal lives in `coord/actionable-conditions.ts`, the
 * zero-import leaf that also carries this family's opt-in entry. A prefix spelled in both
 * places can drift out of its own catalog entry, and the failure is silent — the alarm
 * broadcasts, mints nothing, and reads exactly like a gate that never held anything.
 */
import { FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX } from '../coord/actionable-conditions';

export { FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX };

/** The single condition key for one pipeline's held-repair routing. */
export function frozenRepairConvergenceConditionKey(pipeline: string): string {
  return `${FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX}${pipeline}`;
}

export interface FrozenRepairConvergenceRoutingInput {
  /** `pipelineName(cfg.integrationRoot)` — the key segment and summary tag. */
  pipeline: string;
  /** The frozen candidate sha. Fixes must land ON TOP of this, never at tip. */
  candidate: string;
  /** The movable head fixes converge onto. This is what the queue re-tests. */
  repairHead: string;
  /** The queue's current failing set (replaced each red, so this is the live round). */
  failingTests: readonly string[];
  /** The measured provider wall's own reset time, when the probe reported one. */
  capacityRetryAtMs?: number | null;
  /** The capacity probe's own words (e.g. "all codex accounts are usage-walled"). */
  capacitySummary?: string | null;
  /** How long this queue has been held, and the budget it is held against. */
  heldMs: number;
  convergenceHoldMs: number;
  /** Injected so the rendered deadline is deterministic under test. */
  nowMs: number;
}

/** How many failing paths are named inline before the list is summarized. */
const MAX_NAMED_FAILING = 12;

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function renderDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

/**
 * PURE: the severe-event alarm that routes a held frozen repair to agents.
 *
 * Returns the `conditionKey` alongside the message so a caller cannot broadcast the body
 * under a hand-typed key — a near-miss key mints a SECOND work-item for the same red, which
 * is the specific failure this whole item exists to avoid.
 *
 * ⚠ `oneShot` is deliberately NOT part of this contract, and that is the opposite choice
 * from the neighbouring `gate-red-streak:<pipeline>` broadcast — read this before "fixing"
 * it. `one_shot` exists (WI-6228) for emitters that fire ONCE per episode and then stay
 * deliberately silent, whose frozen `last_seen` the condition-staleness sweep would
 * otherwise misread as recovery. This emitter is the other kind: it re-fires on EVERY gate
 * tick for as long as the hold is actually held, so its silence genuinely means the hold
 * ended (the wall lifted, the candidate went green, or the queue was retired) and letting
 * `selectAbsentConditions` close it on absence is CORRECT. Marking it one-shot would leave
 * a convergence work-item open pointing at a candidate that no longer exists.
 */
export function buildFrozenRepairConvergenceBroadcast(
  input: FrozenRepairConvergenceRoutingInput,
): { conditionKey: string; summary: string; body: string } {
  const failing = input.failingTests.filter(
    (t) => typeof t === 'string' && t.trim() !== '',
  );
  const named = failing.slice(0, MAX_NAMED_FAILING);
  const remaining = failing.length - named.length;
  const remainingMs = Math.max(0, input.convergenceHoldMs - input.heldMs);

  const wall = input.capacitySummary?.trim()
    ? input.capacitySummary.trim()
    : 'the release-fixer provider has no dispatchable capacity';
  const lifts =
    typeof input.capacityRetryAtMs === 'number' &&
    Number.isFinite(input.capacityRetryAtMs)
      ? ` The wall lifts at ${new Date(input.capacityRetryAtMs).toISOString()}` +
        `${input.capacityRetryAtMs > input.nowMs ? ` (${renderDuration(input.capacityRetryAtMs - input.nowMs)} away)` : ''}.`
      : ' The probe reported no reset time.';

  const summary =
    `[${input.pipeline}] frozen candidate ${shortSha(input.candidate)} is HELD for AGENT convergence — ` +
    `no fixer can be dispatched, so ${failing.length || 'its'} failing ` +
    `${failing.length === 1 ? 'file' : 'files'} must be fixed by agents on the frozen lineage ` +
    `within ${renderDuration(remainingMs)}.`;

  const body =
    `The green-checkpoint's frozen repair queue is being HELD rather than retired: ${wall}.${lifts} ` +
    `Retiring would only re-cut a queue that meets the same wall, so the freeze is kept and ` +
    `agent/human convergence is now the ONLY repair path for this candidate.\n\n` +
    `FROZEN CANDIDATE: ${input.candidate}\n` +
    `CONVERGE ONTO (repairHead): ${input.repairHead}\n` +
    `HELD FOR: ${renderDuration(input.heldMs)} of ${renderDuration(input.convergenceHoldMs)} ` +
    `— ${renderDuration(remainingMs)} before the hold gives up and the candidate is retired.\n` +
    `ADMIT WITH: release:repair-queue { op: 'admit', paths: [<the paths you changed>] } — author on the ` +
    `shared staging checkout, dry-run first, then confirm:true. An edit that is never admitted is ` +
    `invisible to the gate (D-010: there is no repair worktree).\n` +
    `\nFAILING ON THE FROZEN CANDIDATE (${failing.length}):\n` +
    (named.length
      ? named.map((t) => `  · ${t}`).join('\n') +
        (remaining > 0 ? `\n  · … +${remaining} more` : '') +
        '\n'
      : '  (the queue recorded no failing-file list for this round)\n') +
    `\n⚠ FIX ON THE FROZEN LINEAGE, NOT AT TIP. A fix committed to staging tip is NOT in ` +
    `${shortSha(input.candidate)}, so this gate re-reds on the same file and the fix reads as ` +
    `not having worked. Admit it to the queue instead:\n\n` +
    `    release:repair-queue { op: 'admit', paths: [ <the files you fixed> ] }\n\n` +
    `That replays exactly those paths onto \`repairHead\` and the queue re-tests THAT sha. Confirm containment ` +
    `afterwards with \`dev:pipeline_position { path }\` or ` +
    `\`state:read { cell: 'gate.greenCheckpoint.candidate', as: '<path>' }\` — ancestry is not ` +
    `containment.\n\n` +
    `This condition owns ONE work-item for this held candidate, so claim that item rather than ` +
    `opening another. It closes on its own when the hold ends — the wall lifts, the candidate ` +
    `goes green, or the hold budget expires and the candidate is retired.`;

  return {
    conditionKey: frozenRepairConvergenceConditionKey(input.pipeline),
    summary,
    body,
  };
}
