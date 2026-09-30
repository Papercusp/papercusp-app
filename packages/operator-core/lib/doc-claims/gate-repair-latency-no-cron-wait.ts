/**
 * CLAUDE.md's freeze-and-converge box tells a fixer to land a repair with
 * `release:repair-queue { op:'admit' }` and promises that "the queue re-tests that head
 * itself" — i.e. an admission is verified WITHOUT waiting for the next hourly cron tick.
 *
 * That promise is a claim about CODE (P-007 / R-7 of green-gate-zero-wait-convergence-
 * 2026-09-08), and it holds only while three properties of `green-checkpoint.ts` do:
 *
 *   1. the run CONSUMES the durable retest marker an admission writes
 *      (`deps.consumeFrozenRepairRetestRequest(...)`) — a run that never reads the marker
 *      cannot notice that the head it just judged is already stale;
 *   2. a `refire` disposition (the marker names a NEWER repair head than the one judged)
 *      is handled IN-PROCESS by re-entering `runGreenCheckpoint(` on that head, so the
 *      admission is verified inside the same run rather than parked for the next cron fire;
 *   3. that in-process recursion is BOUNDED by `MAX_ADMISSION_REFIRE_ATTEMPTS` — the
 *      no-cron-wait promise must not become an unbounded self-refire loop.
 *
 * If someone legitimately makes the retest a cron-only concern, (1)-(3) fail here and the
 * doc sentence must be changed in the same edit. The guard fails on DRIFT, not on today's
 * answer.
 *
 * ⚠ STATED BOUND: textual over comment-stripped lines, not a TS parse — the same bound the
 * siblings `gate-candidate-ref` / `gate-promotion-push-precedes-advance` state, and
 * sufficient for the same reason: the properties are about the presence of a call, a
 * branch, and a bounded recursion, not about types.
 *
 * ⚠ CONTINUATION-AWARENESS: the live call is formatted `await deps.consume…(` on one line
 * today, but the sibling guard already met the split-receiver form (`deps\n  .advance(`).
 * The consume detector therefore matches `.consumeFrozenRepairRetestRequest(` on ANY line,
 * independent of its receiver, and the fixture controls include the split form.
 */
import { stripComments } from './gate-candidate-ref';

/** The exact CLAUDE.md sentence this module keeps honest. */
export const NO_CRON_WAIT_DOC_PHRASE = 'the queue re-tests that head itself';

/** Below this the source is a stub, not the gate — refuse rather than pass vacuously. */
const MIN_SOURCE_CHARS = 200;

/** How far below the `refire` branch the in-process re-entry must appear. */
const REFIRE_WINDOW_LINES = 60;

export type NoCronWaitProperty =
  | 'source-too-short'
  | 'consume-call'
  | 'refire-branch'
  | 'in-process-refire'
  | 'bounded-refire';

export interface NoCronWaitVerdict {
  ok: boolean;
  missing: NoCronWaitProperty[];
  /** 1-based line of each property that WAS found, for a failing run's diagnostics. */
  found: Partial<Record<Exclude<NoCronWaitProperty, 'source-too-short'>, number>>;
}

const CONSUME_CALL = /\.consumeFrozenRepairRetestRequest\s*\(/;
const REFIRE_BRANCH = /kind\s*===\s*["']refire["']/;
const IN_PROCESS_REFIRE = /\brunGreenCheckpoint\s*\(/;
const BOUNDED_REFIRE = /<\s*MAX_ADMISSION_REFIRE_ATTEMPTS\b/;

/** Judge whether `green-checkpoint.ts` (or a fixture) still verifies an admission in-process. */
export function judgeNoCronWaitRepairPath(source: string): NoCronWaitVerdict {
  if (source.length < MIN_SOURCE_CHARS) {
    return { ok: false, missing: ['source-too-short'], found: {} };
  }
  const lines = stripComments(source);
  const found: NoCronWaitVerdict['found'] = {};
  const missing: NoCronWaitProperty[] = [];

  const consumeAt = lines.findIndex((line) => CONSUME_CALL.test(line));
  if (consumeAt >= 0) found['consume-call'] = consumeAt + 1;
  else missing.push('consume-call');

  const refireAt = lines.findIndex((line) => REFIRE_BRANCH.test(line));
  if (refireAt >= 0) {
    found['refire-branch'] = refireAt + 1;
    const window = lines.slice(refireAt, refireAt + REFIRE_WINDOW_LINES);
    const reentryOffset = window.findIndex((line) => IN_PROCESS_REFIRE.test(line));
    if (reentryOffset >= 0) found['in-process-refire'] = refireAt + reentryOffset + 1;
    else missing.push('in-process-refire');
    const boundOffset = window.findIndex((line) => BOUNDED_REFIRE.test(line));
    if (boundOffset >= 0) found['bounded-refire'] = refireAt + boundOffset + 1;
    else missing.push('bounded-refire');
  } else {
    missing.push('refire-branch', 'in-process-refire', 'bounded-refire');
  }

  return { ok: missing.length === 0, missing, found };
}

/** The doc half: the sentence must still be there, or the code pin is guarding a claim nobody makes. */
export function docStillMakesNoCronWaitClaim(claudeMd: string): boolean {
  return claudeMd.includes(NO_CRON_WAIT_DOC_PHRASE);
}
