/**
 * Phase 3 (P-004) of `dbos-durable-jobs-2026-05-31` — the agent pipeline as a
 * DBOS durable workflow (sub-plan `dbos-orchestrator-durability-2026-05-31`).
 *
 * A feature's pipeline is a **dynamic dispatch loop**: each turn an orchestrator
 * agent decides the next role (`NEXT_WORKER` / `NEXT_VALIDATOR` / … / `DONE`), and
 * that role runs. Each agent run is a checkpointed DBOS **step** (driven through
 * `invoke()`'s `idempotencyKey`), so a crash resumes mid-pipeline without
 * re-running completed roles (parent D-019). The dispatch is deterministic given
 * the checkpointed step outputs (`parseDecision` is pure), so workflow replay is
 * safe (D-004) — all agent spawning + the LLM decision live INSIDE steps.
 *
 * Flag-gated by `PAPERCUSP_DBOS_ORCHESTRATOR=1` (registered only when the DBOS
 * bootstrap loads this). The legacy main loop stays the default + A/B fallback
 * (D-006). This handles the COMMON sequential pipeline; parallel lanes / branch
 * isolation / the synthesizer (P-008/P-009) still route through the legacy loop.
 *
 * The agent runner is injected (`setPipelineInvokeRunner`): the operator wires
 * the real `invoke()` (building the InvokeContext via harness-invoke-once);
 * tests inject a stub. This keeps the workflow free of operator/orchestrator
 * ctx-building and directly testable.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import { parseDecisionFor } from '@papercusp/orchestrator';
import { deriveNext, loadBuiltinBlueprint, type BlueprintSpine } from '@papercusp/orchestrator/blueprint';
import { runWithRateLimitTolerance } from './decide-rate-limit';
import { resolveSpawnBackendModel } from '../harness-invoke-once';
import type { WorkItemClaimLeaseHandle } from '../work-item-claim-lease-wiring';

export interface PipelineInput {
  harnessSlug: string;
  featureId: string;
  /** The primary/orchestrator role that decides the next action. Default 'director'. */
  orchestratorRole?: string;
  /**
   * Dispatch-epoch for this pipeline lifetime. DBOS will not re-enqueue a *completed*
   * workflow ID, so a feature-forever ID (`pipeline:<slug>:<feature>`) would let a
   * feature run exactly ONE pipeline ever — re-work after a prior SUCCESS (a reopen,
   * a failed-validation retry, a later feature edit) could never start a fresh
   * pipeline. The epoch — a monotonic per-feature counter the live caller sources
   * from PG — makes the workflow ID unique per lifetime; the `deduplicationID` still
   * guards a concurrent double-start *within* one epoch. See the sub-plan's
   * feature-ownership decision. Defaults to 0.
   */
  epoch?: number;
  /**
   * The workspace this pipeline runs in, CAPTURED at start time. The runner
   * resolves the harness in THIS workspace (not the volatile active one, which
   * can switch mid-pipeline via the desktop UI and break in-flight invokes —
   * observed ERRORing a real auto-dispatched run). Defaults to the active
   * workspace when unset (legacy callers).
   */
  workspaceId?: string;
  /**
   * The resolved blueprint spine that drives this pipeline (P-004). Optional —
   * defaults to the built-in `coding` spine (behavior-preserving; every harness
   * today is a coding harness). A non-coding harness (research, Phase E) resolves
   * its own blueprint and passes its spine here, so the SAME durable loop
   * interprets a different declared graph. Plain data → DBOS-serializable.
   */
  spine?: BlueprintSpine;
  /**
   * D-007 (shared-hive-loop-e2e-testing): the per-Hive work-item lease this pipeline runs
   * under, captured when the executor claimed one (the `WORKITEM_CLAIM_LEASE` flag ON).
   * Threaded so the pipeline can RENEW the lease and, before each side-effecting step,
   * SELF-ABORT if it was stolen/lapsed (heartbeat → `renewed:false`, rule 5). Absent when
   * the lease flag is off / the claim couldn't be taken (fail-open) → the heartbeat seam
   * is skipped, byte-identical to before. Plain data → DBOS-serializable.
   */
  claim?: WorkItemClaimLeaseHandle;
}

/**
 * One agent run. Returns the agent's final text + exit code. The operator wires
 * the real runner (it builds the InvokeContext + calls `invoke()` with
 * `options.idempotencyKey = key`, so a re-run of a completed agent is reused, not
 * re-spawned — P-015); tests inject a stub. `workspaceId` pins the resolution
 * workspace for the whole pipeline.
 */
export type PipelineInvokeRunner = (
  harnessSlug: string,
  role: string,
  featureId: string,
  idempotencyKey: string,
  /** Complete KEY=value extras for this agent run (e.g. FEATURE_ID=, VAL_ID=). */
  extras: string[],
  workspaceId?: string,
) => Promise<{
  output: string;
  exitCode: number;
  /**
   * TERMINAL (not transient): the harness no longer resolves — `resolveProject`
   * returned null because the harness was never registered, was torn down
   * (a gym throwaway `gymbaseline*` whose ephemeral registration is gone), or
   * the pipeline's captured workspace no longer resolves it. Distinct from a
   * plain `exitCode:1` empty result (crash / usage-limit / auth), which IS worth
   * retrying: an unresolvable harness can NEVER succeed on retry, so the workflow
   * must STOP cleanly instead of throw→retry-storm→ERROR (each retry spawns a
   * real agent subprocess that burns budget + orphans DB connections). WI-5630.
   */
  unresolvedHarness?: boolean;
}>;

// ── Injected pipeline hooks (runner + optional seams) — globalThis-backed ──────
// The operator injects these at boot (wireOrchestratorInvokeRunner → the setters
// below). They MUST survive the SAME double-module-load that idempotentRegisterWorkflow
// guards the workflow REGISTRATION against (WI-3830/WI-4015): under the tsx-direct boot
// entrypoint two instances of THIS module coexist in one process, DBOS runs the
// globalThis-cached `featurePipelineWorkflow` closure from instance A, but the operator
// wires the runner/hooks on instance B — so a plain module-level `let` slot on instance A
// stays null. The runner slot then throws "invoke runner not wired" (EI-10567 —
// deterministic on every gym-blueprint-cycle boot, invisible under the bundled esbuild
// entry that collapses to one instance); the fail-SOFT hooks (finalizer, debugger,
// test-digest, settled, feature-passed, lease-heartbeat) silently no-op, a worse quiet
// failure. Store every INJECTED slot on globalThis so both instances share ONE set — the
// same hot-reload-safe-singleton idiom as idempotent-register-workflow.ts. (`_codingSpine`
// below is deliberately NOT here: it is lazily DERIVED, identical per instance, so it has
// no cross-instance split.)
interface InjectedPipelineHooks {
  runner?: PipelineInvokeRunner;
  finalizer?: PipelineFinalizer;
  debuggerHook?: PipelineDebuggerHook;
  testDigestHook?: PipelineTestDigestHook;
  settledHook?: PipelineSettledHook;
  featurePassedHook?: PipelineFeaturePassedHook;
  leaseHeartbeatHook?: PipelineLeaseHeartbeatHook;
}
function pipelineHooks(): InjectedPipelineHooks {
  const g = globalThis as typeof globalThis & { __papercuspPipelineHooks__?: InjectedPipelineHooks };
  if (!g.__papercuspPipelineHooks__) g.__papercuspPipelineHooks__ = {};
  return g.__papercuspPipelineHooks__;
}

export function setPipelineInvokeRunner(fn: PipelineInvokeRunner): void {
  pipelineHooks().runner = fn;
}
function runner(): PipelineInvokeRunner {
  const r = pipelineHooks().runner;
  if (!r) {
    throw new Error('[dbos-orchestrator] invoke runner not wired — call setPipelineInvokeRunner() first');
  }
  return r;
}

/**
 * Terminal finalizer (P-001/P-002): runs the post-DONE curator/documenter/archive
 * (or the ESCALATE curator) when the pipeline reaches a terminal outcome. Injected
 * by the operator (orchestrator-runner) so the workflow stays free of I/O; when
 * unwired (tests, or before boot) finalization is skipped.
 */
export type PipelineFinalizer = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
  outcome: 'done' | 'escalate';
  reason?: string;
}) => Promise<void>;

export function setPipelineFinalizer(fn: PipelineFinalizer): void {
  pipelineHooks().finalizer = fn;
}

/**
 * Debugger-before-worker gate (P-012 / D-005). Fired immediately BEFORE a
 * `worker` dispatch: when the feature has failed enough times
 * (attempts ≥ `debugger.threshold`) and no debug note exists yet, the hook runs
 * the read-only `debugger` role so the worker then runs with the root-cause
 * analysis in context — making `director.md`'s standing promise true under DBOS.
 *
 * The hook does the guard-check AND the debugger-invoke INTERNALLY so the whole
 * thing is one checkpointed DBOS step (D-014 replay-safety: a guard in step A +
 * an invoke in step B would let a partial replay re-fire the debugger; here a
 * re-run re-checks the note the debugger itself writes, so it fires at most
 * once). Injected by the operator; unwired in tests → the gate is skipped.
 */
export type PipelineDebuggerHook = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
}) => Promise<{ fired: boolean }>;

export function setPipelineDebuggerHook(fn: PipelineDebuggerHook): void {
  pipelineHooks().debuggerHook = fn;
}

/**
 * Pre-validator test-digest hook (token-usage-reduction-audit-2026-06-09
 * P-010). Fired immediately BEFORE a `validator` dispatch: runs the harness's
 * configured test command (`knobs.testCommand`) DETERMINISTICALLY, digests the
 * result (exit code + summary + bounded failure excerpts) into a per-feature
 * text artifact, and returns extras to append to the validator spawn
 * (`TEST_DIGEST=<relpath> (…)`). The validator then reads the digest instead of
 * burning agentic turns running + re-reading the whole suite — its prompt
 * instructs it to spot-replay only specific failures. Best-effort by design:
 * no testCommand knob / hook unwired / run failure → empty extras and the
 * validator behaves exactly as before. The guard-check AND the test run happen
 * INSIDE one checkpointed step (the D-014 replay-safety shape the debugger
 * gate established).
 */
export type PipelineTestDigestHook = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
}) => Promise<{ extras: string[] }>;

export function setPipelineTestDigestHook(fn: PipelineTestDigestHook): void {
  pipelineHooks().testDigestHook = fn;
}

/**
 * On-completion refill seam (#1 — continuous dispatch). Fired when a feature's
 * pipeline finishes successfully so the freed concurrency slot can be filled
 * with the next queued feature IMMEDIATELY, instead of waiting up to 30s for the
 * periodic tick. Wired by the operator to `refillHarnessOnSettle`; unset in tests
 * (the hook is a no-op there). Deliberately NOT a checkpointed step — it's an
 * idempotent external nudge, harmless if re-fired on workflow replay.
 */
export type PipelineSettledHook = (harnessSlug: string, workspaceId?: string) => void;
export function setPipelineSettledHook(fn: PipelineSettledHook): void {
  pipelineHooks().settledHook = fn;
}

/**
 * Feature-passed hook (non-collaborator-join-fork-pr B3 / P-002). Fired once, as
 * a CHECKPOINTED step, when a feature's pipeline finishes with outcome `done`
 * (the feature shipped). The operator wires this to the fork-mode code→PR path:
 * in fork mode (the local identity lacks upstream write) it pushes the feature
 * branch to the contributor's fork and opens a cross-fork PR; in owner/
 * integration mode it is a no-op. Checkpointed (NOT fire-and-forget like the
 * settled hook) because opening a PR is an outward-facing effect that must run
 * exactly once per completion, not re-fire on workflow replay.
 *
 * MUST NOT THROW — best-effort. The handler swallows its own errors so a PR-open
 * failure never fails the (already-successful) pipeline. Unwired in tests → skipped.
 */
export type PipelineFeaturePassedHook = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
}) => Promise<void>;
export function setPipelineFeaturePassedHook(fn: PipelineFeaturePassedHook): void {
  pipelineHooks().featurePassedHook = fn;
}

/**
 * Lease-heartbeat hook (shared-hive-loop-e2e-testing D-007, rule 5). Fired at the top of
 * each DISPATCHING turn when the pipeline carries a work-item lease (`input.claim`):
 * RENEWS the lease AND reports whether it is still held. `renewed: false` means the lease
 * lapsed or another Swarm STOLE it — the workflow self-aborts BEFORE the next
 * side-effecting step, leaving the feature for the live holder (completion-adoption rule 2
 * is the backstop for an un-aborted zombie). This is the production wiring of the seam the
 * brief-11 rig proved (loop-agent.ts's `routeHeartbeat`); it RETIRES the orchestrator-loop
 * keep-alive re-acquire (the pipeline now keeps its own lease alive).
 *
 * The operator wires this to the real `heartbeatClaim` (routed through the per-Hive claim
 * authority), FAIL-OPEN on any PG/authority error (a transient blip must never kill a live
 * pipeline → it returns `renewed:true`; the next turn re-checks). Unwired in tests / no
 * `input.claim` → the seam is skipped entirely (byte-identical). Run inside a checkpointed
 * DBOS step, so workflow replay reuses the recorded result (deterministic).
 */
export type PipelineLeaseHeartbeatHook = (input: {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
  claim: WorkItemClaimLeaseHandle;
}) => Promise<{ renewed: boolean; reason?: string }>;
export function setPipelineLeaseHeartbeatHook(fn: PipelineLeaseHeartbeatHook): void {
  pipelineHooks().leaseHeartbeatHook = fn;
}

// The blueprint spine drives the dispatch loop: `deriveNext` replaces the legacy
// `classifyDecision` switch (P-004, D-002). Loaded lazily + memoized; every harness
// today is a coding harness, so the built-in `coding` spine is the behavior-preserving
// default — its `deriveNext` output is byte-equivalent to `classifyDecision`, proven
// across the whole verb vocabulary by derive-next-equivalence.test.ts. A non-coding
// harness (research, Phase E) passes its own resolved spine via PipelineInput.spine.
let _codingSpine: BlueprintSpine | null = null;
function codingSpine(): BlueprintSpine {
  // Owner-directed 2026-07-20: repointed the no-spine fallback from the RETIRED `coding-factory`
  // spine (director → the full NEXT_* verb vocabulary) to the LIVE `coding-solo` spine (decider
  // `worker`, DONE/ESCALATE/IDLE), matching the `codingFallback()` blueprint default above so a
  // blueprint-less harness's pipeline never falls back onto dead legacy code. The derive-next
  // equivalence invariant (derive-next-equivalence.test.ts) loads `coding-factory` DIRECTLY, so it
  // is unaffected by this runtime-fallback repoint.
  return (_codingSpine ??= loadBuiltinBlueprint('coding-solo').blueprint.spine);
}

const key = (slug: string, feature: string, role: string, turn: number): string =>
  `${slug}:${feature}:${role}:t${turn}`;

async function featurePipelineImpl(input: PipelineInput): Promise<string> {
  const spine = input.spine ?? codingSpine();
  // The decider role comes from the blueprint spine (research → 'research-director').
  // ⚠ NOT behavior-preserving for a spine-less input since the 2026-07-20 repoint above:
  // `codingSpine()` is `coding-solo`, whose decider is 'worker', NOT 'director' (WI-39505).
  const orchestratorRole = input.orchestratorRole ?? spine.decider;
  // The decider's verbs are the spine's OWN vocabulary (the edge keys), so a
  // non-coding harness (research) parses against its own verbs (D-002). ⚠ The
  // `codingSpine()` fallback is NO LONGER the 20 built-in coding verbs: `coding-solo`
  // inherits `single-agent`'s DONE/ESCALATE/IDLE only, so every NEXT_* verb misses its
  // edge and resolves through the `default: idle` branch below — the pipeline stops
  // after one decide turn. A caller that needs the multi-role graph must pass
  // `PipelineInput.spine` explicitly (which is how the DBOS tests pin it).
  // `edges` is optional since the coord-op program model landed (a program-mode
  // spine omits it). A program blueprint routes to `coordProgramWorkflow`, never
  // here, so `?? {}` is purely defensive (a misrouted program spine → no verbs →
  // the decider parse finds nothing → default idle, not a crash).
  const spineVerbs = Object.keys(spine.edges ?? {});
  // MAX_TURNS is now a blueprint knob (spine.maxTurns); the env var stays as an
  // operational override (behavior-preserving: unset → the coding spine's 200).
  const maxTurns = Number(process.env.PAPERCUSP_DBOS_PIPELINE_MAX_TURNS ?? spine.maxTurns);
  let lastVerb = 'NONE';
  // The terminal outcome to finalize after the loop (DONE → curator+documenter+
  // archive; ESCALATE → curator). null for IDLE / unsupported / max-turns (stop,
  // the dispatcher re-scans; no finalization).
  let terminal: { outcome: 'done' | 'escalate'; reason?: string } | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Step: the orchestrator agent decides the next action (checkpointed).
    // A failed/empty invoke must NOT look like a clean terminal decision:
    // parseDecision('') is null, which would break the loop and FALSE-SUCCESS
    // the pipeline with no work done (observed on a transient agent failure in
    // the real-agent gold-standard run). Throw so DBOS retries the step; after
    // the retries are exhausted the workflow ERRORs rather than false-succeeding.
    const decision = await DBOS.runStep(
      async () => {
        // Absorb a TRANSIENT 429 / overload in-process before it can look like a real
        // decision failure: the decide step's throw→DBOS-retry budget is tiny (3× over
        // ~15s), which a rate-limit blip under fleet/load can't clear — so a transient
        // 429 would ERROR the whole pipeline (the dominant cloud-frame failure mode). A
        // genuine failure (crash / empty / usage_limit / auth) still returns at once and
        // falls through to the throw below. See decide-rate-limit.ts.
        const r = await runWithRateLimitTolerance({
          run: () =>
            runner()(
              input.harnessSlug,
              orchestratorRole,
              input.featureId,
              key(input.harnessSlug, input.featureId, orchestratorRole, turn),
              [`FEATURE_ID=${input.featureId}`],
              input.workspaceId,
            ),
          backend: resolveSpawnBackendModel(orchestratorRole).backend,
          log: (m) => console.warn(`[dbos-decide] ${input.harnessSlug}/${input.featureId} ${m}`),
          maxAttempts: Number(process.env.PAPERCUSP_DECIDE_RL_MAX_ATTEMPTS) || undefined,
          maxTotalWaitMs: Number(process.env.PAPERCUSP_DECIDE_RL_MAX_WAIT_MS) || undefined,
        });
        // TERMINAL, not transient (WI-5630): the harness no longer resolves. Return
        // the sentinel WITHOUT throwing so DBOS does not retry (3× step + 10×
        // recovery) an invoke that can never succeed — the loop below stops cleanly.
        if (r.unresolvedHarness) return r;
        if (r.exitCode !== 0 || !r.output.trim()) {
          throw new Error(`decide invoke failed (exit=${r.exitCode}, empty=${!r.output.trim()})`);
        }
        return r;
      },
      { name: `decide-${turn}`, retriesAllowed: true, maxAttempts: 3, intervalSeconds: 5, backoffRate: 2 },
    );

    if (decision.unresolvedHarness) {
      // The harness is gone (a torn-down gym `gymbaseline*` throwaway, or a
      // captured workspace that no longer resolves it). Stop the pipeline cleanly:
      // no terminal outcome → no finalization, no ERROR. The dispatcher re-scans
      // for a real harness; a dead gym throwaway simply ends here without poisoning
      // the surrounding gym cycle (an ERRORed run can abort the cycle before any
      // proposal is recorded). WI-5630.
      lastVerb = 'HARNESS_UNRESOLVED';
      break;
    }

    const action = deriveNext(spine, parseDecisionFor(spineVerbs, decision.output), input.featureId);

    if (action.kind === 'terminal') {
      lastVerb = action.outcome.toUpperCase();
      if (action.outcome === 'done' || action.outcome === 'escalate') {
        terminal = { outcome: action.outcome, reason: action.reason };
      }
      break;
    }
    if (action.kind === 'unsupported') {
      // Global-only verb (parallel lanes, NEXT_HARNESS, CEO mode) — deliberately
      // not handled per-feature (D-001). Stop; the dispatcher owns cross-feature work.
      lastVerb = `UNSUPPORTED:${action.verb}`;
      break;
    }

    // D-007 (shared-hive-loop-e2e-testing P-004, rule 5): before any side-effecting
    // dispatch, RENEW + verify the work-item lease. `renewed:false` means the lease
    // lapsed or another Swarm STOLE it — self-abort before the next side effect, leaving
    // the feature for the live holder (completion-adoption rule 2 is the backstop for an
    // un-aborted zombie). One checkpointed step per dispatching turn, so it also keeps a
    // long legit pipeline's lease alive past its TTL (retiring the dispatch-loop keep-alive).
    // Skipped byte-identically when the pipeline carries no lease (flag off / fail-open) or
    // the hook is unwired (tests). `action.kind === 'dispatch'` is guaranteed here.
    const beat = pipelineHooks().leaseHeartbeatHook;
    if (input.claim && beat) {
      const claim = input.claim;
      const hb = await DBOS.runStep(
        () =>
          beat({
            harnessSlug: input.harnessSlug,
            featureId: input.featureId,
            workspaceId: input.workspaceId,
            claim,
          }),
        { name: `lease-heartbeat-${turn}` },
      );
      if (!hb.renewed) {
        lastVerb = `LEASE_LOST:${action.role.toUpperCase()}`;
        console.warn(
          `[dbos-pipeline] ${input.harnessSlug}/${input.featureId} lease not renewed ` +
            `(claim=${claim.claimId}; ${hb.reason ?? 'stolen/lapsed'}) — aborting before ` +
            `${action.role} (D-007 rule 5)`,
        );
        // No `terminal` set → NO finalize: the feature is NOT marked done/escalated; it
        // stays for the holder that stole the lease (or re-dispatch on a fresh epoch).
        break;
      }
    }

    // P-012: before a WORKER run, optionally fire the read-only debugger once
    // (attempts ≥ threshold + no debug note). The hook does the guard-check AND
    // the invoke inside this SINGLE checkpointed step — D-014 replay-safety.
    const dh = pipelineHooks().debuggerHook;
    if (action.role === 'worker' && dh) {
      const feature = action.feature;
      await DBOS.runStep(
        () => dh({ harnessSlug: input.harnessSlug, featureId: feature, workspaceId: input.workspaceId }),
        { name: `debugger-gate-${turn}` },
      );
    }

    // P-010 (token-usage-reduction): before a VALIDATOR run, deterministically
    // run the harness's test command and hand the validator a pre-digested
    // result artifact (TEST_DIGEST=… extra) so it spot-checks instead of
    // re-running + re-reading the whole suite. Guard + run are one checkpointed
    // step (D-014 replay-safety, mirroring the debugger gate above). Best-effort:
    // unwired hook / no testCommand → no extra appended.
    let dispatchExtras = action.extras;
    const th = pipelineHooks().testDigestHook;
    if (action.role === 'validator' && th) {
      const feature = action.feature;
      const digest = await DBOS.runStep(
        () => th({ harnessSlug: input.harnessSlug, featureId: feature, workspaceId: input.workspaceId }),
        { name: `test-digest-${turn}` },
      );
      if (digest.extras.length > 0) dispatchExtras = [...dispatchExtras, ...digest.extras];
    }

    // dispatch: run the role as an idempotent agent run (checkpointed).
    const dispatch = await DBOS.runStep(
      () =>
        runner()(
          input.harnessSlug,
          action.role,
          action.feature,
          key(input.harnessSlug, action.feature, action.role, turn),
          dispatchExtras,
          input.workspaceId,
        ),
      { name: `invoke-${action.role}-${turn}` },
    );
    if (dispatch.unresolvedHarness) {
      // Harness vanished between decide and this dispatch (a gym throwaway torn
      // down mid-pipeline). Stop cleanly rather than loop into another failing
      // decide next turn. WI-5630.
      lastVerb = 'HARNESS_UNRESOLVED';
      break;
    }
    lastVerb = action.role.toUpperCase();
  }

  // Finalize a terminal outcome (checkpointed → runs once, not re-run on replay).
  // Skipped cleanly when no finalizer is wired (tests / pre-boot).
  const fin = pipelineHooks().finalizer;
  if (terminal && fin) {
    const { outcome, reason } = terminal;
    await DBOS.runStep(
      () =>
        fin({
          harnessSlug: input.harnessSlug,
          featureId: input.featureId,
          workspaceId: input.workspaceId,
          outcome,
          reason,
        }),
      { name: `finalize-${outcome}` },
    );
  }

  // Refill the freed slot immediately on a successful finish (#1). Only on `done`:
  // a done feature leaves the NEEDS_WORK set, so the refill picks the NEXT queued
  // feature (never re-picks this one). escalate/idle/max-turns leave the feature
  // re-pickable, so those fall back to the 30s backstop to avoid a tight re-dispatch
  // loop. Fire-and-forget side effect (not a step) — idempotent if replayed.
  if (terminal?.outcome === 'done') {
    // Fork-mode code→PR (B3): in fork mode push the feature branch to the
    // contributor's fork + open a cross-fork PR. Checkpointed → runs exactly
    // once per completion (replay-safe), unlike the fire-and-forget settled
    // hook below. No-op in owner/integration mode and when unwired (tests). The
    // handler is best-effort (never throws), so a PR-open failure cannot fail
    // the already-successful pipeline.
    const fph = pipelineHooks().featurePassedHook;
    if (fph) {
      await DBOS.runStep(
        () =>
          fph({
            harnessSlug: input.harnessSlug,
            featureId: input.featureId,
            workspaceId: input.workspaceId,
          }),
        { name: 'feature-passed-pr' },
      );
    }
    pipelineHooks().settledHook?.(input.harnessSlug, input.workspaceId);
  }

  return `pipeline-complete (last=${lastVerb})`;
}

// WI-3830 (critical, 2026-07-10): a module-level DBOS.registerWorkflow call that gets
// evaluated a SECOND time in one process throws DBOSConflictingRegistrationError
// ("... is already registered") and takes the whole module load down with it — which
// broke EVERY fresh cup/bee spawn (fleet:place_batch AND plain cup:spawn both import
// this module), not just this one workflow. idempotentRegisterWorkflow caches the first
// registration on globalThis so a second load in the same process reuses it instead of
// re-registering. See idempotent-register-workflow.ts's doc comment for the full story.
export const featurePipelineWorkflow = idempotentRegisterWorkflow('featurePipeline', () =>
  DBOS.registerWorkflow(featurePipelineImpl, {
    name: 'featurePipeline',
    maxRecoveryAttempts: 10,
  }),
);

// WI-4015 (critical, 2026-07-11): the SAME module-top-level-DBOS-singleton class as
// WI-3830 above, but for `new WorkflowQueue(...)` — a second top-level evaluation of
// this module in one process throws "Workflow Queue 'feature-pipeline' defined
// multiple times" INSIDE startDbos()'s import chain, which host-bootstrap.ts's caller
// only logs as "[dbos] boot failed (non-fatal)" and swallows — so DBOS.launch() never
// completes and NO scheduled workflow (routinesTick included) ever arms fleet-wide,
// even though the process stays up. idempotentWorkflowQueue guards it the same way.
export const pipelineQueue = idempotentWorkflowQueue('feature-pipeline', () =>
  new WorkflowQueue('feature-pipeline', { concurrency: queueConcurrency(4) }),
);

/**
 * Start (or resume) a feature's durable pipeline. The workflow ID is deterministic
 * per (feature, epoch), so a re-dispatch *within the same epoch* resumes the same
 * workflow rather than starting a second one (the dedup ID guards concurrent
 * double-dispatch); a new epoch starts a fresh pipeline lifetime after a prior one
 * completed (DBOS will not re-enqueue a completed ID — see `PipelineInput.epoch`).
 */
export async function startFeaturePipeline(input: PipelineInput): Promise<string> {
  const workflowID = `pipeline:${input.harnessSlug}:${input.featureId}:e${input.epoch ?? 0}`;
  await DBOS.startWorkflow(featurePipelineWorkflow, {
    workflowID,
    queueName: pipelineQueue.name,
    enqueueOptions: { deduplicationID: workflowID },
  })(input);
  return workflowID;
}
