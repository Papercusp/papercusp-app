/**
 * Phase 3 of `dbos-durable-jobs-2026-05-31` + Phase F of
 * `dbos-retire-legacy-orchestrator-2026-05-31` — the operator-side wiring for the
 * durable feature pipeline (`orchestrator-workflow.ts`):
 *
 *  - the REAL invoke runner (`setPipelineInvokeRunner`): spawns the orchestrator's
 *    `invoke-once` bin (headless) for one agent run, passing `IDEMPOTENCY_KEY` so a
 *    re-run of a completed agent is reused, not re-spawned (P-015), and the
 *    classifier-built `extras` verbatim;
 *  - the REAL terminal finalizer (`setPipelineFinalizer`, P-001/P-002): ports the
 *    legacy main-loop's `handleDone` / `handleEscalate` — needs-human gate, then
 *    curator + documenter + archive + afterDone hook on DONE, or the on-escalate
 *    hook + curator on ESCALATE — so the durable pipeline distills run memory and
 *    writes docs instead of just stopping at DONE.
 *
 * Loaded + wired only when `PAPERCUSP_DBOS_ORCHESTRATOR=1` (via the DBOS bootstrap).
 */
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  configGet,
  resolvePhase,
  runHook,
  postCuratorOutputs,
  postArchiveEvent,
  captureDebuggerOutput,
  materializeFeatureDebugNote,
  healSandboxZeroByteManifest,
  OUTER_ACTIVITY_ECHO_MARKER,
} from '@papercusp/orchestrator';
import { emitPipelineEvent } from '../events/pipeline-events';
import { firePluginLifecycle } from '../plugin-host-runtime';
import { readEffectiveHarnessConfig } from '../harness-effective-config';
import { loadBlueprintFromFile, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { resolveProject } from '../harness-core';
import { activeWorkspaceId } from '../workspace-registry';
import { adminClientForHarness } from './admin-pg-cache';
import { harnessPackageDir } from '../harness-paths';
import { buildInvokeOnce } from '../harness-invoke-once';
import { isSidecarEnabledFromEnv } from '../process-supervision/sidecar-spawn-shared';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  setPipelineInvokeRunner,
  setPipelineFinalizer,
  setPipelineSettledHook,
  setPipelineDebuggerHook,
  setPipelineFeaturePassedHook,
  setPipelineTestDigestHook,
  setPipelineLeaseHeartbeatHook,
  type PipelineInvokeRunner,
  type PipelineFinalizer,
  type PipelineDebuggerHook,
  type PipelineTestDigestHook,
} from './orchestrator-workflow';
import { heartbeatClaim } from '../work-item-claims';
import { digestTestOutput } from './pre-validator-test-digest';
import { saveTextArtifact } from '../text-artifacts';
import { handleFeaturePassed, type FeaturePassedDeps } from '../harness/fork-pr-on-feature-pass';
import {
  planFinalization,
  needsHumanGateUrl,
  reconcileDoneStatus,
  parseAcceptanceVerdict,
  type FinalizeRecipe,
  type ReconcileDbClient,
} from './orchestrator-finalize';
import { buildPipelineExtraEnv } from './orchestrator-spawn-env';
import { acquireAgentDisplay, agentDisplayPool } from '../deployment/display-allocator';
import {
  emitFeatureWorkedStart,
  emitFeatureWorkedEnd,
  emitAgentRunCompleted,
} from '../harness/usage-emitters';
import { refillHarnessOnSettle } from './orchestrator-loop';
import { wireAuditorLane } from './auditor-lane-wiring';
import {
  governorForBackend,
  classifyTurnError,
  isAccountWide,
  setGovernorStore,
  setStatelessUsageSink,
  modelClassOf,
} from '@papercusp/papercusp-shared/agent';
import { resolveSpawnBackendModel } from '../harness-invoke-once';
import { initAgentGovernorObserver } from '../agent-governor-observer';
import { maybeInstallPgGovernorStore } from '../agent-governor-pg-store';
import { initRateLimitConfig } from '../rate-limit-config';
import { recordUsageHeaders } from '../agent-usage-telemetry';
import { SCOPE_LAUNCH_FAILURE_RE, agentSpawnScopeMemoryMaxG, buildIsolatedScopeArgv } from '../systemd-scope';
import {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
  syncEnrolmentScopePath,
} from '../task-manager/enroll-sync';
import { warmScopeProbe, scopeSupportKnown } from '../task-manager/managed-spawn';
import { trackDetached } from '../detached-imports';

// Warm the scope probe so the first agent turn after boot can already be enrolled
// into a NAMED scope (task-manager P-009). Fire-and-forget — an agent turn must
// never wait on the task manager's readiness.
warmScopeProbe();

// Audit P-015 (EI-172): read these env knobs LAZILY, per spawn — as module-init
// consts they froze at first import, so setting/changing the env after host boot
// (or per test case) was silently ignored. Exported for unit testing.
// Default 2700000ms (45 min) to support improvement workers (implementTimeoutMs
// defaults to 45 min; D-010). Prior default 600000ms (10 min) was insufficient.
export const invokeTimeoutMs = (): number =>
  Number(process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS ?? 2_700_000);
// How long an orchestrator spawn will wait on a shared rate-limit pause before giving up
// (the director re-tries later). Unattended → wait generously, but bounded.
export const governorMaxWaitMs = (): number =>
  Number(process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS ?? 1_800_000);

/**
 * Release-fixers have a long overall budget for diagnosis, but a launch that
 * never produces its first agent stream must not consume that whole budget.
 *
 * P-005 (gate-verdict-liveness, D-001): the original 5-minute guard was measured
 * KILLING healthy launches, not just hung ones — 7 first-turn timeouts at avg 301s
 * on 2026-08-31, i.e. fixers guillotined seconds past the deadline while a loaded
 * box (128-core fleet, cold CLI boot + queued gateway admission) was still
 * starting them, and 130/130 dispatches in the streak window produced nothing.
 * Fifteen minutes is the role-scoped budget: generous against load-induced slow
 * boots, still far below invokeTimeoutMs, and the zero-first-turn class remains
 * bounded (EI-209751) — it just stops eating launches that were about to speak.
 */
export const RELEASE_FIXER_FIRST_TURN_TIMEOUT_DEFAULT_MS = 15 * 60_000;
export const releaseFixerFirstTurnTimeoutMs = (): number => {
  const configured = Number(
    process.env.PAPERCUSP_RELEASE_FIXER_FIRST_TURN_TIMEOUT_MS ?? RELEASE_FIXER_FIRST_TURN_TIMEOUT_DEFAULT_MS,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : RELEASE_FIXER_FIRST_TURN_TIMEOUT_DEFAULT_MS;
};

/**
 * Strip the orchestrator's `[2026-…]` timestamp log lines from invoke-once
 * stdout, leaving the agent's actual output (the decision line + body). Mirrors
 * the filter in `routes/harness/spawn.ts`. Exported for unit testing.
 */
export function extractAgentOutput(stdout: string): string {
  return stdout
    .split('\n')
    .filter((l) => !/^\[20\d\d-\d\d-\d\dT/.test(l))
    .join('\n')
    .trim();
}

/**
 * D-007 (shared-hive-loop-e2e-testing) fail-open wrapper for the pipeline's
 * lease-heartbeat hook: run the heartbeat and pass its `{renewed,reason}` through,
 * but map ANY throw to `renewed:true` — a transient PG/authority error must NEVER
 * make a live pipeline self-abort (the next turn re-checks; completion-adoption
 * rule 2 is the backstop for an un-aborted zombie). Exported so the contract is
 * unit-tested directly (the `real*` hooks themselves do I/O and are integration-only).
 */
export async function leaseHeartbeatFailOpen(
  run: () => Promise<{ renewed: boolean; reason?: string }>,
): Promise<{ renewed: boolean; reason?: string }> {
  try {
    return await run();
  } catch (e) {
    return { renewed: true, reason: `heartbeat-error-fail-open: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Max chars of child stderr to surface on a failed invoke (P-005). */
const STDERR_SURFACE_LIMIT = 4000;
/** Max chars of raw child stdout to carry across the invoke boundary for diagnostics. */
export const RAW_STDOUT_TAIL_LIMIT = 2000;

export interface SpawnInvokeOnceResult {
  output: string;
  exitCode: number;
  stderr: string;
  timedOut?: boolean;
  /**
   * The signal NAME that killed the child ('SIGTERM', 'SIGKILL', …), or null when
   * it exited on its own.
   *
   * EI-21908787009967815, and the direct sequel to WI-38054. Node passes this as the
   * SECOND argument of `close`, and this runner destructured only `code` — the exact
   * shape that made `psu-pty-host.mjs` record every killed terminal as a voluntary
   * exit. Dropping it here left `spawn.ts` with only its OWN `timedOut` flag to reason
   * from, so a worker killed by anyone else (a sidecar restart tearing down the cgroup,
   * an operator `processes:kill`, the OOM killer) reached `markAdvSessionEnded` as
   * `ended_by='self'` — a row positively asserting the exit was voluntary.
   *
   * Carried as the name Node gives, NOT re-derived from `exitCode`: a 128+N exit code
   * is a CONVENTION a process may also produce deliberately, so inferring a kill from
   * it would manufacture the attribution migration 800 deliberately refuses to invent.
   */
  endedSignal?: string | null;
  /** True when the release-fixer's bounded pre-turn silence guard fired. */
  firstTurnTimedOut?: boolean;
  /**
   * Bounded, unfiltered stdout tail from the child process. `output` strips
   * timestamp/log transport lines for normal action parsing; this keeps the
   * exact CLI failure text available when an agent exits before emitting a turn.
   */
  rawStdoutTail?: string;
}

function rawStdoutTail(stdout: string): string {
  return stdout.length > RAW_STDOUT_TAIL_LIMIT ? stdout.slice(-RAW_STDOUT_TAIL_LIMIT) : stdout;
}

/**
 * Build the stderr-surfacing log line for a non-zero `invoke-once` exit (P-005).
 * Returns `null` on a clean exit (code 0) or when the child wrote nothing to
 * stderr. Exported for unit testing.
 *
 * Why this exists: a subprocess that THROWS during boot (e.g. the
 * `source_plan_slug` column / `paths.map` runtime bugs the retire plan's D-014
 * fixed) writes its message to the child's stderr and exits non-zero BEFORE it
 * ever records a `harness_run_output` row — so the parent saw only an empty
 * stdout + exit 1 and the real cause was invisible. Capturing + logging the
 * child's stderr here makes those throw-before-run failures debuggable, which the
 * debugger-before-worker (P-012) and CONVERT_ISSUES (P-011) fills depend on.
 */
export function formatInvokeStderr(role: string, exitCode: number, stderr: string): string | null {
  const trimmed = stderr.trim();
  if (exitCode === 0 || !trimmed) return null;
  const body =
    trimmed.length > STDERR_SURFACE_LIMIT
      ? `${trimmed.slice(0, STDERR_SURFACE_LIMIT)}\n... [stderr truncated: ${trimmed.length} chars]`
      : trimmed;
  return `[dbos-invoke] role=${role} exited ${exitCode} — stderr:\n${body}`;
}

/**
 * spawnInvokeOnce — THE single agent-spawn chokepoint. Spawn one headless
 * `invoke-once` run for `role` with the given `extras` (complete KEY=value list)
 * inside `projectDir`. Shared by the pipeline role runner, the finalizer
 * (curator/documenter), the operator nursery (`cup:spawn`), and the coord-program
 * fan-out. Resolves to the agent's output + exit code + captured stderr; never
 * rejects. On a non-zero exit the child's stderr is surfaced to the operator run
 * log so a throw-before-run isn't silent.
 *
 * ── What this chokepoint owns (unify-agent-spawn-chokepoint-2026-06-06) ──
 *   • ADMISSION — "is this spawn worth it right now?" is the BRAIN's judgment
 *     (the deterministic governor is only a floor), routed as a typed role-gated
 *     new_subagent request; the requester awaits the grant (D-002/D-004/D-008).
 *   • PACING / SAFETY FLOOR — the optional SHARED governor below (RB-012): a
 *     concurrency permit + reactive 429-penalty so the whole operator stays under
 *     the provider's rate limits, plus the single hard ceiling (rate_limit_config
 *     `maxSimultaneousAgents`, D-002/P-007). Reactive physics, never the worth-it call.
 *   • DELIVERY / DURABILITY — opt-in BY SPAWN CLASS (D-003): AUTONOMOUS spawns
 *     (routine fires, launch-blueprints, `cup:spawn`) are wrapped in a durable,
 *     idempotency-keyed DBOS step so a crash re-runs them once (P-010); INTERACTIVE
 *     `psu` is NOT made durable — a human is the durability, and auto-retrying their
 *     session would be wrong — but it STILL passes admission + the safety floor.
 *
 * ── What this chokepoint does NOT own: model-turn retry (D-005) ──
 *   The model-turn rate-limit retry (`runWithRetry`/`runAgentTurn`) is a SEPARATE
 *   layer that wraps our IN-PROCESS `anthropic-direct` calls. It physically CANNOT reach
 *   inside a spawned `claude`/`omp`/`codex` subprocess's turns — we only see the
 *   process boundary. The CLI self-retries its own turns and the director owns
 *   turn-retries; folding subprocess-turn retry in HERE would be our-retry ×
 *   CLI-retry amplification. The chokepoint's "delivery" guarantee is whole-spawn
 *   re-run on crash (DBOS), a DIFFERENT thing from in-turn retry. Do NOT add
 *   per-turn retry to this function.
 */
// Exported for unit testing (P-012): the subprocess spawn + timeout-kill +
// stdout/stderr-capture path. Tests mock `buildInvokeOnce` to drive a fake
// process; production callers go through realRunner / realFinalizer.
export async function spawnInvokeOnce(
  projectDir: string,
  role: string,
  extras: string[],
  extraEnv: Record<string, string>,
  /** Optional abort: when the signal fires, the child is SIGTERM'd (then SIGKILL
   *  after a grace period). Lets a caller (e.g. fleet:cancel via the operator
   *  spawn engine, EI-40) actually STOP the running agent, not just flip its row.
   *  Omitted by the pipeline runner / finalizer, which never abort mid-run.
   *  `resultPath`: when set, invoke-once tees its output here and appends the
   *  `__INVOCATION_DONE__` sentinel on exit — for a BACKGROUND caller that
   *  fire-and-forgets the spawn and polls the result FILE for completion (the
   *  scoper). Routing such a caller here (rather than a private raw spawn) is
   *  what keeps the scoper governed by the one chokepoint (P-008 / D-013). */
  /** `onChildPid`: fired once with the child OS pid right after spawn (EI-85) —
   *  the caller records it on the nursery row so the reclaim sweep can liveness-
   *  check the process instead of blindly reclaiming a stale-heartbeat row. */
  opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    resultPath?: string;
    forceSessionId?: string;
    onChildPid?: (pid: number) => void;
    /** Fired on EVERY stdout/stderr chunk the child emits (liveness-hardening
     *  P-008) — the in-process mid-turn signal. The caller throttles (the
     *  spawn engine folds it into the nursery heartbeat tick); this layer
     *  just reports. Best-effort: a throwing callback is ignored. */
    onOutputActivity?: () => void;
    /** Optional bounded silence guard used by the release-fixer before its first
     *  agent stream. Ordinary roles retain only their overall invoke timeout. */
    firstTurnTimeoutMs?: number;
    /** Durable spawn-row identity whose real payload is being enrolled. The
     *  systemd-run client may exit while its named scope keeps running, so this
     *  correlation lets liveness readers follow the payload instead of the
     *  short-lived client PID (EI-21065737245117808). */
    taskSpawnId?: string;
  },
): Promise<SpawnInvokeOnceResult> {
  // P-008 (cloud-deployment-layer): deliver the per-install instance config to the
  // child via env-transport (workspace PG is canonical; config.json is the
  // back-compat fallback). Gated on HARNESS_SLUG + PAPERCUSP_WORKSPACE_ID (set by
  // buildPipelineExtraEnv on every pipeline spawn). Best-effort + behavior-
  // preserving: for an un-migrated harness the assembled config IS that harness's
  // config.json, and any failure falls through to the child reading the file.
  let resolvedExtraEnv = extraEnv;
  const cfgSlug = extraEnv.HARNESS_SLUG;
  const cfgWs = extraEnv.PAPERCUSP_WORKSPACE_ID;
  if (cfgSlug && cfgWs && !extraEnv.HARNESS_CONFIG_JSON) {
    try {
      const { instanceConfigEnv } = await import('../deployment/instance-config');
      const instEnv = await instanceConfigEnv(cfgSlug, cfgWs);
      if (instEnv.HARNESS_CONFIG_JSON) resolvedExtraEnv = { ...extraEnv, ...instEnv };
    } catch {
      /* fall back to the child reading .papercusp/config.json */
    }
  }
  // EI-286 leg (b): pin the child's MCP config to THIS host. spawn-mcp resolves
  // its operator URL as PAPERCUSP_OPERATOR_URL ?? :3070/:3055 — and the child
  // INHERITS the host process env (buildInvokeOnce spreads process.env), where
  // .env.local sets PAPERCUSP_OPERATOR_URL=:3070. So agents spawned by the
  // staging host (:3170) handshook the GREEN host's MCP: wrong code version,
  // wrong role catalog (P-071 smoke: four consecutive Queen launches saw no
  // placement tools). The host's own env value is the HOST's config, not a
  // per-child directive — when this host knows its serving port it OVERRIDES
  // the inherited value so children always talk to their spawner. An explicit
  // caller pin (extraEnv) still wins.
  if (!resolvedExtraEnv.PAPERCUSP_OPERATOR_URL && process.env.PAPERCUSP_HONO_PORT) {
    resolvedExtraEnv = {
      ...resolvedExtraEnv,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${process.env.PAPERCUSP_HONO_PORT}/api/mcp`,
    };
  }
  // P-002 (hive-frame-desktops-live-view): on a desktop-enabled frame the
  // bootstrap stood up one Xvfb display per agent slot and advertised the pool
  // via PAPERCUSP_DESKTOP_DISPLAYS/_DISPLAY_BASE — lease one for this agent so
  // concurrent GUI agents never share a screen (D-001). Off-frame this is a
  // no-op; pool exhausted → headless spawn (logged), never queued.
  const displayLease = acquireAgentDisplay({ role });
  if (displayLease) {
    resolvedExtraEnv = {
      ...resolvedExtraEnv,
      DISPLAY: displayLease.display,
      // The explicit capability marker — DISPLAY alone can leak in from a dev
      // box's own session; this says "leased for THIS agent by the frame".
      PAPERCUSP_AGENT_DISPLAY: displayLease.display,
    };
  } else if (agentDisplayPool()) {
    console.warn(`[dbos-invoke] role=${role} desktop display pool exhausted — spawning headless`);
  }

  // B-18 fleet cutover (agent-capability-confinement P-020): resolve the
  // papercusp-fleet-capability-only flag PER-SPAWN and thread it to the
  // invoke-once child as PAPERCUSP_FLEET_CAPABILITY_ONLY. invoke()/claudeMcpArgs
  // (which runs in that child) reads it to drop native write/exec/fetch tools
  // from a confined role's --allowed-tools and route them to the gated
  // capability:* tools. DEFAULT-OFF (getFlag falls back to FLAG_DEFAULTS=false on
  // any PostHog miss, and a thrown lookup degrades to off) — so a flag hiccup can
  // never silently confine the fleet; the owner's flip is the only thing that arms it.
  try {
    if (await getFlag(FLAGS.FLEET_CAPABILITY_ONLY, 'system')) {
      resolvedExtraEnv = { ...resolvedExtraEnv, PAPERCUSP_FLEET_CAPABILITY_ONLY: '1' };
    }
  } catch {
    /* flag lookup failure ⇒ cutover stays off (current behavior) */
  }

  // A release-fixer has a generous overall timeout for diagnosis, but a
  // process that never reaches its first agent stream must fail sooner. Keep
  // the guard at the shared subprocess chokepoint so both the /invoke route
  // and any direct release-fixer caller get the same behavior.
  const firstTurnTimeoutMs =
    opts?.firstTurnTimeoutMs ??
    (role === 'release-fixer'
      ? Math.min(releaseFixerFirstTurnTimeoutMs(), opts?.timeoutMs ?? invokeTimeoutMs())
      : undefined);

  try {
    const { command, args, env } = buildInvokeOnce({
      projectDir,
      stateDir: join(projectDir, '.papercusp'),
      harnessDir: harnessPackageDir(),
      role,
      extras,
      extraEnv: resolvedExtraEnv,
      resultPath: opts?.resultPath,
      // P-016/D-007: when set (claude bees), bakes `--session-id <uuid>` into the
      // agent command so the headless run is resumable by exact id for the
      // hive-tabs bee attach (`claude --resume`). No-op for omp/codex.
      forceSessionId: opts?.forceSessionId,
    });

    // RB-012 / EI-86: the SHARED governor that paces + tracks this spawn's account budget.
    // Key the bucket to the backend+model the spawn ACTUALLY uses (the default `omp -p`
    // self-paces → its own concurrency-only bucket; claude → the Anthropic per-class bucket)
    // rather than the old hardcoded `('claude-code','')` which mis-bucketed everything.
    // P-019: on a frame launched under a bound account, key the bucket to that account so its
    // separate subscription tracks its separate rate limits (and its pauses carry the account
    // id, driving the Queen's scale-out). Unset locally ⇒ the global bucket.
    // PAPERCUSP_SPAWN_MODEL / _BACKEND (per-spawn escalation) shift the child onto a
    // different model class or CLI — key the bucket to what it ACTUALLY runs.
    const { backend, model } = resolveSpawnBackendModel(
      role, extraEnv.PAPERCUSP_SPAWN_MODEL, extraEnv.PAPERCUSP_SPAWN_BACKEND,
    );
    // account-aware-rate-governor-routing Phase 1: prefer the PER-SPAWN selected account (set in
    // `extraEnv.PAPERCUSP_ACCOUNT_ID` by operator-spawn's selectSpawnAccount) over the parent
    // operator's process env. A bee spawned from the MAIN operator has no PAPERCUSP_ACCOUNT_ID in
    // process.env, so this used to fall onto the account-BLIND global `anthropic:opus` bucket — and
    // one account's 429 then paused that bucket fleet-wide, the bee waited past maxWait, and failed
    // ("rate-limit pause exceeded max wait") even with six idle accounts. Keying per-account makes an
    // available account's bucket admit; the class only blocks when EVERY account is genuinely tapped.
    const gov = governorForBackend(
      backend,
      model,
      undefined,
      extraEnv.PAPERCUSP_ACCOUNT_ID || process.env.PAPERCUSP_ACCOUNT_ID || undefined,
    );
    // The back-edge EI-86 closes: classify the child's outcome and, on an account-wide stop
    // (429 / overload / usage-cap), PENALIZE the shared governor so the AIMD + the rate
    // read-model react to the DOMINANT (spawned claude-CLI) traffic class — not just the
    // in-process anthropic-direct lane. The claude/codex CLIs print these to STDOUT, so
    // classifyTurnError folds it in on a failed exit. This feedback is ALWAYS-ON: pacing
    // (acquire, below) is opt-in, but without the penalize back-edge the governor stays blind
    // to bee 429s, buckets read green while the account chokes, and the AIMD never engages.
    // A usage_limit carries its reset, so the fleet parks until reset (D-001). No retry here —
    // the director owns turn-retries (avoid double-retry).
    const feedGovernor = (inner: { output: string; exitCode: number; stderr: string }): void => {
      const te = classifyTurnError(backend, { exitCode: inner.exitCode, signal: null, stderr: inner.stderr, stdout: inner.output });
      if (isAccountWide(te.class)) gov.penalize({ retryAfterMs: te.retryAfterMs, resetAt: te.resetAt });
    };

    // PACING is opt-in (PAPERCUSP_AGENT_GOVERNOR=1, default OFF → unchanged): when enabled,
    // gate the spawn through the governor's concurrency/rate budget on top of the always-on
    // feedback, so the whole operator's agent spawns stay under the account's rate limit.
    if (process.env.PAPERCUSP_AGENT_GOVERNOR === '1') {
      const release = await gov.acquire({}, { maxWaitMs: governorMaxWaitMs() });
      if (!release) {
        // The per-account spawn-admission bucket is paused past maxWait. DON'T fail the spawn $0 when the
        // inference gateway owns egress: it does per-account failover + internal retry, so the bee reaches a
        // HEALTHY account anyway (the owner's "route around a paused account, don't fail with headroom" — the
        // spawn-side per-account gate must not veto what the gateway can serve; otherwise a single account's
        // pause kills spawns with five idle accounts). The gateway's admission queue + pacing still bound
        // egress. Only with NO gateway egress (no failover safety net) is the hard $0 fail correct.
        const gatewayEgress = !!(extraEnv.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL);
        if (!gatewayEgress) {
          return { output: '', exitCode: 1, stderr: 'agent governor: rate-limit pause exceeded max wait', rawStdoutTail: '' };
        }
        console.warn(`[dbos-invoke] role=${role} spawn-governor bucket paced past maxWait → proceeding via inference-gateway failover`);
        const inner = await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs, firstTurnTimeoutMs, opts?.onChildPid, opts?.onOutputActivity, opts?.taskSpawnId);
        feedGovernor(inner);
        return inner;
      }
      try {
        const inner = await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs, firstTurnTimeoutMs, opts?.onChildPid, opts?.onOutputActivity, opts?.taskSpawnId);
        feedGovernor(inner);
        return inner;
      } finally {
        release();
      }
    }
    // Pacing off (the default): run directly, but STILL feed the child's 429/overload back into
    // the shared governor (EI-86). The await happens here (inside the try) so the display
    // lease's finally releases AFTER the child exits, not when the promise is handed back.
    const inner = await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs, firstTurnTimeoutMs, opts?.onChildPid, opts?.onOutputActivity, opts?.taskSpawnId);
    feedGovernor(inner);
    return inner;
  } catch (err) {
    // EI-18118494223190987 (orphaned auto-implement dispatch worker): this
    // function's own contract (see the doc comment above) promises it "never
    // rejects" — every OTHER step in the try block above (buildInvokeOnce,
    // resolveSpawnBackendModel, governorForBackend, gov.acquire, feedGovernor/
    // classifyTurnError/gov.penalize) is synchronous or awaited INSIDE this try,
    // but none of them was actually caught: a throw from any of them (e.g. a
    // transient DB/instance-config read, a bad governor bucket key) propagated
    // as a REJECTED promise, contradicting the doc'd contract. `runChild` itself
    // never rejects (it's a bare `new Promise((resolve) => …)` with no reject
    // path), so this can only be one of the setup/governor steps above it.
    // Every caller of this chokepoint (the pipeline runner, the finalizer,
    // cup:spawn, the coord-program fan-out, and the harness /invoke route)
    // relies on the "never rejects" promise — the /invoke route in particular
    // has no try/catch around its `await spawnInvokeOnce(...)` call, so an
    // unhandled rejection here skipped its worker-exit back-edge entirely,
    // leaving auto-implement dispatch rows to the silent 2h orphan collector
    // instead of being closed promptly with a real diagnostic detail (the
    // observed EI-18118494223190987 orphans). Resolve like a hard-failed spawn
    // instead of rejecting, so every caller's normal exitCode!=0 handling (and
    // this dispatch's worker-exit back-edge) fires immediately with the real
    // cause instead of silently vanishing.
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[dbos-invoke] role=${role} spawnInvokeOnce setup/governor threw (never-rejects contract enforced): ${msg}`);
    return { output: '', exitCode: 1, stderr: msg, rawStdoutTail: '' };
  } finally {
    displayLease?.release();
  }
}

type AdminPgClient = ReturnType<typeof adminClientForHarness>;

function toPostgresPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function reconcileClientFromPostgres(pg: AdminPgClient): ReconcileDbClient {
  return {
    prepare: (sql: string) => {
      const query = toPostgresPlaceholders(sql);
      return {
        get: async (...params: unknown[]) => {
          const rows = (await pg.unsafe(query, params as never[])) as unknown[];
          return rows[0];
        },
        run: async (...params: unknown[]) => {
          await pg.unsafe(query, params as never[]);
        },
      };
    },
  };
}

/** SIGKILL grace after the SIGTERM on abort/timeout — gives the child a moment
 *  to flush + exit cleanly before we hard-kill. */
const KILL_GRACE_MS = 2_000;

/** Isolation kill-switch (peer of release-actions.ts's PAPERCUSP_CHECKPOINT_SCOPE):
 *  PAPERCUSP_AGENT_SPAWN_SCOPE=0 forces the pre-hardening same-cgroup spawn (ops
 *  escape hatch). Linux-only — systemd-run has no analog elsewhere, and every
 *  deployment target for this operator is Linux hosts (dev box + prod). */
function agentSpawnScopeEnabled(): boolean {
  return process.platform === 'linux' && process.env.PAPERCUSP_AGENT_SPAWN_SCOPE !== '0';
}

/** The raw subprocess spawn + timeout-kill + stdout/stderr capture (never rejects).
 *
 * WI-1499: every bee/queen turn is spawned inside its own transient systemd user
 * SCOPE (own cgroup, per-agent MemoryMax) — see `buildIsolatedScopeArgv`. Before this,
 * every agent child ran inside papercup-bg-host.service's OWN cgroup, so a bg-host
 * restart or OOM (systemd's default KillMode=control-group) killed every in-flight
 * bee/queen turn along with it, reclaiming them at the next boot reconcile even
 * though nothing about THEIR work actually failed. Scope-isolating them means a
 * bg-host restart no longer touches their cgroup, so they simply keep running —
 * `reconcileSpawnAdmissionOnBoot` (spawn-reclaim.ts) re-attaches to them instead of
 * reclaiming. `--scope` (not `--unit`, mirroring release-actions.ts's precedent):
 * the payload stays OUR CHILD — piped stdio, full env inheritance, and the existing
 * pgid tree-kill below still covers it (systemd-run remains the process-group
 * leader; the payload inherits its pgid). On a SCOPE LAUNCH failure (no user bus,
 * no systemd-run binary, …) this retries DIRECT once, exactly like
 * release-actions.ts's runScript, so a box without a reachable user bus degrades to
 * the pre-hardening behavior instead of failing every agent turn outright. */
function runChild(
  command: string,
  args: string[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
  role: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  firstTurnTimeoutMs?: number,
  onChildPid?: (pid: number) => void,
  onOutputActivity?: () => void,
  taskSpawnId?: string,
  useScope: boolean = agentSpawnScopeEnabled(),
  // WI-5601: one bounded retry for an "exec-shaped" transient failure — a fast
  // (<5s) non-zero exit with BOTH stdout and stderr completely empty (the
  // exit-127-in-~21ms signature, ~11.6% of spawns in the measured window,
  // consistent with a brief host-resource-pressure blip around fork/exec
  // rather than a real agent-code failure). Defaults false; the retry call
  // below passes true so it can only fire once per runChild chain.
  execFailureRetried: boolean = false,
): Promise<SpawnInvokeOnceResult> {
  return new Promise((resolve) => {
    // Already-aborted before we spawn → don't launch at all.
    if (signal?.aborted) {
      resolve({ output: '', exitCode: 1, stderr: 'aborted before start', rawStdoutTail: '' });
      return;
    }
    let timedOut = false;
    let firstTurnTimedOut = false;
    let firstTurnStarted = false;
    let firstTurnTimer: ReturnType<typeof setTimeout> | null = null;
    const launchedAt = Date.now();
    // EI-22174354183651399: this seam wrote agent-session ledger rows with NO
    // coordOwnerId — the only field that answers "which row is ME" (launched_by
    // holds whoever SPAWNED it, a different agent for any fleet member). A
    // coordOwnerId-keyed filter then silently returned zero rows for ~28-30% of
    // live agent sessions, reading as "unenrolled" when the row existed all
    // along. Same derivation as `libs/papercusp/packages/orchestrator/src/
    // invoke.ts:3509` (the CHILD reads its OWN process.env there); this is the
    // PARENT building that child's env, so read it off the constructed `env`
    // map this function is about to spawn with, not `process.env`.
    const coordOwnerId = (env.PAPERCUSP_SPAWN_ID ?? '').trim() || null;
    // task-manager-no-escape-2026-07-27 P-009: this is the single biggest subtree
    // on the box — an agent CLI plus everything it goes on to run — so it is the
    // spawn most worth naming. The scope was already isolated (WI-1499); what
    // changes here is that it is now a NAMED scope carrying a ledger key, which is
    // what makes the whole subtree addressable and attributable instead of merely
    // memory-capped. Enrolment happens even when the scope flag is off: the ledger
    // row is not the part that should be switchable.
    const enrolment = beginSyncEnrolment(
      {
        class: 'agent-session',
        memoryMaxBytes: agentSpawnScopeMemoryMaxG() * 1024 ** 3,
        runtimeMaxSec: timeoutMs ? Math.ceil(timeoutMs / 1000) : null,
      },
      { confine: useScope },
    );
    // `systemd-run --scope` may exit after handing the payload to the named
    // scope. Keep the enrollment row live in that handoff window so the
    // reconciler, rather than this client close event, owns the real payload's
    // terminal transition (WI-37509 / EI-21045581515656760).
    const scopeCgroupPath = syncEnrolmentScopePath(enrolment, 'agent-session');
    /* WI-6499 gates ENROLMENT on the task-manager flag, and defines flag-OFF as
       "byte-identical-to-pre-feature behaviour — an unconfined, unledgered spawn".
       That definition is right for a spawn seam the task manager INTRODUCED
       confinement to. It is wrong HERE, and silently regressed this one: the
       pre-task-manager behaviour of THIS seam was already scope-confined by
       WI-1499 (bg-host-agent-spawn-scope-isolation-2026-07-02), which exists
       because agent turns sharing papercup-bg-host.service's cgroup let one
       restart or OOM kill every in-flight turn — the 2026-07-01 40G OOM
       crash-loop. Flag-OFF was therefore dropping the memory cap entirely, not
       returning to the previous behaviour.

       So the flag governs the LEDGER + the NAMED unit (the new part); the memory
       cap is not switchable. When enrolment declines to confine but this seam
       still wants a scope, fall back to the ORIGINAL unnamed isolated scope.
       `orchestrator-runner-scope.test.ts` is what caught this, and it is the
       reason that file asserts on `systemd-run` rather than on the ledger. */
    /* The probe is consulted here too, but with WI-1499's bias rather than the
       ledger's. The task manager skips confinement whenever the probe has not
       LANDED yet, on the principle that a warming-up task manager must never be
       why a command does not run. For the ledger that is right. For the memory
       cap it is not: this seam has always ATTEMPTED the scope and degraded on a
       real launch failure (the retry a few lines below), so an un-landed probe
       is not a reason to run an agent turn uncapped — it is only a reason not to
       NAME it. A definitive "this host cannot make user scopes" (ok:false) is
       still honoured, because there the attempt is known-futile. */
    const scopeProbe = scopeSupportKnown();
    const fallbackToUnnamedScope = useScope && scopeProbe?.ok !== false;
    const wrapped = enrolment.confined
      ? enrolment.wrap(command, args)
      : fallbackToUnnamedScope
        ? (() => {
            const argv = buildIsolatedScopeArgv(
              [command, ...args],
              agentSpawnScopeMemoryMaxG(),
            );
            return { binary: argv[0], argv: argv.slice(1) };
          })()
        : { binary: command, argv: args };
    const [spawnCommand, ...spawnArgs] = [wrapped.binary, ...wrapped.argv];
    // `detached: true` puts the child in its OWN process group so we can reap the
    // WHOLE tree on abort/timeout, not just the immediate child. In dev the spawn is
    // `node <tsx-cli> invoke-once.ts`, and the tsx CLI forks a worker (invoke-once,
    // which spawns the agent) — a single-PID kill hits only the wrapper and orphans
    // the agent (EI-40). Group-kill (`process.kill(-pid)`) takes out wrapper +
    // invoke-once + agent together (and, under the scope wrapper, systemd-run +
    // that same tree — it inherits the group's pgid). The new group is the child's
    // alone, so it can never signal the operator host (a different group).
    const child = spawn(spawnCommand, spawnArgs, { cwd: projectDir, env, detached: true });
    // EI-85: surface the child OS pid so the caller can record it on the nursery
    // row — the reclaim sweep liveness-checks /proc/<pid> rather than blindly
    // reclaiming a stale-heartbeat row whose child is actually still alive. Under
    // the scope wrapper this is systemd-run's own pid (the group leader), which is
    // exactly the pid the pgid tree-kill needs and whose /proc/<pid>/cmdline still
    // carries the wrapped invoke-once argv (isSpawnProcessAlive's 'invoke-once'
    // substring check keeps working unmodified).
    if (child.pid != null) {
      try { onChildPid?.(child.pid); } catch { /* recording is best-effort */ }
    }
    completeSyncEnrolment(
      enrolment,
      {
        class: 'agent-session',
        title: `agent turn: ${role}`,
        argv: [command, ...args],
        cwd: projectDir,
        launchedBy: `orchestrator:${role}`,
        memoryMaxBytes: agentSpawnScopeMemoryMaxG() * 1024 ** 3,
        runtimeMaxSec: timeoutMs ? Math.ceil(timeoutMs / 1000) : null,
        detail: {
          role,
          scopeRequested: useScope,
          ...(taskSpawnId ? { spawnRecordId: taskSpawnId } : {}),
          ...(coordOwnerId ? { coordOwnerId } : {}),
        },
      },
      child.pid ?? null,
    );
    let stdout = '';
    let stderr = '';
    let killGrace: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;
    let settled = false;
    // Kill the child's whole process group; fall back to a single-PID kill if the
    // group send fails (e.g. the child already exited / no group).
    const killTree = (sigName: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid) { try { process.kill(-pid, sigName); return; } catch { /* fall through */ } }
      try { child.kill(sigName); } catch { /* ignore */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
    }, timeoutMs ?? invokeTimeoutMs());
    const firstTurnGuardMs =
      typeof firstTurnTimeoutMs === 'number' && Number.isFinite(firstTurnTimeoutMs) && firstTurnTimeoutMs > 0
        ? Math.min(firstTurnTimeoutMs, timeoutMs ?? invokeTimeoutMs())
        : null;
    if (firstTurnGuardMs != null) {
      firstTurnTimer = setTimeout(() => {
        if (settled || aborted || timedOut || firstTurnStarted) return;
        firstTurnTimedOut = true;
        timedOut = true;
        stderr += `${stderr ? '\n' : ''}release-fixer first-turn timeout after ${firstTurnGuardMs}ms (no agent stream)`;
        killTree('SIGTERM');
      }, firstTurnGuardMs);
    }
    // Caller-driven abort (EI-40: fleet:cancel of an operator spawn): SIGTERM the
    // tree now, SIGKILL it after a grace period if it ignores the term.
    const onAbort = () => {
      aborted = true;
      killTree('SIGTERM');
      killGrace = setTimeout(() => { killTree('SIGKILL'); }, KILL_GRACE_MS);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (firstTurnTimer) clearTimeout(firstTurnTimer);
      firstTurnTimer = null;
      if (killGrace) clearTimeout(killGrace);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    // P-008: every emitted chunk is the mid-turn signal — stderr counts too
    // (some backends log progress there while stdout buffers).
    const reportActivity = () => { try { onOutputActivity?.(); } catch { /* best-effort */ } };
    child.stdout?.on('data', (d) => {
      const chunk = String(d);
      // invoke-once prefixes its own bootstrap/log lines with timestamps. The
      // first non-log stdout chunk is the agent stream; prompt-budget and PG
      // bootstrap output therefore cannot falsely satisfy this guard.
      if (!firstTurnStarted && firstTurnTimer && extractAgentOutput(chunk).trim().length > 0) {
        firstTurnStarted = true;
        clearTimeout(firstTurnTimer);
        firstTurnTimer = null;
      }
      reportActivity();
      stdout += chunk;
    });
    child.stderr?.on('data', (d) => {
      const chunk = String(d);
      // WI-85288: the inner agent CLI's own stdout is NEVER echoed onto this child's
      // stdout — WI-3302 deliberately routes its liveness signal to STDERR instead
      // (`OUTER_ACTIVITY_ECHO_MARKER`, invoke.ts:4160), because downstream consumers
      // key off exact stdout content. invoke.ts emits that marker only from the inner
      // child's `stdout.on('data')`, so it means precisely what the stdout heuristic
      // below is trying to detect: the agent stream has really started. Without this,
      // the release-fixer first-turn guard could never be disarmed and SIGTERM'd every
      // fixer at exactly 300000ms — measured 0 completions and 100% timeouts from
      // 2026-08-24 16:57Z (the last `exited` run) through 2026-08-27, which is why
      // `main` could not advance: no fixer ever survived long enough to commit.
      if (!firstTurnStarted && firstTurnTimer && chunk.includes(OUTER_ACTIVITY_ECHO_MARKER)) {
        firstTurnStarted = true;
        clearTimeout(firstTurnTimer);
        firstTurnTimer = null;
      }
      reportActivity();
      stderr += chunk;
    });
    // Scope-launch failure (fast systemd-run exit with a launch-shaped stderr, before
    // any real agent turn could plausibly have run) → retry DIRECT once, exactly like
    // release-actions.ts's runScript, so a box without a reachable user bus degrades
    // to the pre-hardening same-cgroup spawn instead of failing the agent turn.
    const isScopeLaunchFailure = (code: number | null): boolean =>
      useScope &&
      !aborted &&
      !timedOut &&
      code !== 0 &&
      Date.now() - launchedAt < 5_000 &&
      SCOPE_LAUNCH_FAILURE_RE.test(stderr);
    // WI-5601: a fast, silent, non-zero exit — no stderr AND no stdout at all —
    // does not fit the scope-launch-failure shape above (that one requires a
    // real stderr message matching SCOPE_LAUNCH_FAILURE_RE) but is equally
    // "before any real agent turn could plausibly have run". Measured: 40/344
    // (11.6%) of spawns hit exactly this (exit 127 in ~21ms, both streams
    // empty), clustered around a host-resource-pressure window, with zero
    // recurrences since. One bounded retry (gated by execFailureRetried so it
    // can only fire once) turns a permanent spawn loss into, at worst, one
    // extra ~20ms attempt.
    const isExecShapedTransientFailure = (code: number | null): boolean =>
      !execFailureRetried &&
      !aborted &&
      !timedOut &&
      code !== null &&
      code !== 0 &&
      Date.now() - launchedAt < 5_000 &&
      stdout.length === 0 &&
      stderr.length === 0;
    // WI-38054 / EI-21908787009967815: `closeSignal` MUST be read here. Node passes the
    // signal NAME as `close`'s second argument, and it is the ONLY evidence that the
    // child was killed rather than choosing to exit — `code` is null in exactly that
    // case, so the surviving value cannot carry it. Destructuring only `code` (as this
    // did) is what let a reaped worker reach adv_sessions as ended_by='self'.
    child.on('close', (code, closeSignal) => {
      cleanup();
      if (settled) return;
      if (isScopeLaunchFailure(code)) {
        settled = true;
        // The retry gets its OWN enrolment (a fresh runChild call); close this row
        // with the real reason so the ledger shows a scope failure rather than a
        // phantom agent turn that exited non-zero for no visible cause.
        finishSyncEnrolment(enrolment, {
          state: 'exited',
          exitCode: code,
          exitReason: 'scope launch failed — retried unconfined',
        }, { scopeCgroupPath });
        resolve(runChild(command, args, projectDir, env, role, signal, timeoutMs, firstTurnTimeoutMs, onChildPid, onOutputActivity, taskSpawnId, false, execFailureRetried));
        return;
      }
      if (isExecShapedTransientFailure(code)) {
        settled = true;
        finishSyncEnrolment(enrolment, {
          state: 'exited',
          exitCode: code,
          exitReason: `exec-shaped failure (empty stdio, ${Date.now() - launchedAt}ms) — retried once`,
        }, { scopeCgroupPath });
        console.error(
          `[dbos-invoke] role=${role} exited ${code} in ${Date.now() - launchedAt}ms with BOTH streams empty — ` +
            `treating as a transient exec failure, retrying once (WI-5601)`,
        );
        resolve(runChild(command, args, projectDir, env, role, signal, timeoutMs, firstTurnTimeoutMs, onChildPid, onOutputActivity, taskSpawnId, useScope, true));
        return;
      }
      settled = true;
      finishSyncEnrolment(enrolment, {
        state: timedOut ? 'timed_out' : aborted ? 'killed' : 'exited',
        exitCode: code,
        exitReason: firstTurnTimedOut
          ? 'agent first-turn timeout'
          : timedOut
            ? 'agent turn timeout'
            : aborted
              ? 'aborted (fleet:cancel)'
              : null,
      }, { scopeCgroupPath });
      // A child we aborted may exit 0 (it caught SIGTERM and shut down) or via the
      // signal — normalize to a non-zero "aborted" outcome so callers don't read a
      // cancelled run as a clean success.
      if (aborted) {
        resolve({
          output: extractAgentOutput(stdout),
          exitCode: 1,
          stderr: stderr.trim() || 'aborted (fleet:cancel)',
          // An abort IS a kill we performed. The exitCode is normalized to 1 above so
          // callers cannot read a cancel as success; that normalization erases the
          // signal, so carry it explicitly rather than leaving the row to claim the
          // child chose to stop.
          endedSignal: closeSignal ?? null,
          rawStdoutTail: rawStdoutTail(stdout),
        });
        return;
      }
      const exitCode = code ?? 1;
      const failLog = formatInvokeStderr(role, exitCode, stderr);
      if (failLog) console.error(failLog);
      // A non-zero exit with EMPTY stderr is otherwise completely silent (the
      // upstream "exit=1 empty=true" hides whether the agent even produced output).
      // WI-5601: this used to gate the stdout tail entirely behind
      // PAPERCUSP_DBOS_INVOKE_DEBUG=1 — unset in normal operation — so a
      // genuinely-informative stdout (the WI-5601 example was 469 chars total)
      // was captured nowhere and the failure was unrecoverable after the fact.
      // Always log a bounded tail; DEBUG only widens it.
      else if (exitCode !== 0) {
        const tailLen = process.env.PAPERCUSP_DBOS_INVOKE_DEBUG === '1' ? 2000 : 500;
        const dbg = stdout.length
          ? `\n--- stdout tail (${role}) ---\n${stdout.length > tailLen ? stdout.slice(-tailLen) : stdout}`
          : '';
        console.error(`[dbos-invoke] role=${role} exited ${exitCode} with empty stderr (stdout ${stdout.length} chars)${dbg}`);
      } else if (stderr.trim()) {
        // Exit 0 with non-empty stderr: surface it so the operator log shows why
        // the bee vanished (e.g. "You've hit your session limit"). Without this,
        // exit-0 runs are completely silent even when the stderr carries the cause.
        const stderrHead = stderr.trim().slice(0, 500);
        console.warn(`[dbos-invoke] role=${role} exited 0 with stderr (${stderr.length} chars): ${stderrHead}`);
      }
      resolve({
        output: extractAgentOutput(stdout),
        exitCode,
        stderr,
        timedOut,
        endedSignal: closeSignal ?? null,
        firstTurnTimedOut,
        rawStdoutTail: rawStdoutTail(stdout),
      });
    });
    child.on('error', (err) => {
      cleanup();
      if (settled) return;
      if (useScope && !aborted) {
        settled = true;
        finishSyncEnrolment(enrolment, {
          state: 'exited',
          exitCode: null,
          exitReason: `scope spawn error — retried unconfined: ${err instanceof Error ? err.message : String(err)}`,
        }, { scopeCgroupPath });
        resolve(runChild(command, args, projectDir, env, role, signal, timeoutMs, firstTurnTimeoutMs, onChildPid, onOutputActivity, taskSpawnId, false));
        return;
      }
      settled = true;
      const msg = err instanceof Error ? err.message : String(err);
      finishSyncEnrolment(
        enrolment,
        { state: 'exited', exitCode: null, exitReason: `spawn error: ${msg}` },
        { scopeCgroupPath },
      );
      console.error(`[dbos-invoke] role=${role} spawn error: ${msg}`);
      resolve({ output: '', exitCode: 1, stderr: msg, rawStdoutTail: rawStdoutTail(stdout) });
    });
  });
}

const realRunner: PipelineInvokeRunner = async (harnessSlug, role, featureId, idempotencyKey, extras, workspaceId) => {
  // Resolve in the pipeline's CAPTURED workspace, not the volatile active one
  // (which can switch mid-pipeline and make `resolveProject` return null →
  // empty output → a spurious ERROR on a later turn).
  const project = await resolveProject(harnessSlug, workspaceId);
  if (!project) {
    // Unknown harness → empty output (the workflow parses '' → terminal → stops).
    // Surface it: an unresolved harness and an agent that exits empty are otherwise
    // indistinguishable upstream (both → "invoke failed exit=1 empty=true").
    console.error(`[dbos-invoke] role=${role} resolveProject NULL — unknown harness slug=${harnessSlug} ws=${workspaceId ?? '(none)'}`);
    // TERMINAL, not transient (WI-5630): an unresolvable harness can never succeed
    // on retry. Flag it so the workflow STOPS the pipeline cleanly rather than
    // throw → 3× step retry → 10× DBOS recovery, each attempt spawning a real agent
    // subprocess that burns gym budget and orphans ephemeral test-PG connections.
    return { output: '', exitCode: 1, unresolvedHarness: true };
  }
  // P-070 usage ledger (best-effort, never throws): a worker run starting is
  // `feature_worked_start`; ANY role run ending is `agent_run_completed` and a
  // worker run ending is `feature_worked_end`. run_id = the run's idempotency
  // key. Actor = the local machine identity (the orchestrator host). The
  // finalizer's curator/documenter runs are a separate path with no run id —
  // their agent_run_completed is a tracked follow-up, not wired here.
  const runId = idempotencyKey || '';
  if (runId && role === 'worker') {
    void emitFeatureWorkedStart(harnessSlug, runId, { role });
  }
  // P-004 (plugin-system-hive-port D-003): spine step transitions are event
  // emissions — `pipeline:step-start` / `pipeline:step-done` serve reaction
  // rules + events:await + UI in one fire. This runner executes INSIDE a
  // checkpointed DBOS step, so a workflow replay does not re-emit for
  // completed role runs. (These supersede the bash-era pre-/post-role hook
  // points lost in the DBOS migration — known-hooks.ts EI-95 backlog.)
  emitPipelineEvent({
    name: 'step-start', harnessSlug, featureId, role, runId,
    ...(workspaceId ? { workspaceId } : {}),
  });
  const startedAt = Date.now();
  // HARNESS_SLUG = the registry slug (not basename(project.path)) so invoke-once's
  // pg-bootstrap resolves harness_<slug> correctly; PAPERCUSP_WORKSPACE_ID pins the
  // agent's feature reads to the pipeline's captured workspace.
  const result = await spawnInvokeOnce(
    project.path,
    role,
    extras,
    buildPipelineExtraEnv({ harnessSlug, idempotencyKey, workspaceId }),
  );
  const durationMs = Date.now() - startedAt;
  if (runId) {
    void emitAgentRunCompleted(harnessSlug, runId, { role, durationMs });
    if (role === 'worker') {
      void emitFeatureWorkedEnd(harnessSlug, runId, {
        outcome: result.exitCode === 0 ? 'completed' : 'failed',
      });
    }
  }
  emitPipelineEvent({
    name: 'step-done', harnessSlug, featureId, role, runId,
    exitCode: result.exitCode, durationMs,
    ...(workspaceId ? { workspaceId } : {}),
  });
  return result;
};

/** Deprecated compatibility guard. DBOS always uses ordinary invoke now. */
export function useWorkerChunkLoopOp(input: {
  role: string;
  flagEnabled: boolean;
  harnessOptIn: boolean;
  cohortPercent?: number | string | null;
  cohortKey?: string | null;
}): boolean {
  void input;
  return false;
}

/**
 * Pure guard for debugger-before-worker (P-012 / D-005), mirroring the legacy
 * main-loop guard (`main-loop.ts:1061-1065`): fire the read-only debugger before
 * the worker iff the debugger is enabled, the feature has failed enough times
 * (`attempts ≥ threshold`), and no debug note exists yet (fires at most once).
 * Exported for unit testing.
 */
export function debuggerGateDecision(input: {
  enabled: boolean;
  attempts: number;
  threshold: number;
  noteExists: boolean;
}): boolean {
  return input.enabled && input.attempts >= input.threshold && !input.noteExists;
}

/**
 * The real debugger-before-worker hook (P-012). Resolves the harness in the
 * pipeline's captured workspace, reads `debugger.enabled`/`debugger.threshold`
 * from config + the feature's current `attempts` from PG, and — when the gate
 * fires — runs the read-only `debugger` role then captures its `<stateDir>/debug/
 * <fid>.md` output to PG (canonical). The note (PG-canonical, materialized to FS)
 * is the once-only dedup the worker also reads. Best-effort: any failure returns
 * `{ fired: false }` so a debugger problem never blocks the worker.
 */
/**
 * Resolve the harness's blueprint knobs from its git-canonical
 * `.papercusp/blueprint.yaml` (P-004 — the blueprint is authoritative for shape
 * knobs like debuggerThreshold; instance config still overrides). null when the
 * harness has no blueprint file. Fail-safe (any error → null → config/default).
 */
function harnessBlueprintKnobs(projectDir: string): Blueprint['knobs'] | null {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    return existsSync(f) ? loadBlueprintFromFile(f).blueprint.knobs : null;
  } catch {
    return null;
  }
}

/**
 * unify-agent-launches-as-blueprints D-001/D-003: the debugger is the degenerate
 * single-role launch DECLARED as the coding blueprint's reactive-before-worker
 * overlay role (`reactive: [{ role: debugger, when: { beforeRole: worker } }]`). So
 * the launched role is resolved from that declaration rather than a hardcoded
 * literal — a fork that swaps the reactive role (a different debugger persona) is
 * honored without code. Falls back to `'debugger'` (the coding default) when the
 * harness has no blueprint file or no before-worker reactive rule — behavior-
 * preserving for every harness on the coding fallback.
 */
export function pickReactiveBeforeWorkerRole(reactive: Blueprint['reactive']): string {
  return reactive.find((r) => r.when.beforeRole === 'worker')?.role ?? 'debugger';
}

function reactiveDebuggerRole(projectDir: string): string {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return 'debugger';
    return pickReactiveBeforeWorkerRole(loadBlueprintFromFile(f).blueprint.reactive);
  } catch {
    return 'debugger';
  }
}

/**
 * unify-agent-launches-as-blueprints P-007: the finalize recipe is the harness
 * blueprint's `gates.finalize` (`onDone`/`onEscalate`), resolved from its
 * git-canonical `.papercusp/blueprint.yaml` (extends merged). `undefined` when the
 * harness has no blueprint file or declares no finalize recipe → planFinalization
 * applies the DEFAULT_FINALIZE_RECIPE (the coding recipe), behavior-preserving for
 * every pre-blueprint harness. This is what makes finalization declarative: a `gym`
 * harness's `onDone: [committer]` is now HONORED (it was masked by the old hardcode).
 */
function harnessFinalizeRecipe(projectDir: string): FinalizeRecipe | undefined {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    const fin = loadBlueprintFromFile(f).blueprint.gates.finalize;
    return fin ? { onDone: fin.onDone, onEscalate: fin.onEscalate } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The harness blueprint's `acceptance.kind` (hive-blueprint-generalization P-009),
 * read from `.papercusp/blueprint.yaml`. Undefined for a pre-blueprint / coding harness
 * (which declares no `acceptance`), so the finalizer's acceptance gate is a no-op there —
 * behavior-preserving, exactly like harnessFinalizeRecipe.
 */
function harnessAcceptanceKind(projectDir: string): 'tests' | 'judge' | 'human-gate' | 'none' | undefined {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    return loadBlueprintFromFile(f).blueprint.acceptance?.kind;
  } catch {
    return undefined;
  }
}

/**
 * The harness blueprint's `output.kind` (hive-blueprint-generalization P-010), read from
 * `.papercusp/blueprint.yaml`. Undefined for a pre-blueprint / coding harness (⇒ repo-commit
 * default, no OUTPUT_KIND extra), so the finalizer is behavior-preserving there.
 */
function harnessOutputKind(
  projectDir: string,
): 'repo-commit' | 'artifacts' | 'external-action' | 'work-item-payload' | undefined {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    return loadBlueprintFromFile(f).blueprint.output?.kind;
  } catch {
    return undefined;
  }
}

const realDebuggerHook: PipelineDebuggerHook = async ({ harnessSlug, featureId, workspaceId }) => {
  const project = await resolveProject(harnessSlug, workspaceId);
  if (!project) return { fired: false };
  const projectDir = project.path;
  const stateDir = join(projectDir, '.papercusp');
  const ws = workspaceId ?? activeWorkspaceId();
  // Effective config from the blueprint (⊕ workspace-PG instance overrides), not
  // config.json (deprecate-harness-config-json-2026-06-06).
  const cfg = await readEffectiveHarnessConfig(harnessSlug, ws, projectDir);
  if (configGet<boolean>(cfg, 'debugger.enabled', true) !== true) return { fired: false };
  // P-004: the debugger threshold is a blueprint knob (knobs.debuggerThreshold);
  // instance config OVERRIDES it when explicitly set. Precedence:
  // config-explicit ?? blueprint ?? 3 — behavior-preserving (config-set wins as
  // before; unset → the blueprint's coding default 3 = the old hardcoded 3).
  const cfgThreshold = configGet<number | undefined>(cfg, 'debugger.threshold', undefined);
  const threshold = Number(cfgThreshold ?? harnessBlueprintKnobs(projectDir)?.debuggerThreshold ?? 3);

  // Audit P-036: the debugger gate runs on every pipeline invocation past the
  // attempt threshold — opening a fresh pool each time burned a connection slot +
  // startup round-trips per spawn. Reuse the shared admin-client LRU instead (one
  // client per (url, harness), shared with the orchestrator dispatch loop).
  const pg = adminClientForHarness(harnessSlug);
  try {
    const attRows = await pg<Array<{ attempts: number | bigint | null }>>`
      SELECT attempts FROM harness_features
       WHERE workspace_id = ${ws} AND feature_id = ${featureId}
       LIMIT 1
    `;
    const attempts = Number(attRows[0]?.attempts ?? 0);
    if (attempts < threshold) return { fired: false };

    // PG is canonical for debug notes; materialize PG → FS so (a) the worker
    // prompt's "read .papercusp/debug/<fid>.md" sees prior analysis and (b) a note
    // from an earlier run/process counts as "already debugged" without an
    // expensive re-run. A note on disk (this same epoch) also counts.
    const debugNotePath = join(stateDir, 'debug', `${featureId}.md`);
    const mat = await materializeFeatureDebugNote({ pg: pg as never, workspaceId: ws, harnessSlug, featureId, stateDir });
    const noteExists = mat.written || existsSync(debugNotePath);

    if (!debuggerGateDecision({ enabled: true, attempts, threshold, noteExists })) {
      return { fired: false };
    }

    const debugRole = reactiveDebuggerRole(projectDir);
    console.log(`[dbos-debugger] ${harnessSlug}/${featureId} starting role=${debugRole} (attempts=${attempts} ≥ ${threshold})`);
    const extraEnv = buildPipelineExtraEnv({ harnessSlug, workspaceId: ws });
    const r = await spawnInvokeOnce(projectDir, debugRole, [`FEATURE_ID=${featureId}`], extraEnv);
    console.log(`[dbos-debugger] ${(r.output || '').slice(0, 200) || '(no output)'}`);
    // Capture whatever the debugger wrote at <stateDir>/debug/<fid>.md → PG.
    await captureDebuggerOutput({ pg: pg as never, workspaceId: ws, harnessSlug, featureId, stateDir }).catch(() => {});
    return { fired: true };
  } catch (err) {
    console.warn(`[dbos-debugger] ${harnessSlug}/${featureId} gate error (non-fatal):`, err instanceof Error ? err.message : err);
    return { fired: false };
  }
  // No pg.end() here — the client is cached per harness (P-036).
};

/**
 * Pre-validator test-digest hook (token-usage-reduction-audit-2026-06-09
 * P-010). Runs the harness's `knobs.testCommand` once, deterministically,
 * digests the result (pre-validator-test-digest.ts), saves it as the
 * PG-canonical text artifact `.papercusp/test-digest/<feature>.md` (disk-
 * mirrored where the validator reads it), and returns a `TEST_DIGEST=…`
 * runtime-context extra for the validator spawn. Best-effort everywhere: no
 * testCommand → no extra; a hook error never blocks the validator.
 */
const TEST_DIGEST_TIMEOUT_MS = 10 * 60 * 1000;
const realTestDigestHook: PipelineTestDigestHook = async ({ harnessSlug, featureId, workspaceId }) => {
  try {
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return { extras: [] };
    const projectDir = project.path;
    const ws = workspaceId ?? activeWorkspaceId();
    const cfg = await readEffectiveHarnessConfig(harnessSlug, ws, projectDir);
    const testCommand =
      configGet<string | undefined>(cfg, 'testCommand', undefined) ??
      harnessBlueprintKnobs(projectDir)?.testCommand;
    if (!testCommand || !testCommand.trim()) return { extras: [] };

    console.log(`[dbos-test-digest] ${harnessSlug}/${featureId} running: ${testCommand}`);
    const started = Date.now();
    const run = spawnSync('bash', ['-lc', testCommand], {
      cwd: projectDir,
      timeout: TEST_DIGEST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    const durationMs = Date.now() - started;
    const exitCode = run.status ?? (run.signal ? 124 : 1);
    const raw = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const { summary, body } = digestTestOutput(raw, exitCode, testCommand);

    const relPath = `test-digest/${featureId}.md`;
    await saveTextArtifact(
      harnessSlug,
      relPath,
      `${body}\n\n- Duration: ${Math.round(durationMs / 1000)}s\n- Generated: ${new Date().toISOString()} (pre-validator, run once per validation round)\n`,
    );
    console.log(
      `[dbos-test-digest] ${harnessSlug}/${featureId} exit=${exitCode} in ${Math.round(durationMs / 1000)}s — ${summary}`,
    );
    return {
      extras: [
        `TEST_DIGEST=.papercusp/${relPath} (exit=${exitCode}; ${summary}) — pre-digested full-suite result; read it INSTEAD of re-running the whole suite`,
      ],
    };
  } catch (err) {
    console.warn(
      `[dbos-test-digest] ${harnessSlug}/${featureId} non-fatal:`,
      err instanceof Error ? err.message : err,
    );
    return { extras: [] };
  }
};

/**
 * Substrate base for the needs-human DONE-gate (mirrors legacy handleDone).
 */
function substrateBase(): string {
  return (
    process.env.PAPERCUSP_SUBSTRATE_BASE ??
    process.env.PAPERCUSP_HONO_BASE ??
    'http://localhost:3070'
  );
}

/** True iff the harness has an open needs-human plan item for ITS OWN plans (blocks DONE). */
async function needsHumanOpen(slug: string): Promise<boolean> {
  try {
    const url = needsHumanGateUrl(substrateBase(), slug);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { items?: unknown[] };
    return Array.isArray(body.items) && body.items.length > 0;
  } catch {
    // Gate is advisory; a fetch failure must not strand a finished feature.
    return false;
  }
}

const realFinalizer: PipelineFinalizer = async ({ harnessSlug, featureId, workspaceId, outcome, reason }) => {
  const project = await resolveProject(harnessSlug, workspaceId);
  if (!project) {
    console.warn(`[dbos-finalize] unknown harness ${harnessSlug} — skipping finalization`);
    return;
  }
  const projectDir = project.path;
  const stateDir = join(projectDir, '.papercusp');
  const logDir = join(stateDir, 'logs');
  // Effective config from the blueprint (⊕ workspace-PG instance overrides), not
  // config.json (deprecate-harness-config-json-2026-06-06).
  const cfg = await readEffectiveHarnessConfig(harnessSlug, workspaceId ?? activeWorkspaceId(), projectDir);
  // Curator/documenter run with the registry slug too (correct schema) + the
  // pipeline's workspace; no idempotency key (they run once at finalization).
  const extraEnv = buildPipelineExtraEnv({ harnessSlug, workspaceId });

  // Gates only apply to DONE; ESCALATE always distills memory.
  const blocked = outcome === 'done' ? await needsHumanOpen(harnessSlug) : false;
  const plan = planFinalization({
    outcome,
    featureId,
    reason,
    needsHumanOpen: blocked,
    // Smoke gate is config-gated-off for ~all harnesses; not yet ported into the
    // durable finalizer (runSmokeTest is a main-loop-internal). Tracked as a Phase
    // F follow-up; pass not-run so it never blocks here.
    smokeEnabled: false,
    smokePassed: null,
    archiveOnDone: configGet<boolean>(cfg, 'archiveOnDone', false) === true,
    // P-007: the finalize roles come from the blueprint's gates.finalize (declarative),
    // defaulting to the coding recipe when the harness declares none.
    finalize: harnessFinalizeRecipe(projectDir),
    // hive-blueprint-generalization P-009: the acceptance model gates DONE — undefined for
    // a coding/pre-blueprint harness, so this is a no-op there (behavior-preserving).
    acceptanceKind: harnessAcceptanceKind(projectDir),
    // P-010: the output sink — undefined/repo-commit for a coding harness ⇒ no change.
    outputKind: harnessOutputKind(projectDir),
  });

  if (plan.blocked) {
    console.log(
      `[dbos-finalize] DONE blocked for ${harnessSlug} (open needs-human plan item) — skipping curator/documenter`,
    );
    return;
  }

  // Unblocked DONE: close the status loop if the validator omitted its
  // validating→passed PG write (live on frame 138838461, 2026-06-09 — see
  // reconcileDoneStatus). Best-effort: a reconcile hiccup must not block the
  // curator/documenter finalization steps.
  if (outcome === 'done') {
    try {
      const pg = adminClientForHarness(harnessSlug);
      const flipped = await reconcileDoneStatus(harnessSlug, featureId, reconcileClientFromPostgres(pg), (m) =>
        console.log(m),
      );
      if (flipped) {
        const { auditFeatureChange } = await import('../feature-audit');
        auditFeatureChange(harnessSlug, featureId, 'status', 'validating', 'passed', 'dbos-finalize');
      }
    } catch (e) {
      console.warn(`[dbos-finalize] status reconcile failed (non-fatal): ${(e as Error).message}`);
    }
  }

  for (const step of plan.steps) {
    try {
      if (step.kind === 'invoke') {
        const finalizeStartedAt = Date.now();
        const r = await spawnInvokeOnce(projectDir, step.role, step.extras, extraEnv);
        // P-070 (best-effort): the finalizer's curator/documenter runs are agent
        // runs too. They carry no idempotency key (run once per finalization), so
        // synthesize a stable run_id from feature+role+phase.
        void emitAgentRunCompleted(harnessSlug, `${featureId}:${step.role}:finalize`, {
          role: step.role,
          durationMs: Date.now() - finalizeStartedAt,
        });
        console.log(`[dbos-finalize] ${step.role}: ${(r.output || '').slice(0, 160) || '(no output)'}`);
        // P-009 acceptance gate: a judge step whose verdict is `revise` HARD-BLOCKS the
        // rest of the finalize recipe (onDone — artifacts:save / documenter), so a
        // deliverable that fails the rubric is NOT published. The work item is left
        // non-terminal for the Queen to re-place; a `pass` (or a fail-open missing
        // marker) falls through to the output recipe unchanged. Only fires for a
        // judge-acceptance hive (the step carries acceptanceGate); coding is untouched.
        if (step.acceptanceGate && parseAcceptanceVerdict(r.output) === 'revise') {
          console.warn(
            `[dbos-finalize] acceptance gate: ${step.role} returned REVISE for ${featureId} — blocking the output recipe (deliverable not published); left for re-placement`,
          );
          emitPipelineEvent({
            name: 'escalate',
            harnessSlug,
            featureId: featureId ?? '-',
            reason: `acceptance: judge verdict REVISE — ${featureId} needs revision before its deliverable is published`,
            ...(workspaceId ? { workspaceId } : {}),
          });
          break;
        }
      } else if (step.kind === 'postCuratorOutputs') {
        await postCuratorOutputs({ stateDir, harnessDir: harnessPackageDir() }).catch(() => {});
      } else if (step.kind === 'archive') {
        archiveStateDir(stateDir, resolvePhase(cfg).phase || 'staging');
      } else if (step.kind === 'hook') {
        if (step.hook === 'on-escalate') {
          runHook('on-escalate', {
            stateDir,
            projectDir,
            logDir,
            env: { REASON: reason ?? '', PROJECT_DIR: projectDir, STATE_DIR: stateDir },
            log: (m) => console.log(`[dbos-finalize] ${m}`),
            harnessSlug,
            ...(workspaceId ? { workspaceId } : {}),
          });
          // P-004: the terminal transition is an event emission (reaction rules +
          // events:await + UI in one fire). Inside the checkpointed finalize step.
          emitPipelineEvent({
            name: 'escalate', harnessSlug, featureId: featureId ?? '-',
            ...(reason ? { reason } : {}), ...(workspaceId ? { workspaceId } : {}),
          });
        } else if (step.hook === 'afterDone') {
          // P-004 (promote-spawn-child-harness): the parent-notification BUILTIN.
          // A per-harness hooks/afterDone.sh overrides it entirely (parity with
          // the retired run.sh builtin resolver); when no user hook ran, the TS
          // builtin posts a `Completion` message to this harness's sealed parent
          // once the feature queue drains — so a parent that spawn_child'ed this
          // harness learns its sub-work is done. Plugins fire regardless.
          const userHook = runHook('afterDone', {
            stateDir,
            projectDir,
            logDir,
            env: { TRIGGER: 'done', FEATURE_ID: featureId ?? '', PROJECT_DIR: projectDir, STATE_DIR: stateDir },
            log: (m) => console.log(`[dbos-finalize] ${m}`),
            harnessSlug,
            ...(workspaceId ? { workspaceId } : {}),
          });
          if (!userHook.ran) {
            const { notifyParentOnDone } = await import('./notify-parent-done');
            await notifyParentOnDone({
              harnessSlug,
              workspaceId: workspaceId ?? activeWorkspaceId(),
              ...(featureId && featureId !== '-' ? { featureId } : {}),
              log: (m) => console.log(`[dbos-finalize] ${m}`),
            });
          }
          // P-006 (plugin-system-hive-port D-003): the deprecated `firePluginHook`
          // shell-out (per-plugin child process via the papercusp-fire-hook CLI)
          // is replaced by the in-process typed fire — `afterDone` is one of the
          // FROZEN legacy fire-points D-003 keeps for back-compat. Best-effort:
          // a plugin hook failure is logged by the host, never sinks finalization.
          await firePluginLifecycle('afterDone', {
            installSlug: harnessSlug,
            projectDir,
            stateDir,
          }).catch((e) => console.warn(`[dbos-finalize] afterDone plugin hooks failed: ${e instanceof Error ? e.message : e}`));
          // P-004: the terminal transition as an event emission — the extension
          // surface plugins actually subscribe to (capability-scoped reaction
          // rules), plus events:await wakes on `pipeline:done:<slug>:<feature>`.
          emitPipelineEvent({
            name: 'done', harnessSlug, featureId: featureId ?? '-',
            ...(workspaceId ? { workspaceId } : {}),
          });
        }
      }
    } catch (err) {
      console.warn(`[dbos-finalize] step ${step.kind} error (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }

  // P-043 / D-019: completion-time generator safety net. The producing feature's
  // worker normally expands its generative wave at generators:publish-time; this
  // re-runs that expansion on DONE — idempotent (deterministic child ids), so it's
  // a no-op if already expanded, but it (a) catches a publish that failed to
  // expand and (b) ESCALATES if a feature that a `for_each: { from_feature: <this> }`
  // wave sources from finished WITHOUT publishing any items (never silently yields
  // zero children — D-012a). Best-effort; never sinks finalization.
  if (outcome === 'done' && featureId && featureId !== '-') {
    try {
      const { expandGeneratorsForFeature } = await import('../agent-tools/plans/expand-generators');
      const r = await expandGeneratorsForFeature({
        harnessSlug,
        featureId,
        workspaceId: workspaceId ?? activeWorkspaceId(),
        requireItems: true,
      });
      if (r.expanded > 0) {
        console.log(`[dbos-finalize] expanded ${r.expanded} generated child feature(s) from ${featureId}`);
      }
      for (const esc of r.escalations) {
        console.warn(`[dbos-finalize] generator escalation (${harnessSlug}/${featureId}): ${esc}`);
      }
    } catch (err) {
      console.warn(`[dbos-finalize] generator expansion error (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }
};

/** Archive the state dir to `<stateDir>/archives/<ts>-done.tar.gz` + post the event. */
function archiveStateDir(stateDir: string, phase: string): void {
  const archivesDir = join(stateDir, 'archives');
  mkdirSync(archivesDir, { recursive: true });
  const archivePath = join(archivesDir, `${Math.floor(Date.now() / 1000)}-done.tar.gz`);
  const tarRes = spawnSync(
    'tar',
    ['czf', archivePath, '-C', stateDir, '--exclude=archives', '--exclude=./archives', '.'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (tarRes.status === 0 && existsSync(archivePath)) {
    const sz = (() => { try { return statSync(archivePath).size; } catch { return 0; } })();
    console.log(`[dbos-finalize] archiveOnDone: saved ${basename(archivePath)} (${sz} bytes)`);
    void postArchiveEvent({ stateDir, archivePath, phase }).catch(() => {});
  } else {
    console.log(`[dbos-finalize] archiveOnDone: tar failed (rc=${tarRes.status})`);
  }
}

let _wired = false;
/** Wire the real invoke runner + terminal finalizer + on-completion refill +
 * G2 auditor lane into the durable pipeline. Idempotent. */
/**
 * Real deps for the feature-passed → fork-PR handler (B3 / P-002). Each external
 * effect is lazily imported (the runner module is import-sensitive). The handler
 * logic + fork-mode gating is unit-tested via injected seams in
 * lib/harness/fork-pr-on-feature-pass.test.ts; these are the live wires.
 */
const realFeaturePassedDeps: FeaturePassedDeps = {
  loadSharedConfig: async ({ harnessSlug, workspaceId }) => {
    // P-013 (hive-from-github-url): the gate is no longer shared.json-only —
    // a hive member with registry coords (a URL-created harness) is upstream-
    // bound too. A standalone private harness stays out (upstreamGateAllows).
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return null;
    const { resolveUpstreamRepoSource, upstreamGateAllows } = await import(
      '../harness/upstream-repo-context'
    );
    const src = await resolveUpstreamRepoSource(project);
    if (!src || !upstreamGateAllows(project, src)) return null;
    return {
      github_remote: src.github_remote,
      github_repository_id: src.github_repository_id ?? 0,
    };
  },
  resolveRepoContext: async ({ harnessSlug, workspaceId }) => {
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return null;
    const { resolveUpstreamRepoSource } = await import('../harness/upstream-repo-context');
    const src = await resolveUpstreamRepoSource(project);
    if (!src) return null;
    const { resolveLocalGithubIdentity } = await import('../identity/resolve-local-github-identity');
    const id = await resolveLocalGithubIdentity();
    if (id.kind !== 'ok') return null;
    return {
      repoPath: project.path,
      // P-013: the detected upstream default branch — 'main' only as the true
      // last resort (the old hardcode mis-targeted master upstreams).
      baseBranch: src.default_branch ?? 'main',
      token: id.token,
      upstreamOwner: src.owner,
      upstreamRepo: src.repo,
      // PR-4 (c): the SAME resolved gh identity that authors the PR — recorded as
      // the human operator on the harness_feature_prs row (attributable; the EN-2
      // P-RATE bucket key).
      authorGithubUserId: id.githubUserId,
    };
  },
  getPermission: async ({ owner, repo }) => {
    const { getOctokit } = await import('../identity/octokit-client');
    const oc = await getOctokit();
    if (!oc) return 'none';
    try {
      const { data } = await oc.rest.repos.get({ owner, repo });
      const p = (data as {
        permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
      }).permissions;
      if (p?.admin) return 'admin';
      if (p?.maintain) return 'maintain';
      if (p?.push) return 'write';
      if (p?.pull) return 'read';
      return 'none';
    } catch {
      return 'none';
    }
  },
  ensureFeatureBranch: async ({ repoPath, featureBranch }) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    // Move/create the feature branch to the current HEAD WITHOUT checking it out
    // (the integration HEAD holds the feature's committed work).
    await run('git', ['-C', repoPath, 'branch', '-f', featureBranch, 'HEAD']);
  },
  openForkPr: async (opts) => {
    const { openForkPr } = await import('../harness/open-fork-pr');
    return openForkPr(opts);
  },
  // PR-4 (b): the live WI↔PR producer — UPSERT the harness_feature_prs row at
  // PR-open so the merge-time completion stamp resolves the feature from the row
  // (not the empty fallback) and the report GUI can link WI→PR→merged.
  recordFeaturePrOpened: async (row) => {
    const { upsertFeaturePrOnOpen } = await import('../harness/feature-pr-producer');
    await upsertFeaturePrOnOpen(row);
  },
  log: (msg) => console.error(msg),
};

export function wireOrchestratorInvokeRunner(): void {
  if (_wired) return;
  _wired = true;
  // RB-009: surface rate-limit-governor pauses to coord + the toast stream. Idempotent; the
  // governor is shared by the pipeline spawn, stateless LLM calls, and the gym, so one init here
  // (on operator boot) covers them all.
  initAgentGovernorObserver();
  // cloud-deployment-layer Phase 7 (P-019/P-021): bridge the governor's per-account pause
  // signal into the account pool — record each account's rate state, and when an account is
  // SUSTAINEDLY limited, scale out onto a fresh account instead of only pausing. A no-op until
  // a process runs under PAPERCUSP_ACCOUNT_ID (i.e. account-keyed buckets exist).
  void trackDetached(import('../deployment/account-pool-store'))
    .then(({ initAccountScaleObserver, syncDefaultAccountEnv }) => {
      initAccountScaleObserver();
      // default-deploy-account-2026-08-08 P-008: publish the "a default account is in force"
      // marker onto this process's env, so the in-process anthropic-direct family (judges,
      // sim-users, summarisers, memory session-extraction) egresses via the gateway — which
      // starts on the default account — instead of this box's ~/.claude login. Per-process and
      // fail-soft; see syncDefaultAccountEnv for the sibling-host staleness note.
      return syncDefaultAccountEnv();
    })
    .catch((err) => console.error('[account-pool] observer init failed:', err));
  // RB-007: when PAPERCUSP_AGENT_GOVERNOR_PG=1, route the governor's rate+pause budget through a
  // PG-backed store so every operator process + the gym share ONE account budget (no co-burst).
  maybeInstallPgGovernorStore(setGovernorStore);
  // rate-limit-layer-v2 D-004: load the user's live fleet cap (maxSimultaneousAgents) + AIMD
  // floor from PG into the governor's global gate, and subscribe to live edits (no restart).
  void initRateLimitConfig().catch((err) => console.error('[rate-limit-config] init failed:', err));
  // rate-limit-layer-v2 D-002 (capture point 1): the stateless anthropic-direct path reports per-call token usage
  // + any anthropic-ratelimit-* headers; persist each as a usage sample for the fleet read-model.
  setStatelessUsageSink((ev) => {
    const modelClass = modelClassOf(ev.model);
    void recordUsageHeaders(`anthropic:${modelClass}`, 'anthropic', modelClass, ev.headers ?? {}, {
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      cacheReadTokens: ev.cacheReadTokens,
      cacheCreationTokens: ev.cacheCreationTokens,
      costUsd: ev.costUsd,
      model: ev.model,
      accountId: process.env.PAPERCUSP_ACCOUNT_ID,
      // Caller attribution (the stateless usageAttribution seam) — before this,
      // every source:'headers' row was anonymous (null role/run/session).
      ...(ev.attribution ?? {}),
    });
  });
  setPipelineInvokeRunner(realRunner);
  setPipelineFinalizer(realFinalizer);
  // P-012: fire the read-only debugger before a worker when the feature has
  // failed ≥ debugger.threshold times and has no debug note yet.
  setPipelineDebuggerHook(realDebuggerHook);
  // token-usage-reduction P-010: run the harness's test command once before a
  // validator spawn and hand it the digest, replacing run-and-reread loops.
  setPipelineTestDigestHook(realTestDigestHook);
  // D-007 (shared-hive-loop-e2e-testing): at each dispatching turn, RENEW + verify the
  // executor's per-Hive work-item lease through the real authority-routed heartbeat.
  // `renewed:false` (lapsed / stolen by another Swarm) makes the pipeline self-abort
  // before its next side effect. FAIL-OPEN: any PG/authority error returns `renewed:true`
  // — the lease check must NEVER kill a live pipeline (the next turn re-checks; adoption
  // rule 2 is the backstop for an un-aborted zombie).
  setPipelineLeaseHeartbeatHook(({ harnessSlug, featureId, workspaceId, claim }) =>
    leaseHeartbeatFailOpen(async () => {
      const r = await heartbeatClaim({
        workspaceId: workspaceId ?? activeWorkspaceId(),
        harnessSlug,
        workItemId: featureId,
        potSlug: claim.potSlug,
        claimId: claim.claimId,
        owner: claim.owner,
        holderPubkey: claim.holderPubkey,
      });
      return { renewed: r.renewed, reason: r.reason };
    }),
  );
  // #1: a finished feature immediately refills its harness's freed slot with the
  // next queued feature, instead of waiting up to 30s for the periodic tick.
  setPipelineSettledHook((slug, workspaceId) =>
    refillHarnessOnSettle(slug, workspaceId ?? activeWorkspaceId()),
  );
  // B3 (non-collaborator-join-fork-pr P-002): when a feature ships in FORK MODE
  // (the local identity lacks upstream write), push the feature branch to the
  // contributor's fork + open a cross-fork PR. No-op in owner/integration mode
  // and for non-shared harnesses. Best-effort (handleFeaturePassed never throws).
  setPipelineFeaturePassedHook(async (input) => {
    await handleFeaturePassed(input, realFeaturePassedDeps);
  });
  // G2 P-007: wire the real auditor spawn + escalation functions so the
  // orchestrator loop's audit lane can screen remote-pending features.
  wireAuditorLane();
}

/**
 * spawnInvokeOnceWithFallback — the SPAWNER_SIDECAR-gated front door to the agent
 * spawn chokepoint (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Mirrors substrate's `bootSubstrateWithFallback`. OFF (the default + correct state
 * until the sidecar is wired + verified) ⇒ byte-identical in-process spawnInvokeOnce.
 * ON ⇒ ensure the spawner sidecar is up, then route the spawn over IPC so the
 * `child_process.spawn` of bee/queen children + the synchronous `buildInvokeOnce`
 * run in the sidecar process — OFF the bg-host main event loop that they currently
 * saturate (the ~24.5% main-loop CPU that freezes routinesTick). The mid-turn
 * signals the in-process path emits (child pid, output-activity) are delivered back
 * over the sidecar's push channel and re-fired into the SAME `opts` callbacks; an
 * `opts.signal` abort is forwarded as a `spawn:cancel` for the captured request id.
 *
 * INERT until deliberately wired: nothing calls this yet (operator-spawn.ts /
 * serve.ts / host-bootstrap.ts are wired by the orchestrator separately), and the
 * sidecar machinery is loaded via DYNAMIC import only on the ON path — so loading
 * orchestrator-runner.ts (the hot bg-host module) pulls in NONE of it. ANY error
 * (flag read, sidecar spawn, or the IPC call) falls back to in-process — the sidecar
 * is strictly optional, exactly like the substrate sidecar.
 *
 * Return type is unchanged (SpawnInvokeOnceResult); spawnInvokeOnce is NOT modified.
 */
export async function spawnInvokeOnceWithFallback(
  projectDir: string,
  role: string,
  extras: string[],
  extraEnv: Record<string, string>,
  opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    resultPath?: string;
    forceSessionId?: string;
    taskSpawnId?: string;
    onChildPid?: (pid: number) => void;
    onOutputActivity?: () => void;
  },
): Promise<SpawnInvokeOnceResult> {
  // A PRIOR sandboxed agent in this cwd may have left a 0-byte package.json (claude's
  // protected-file mask artifact). It is INVALID JSON, so the next Node-based agent
  // aborts at boot with ERR_INVALID_PACKAGE_CONFIG — i.e. the FIRST spawn into a fresh
  // app dir bricks it for every spawn after. invoke.ts heals its own spawns, but the
  // OPERATOR path (operator-spawn.ts -> here) never reached that call, so cups placed
  // into a template-materialized app died in ~5s, 100% of the time, with no signal
  // pointing at the cause. Measured 2026-08-09 on the P-010 canary: a Mug ran first and
  // left the artifact; the cup behind it failed instantly. Healing HERE covers both the
  // sidecar and in-process branches below, and every caller of this seam.
  healSandboxZeroByteManifest(projectDir, (m) => console.log(`[spawn-invoke] ${m}`));
  // v1 rollout control is a PER-HOST env opt-in (PAPERCUSP_SPAWNER_SIDECAR=1), NOT
  // the global papercusp-spawner-sidecar flag: post the 2026-06-29 flag-default
  // inversion that flag derives default-ON and is system-scope (global) + is not
  // settable via the MCP flags tool, so it can neither stage a per-host rollout nor
  // offer an off-switch. The env gate is set ONLY on the bg-host systemd unit (the
  // host whose main loop the spawn CPU saturates), default-unset everywhere else ⇒
  // byte-identical, instantly reversible (unset + restart). The flag stays registered
  // as a future global control once it is in DARK_FLAGS + the MCP enum.
  // WI-3793: routed through the shared isSidecarEnabledFromEnv (same guarded
  // pattern every node-child sidecar's enable-check now shares) instead of a
  // bare inline env read — closes the same latent self-fire gap host-bootstrap's
  // pre-warm check had; behavior is unchanged today (this codepath never runs
  // inside the sidecar's own re-exec'd child).
  const on = isSidecarEnabledFromEnv({
    enableVar: 'PAPERCUSP_SPAWNER_SIDECAR',
    modeVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
  });
  if (!on) {
    // Env unset (the default): in-process spawn, byte-identical to today.
    return spawnInvokeOnce(projectDir, role, extras, extraEnv, opts);
  }

  try {
    // Dynamic import keeps the sidecar machinery OFF the hot path's module graph —
    // it is loaded only when the flag is ON and this wrapper is actually called.
    const { spawnSpawnerSidecar } = await import('../fleet/spawner-sidecar-spawn');
    const { getSpawnerIpcClient } = await import('../fleet/spawner-ipc-client');

    await spawnSpawnerSidecar();
    const client = getSpawnerIpcClient();

    // Capture the request id the client assigns so an abort can cancel ACROSS the
    // IPC boundary (the sidecar holds the AbortController for that request id).
    let requestId: number | undefined;
    const onAbort = (): void => {
      if (requestId !== undefined) {
        void client.call('spawn:cancel', { requestId }).catch(() => {
          /* best-effort cancel; the timeout in the sidecar is the backstop */
        });
      }
    };
    const signal = opts?.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      return await client.call<SpawnInvokeOnceResult>(
        'spawn:invokeOnce',
        {
          projectDir,
          role,
          extras,
          extraEnv,
          timeoutMs: opts?.timeoutMs,
          resultPath: opts?.resultPath,
          forceSessionId: opts?.forceSessionId,
          taskSpawnId: opts?.taskSpawnId,
        },
        {
          onPid: opts?.onChildPid,
          onOutputActivity: opts?.onOutputActivity,
          onRequestId: (id) => {
            requestId = id;
          },
          // No client RPC timeout: spawn:invokeOnce resolves only when the bee EXITS
          // (the whole agent run, minutes). The sidecar's own spawn timeout is the
          // real bound; a fixed client timeout would spuriously fall back → double-spawn.
          timeoutMs: 0,
        },
      );
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    console.warn('[spawner-sidecar] fell back to in-process:', e);
    return spawnInvokeOnce(projectDir, role, extras, extraEnv, opts);
  }
}
