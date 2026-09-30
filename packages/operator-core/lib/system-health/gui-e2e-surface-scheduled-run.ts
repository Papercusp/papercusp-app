/**
 * Scheduled producer for the GUI E2E Tauri surface-verification suite
 * (gui-e2e-tauri-surface-verification-2026-08-27 P-008).
 *
 * Phases 1-2 of that plan built a set of live, Tauri-driven,
 * regression-failing DOM assertions for every top-level desktop surface
 * (scripts/tauri-surface-verify-p0*.sh) — but every one of them was, until
 * this tick, run "only by hand" by whichever agent happened to be working
 * the plan. One of them (the /dev/gym leg, WI-64726) caught a REAL,
 * always-reproducing bug — `GymDashboard.tsx` never unwrapped the
 * `{ harnesses: [...] }` envelope `GET /api/gym/harnesses` actually returns —
 * that a grep-based coverage census AND the surface's own unit-test mock
 * both missed. That is exactly the class of regression this producer exists
 * to keep catching automatically, on a schedule, instead of only when an
 * agent happens to re-run the script.
 *
 * DELIBERATELY DOES NOT TOUCH THE RELEASE / GREEN-CHECKPOINT GATE. WI-40086
 * owns that gate; P-008's own text is explicit ("never greening the gate
 * from this plan"). This tick therefore never writes anything the gate
 * reads and never fails a build — a failing leg is reported via the shared
 * alarm-attention rail (`escalateAlarm`, the same cooldown-gated delivery
 * path `disk-space-alarm.ts` / `replication-slot-alarm.ts` already use), a
 * human-facing signal that is entirely independent of deploy gating.
 *
 * NEVER TREATS A TEST-FINDING FAILURE AS A TICK FAILURE, mirroring
 * `desktop-perf-scheduled-run.ts`: a nonzero exit from
 * `scripts/tauri-surface-verify-suite.sh` means the suite found a real
 * regression — that is success for this producer, which already escalated
 * it. Only an infra failure (the script could not be spawned, or the whole
 * suite hung past the timeout) is worth surfacing as a problem with THIS
 * tick.
 *
 * The suite itself is one of the heaviest things this file schedules — 8
 * sequential legs, each its own real Xvfb + VirtualGL + full `papercusp-desktop`
 * boot (see scripts/verify-tauri-headless.sh) — so it runs once/day, and the
 * caller applies `shouldShedHeavyTick` the same way `desktop-perf-scheduled-run`
 * does.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { REPO_ROOT } from '../agent-tools/docs/_repo-paths';
import { collectChildOutput } from '../child-output.js';
import { escalateAlarm } from '../alarm-attention';

const SUITE_SCRIPT = 'scripts/tauri-surface-verify-suite.sh';

/**
 * Bounded — 8 sequential legs, each a real isolated-Xvfb Tauri boot (the
 * live P-004 gym leg alone took ~1-3min to boot). 40 minutes gives generous
 * margin without letting a wedged leg hold the slot indefinitely; mirrors
 * `desktop-perf-scheduled-run`'s own SIGKILL-on-timeout shape.
 */
export const RUN_TIMEOUT_MS = 40 * 60 * 1000;

/** Bound the tail kept for logs/escalation body — an excerpt, not a report. */
const LOG_TAIL_CHARS = 4000;

/**
 * Once/day is already the run cadence, so this cooldown only guards against
 * double-notifying when a human ALSO re-runs the suite by hand the same day
 * (mirrors DEFAULT_ALARM_ESCALATION_COOLDOWN_MS's spirit — a distinct,
 * slightly longer value since this producer already self-throttles to
 * once/day).
 */
export const ESCALATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface GuiE2eSurfaceLegResult {
  leg: string;
  ok: boolean;
}

/**
 * Parse the suite script's per-leg PASS/FAIL lines out of its combined
 * stdout+stderr. Pure and exported so the parsing contract (shared with
 * every `tauri-surface-verify-p0*.sh` leg script) is independently
 * unit-testable without spawning anything.
 */
export function parseGuiE2eSurfaceSuiteOutput(output: string): GuiE2eSurfaceLegResult[] {
  const results: GuiE2eSurfaceLegResult[] = [];
  const re = /^P0\d\d_TAURI_SURFACE_VERIFY_(OK|FAIL)\s+leg=(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    results.push({ leg: m[2], ok: m[1] === 'OK' });
  }
  return results;
}

export interface GuiE2eSurfaceScheduledRunResult {
  ran: boolean;
  skippedReason?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /** Per-leg verdicts parsed from the suite's own output; empty if none parsed. */
  legs?: GuiE2eSurfaceLegResult[];
  /** Did this run escalate to a human? Only meaningful when a leg failed. */
  escalated?: boolean;
}

/** IO seam for tests. */
export interface GuiE2eSurfaceScheduledRunIO {
  spawnFn: (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;
  readEnabled: () => Promise<boolean>;
  /** Injectable for tests; production defaults to the shared alarm-attention rail. */
  escalate: (input: { title: string; body: string }) => Promise<boolean>;
}

const defaultIO: GuiE2eSurfaceScheduledRunIO = {
  spawnFn: (command, args, options) => spawn(command, args as string[], options),
  readEnabled: () => getFlag(FLAGS.GUI_E2E_SURFACE_SCHEDULED_RUN, 'system').catch(() => true),
  escalate: (input) =>
    escalateAlarm({
      title: input.title,
      body: input.body,
      cooldownMs: ESCALATION_COOLDOWN_MS,
      source: 'gui-e2e-surface-scheduled-run',
    }),
};

/**
 * Run the GUI E2E Tauri surface-verification suite once. Resolves — never
 * rejects — with a result describing what happened; DBOS retries an
 * infra-level miss (spawn error) via the caller's step wrapper, not this
 * function throwing.
 */
export async function runGuiE2eSurfaceScheduledRun(
  io: GuiE2eSurfaceScheduledRunIO = defaultIO,
): Promise<GuiE2eSurfaceScheduledRunResult> {
  const enabled = await io.readEnabled();
  if (!enabled) {
    return { ran: false, skippedReason: 'GUI_E2E_SURFACE_SCHEDULED_RUN flag is off' };
  }

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = io.spawnFn('bash', [SUITE_SCRIPT], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { stdout, stderr } = collectChildOutput(child);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      console.warn(
        `[gui-e2e-surface-scheduled-run] timed out after ${RUN_TIMEOUT_MS}ms — killed. ` +
          `stdout tail:\n${stdout.text().slice(-LOG_TAIL_CHARS)}\nstderr tail:\n${stderr.text().slice(-LOG_TAIL_CHARS)}`,
      );
      resolve({ ran: true, timedOut: true, durationMs: Date.now() - startedAt });
    }, RUN_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gui-e2e-surface-scheduled-run] failed to spawn: ${message}`);
      resolve({ ran: false, skippedReason: `spawn error: ${message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const combined = `${stdout.text()}\n${stderr.text()}`;
      const legs = parseGuiE2eSurfaceSuiteOutput(combined);
      const failed = legs.filter((l) => !l.ok);

      void (async () => {
        let escalated = false;
        if (code !== 0) {
          // NOT a tick failure — see the module doc: a nonzero exit is the
          // suite reporting a real regression it already found. Logged for
          // visibility, then escalated to a human via the shared alarm rail
          // (never the release gate — WI-40086 owns that separately).
          console.warn(
            `[gui-e2e-surface-scheduled-run] suite exited ${code} after ${durationMs}ms — ` +
              `${
                failed.length > 0
                  ? `failing leg(s): ${failed.map((l) => l.leg).join(', ')}`
                  : 'no per-leg P0\\d\\d_TAURI_SURFACE_VERIFY_(OK|FAIL) line parsed — see tail'
              } — tail:\n${combined.slice(-LOG_TAIL_CHARS)}`,
          );
          const title =
            failed.length > 0
              ? `GUI E2E surface verification: ${failed.length} leg(s) failing`
              : 'GUI E2E surface verification suite failed (unparsed output)';
          const body =
            failed.length > 0
              ? `Failing leg(s): ${failed.map((l) => l.leg).join(', ')}.\n\n` +
                `Re-run by hand: bash scripts/tauri-surface-verify-suite.sh\n` +
                `This is NOT the release gate (WI-40086) — a regression here does not block ` +
                `deploys. Investigate and fix the failing surface(s) directly; see the plan ` +
                `gui-e2e-tauri-surface-verification-2026-08-27 for context on each leg.`
              : `The suite exited ${code} but no per-leg PASS/FAIL line was found in its ` +
                `output — the runner itself may be broken rather than any one surface. Check ` +
                `the scheduled-tick log for the suite's own stdout tail.`;
          escalated = await io.escalate({ title, body });
        } else {
          console.log(
            `[gui-e2e-surface-scheduled-run] ran in ${durationMs}ms, all ${legs.length} leg(s) passed`,
          );
        }
        resolve({ ran: true, exitCode: code, durationMs, legs, escalated });
      })();
    });
  });
}
