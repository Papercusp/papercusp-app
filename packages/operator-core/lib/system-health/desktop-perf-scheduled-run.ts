/**
 * Scheduled producer for the desktop-perf release gate (WI-6538).
 *
 * The desktop-perf gate (apps/operator/lib/release/desktop-perf-gate.ts) has
 * been structurally incapable of firing since the suite landed 2026-07-20:
 * `harness_shared.desktop_perf_runs` was written ONLY by a human clicking Run
 * in the admin testing UI, and nobody ever has — the table stayed at zero
 * rows. This tick is the missing PRODUCER: it runs the already-working,
 * self-contained packaged-binary wdio suite (tools/perf-test/wdio — WI-5662
 * fixed its tauri-driver wiring 2026-07-27, verified end-to-end) on a
 * schedule, so the gate's `maxAgeMs` freshness window (24h — see that file's
 * own `DEFAULT_DESKTOP_PERF_MAX_AGE_MS`) always has a real run to evaluate.
 *
 * The suite is FULLY self-contained and this tick deliberately does not
 * duplicate any of its resolution logic (the two-copies trap wdio.conf.ts's
 * own `cargoTargetDir` note warns about):
 *   - it auto-picks a free Xvfb display via `xvfb-run -a` when DISPLAY is
 *     unset (wdio.conf.ts's tauriDriverSpawnArgs) — never touches :0/:1;
 *   - it auto-resolves the freshest COMPLETE packaged binary via `cargo
 *     metadata` (wdio.conf.ts's resolveTauriAppPath);
 *   - its own `onComplete` hook POSTs the measures to the ingest route
 *     (endpoint-route/routes/admin/testing-desktop-perf-ingest.ts), which
 *     calls the SAME `recordDesktopPerfRun` the in-app admin suite uses —
 *     one writer, one schema, one trend.
 * This tick therefore only has to launch the suite and wait; it never writes
 * to desktop_perf_runs itself.
 *
 * NEVER TREATS A TEST-FINDING FAILURE AS A TICK FAILURE. A nonzero wdio exit
 * means the suite found a real regression — it already recorded that via
 * `onComplete` (which fires before the budget asserts, per perf-report.ts's
 * own doc comment) before throwing. Only an infra failure (the process could
 * not be spawned, or hung past the timeout) is worth surfacing as a problem
 * with THIS tick; a completed run, whatever its exit code, is success here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { REPO_ROOT } from '../agent-tools/docs/_repo-paths';
import { collectChildOutput } from '../child-output.js';

const WDIO_DIR = path.join(REPO_ROOT, 'tools', 'perf-test', 'wdio');

/**
 * Bounded — a hung tauri-driver/webview session must not wedge this tick
 * forever (mirrors green-checkpoint's own `runCmd` SIGKILL-on-timeout shape).
 * 10 minutes is generous: the WI-5662 live verification run completed the
 * full 3-spec suite in 00:01:38.
 */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Bound the tail kept for the warn log — this is a log excerpt, not a report. */
const LOG_TAIL_CHARS = 4000;

export interface DesktopPerfScheduledRunResult {
  ran: boolean;
  skippedReason?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /**
   * Did this run actually PERSIST a row? `false` means the producer produced
   * nothing, whatever the exit code said. `undefined` means the check could not
   * be made (a read error) — never read that as success.
   */
  producedRow?: boolean;
}

/** IO seam for tests. */
export interface DesktopPerfScheduledRunIO {
  spawnFn: (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;
  readEnabled: () => Promise<boolean>;
  /**
   * Newest persisted `created_ts` for this producer's workspace, or null when
   * the table is empty. Used as a before/after watermark to prove the run wrote
   * something. Returns null on a read error too — the caller treats "could not
   * tell" as unknown, never as success.
   */
  readNewestRunTs: () => Promise<number | null>;
}

/**
 * The workspace this producer writes into, resolved by the SAME chain as its two
 * readers — `testing-desktop-perf-ingest.ts` (which writes the row) and
 * `desktop-perf-gate.ts`'s `runDesktopPerfGate` (which reads it). Keeping one
 * chain is what makes the watermark check below meaningful: a check that read a
 * different workspace than the ingest writes would report "produced nothing" on
 * every healthy run, and a guard that cries wolf gets muted, which is strictly
 * worse than no guard.
 */
function producerWorkspaceId(): string {
  return process.env.PAPERCUSP_WORKSPACE_ID ?? 'default';
}

const defaultIO: DesktopPerfScheduledRunIO = {
  spawnFn: (command, args, options) => spawn(command, args as string[], options),
  readEnabled: () => getFlag(FLAGS.DESKTOP_PERF_SCHEDULED_RUN, 'system').catch(() => true),
  readNewestRunTs: async () => {
    try {
      const { readDesktopPerfRuns } = await import('./desktop-perf-runs.js');
      const [newest] = await readDesktopPerfRuns(producerWorkspaceId(), 1);
      return newest ? newest.createdTs : null;
    } catch {
      return null;
    }
  },
};

/**
 * Run the packaged-binary desktop-perf suite once. Resolves — never rejects —
 * with a result describing what happened; DBOS retries an infra-level miss
 * (spawn error) via the caller's step wrapper, not this function throwing.
 */
export async function runDesktopPerfScheduledRun(
  io: DesktopPerfScheduledRunIO = defaultIO,
): Promise<DesktopPerfScheduledRunResult> {
  const enabled = await io.readEnabled();
  if (!enabled) {
    return { ran: false, skippedReason: 'DESKTOP_PERF_SCHEDULED_RUN flag is off' };
  }

  const startedAt = Date.now();
  // Watermark BEFORE the run, so "did this produce anything" is answerable after
  // it. See `settle` below for why this exists at all.
  const beforeTs = await io.readNewestRunTs();
  return new Promise((resolve) => {
    /**
     * Resolve the tick, having first CHECKED that the run actually persisted a
     * row — instead of asserting it did.
     *
     * This is the guard whose absence made WI-38449 cost 13 days. The producer
     * has (at least) three independent ways to run to completion and persist
     * NOTHING, and until now the tick reported success for all three:
     *   1. a spec times out mid-suite, so measures are never collected;
     *   2. the publish POSTs to a bad base URL and 404s (a console.warn in the
     *      child, invisible here);
     *   3. the suite's node_modules are absent — it is deliberately outside the
     *      npm workspace with a MANUAL `npm install` bootstrap (see its README),
     *      so `npm test` exits 127 in milliseconds having done nothing.
     * All three are indistinguishable from a healthy run if you only look at the
     * exit code, which is precisely what this tick used to do while logging
     * "measures already posted via onComplete regardless of exit code".
     *
     * The row is the ONLY honest evidence: it is what `DESKTOP_PERF_GATE`
     * actually reads, so checking for it tests the real contract rather than a
     * proxy for it. A `false` here means the gate is going blind within its 24h
     * freshness window and someone must look — hence console.error, not warn.
     */
    const settle = (result: DesktopPerfScheduledRunResult): void => {
      void (async () => {
        const afterTs = await io.readNewestRunTs();
        const producedRow =
          afterTs === null ? undefined : beforeTs === null ? true : afterTs > beforeTs;
        if (producedRow === false) {
          console.error(
            `[desktop-perf-scheduled-run] RAN BUT PRODUCED NO ROW — the suite completed ` +
              `(exit ${result.exitCode ?? 'n/a'}${result.timedOut ? ', timed out' : ''}) but ` +
              `harness_shared.desktop_perf_runs gained nothing for workspace ` +
              `'${producerWorkspaceId()}'. DESKTOP_PERF_GATE will fail-soft PASS every deploy ` +
              `once the newest row falls outside its 24h freshness window. Check, in order: a ` +
              `'[perf-report] publish REJECTED' line in the child output above; whether ` +
              `${WDIO_DIR}/node_modules exists (the suite is outside the npm workspace and its ` +
              `install is a manual bootstrap — see its README); and whether a spec timed out ` +
              `before any measure was recorded.`,
          );
        }
        resolve({ ...result, producedRow });
      })();
    };
    // Deliberately NO DISPLAY / TAURI_APP_PATH set here — wdio.conf.ts's own
    // resolvers already do this correctly (see the module doc above) and are
    // the single source of truth for it.
    // PAPERCUSP_OPERATOR_URL is deliberately DROPPED rather than forwarded.
    //
    // This tick runs inside the operator host, so `process.env` is the HOST's
    // environment — and the host sets this variable for its own purposes, at
    // values that are not an operator origin (observed: `http://127.0.0.1:9071`,
    // and `http://localhost:3070/api/mcp`). The suite's publisher treats it as a
    // base and appends absolute `/api/...` paths to it, so inheriting it sent
    // every measure to a doubled URL that 404'd. The suite kept running, the
    // 404 was a console.warn, and this tick went on logging "measures already
    // posted via onComplete regardless of exit code" — which was false for 13
    // days while DESKTOP_PERF_GATE fail-soft passed every deploy (WI-38449).
    //
    // Unset (rather than set to a guess) so the suite falls back to its own
    // documented default, :3070 — one owner for that literal, in the suite, per
    // `operatorBaseUrl`'s "one literal, one place" note. An operator explicitly
    // targeting staging still overrides it when invoking the suite directly.
    const { PAPERCUSP_OPERATOR_URL: _hostOperatorUrl, ...childEnv } = process.env;
    // `test:all`, NOT `test`: the package's `test` is the headless runner-guard suite the
    // green gate selects (WI-10003821). Only `test:all` boots the packaged binary and
    // produces the measures this tick exists to collect.
    const child = io.spawnFn('npm', ['run', 'test:all'], {
      cwd: WDIO_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Chunk-boundary-safe accumulation (WI-6728) — a raw `stdout += d.toString()`
    // decodes each 'data' chunk in isolation, so a multi-byte UTF-8 character
    // split across two chunks silently corrupts to replacement characters. The
    // shared collector holds a StringDecoder per stream instead.
    const { stdout, stderr } = collectChildOutput(child);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      console.warn(
        `[desktop-perf-scheduled-run] timed out after ${RUN_TIMEOUT_MS}ms — killed. ` +
          `stdout tail:\n${stdout.text().slice(-LOG_TAIL_CHARS)}\nstderr tail:\n${stderr.text().slice(-LOG_TAIL_CHARS)}`,
      );
      settle({ ran: true, timedOut: true, durationMs: Date.now() - startedAt });
    }, RUN_TIMEOUT_MS);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[desktop-perf-scheduled-run] failed to spawn: ${message}`);
      resolve({ ran: false, skippedReason: `spawn error: ${message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        // NOT a tick failure — see the module doc: a nonzero exit is the
        // suite reporting a real regression it already recorded. Logged for
        // visibility only.
        console.warn(
          `[desktop-perf-scheduled-run] wdio exited ${code} after ${durationMs}ms ` +
            `(measures already posted via onComplete regardless of exit code) — tail:\n` +
            `${stdout.text().slice(-LOG_TAIL_CHARS)}\n${stderr.text().slice(-LOG_TAIL_CHARS)}`,
        );
      }
      settle({ ran: true, exitCode: code, durationMs });
    });
  });
}
