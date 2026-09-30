/**
 * Background scoper invocation — fires a detached TS `invoke-once` process
 * (the orchestrator's single-invoke entry) that runs `invoke scoper
 * MODE=<mode>`. Returns an opaque invocationId; the child writes to
 * `scoper-results/<mode>-<id>.log` with a trailing `__INVOCATION_DONE__`
 * sentinel (appended by invoke-once when RESULT_PATH is set).
 *
 * Relocated from `app/api/_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 29 — prereq for the proposals/product-review/replan/cleanup
 * routes which all call this helper).
 *
 * Ported off the legacy `bash -c 'source <(awk ... run.sh); invoke scoper'`
 * shell-out onto the TS orchestrator's `invoke-once.ts` (run.sh retirement).
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { loadHarnessKnobs } from '@papercusp/orchestrator';
import { join } from 'node:path';
import { harnessDir } from './harness-core';
import { type ProjectEntry } from './harness-registry';
import { instanceConfigEnv } from './deployment/instance-config';
import { activeWorkspaceId } from './workspace-registry';

/**
 * Wall-clock bound on a background scoper run now routed through the chokepoint.
 * The old detached spawn was effectively unbounded (its 30-min governor wait
 * gated only the permit, not the run), so keep a generous 30-min ceiling: a big
 * proposal/replan scan is never truncated, but a genuinely hung scoper can't
 * hold a slot forever. (The pipeline scoper runs under the 10-min
 * INVOKE_TIMEOUT_MS default; a manual proposal scan can legitimately run longer.)
 */
const SCOPER_INVOKE_TIMEOUT_MS = 30 * 60_000;

/**
 * Resolve scoper.outputMode from the blueprint knob `scoper.outputMode`
 * (`deprecate-harness-config-json-2026-06-06`: scoper is a SHAPE knob → it lives in
 * the blueprint, not per-install config.json; the old config.json instance-override
 * read is removed). Defaults to 'proposal'.
 */
function readScoperOutputMode(stateDir: string): 'proposal' | 'plan' {
  try {
    const knobScoper = loadHarnessKnobs(stateDir)?.scoper as { outputMode?: string } | undefined;
    return knobScoper?.outputMode === 'plan' ? 'plan' : 'proposal';
  } catch {
    return 'proposal';
  }
}

export async function invokeScoperBackground(
  project: ProjectEntry,
  mode: 'proposal' | 'replan' | 'cleanup',
): Promise<{ invocationId: string }> {
  const invocationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stateDir = join(project.path, '.papercusp');
  const resultsDir = join(harnessDir(project), 'scoper-results');
  const resultPath = join(resultsDir, `${mode}-${invocationId}.log`);
  const outputMode = mode === 'proposal' ? readScoperOutputMode(stateDir) : 'proposal';
  // The scoper agent writes proposals here; invoke-once creates logDir +
  // the RESULT_PATH dir itself, but not the proposals dir.
  try { mkdirSync(join(stateDir, 'proposals'), { recursive: true }); } catch { /* ignore */ }
  // Deliver the per-install instance config via the env-transport — the spawned
  // orchestrator reads HARNESS_CONFIG_JSON only, never `.papercusp/config.json`
  // (deprecate-harness-config-json-2026-06-06). Best-effort: a store miss just
  // means blueprint defaults.
  let instEnv: Record<string, string> = {};
  try {
    instEnv = await instanceConfigEnv(project.slug, activeWorkspaceId());
  } catch { /* spawn proceeds with blueprint defaults */ }
  const extras = [`MODE=${mode}`, `OUTPUT_MODE=${outputMode}`];
  const extraEnv: Record<string, string> = {
    SCOPER_INVOCATION_ID: invocationId,
    SCOPER_OUTPUT_MODE: outputMode,
    ...instEnv,
  };
  // Route the background scoper through the ONE chokepoint (spawnInvokeOnce) —
  // P-008 / D-013 — instead of a private buildInvokeOnce + raw detached
  // child_process.spawn (the off-chokepoint bypass the Phase-0 audit found). It
  // now shares the chokepoint's governor pacing (per-role backend/model bucket),
  // the config-env + display lease seam, and group-kill-on-timeout. Still
  // fire-and-forget: the caller polls `resultPath` for the __INVOCATION_DONE__
  // sentinel, so we `void` the promise and hold no child handle.
  //
  // LAZY import (mirrors the /invoke route, D-012): orchestrator-runner registers
  // the DBOS workflow graph at module load, so an EAGER import would drag those
  // process-global registrations into harness-scoper's import graph and crash any
  // route test that re-imports it under vi.resetModules. Cached after first scope.
  const { spawnInvokeOnce } = await import('./dbos/orchestrator-runner');
  void spawnInvokeOnce(project.path, 'scoper', extras, extraEnv, {
    resultPath,
    timeoutMs: SCOPER_INVOKE_TIMEOUT_MS,
  })
    .then((r) => {
      // invoke-once appends the sentinel itself when it actually runs; a PRE-spawn
      // bail (governor permit timeout / aborted-before-start) never does, leaving
      // the file-poller hanging — so end the poll ourselves. Idempotent: a
      // duplicate sentinel after the child's own is harmless (the poller stops at
      // the first). Preserves the old detached background spawn's permit-bail end.
      if (r.exitCode !== 0) {
        try {
          appendFileSync(
            resultPath,
            `\n[scoper-spawn] invocation failed (exit ${r.exitCode}): ${(r.stderr || 'unknown').slice(0, 500)}\n__INVOCATION_DONE__\n`,
          );
        } catch { /* the poller times out on its own otherwise */ }
      }
    })
    .catch((err) => {
      try {
        appendFileSync(
          resultPath,
          `\n[scoper-spawn] invocation error: ${err instanceof Error ? err.message : String(err)}\n__INVOCATION_DONE__\n`,
        );
      } catch { /* best-effort */ }
    });
  return { invocationId };
}
