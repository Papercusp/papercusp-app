/**
 * `testing:run { changedPaths }` — the CHEAP half of `npm run test:affected`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Root CLAUDE.md mandates one comma-delimited value after `--changed-paths`, for
 * example `npm run test:affected -- --changed-paths=path/to/first.ts,path/to/second.ts`.
 * That entrypoint is pc-heavy-wrapped, so under fleet load it queues on the
 * shared test-process admission mutex. Measured 2026-09-02 (EI-22171363189119304):
 * it waited 1022s behind other agents' 29- and 32-task runs and was then SIGTERMed
 * (`PC_HEAVY_RESULT status=undetermined reason=signal exit=143`) having measured ZERO
 * files. CLAUDE.md's routing table already names that hazard for `npm run test:file`
 * and routes around it to `testing:run` — but `testing:run` takes an explicit `files`
 * list, and nothing exposed the DERIVATION that produces such a list. So the one
 * command the repo mandates after every edit was the one with no bypass, and each
 * agent hand-reconstructed the radius by grepping for `*.test.ts` files mentioning the
 * symbols it changed — which silently omits any file the grep missed.
 *
 * ── Why this PLANS and does not RUN ─────────────────────────────────────────
 * Two things are true at once, and conflating them is the trap:
 *
 *   1. The DERIVATION is cheap and needs no admission ticket. Measured: 0.415s real
 *      for a 2-path set, run comfortably while the real sweep was starving.
 *   2. The RUN is genuinely heavy and the ticket is CORRECT. That same 2-path set
 *      derives `workspaces=6 guards=19 tasks=27`, including two full operator-core
 *      lanes. The radius is WORKSPACE-level, not file-level.
 *
 * So this module takes (1) and deliberately declines (2). It does not execute, and it
 * cannot feed `testing:run { files }` automatically either: `--print-affected` emits
 * workspaces, task COMMANDS and guards — never a test-FILE list — so there is no file
 * set to hand over. Running whole affected workspaces through the `files` path to dodge
 * the mutex would be routing around a rail that exists for exactly that weight.
 *
 * `run.ts`'s own header already scoped `test:affected` out, for a reason that governs
 * EXECUTION only: "affected-tests.mjs runs each workspace's own npm test and has no
 * vitest-arg passthrough, so a JSON reporter cannot be plumbed through it without real
 * work." Enumeration was never blocked by that, and is what this adds.
 *
 * The value is therefore an exact answer in ~0.4s to "what will verifying this edit
 * actually run", so the agent can choose deliberately: run a bounded subset through
 * `files`, run one named task command, or wait for the sweep knowing its cost.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  parseAffectedProbe,
  type AffectedDerivation,
  type AffectedTaskCommand,
} from '../../release/sync-batch-delta-check';

/** The derivation is a sub-second enumeration; anything near this bound means the probe
 *  itself is wedged, which is a finding, not something to wait out. */
export const AFFECTED_PLAN_TIMEOUT_MS = 30_000;

/** Bound on returned rows. The counts in `derivation` stay COMPLETE regardless, so a
 *  truncated list can never be read as a smaller radius. */
export const AFFECTED_PLAN_MAX_ROWS = 60;

export interface AffectedPlanResult {
  ok: true;
  /** Always `'plan'`. Present so a reader can never mistake this for an executed run:
   *  there are no passed/failed counts here because nothing ran. */
  mode: 'plan';
  changedPaths: string[];
  derivation: AffectedDerivation | null;
  workspaces: string[];
  taskCommands: AffectedTaskCommand[];
  guards: string[];
  counts: { workspaces: number; tasks: number; guards: number };
  truncated: { taskCommands: number; guards: number };
  note: string;
}

export interface AffectedPlanFailure {
  ok: false;
  error: 'probe_failed';
  detail: string;
  exitCode: number | null;
  stderrTail: string;
}

function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/** The narrow slice of `execFile` this module uses. Declared explicitly rather than
 *  reusing `typeof execFile` so a test can inject a plain function and ASSERT THE ARGV
 *  — which is the point: the comma-joining below is load-bearing, and a mock that
 *  cannot see argv could not catch it regressing. */
export type AffectedPlanExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number; signal?: AbortSignal },
  callback: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
) => void;

const defaultExec: AffectedPlanExec = (file, args, options, callback) => {
  execFile(file, [...args], options, (err, stdout, stderr) => {
    callback(err as (Error & { code?: number }) | null, String(stdout ?? ''), String(stderr ?? ''));
  });
};

/**
 * Shell `affected-tests.mjs --print-affected` and return the parsed plan.
 *
 * The paths are joined with commas ON PURPOSE and passed as ONE argument: the script
 * accepts flags only and rejects positional paths outright (EI-22026635212798684), so
 * `--changed-paths a b c` aborts rather than narrowing.
 */
export async function deriveAffectedPlan(input: {
  changedPaths: readonly string[];
  root: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  execFileImpl?: AffectedPlanExec;
}): Promise<AffectedPlanResult | AffectedPlanFailure> {
  const changedPaths = [...input.changedPaths];
  const exec = input.execFileImpl ?? defaultExec;
  const args = [
    join(input.root, 'scripts', 'affected-tests.mjs'),
    '--changed-paths',
    changedPaths.join(','),
    '--print-affected',
  ];

  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; failure: string | null }>(
    (resolve) => {
      exec(
        process.execPath,
        args,
        {
          cwd: input.root,
          timeout: input.timeoutMs ?? AFFECTED_PLAN_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            failure: err ? err.message : null,
          });
        },
      );
    },
  );

  if (outcome.failure !== null) {
    return {
      ok: false,
      error: 'probe_failed',
      detail:
        `the --print-affected derivation did not complete (${outcome.failure}). This is an ENUMERATION ` +
        `query that normally returns in well under a second, so a failure here is a probe fault, not a ` +
        `busy tree — it is NOT evidence that the affected set is empty.`,
      exitCode: outcome.code,
      stderrTail: tail(outcome.stderr),
    };
  }

  const probe = parseAffectedProbe(outcome.stdout);
  const taskCommands = probe.taskCommands.slice(0, AFFECTED_PLAN_MAX_ROWS);
  const guards = probe.guards.slice(0, AFFECTED_PLAN_MAX_ROWS);

  return {
    ok: true,
    mode: 'plan',
    changedPaths,
    derivation: probe.derivation,
    workspaces: probe.workspaces,
    taskCommands,
    guards,
    counts: {
      workspaces: probe.workspaces.length,
      tasks: probe.taskCommands.length,
      guards: probe.guards.length,
    },
    truncated: {
      taskCommands: probe.taskCommands.length - taskCommands.length,
      guards: probe.guards.length - guards.length,
    },
    note: planNote(probe.workspaces.length, probe.taskCommands.length),
  };
}

/**
 * The one sentence a reader must not get wrong: NOTHING RAN. A plan-shaped result sitting
 * where an agent expected a verdict is exactly the "zero files measured, exit 0" false-green
 * this repo keeps paying for, so the disclaimer leads and is unconditional.
 */
export function planNote(workspaces: number, tasks: number): string {
  if (workspaces === 0 && tasks === 0) {
    return (
      'NOTHING RAN — this is a plan, not a verdict. The derivation selected ZERO workspaces, which is a ' +
      'real and common answer (a docs- or plan-only edit legitimately selects nothing to run), NOT a ' +
      'failed probe. There is no affected suite to wait for.'
    );
  }
  return (
    `NOTHING RAN — this is a plan, not a verdict. Verifying this edit means ${tasks} task(s) across ` +
    `${workspaces} workspace(s); note tasks EXCEED workspaces because one workspace contributes several ` +
    `(operator-core alone splits into test:lane-pure + test:lane-stateful plus its lint guards), so the ` +
    `workspace count understates the real cost. Choose deliberately: run the specific test files through ` +
    `testing:run { files } (no admission ticket), run one exact taskCommands[].command verbatim, or run ` +
    `npm run test:affected -- --changed-paths=path/to/first.ts,path/to/second.ts and accept the queue. ` +
    '`--changed-paths` must be one comma-delimited argument. Copy a command VERBATIM — ' +
    `never rebuild one from a workspace name, because a standalone submodule needs npm --prefix and the ` +
    `--workspace form exits 1 having measured ZERO tests.`
  );
}
