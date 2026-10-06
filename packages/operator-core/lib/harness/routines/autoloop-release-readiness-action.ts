/**
 * autoloop-release-readiness-action.ts — `system:autoloop-release-readiness-monitor`
 * (WI-5144, follow-up from WI-4964 / plan rubric-system-and-auto-loop-release-profile-
 * 2026-07-15 P-011).
 *
 * `evaluateAutoloopReleaseProfile()` (apps/operator/lib/release/release-profile.ts) is
 * fully implemented, tested, and verified live (WI-4964) — but nothing previously
 * called it on a recurring cadence; the verdict was only ever checked ad-hoc. This
 * action wires it onto the routines engine: on each tick it shells out to the
 * standalone `run-autoloop-release-profile.ts` CLI (operator-core must not import the
 * apps/operator tier — the SAME layering `system:green-checkpoint` / `system:release-
 * trigger` already use, see release-actions.ts's file header), records the verdict as
 * a workspace-scoped fact every tick (`autoloop-release-readiness-verdict`), and — ONLY
 * when `verdict.go === true` — emits the `release-pass:autoloop` awaited event. Never
 * emits on a fail: the event stays a trustworthy one-shot GO signal for anything
 * `events:await`-ing it, never a noisy per-tick status ping.
 *
 * Seeded INACTIVE by seed-autoloop-release-readiness-routine.ts — arming is an explicit
 * step, separate from landing the code (a monitor that starts firing real awaited
 * events is exactly the kind of surface CLAUDE.md's "owner-authority" carve-out covers,
 * even though the read side itself is side-effect-free).
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { assertFact } from '../../agent-facts/store';
import { emitAwaitedEvent } from '../../events/await/engine';

/** Must match AUTOLOOP_RELEASE_PROFILE_RESULT_MARKER in
 *  apps/operator/lib/release/run-autoloop-release-profile.ts — operator-core cannot
 *  import that apps/operator-tier module, so (like GREEN_CHECKPOINT_RESULT_MARKER in
 *  release-actions.ts) the literal is duplicated by value. */
const RESULT_MARKER = '__AUTOLOOP_RELEASE_PROFILE_RESULT__';

export const AUTOLOOP_RELEASE_READINESS_FACT_KEY = 'autoloop-release-readiness-verdict';
export const AUTOLOOP_RELEASE_PASS_EVENT_KEY = 'release-pass:autoloop';

/** The evaluator reads scorecards/rubrics + a few git commands — no test suite, no
 *  build — so a generous-but-bounded 5m budget is ample; it exists only to guarantee a
 *  wedged/hung child (e.g. a stuck git subprocess) can't pin the routine tick forever. */
const RUN_TIMEOUT_MS = 5 * 60_000;

/** The integration tree (same convention as release-actions.ts's integrationRoot()). */
function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable for tests — the live default shells out via tsx. */
export type RunEvaluatorFn = (root: string) => Promise<RunResult>;

function defaultRunEvaluator(root: string): Promise<RunResult> {
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  const script = path.join(root, 'apps/operator/lib/release/run-autoloop-release-profile.ts');
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(tsx, [script], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root },
    });
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(r);
    };
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: 1, stdout, stderr: stderr + '\n[autoloop-release-readiness-monitor] TIMED OUT' });
    }, RUN_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

let _runEvaluator: RunEvaluatorFn = defaultRunEvaluator;
/** Override the evaluator runner (tests). Pass null to restore the live spawn path. */
export function setAutoloopReleaseReadinessRunner(fn: RunEvaluatorFn | null): void {
  _runEvaluator = fn ?? defaultRunEvaluator;
}

/** Parse the JSON on the line carrying `RESULT_MARKER` (mirrors release-actions.ts's
 *  parseMarkerLine — duplicated locally to avoid importing an apps/operator-adjacent
 *  release-actions internal). */
export function parseAutoloopVerdictMarker(stdout: string): Record<string, unknown> | null {
  const line = stdout.split('\n').find((l) => l.includes(RESULT_MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

registerSystemAction('autoloop-release-readiness-monitor', async (ctx: SystemActionCtx) => {
  const root = integrationRoot();
  const r = await _runEvaluator(root);
  const verdict = parseAutoloopVerdictMarker(r.stdout);
  if (!verdict) {
    console.warn(
      `[autoloop-release-readiness-monitor] evaluator run produced no parseable verdict (exit ${r.code}): ` +
        (r.stderr || r.stdout).slice(0, 2000),
    );
    return;
  }

  const go = verdict.go === true;
  const reason = typeof verdict.reason === 'string' ? verdict.reason : '(no reason field)';
  console.log(`[autoloop-release-readiness-monitor] go=${go} reason=${reason}`);

  await assertFact({
    scope: 'workspace',
    key: AUTOLOOP_RELEASE_READINESS_FACT_KEY,
    body: `autoloop release-readiness: ${go ? 'GO' : 'NO-GO'} — ${reason}`.slice(0, 500),
    createdBy: 'system:autoloop-release-readiness-monitor',
    ttlSec: 24 * 3600,
    workspaceId: ctx.workspaceId,
  }).catch((e) => {
    console.warn(
      '[autoloop-release-readiness-monitor] fact assert failed (non-fatal):',
      e instanceof Error ? e.message : e,
    );
  });

  // Never emit on go:false — a per-tick fail-ping would make the event untrustworthy
  // as a one-shot GO signal for anything events:await-ing it.
  if (go) {
    await emitAwaitedEvent({
      key: AUTOLOOP_RELEASE_PASS_EVENT_KEY,
      payload: verdict,
      summary: `autoloop release-readiness: GO — ${reason}`,
      source: 'system:autoloop-release-readiness-monitor',
      workspaceId: ctx.workspaceId,
    }).catch((e) => {
      console.warn(
        '[autoloop-release-readiness-monitor] event emit failed (non-fatal):',
        e instanceof Error ? e.message : e,
      );
    });
  }
  // WI-10005745: runs tsx <root>/apps/operator/lib/release/run-autoloop-release-profile.ts.
}, { executesIntegrationTreeCode: true });
