/**
 * Named, ordered, replaceable dispatch pipeline.
 *
 * The dispatcher's pre-handler gates (role, capability, quota), context
 * decorators (timeout, idle watchdog, replay buffer, ctx.emit/progress/
 * askUser/publishState/metadata wrappers), and handler-invoke step are
 * each one entry in a typed stack.
 *
 * The stack ordering is load-bearing (e.g. timeout must arm before
 * idle-watchdog because idle-watchdog races against the same
 * AbortController). The default order is exported as a constant and is
 * what production uses. Hosts can derive a customized stack by replacing
 * a step by name (`withReplacedStep`); inserting / removing steps is
 * intentionally not supported in v1 — the stack invariants are tighter
 * than that.
 *
 * Telemetry sits outside the stack: it runs in the orchestrator's
 * finally block with the final result, on every termination (gate
 * denial, success, error, timeout). Surfaces as `recordTelemetry()` here
 * so it stays co-located with the steps it observes.
 */

import type { ToolResult } from './wire';
import { applySeeAlso } from './see-also';
import { applyDenominator } from './denominator';
import { applyResultAnnotator } from './result-annotator';
import type { AgentRole } from './host-types';
import {
  PROJECTED_TOOL_REGISTRY_SOURCE,
  toolDeclaresGate,
  type AbortCompletionReceipt,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';
import {
  openBuffer as openReplayBuffer,
  type ReplayBufferWriter,
} from './replay-buffer';
import {
  cancelPendingCardsForRun,
  registerCard,
} from './card-correlator';
import { openRun, closeRun, setToolState } from './state-channel';
import type { CardResponse, CardSpec } from './types';
import { validateSync, formatIssues, type StandardSchemaV1 } from './standard-schema';
import { isLateCompletionSafeRead, tierFor } from './capability-tiers';
import {
  collectEntityRefs,
  formatEntityRefViolations,
  resolveEntityRefs,
} from './entity-ref';
import {
  PASS_THROUGH,
  HarnessRequiredError,
  InvalidInputError,
  UnauthorizedToolError,
  defaultComputeQuotaWindow,
  type CapabilityEnvelopeVerdict,
  type DispatchProjectedDeps,
  type DispatchProjectedErrorCode,
  type DispatchProjectedResult,
} from './dispatch-types';
import {
  appliedExecutionRevision,
  evaluateKernelEnforcement,
  isKernelDenied,
  type KernelBoundary,
  type KernelEnforcementPort,
  type KernelEnforcementResult,
  type KernelExecutionRevision,
  type KernelOwnershipRequirement,
} from './kernel-enforcement';
import { evaluateDataCondition } from '@papercusp/rules';
import type { ToolPreInvokeEvent, ToolRequireSpec } from './requires';
import { applyWorkspaceTxContract } from './workspace-tx';

/* ─── Step names ─────────────────────────────────────────────────────── */

export type DispatchStepName =
  | 'kernel-preflight'
  | 'default-deny'
  | 'role-allowlist'
  | 'capability-check'
  | 'capability-envelope'
  | 'role-requirement'
  | 'harness-check'
  | 'quota'
  | 'authorize'
  | 'preconditions'
  | 'entity-check'
  | 'timeout'
  | 'idle-watchdog'
  | 'replay-buffer'
  | 'ctx-bindings'
  | 'kernel-enforce'
  | 'invoke';

/* ─── Per-call mutable state ─────────────────────────────────────────── */

/**
 * Mutable state that flows between steps. Read-only fields are set at
 * init; mutable fields are written by specific steps (named in each
 * field's comment). Keeping this typed lets a future step author see
 * which prior steps they depend on without having to read the code.
 */
export interface DispatchExecution {
  // ─── set at init, never mutated ─────────────────────────────────────
  readonly tool: ProjectedTool;
  readonly toolName: string;
  readonly input: unknown;
  /** Original ctx as received by the dispatcher. */
  readonly ctx: UnifiedToolContext;
  readonly deps: DispatchProjectedDeps;
  /**
   * Per-call correlation id handed to BOTH `onDispatchStart` and
   * `recordInvocation`, so a host can open in-flight state at start and close
   * that exact entry at settle. See `DispatchStartEvent['callId']` for why no
   * existing ctx field can serve (they are all session-scoped).
   */
  readonly callId: string;
  readonly startedAt: number;
  /** Quota/telemetry window key, or null when ctx has no run/chunk to scope to. */
  readonly windowKey: string | null;
  /** Quota ceiling within the window, or null when the call is unlimited. */
  readonly quotaLimit: number | null;

  // ─── written by 'timeout' step ──────────────────────────────────────
  abort: AbortController;
  timeoutSec: number;

  // ─── written by 'idle-watchdog' step ────────────────────────────────
  idleSec: number;
  lastEmitMs: number;
  idleTimer: ReturnType<typeof setInterval> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;

  // ─── written by 'replay-buffer' step ────────────────────────────────
  bufferWriter: ReplayBufferWriter | null;

  // ─── written by 'ctx-bindings' step ─────────────────────────────────
  /** Bumped on every wrappedEmit call. Surfaced in telemetry. */
  eventCount: number;
  /** Per-call metadata accumulator. Most recent ctx.metadata() wins. */
  metadataJson: Record<string, unknown> | null;
  /** ctx with emit/progress/askUser/publishState/metadata wrappers applied. */
  handlerCtx: UnifiedToolContext;

  // ─── written by 'capability-envelope' step ──────────────────────────
  /** The capability-envelope verdict (B-06), threaded into the postInvoke event. Null until set. */
  envelopeVerdict: CapabilityEnvelopeVerdict | null;

  // ─── written by the P-041 kernel steps ──────────────────────────────
  /** Host decision observed before any dispatch decorators/side effects. */
  kernelPreflight: KernelEnforcementResult | null;
  /** Host decision observed immediately before invoke crosses the boundary. */
  kernelEnforcement: KernelEnforcementResult | null;
  /** Actual applied revision, suitable for handler/event/telemetry attribution. */
  executionRevision: KernelExecutionRevision | null;

  // ─── written by 'invoke' step ───────────────────────────────────────
  handlerResult: ToolResult | null;
}

/**
 * Per-call id source for `DispatchExecution.callId`.
 *
 * A process-local counter behind a random prefix, deliberately NOT a UUID: the
 * consumer is an in-process in-flight registry keyed per call, so uniqueness
 * WITHIN a process is the whole requirement, and this costs a string concat on
 * a hot path where `randomUUID()` would cost entropy. The prefix keeps two
 * processes' ids distinct if one is ever persisted or compared across a port.
 */
let callSeq = 0;
const CALL_ID_PREFIX = Math.random().toString(36).slice(2, 8);
function nextCallId(): string {
  callSeq += 1;
  return `${CALL_ID_PREFIX}-${callSeq.toString(36)}`;
}

function initExecution(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
): DispatchExecution {
  // EI-18808330244321407: enforce the tx contract before ANY gate or
  // authorizer can observe ctx. The final handler-decorator spread below
  // reapplies the guard because its getter is deliberately non-enumerable.
  const contractCtx = applyWorkspaceTxContract(tool, toolName, ctx);
  // Resolve the quota window + ceiling once, up front: the window key feeds
  // both the quota gate and telemetry, so it must be computed for every call
  // (not just quota'd ones). `roleQuota` is the tool's entry for this role.
  const roleQuota = contractCtx.role ? tool.rolesQuota?.[contractCtx.role] : undefined;
  const { key: windowKey, limit: quotaLimit } = (
    deps.computeQuotaWindow ?? defaultComputeQuotaWindow
  )(contractCtx, roleQuota, toolName, input);
  return {
    tool,
    toolName,
    input,
    ctx: contractCtx,
    deps,
    callId: nextCallId(),
    startedAt: Date.now(),
    windowKey,
    quotaLimit,
    abort: new AbortController(),
    timeoutSec: 0,
    idleSec: 0,
    lastEmitMs: 0,
    idleTimer: null,
    timeoutTimer: null,
    bufferWriter: null,
    eventCount: 0,
    metadataJson: null,
    handlerCtx: contractCtx,
    handlerResult: null,
    envelopeVerdict: null,
    kernelPreflight: null,
    kernelEnforcement: null,
    executionRevision: null,
  };
}

/* ─── Step contract ──────────────────────────────────────────────────── */

/**
 * A dispatch step. Returns:
 *   - `DispatchProjectedResult` to short-circuit the pipeline (gate
 *     denied, handler returned, handler errored, etc). Subsequent
 *     steps are skipped; telemetry runs on the returned result.
 *   - `null` to continue to the next step.
 */
export interface DispatchStep {
  name: DispatchStepName;
  run(exec: DispatchExecution): Promise<DispatchProjectedResult | null>;
}

/* ─── Steps ──────────────────────────────────────────────────────────── */

function kernelPort(exec: DispatchExecution): KernelEnforcementPort | undefined {
  return exec.deps.kernelEnforcement ?? exec.deps.kernelPolicy;
}

function kernelBoundaryFor(ctx: UnifiedToolContext): KernelBoundary {
  return ctx.kernelBoundary ?? ctx.dispatchBoundary ?? (ctx.reactionCause
    ? 'reaction'
    : ctx.codeMode || ctx.telemetrySurface === 'tools:invoke'
      ? 'indirect-dispatch'
      : 'dispatch');
}

function kernelRequestedRevision(ctx: UnifiedToolContext): KernelExecutionRevision | null {
  return ctx.requestedExecutionRevision ?? ctx.kernelState?.requestedRevision ?? null;
}

function kernelAppliedRevision(ctx: UnifiedToolContext): KernelExecutionRevision | null {
  return ctx.appliedExecutionRevision ?? ctx.kernelState?.appliedRevision ?? ctx.kernelState?.activation?.applied ?? null;
}

function kernelOwnership(ctx: UnifiedToolContext): KernelOwnershipRequirement | undefined {
  return ctx.kernelOwnership ?? ctx.kernelState?.ownership;
}

function kernelRequest(
  exec: DispatchExecution,
  phase: 'preflight' | 'enforce',
  ctx: UnifiedToolContext = exec.ctx,
): Parameters<KernelEnforcementPort>[0] {
  return {
    phase,
    boundary: kernelBoundaryFor(ctx),
    toolName: exec.toolName,
    capabilities: exec.tool.capabilities,
    args: exec.input,
    ctx,
    callId: exec.callId,
    appliedRevision: kernelAppliedRevision(ctx),
    requestedRevision: kernelRequestedRevision(ctx),
    ownership: kernelOwnership(ctx),
    operation: exec.toolName,
  };
}

function kernelDenial(
  exec: DispatchExecution,
  phase: 'preflight' | 'enforce',
  decision: KernelEnforcementResult,
): DispatchProjectedResult {
  const detail = decision.reason || decision.code || 'policy denied the operation';
  return {
    ok: false,
    error: {
      // Keep the established public authorization error code while preserving
      // the kernel-specific reason in structured metadata. Existing transports
      // therefore remain compatible, and operators can still distinguish a
      // stale/revoked kernel denial from a tool-level authorize denial.
      code: 'authorization_denied' as DispatchProjectedErrorCode,
      message: `Kernel ${phase} denied tool "${exec.toolName}": ${detail}`,
      meta: {
        tool: exec.toolName,
        kernelPhase: phase,
        kernelCode: decision.code ?? null,
        kernelDecision: decision,
      },
    },
  };
}

/**
 * P-041 preflight. This is intentionally the first stack entry: a host can
 * validate ownership, activation and revocation before any other gate or
 * decorator gets a chance to touch mutable state. An unwired port is a true
 * no-op, preserving the generic package's old behavior.
 */
const kernelPreflightStep: DispatchStep = {
  name: 'kernel-preflight',
  async run(exec) {
    const port = kernelPort(exec);
    if (!port) return null;
    const decision = await evaluateKernelEnforcement(port, kernelRequest(exec, 'preflight'));
    exec.kernelPreflight = decision;
    if (isKernelDenied(decision)) return kernelDenial(exec, 'preflight', decision);
    return null;
  },
};

/**
 * Default-deny gate (RFC tooldef-auth Phase 3, decision D1). Runs first.
 *
 * Opt-in via `deps.defaultDeny` (off = the legacy allow-by-omission posture, no behavior
 * change). When on, a tool that declares NO gate — no capabilities, no agent `roles`, no
 * `requireRoles`, no `authorize` — is denied as `ungated` UNLESS it sets `public: true`
 * (the explicit `[AllowAnonymous]` equivalent). This is the fail-closed "forgot to gate ⇒
 * deny" baseline the §8 audit (D1) committed to. NOT bypassable: an ungated tool is a
 * declaration gap regardless of caller — the fix is to declare a gate or mark it public.
 * `defineTool` requires `capability`, so first-party tools are never ungated; the targets
 * are plugin / direct registrations.
 */
const defaultDenyStep: DispatchStep = {
  name: 'default-deny',
  async run(exec) {
    const { tool, toolName, deps } = exec;
    if (!deps.defaultDeny || tool.public) return null;
    if (toolDeclaresGate(tool)) return null;
    return {
      ok: false,
      error: {
        code: 'ungated' as DispatchProjectedErrorCode,
        message: `Tool "${toolName}" declares no auth gate (capability/roles/requireRoles/authorize) and is not marked public; denied under default-deny`,
        meta: { tool: toolName },
      },
    };
  },
};

const roleAllowlistStep: DispatchStep = {
  name: 'role-allowlist',
  async run(exec) {
    const { tool, ctx, toolName, deps } = exec;
    if (!tool.agentRoles || !ctx.role || ctx.gateBypass?.role) return null;
    if (tool.agentRoles.includes(ctx.role as AgentRole)) return null;
    // The allowed-roles list says what WOULD be permitted, never where to get it —
    // so the caller is left to guess which surface carries one of those roles. Let
    // the host name the remedy, on the same seam the capability denial already uses.
    let hint: string | undefined;
    try {
      hint = deps.authorizationFailureHint?.({
        toolName,
        deniedRole: String(ctx.role),
        allowedRoles: tool.agentRoles,
        ctx,
      });
    } catch {
      hint = undefined; // a hint must never change the refusal it decorates
    }
    const denial = `Role "${ctx.role}" cannot call tool "${toolName}" (allowed roles: ${tool.agentRoles.join(', ')})`;
    return {
      ok: false,
      error: {
        code: 'role_not_allowed' as DispatchProjectedErrorCode,
        message: hint ? `${denial} — ${hint}` : denial,
      },
    };
  },
};

const capabilityCheckStep: DispatchStep = {
  name: 'capability-check',
  async run(exec) {
    const { tool, ctx, toolName, deps } = exec;
    const allowedTools = ctx.principal?.allowedTools;
    if (allowedTools !== undefined && !allowedTools.has(toolName)) {
      return {
        ok: false,
        error: {
          code: 'authorization_denied' as DispatchProjectedErrorCode,
          message:
            `Principal "${ctx.principal!.slug}" is not allowed to call tool "${toolName}" ` +
            '(not in its exact MCP tool allowlist)',
          meta: { tool: toolName, principal: ctx.principal!.slug, reason: 'tool_not_in_allowlist' },
        },
      };
    }
    if (!ctx.principal || ctx.gateBypass?.capability || tool.capabilities.length === 0) return null;
    for (const cap of tool.capabilities) {
      if (
        !ctx.principal.capabilities.has(cap) &&
        !ctx.principal.capabilities.has('*')
      ) {
        let hint: string | undefined;
        try {
          hint = deps.authorizationFailureHint?.({ toolName, missingCapability: cap, ctx });
        } catch {
          // Host guidance is advisory; never turn an authorization denial into
          // a handler failure because its formatter threw.
        }
        return {
          ok: false,
          error: {
            code: 'missing_capability' as DispatchProjectedErrorCode,
            message:
              `Principal "${ctx.principal.slug}" lacks capability "${cap}" (tool: ${toolName})` +
              (hint ? ` — ${hint}` : ''),
            meta: { tool: toolName, principal: ctx.principal.slug, missing: cap },
          },
        };
      }
    }
    return null;
  },
};

/**
 * Capability-envelope gate (agent-capability-confinement-2026-06-13 B-06 / P-012). The
 * cheap, static, per-role "may this caller do X at all" gate for the autonomous fleet —
 * the *capability gate* of the two-gate split (D-003), distinct from the Queen's rich
 * autonomy/decision gate. Pure mechanism: ALL policy (per-role allowlist, protected set,
 * SU/non-fleet exemptions, enforce-vs-observe) lives behind the host's
 * `deps.checkCapabilityEnvelope` port; this step only acts on the returned verdict.
 *
 * No-op when the port is unwired (behavior-neutral). FAIL-OPEN on an evaluator throw (the
 * OS sandbox is the containment backstop, D-006 — a bug here must not wedge the fleet).
 * The verdict is stashed on `exec.envelopeVerdict` and threaded into the postInvoke event
 * so the decision-ledger emit (P-011) records the action's posture. Runs right after
 * `capability-check` (both are cheap capability gates) and before the costlier
 * authorize/precondition gates.
 */
const capabilityEnvelopeStep: DispatchStep = {
  name: 'capability-envelope',
  async run(exec) {
    const { tool, toolName, input, ctx, deps } = exec;
    const port = deps.checkCapabilityEnvelope;
    if (!port) return null; // no policy wired ⇒ no-op (behavior-neutral)
    let verdict: CapabilityEnvelopeVerdict | null;
    try {
      verdict = await port({ toolName, capabilities: tool.capabilities, ctx, args: input });
    } catch (err) {
      // FAIL-OPEN (D-006): an evaluator bug must never wedge the fleet; the OS sandbox is the
      // containment backstop. Matches the quota gate's fail-open-on-error posture.
      // eslint-disable-next-line no-console
      console.warn(
        `[capability-envelope] evaluator threw for "${toolName}" (failing open): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!verdict) return null;
    exec.envelopeVerdict = verdict; // threaded into PostInvokeEvent for the decision-ledger emit
    if (verdict.decision === 'deny') {
      return {
        ok: false,
        error: {
          code: 'capability_denied' as DispatchProjectedErrorCode,
          message:
            verdict.reason ??
            `Tool "${toolName}" is outside role "${ctx.role ?? '(none)'}" capability envelope`,
          meta: { tool: toolName, role: ctx.role ?? null },
        },
      };
    }
    return null; // 'allow' | 'observe' ⇒ continue
  },
};

/**
 * RBAC role-requirement gate (RFC tooldef-auth Phase 2).
 *
 * A tool declaring `requireRoles` is callable only by a principal whose `roles` include
 * at least ONE of them (any-of) — the declarative, typed replacement for ad-hoc
 * `requireAdminKey`/`requireStaff` checks. Additive (a tool with no `requireRoles` is
 * unaffected). Fail-closed: an anonymous call (no principal) is DENIED, since a role
 * requirement can't be satisfied without an identity. Bypassed by `GateBypass.role` (a
 * superuser passes RBAC role gates as it passes the agent-role allowlist). Audited like
 * the other gates (gate:'role').
 */
const roleRequirementStep: DispatchStep = {
  name: 'role-requirement',
  async run(exec) {
    const { tool, ctx, toolName, deps } = exec;
    const required = tool.requireRoles;
    if (!required || required.length === 0 || ctx.gateBypass?.role) return null;
    const have = ctx.principal?.roles;
    if (have && required.some((r) => have.has(r))) return null;
    deps.auditAuth?.({
      ts: Date.now(),
      principal: ctx.principal ? { slug: ctx.principal.slug, workspaceId: ctx.principal.workspaceId } : null,
      tool: toolName,
      action: toolName,
      decision: 'deny',
      gate: 'role',
      reason: `requires one of role(s): ${required.join(', ')}`,
    });
    return {
      ok: false,
      error: {
        code: 'missing_role' as DispatchProjectedErrorCode,
        message: `Principal ${ctx.principal ? `"${ctx.principal.slug}"` : '(anonymous)'} lacks a required role for tool "${toolName}" (needs one of: ${required.join(', ')})`,
        meta: { tool: toolName, required, principal: ctx.principal?.slug ?? null },
      },
    };
  },
};

/**
 * Harness-required gate (su-prompt-audit-fixes P-020 / D-007).
 *
 * A tool declaring `harness: 'required'` (a CTX-ONLY harness-scoped tool —
 * one with no slug arg, so `ctx.harnessSlug` is its only harness source)
 * gets a UNIFORM `harness_required` error when no harness is resolvable —
 * i.e. `ctx.harnessSlug` is unset or the `'*'` wildcard (the superuser
 * "no harness picked" sentinel). This replaces the old per-handler grab-bag
 * (harness_not_registered / require-slug / primary-fallback / stub) with one
 * self-documenting message. Tools that accept an explicit slug self-resolve
 * and stay `'optional'`; the gate is a no-op for them.
 *
 * Fails closed even for privileged callers: a missing harness is a FUNCTIONAL
 * gap (the tool can't run), not a permission one, so superuser/power don't
 * bypass it. `gateBypass.papercusp` is an explicit per-call escape hatch only.
 */
const harnessCheckStep: DispatchStep = {
  name: 'harness-check',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    if (tool.harness !== 'required' || ctx.gateBypass?.harness) return null;
    const slug = ctx.harnessSlug?.trim();
    if (slug && slug !== '*') return null;
    return {
      ok: false,
      error: {
        code: 'harness_required' as DispatchProjectedErrorCode,
        message:
          `Tool "${toolName}" requires a harness. Pass a harness slug (e.g. via ` +
          `the spawn's ?harness= / X-Papercusp-Harness), or run \`harness:list\` ` +
          `and relaunch scoped to one. For a different harness use \`cross_harness:*\`.`,
        meta: { tool: toolName },
      },
    };
  },
};

const quotaStep: DispatchStep = {
  name: 'quota',
  async run(exec) {
    const { ctx, toolName, deps, windowKey, quotaLimit } = exec;
    // The host decides quota bypass (Papercusp: superuser yes, power-user no —
    // workspace quotas apply to end users; see omp-power-user-bundle-2026-05-20
    // §4.1, encoded in papercuspGateBypass). The engine just reads the signal.
    const quotaBypass = ctx.gateBypass?.quota ?? false;
    // The window key + ceiling were resolved at init by the host's
    // `computeQuotaWindow` policy (worker→chunk, power-user→session, …);
    // this step only enforces the count against the resolved limit.
    if (!windowKey || quotaLimit == null || quotaLimit <= 0 || !deps.readQuotaState || quotaBypass) {
      return null;
    }
    try {
      const state = await deps.readQuotaState(toolName, ctx, windowKey);
      if (state && state.count >= quotaLimit) {
        return {
          ok: false,
          error: {
            code: 'quota_exceeded' as DispatchProjectedErrorCode,
            message: `Tool "${toolName}" exceeded quota (${state.count}/${quotaLimit}) in window "${windowKey}"`,
            meta: { tool: toolName, role: ctx.role, windowKey, used: state.count, limit: quotaLimit },
          },
        };
      }
    } catch {
      // fail-open on PG error — matches pre-refactor behavior
    }
    return null;
  },
};

const timeoutStep: DispatchStep = {
  name: 'timeout',
  async run(exec) {
    exec.timeoutSec = exec.tool.timeoutSec ?? 60;
    const timer = setTimeout(() => exec.abort.abort(), exec.timeoutSec * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    exec.timeoutTimer = timer;
    // Compose any caller-supplied signal — caller-side aborts must still
    // propagate to the dispatcher's controller.
    if (exec.ctx.signal && !exec.ctx.signal.aborted) {
      exec.ctx.signal.addEventListener('abort', () => exec.abort.abort(), { once: true });
    }
    return null;
  },
};

const idleWatchdogStep: DispatchStep = {
  name: 'idle-watchdog',
  async run(exec) {
    exec.idleSec = exec.tool.idleTimeoutSec ?? 0;
    exec.lastEmitMs = Date.now();
    if (exec.idleSec > 0) {
      const checkMs = Math.max(1_000, Math.floor((exec.idleSec * 1000) / 4));
      const timer = setInterval(() => {
        if (exec.abort.signal.aborted) return;
        if (Date.now() - exec.lastEmitMs > exec.idleSec * 1000) exec.abort.abort();
      }, checkMs);
      if (typeof timer.unref === 'function') timer.unref();
      exec.idleTimer = timer;
    }
    return null;
  },
};

const replayBufferStep: DispatchStep = {
  name: 'replay-buffer',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    // State-shaped tools skip the ring buffer — their reconnect strategy
    // is "latest snapshot," not "event history."
    const replayCap = tool.state ? 0 : (tool.replayBufferSize ?? 0);
    if (replayCap > 0 && ctx.workspaceId && ctx.runId) {
      exec.bufferWriter = openReplayBuffer({
        workspaceId: ctx.workspaceId,
        toolName,
        runId: ctx.runId,
        capacity: replayCap,
        onEvict: (ev) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[replay-buffer] ${toolName}/${ctx.runId}: evicted event id=${ev.id} name=${ev.name} (capacity ${replayCap})`,
          );
        },
      });
    }
    return null;
  },
};

const ctxBindingsStep: DispatchStep = {
  name: 'ctx-bindings',
  async run(exec) {
    const { ctx, tool, toolName } = exec;

    // wrappedEmit — refreshes idle deadline + pushes into replay buffer
    // + bumps eventCount. Always installed; both features are conditional
    // inside.
    const wrappedEmit = (name: string, data: unknown): void => {
      if (exec.idleSec > 0) exec.lastEmitMs = Date.now();
      exec.eventCount += 1;
      if (exec.bufferWriter) exec.bufferWriter.push({ id: exec.eventCount, name, data });
      ctx.emit(name, data);
    };
    const wrappedProgress = (pct: number | undefined, msg?: string): void => {
      wrappedEmit('progress', {
        progress: typeof pct === 'number' ? pct : 0,
        total: 100,
        ...(msg ? { message: msg } : {}),
      });
    };

    // askUser — installed only when the caller explicitly proves it has an
    // interactive card responder, in addition to the workspace/run identity
    // needed for card-correlator cleanup. WorkspaceId + runId alone are also
    // present on headless/MCP/non-chat calls and must not make those callers
    // wait for a responder that does not exist.
    let askUser: UnifiedToolContext['askUser'] | undefined;
    if (ctx.interactiveCardCapability && ctx.workspaceId && ctx.runId) {
      const wsId = ctx.workspaceId;
      const runId = ctx.runId;
      openRun({ workspaceId: wsId, runId });
      askUser = async <TSchema extends StandardSchemaV1>(
        spec: CardSpec<TSchema>,
      ): Promise<CardResponse<TSchema>> => {
        const { correlationId, result } = registerCard({ workspaceId: wsId, runId, spec });
        // Surface the freshly-minted id so a caller can link an external
        // durable record (Phase D). Skip an idempotency-cache hit (no card was
        // registered — correlationId is the 'idempotent' sentinel).
        if (spec.onCard && correlationId !== 'idempotent') {
          try {
            spec.onCard({ correlationId, runId, workspaceId: wsId });
          } catch {
            /* onCard must never break the card flow */
          }
        }
        return await new Promise<CardResponse<TSchema>>((resolve) => {
          const onAbort = () => {
            exec.abort.signal.removeEventListener('abort', onAbort);
            resolve({ action: 'cancel' } as CardResponse<TSchema>);
          };
          if (exec.abort.signal.aborted) return onAbort();
          exec.abort.signal.addEventListener('abort', onAbort);
          void result.then((r) => {
            exec.abort.signal.removeEventListener('abort', onAbort);
            resolve(r);
          });
        });
      };
    }

    // publishState — installed only when (a) tool declared `state` and
    // (b) ctx has a workspaceId + runId.
    let publishState: UnifiedToolContext['publishState'] | undefined;
    if (tool.state && ctx.workspaceId && ctx.runId) {
      const stateSchema = tool.state;
      const runIdLocal = ctx.runId;
      publishState = (snapshot: unknown) => {
        if (Array.isArray(snapshot)) {
          throw new Error(
            'ctx.publishState v1 is snapshot-only; pass a full state object, not a JSON-Patch array',
          );
        }
        // Validate synchronously — publishState is fire-and-forget (tools call
        // it without await), so an async validator can't be supported here.
        const parsed = validateSync(stateSchema, snapshot);
        if (!parsed.ok) {
          throw new Error(
            `ctx.publishState: snapshot does not match tool.state schema: ${formatIssues(parsed.issues)}`,
          );
        }
        setToolState(runIdLocal, parsed.value);
      };
    }

    // metadata — overwrite-not-merge semantics, last write wins.
    const metadataCallback = (data: Record<string, unknown>): void => {
      exec.metadataJson = { ...data };
    };

    exec.handlerCtx = applyWorkspaceTxContract(tool, toolName, {
      ...ctx,
      dispatchCallId: exec.callId,
      signal: exec.abort.signal,
      emit: wrappedEmit,
      progress: wrappedProgress,
      metadata: metadataCallback,
      ...(askUser ? { askUser } : {}),
      ...(publishState ? { publishState } : {}),
    });

    return null;
  },
};

/**
 * P-041 final enforcement.  This is deliberately after all decorators have
 * prepared the handler context and immediately before `invoke`; a revocation
 * or permission reduction observed while a call was being prepared therefore
 * cannot be bypassed by a stale preflight result.
 */
const kernelEnforceStep: DispatchStep = {
  name: 'kernel-enforce',
  async run(exec) {
    const port = kernelPort(exec);
    if (!port) return null;
    const decision = await evaluateKernelEnforcement(
      port,
      kernelRequest(exec, 'enforce', exec.handlerCtx),
    );
    exec.kernelEnforcement = decision;
    if (isKernelDenied(decision)) return kernelDenial(exec, 'enforce', decision);

    // Only an explicitly applied enforce-phase revision is execution truth.
    // Desired/prepared values remain visible to the host result but can never
    // be stamped onto the handler context or telemetry as "what ran".
    exec.executionRevision = appliedExecutionRevision(decision, 'enforce');
    // The spread below is the LAST decorator spread before `invoke`, so it must
    // reapply the workspace-tx contract: `applyWorkspaceTxContract` installs
    // `tx` as a deliberately NON-ENUMERABLE getter, and object spread copies
    // only enumerable own properties — so spreading without reapplying DROPS
    // the guard entirely and `ctx.tx` then reads `undefined` in the handler
    // instead of throwing WorkspaceTxNotDeclaredError. That is fail-open: an
    // undeclared `ctx.tx` access stops being a loud contract error everywhere.
    exec.handlerCtx = applyWorkspaceTxContract(exec.tool, exec.toolName, {
      ...exec.handlerCtx,
      kernelPreflight: exec.kernelPreflight,
      kernelEnforcement: decision,
      executionRevision: exec.executionRevision,
      ...(exec.executionRevision ? { appliedExecutionRevision: exec.executionRevision } : {}),
    });
    return null;
  },
};

const invokeStep: DispatchStep = {
  name: 'invoke',
  async run(exec) {
    const { tool, toolName, input, handlerCtx, deps } = exec;
    try {
      let result: ToolResult;
      if (deps.overrideTool) {
        const ov = await deps.overrideTool(toolName, input, handlerCtx);
        if (ov !== PASS_THROUGH) {
          result = ov as ToolResult;
        } else {
          result = await tool.fn(input, handlerCtx);
        }
      } else {
        result = await tool.fn(input, handlerCtx);
      }
      // guidance.seeAlso — result-aware cross-link pointers rendered uniformly
      // into the envelope (_meta._seeAlso + a one-line "See also:" text block).
      // Self-gates (unchanged result) when the tool declares none / emits none /
      // errored; never fails the underlying tool call.
      result = applySeeAlso(result, exec.tool.guidance?.seeAlso, input, handlerCtx);
      // guidance.denominator — the base-rate stamp (EI-19375528138828761): what
      // this result MATCHED against the population it was drawn from, so a
      // filtered slice cannot be read as a census. Authored per-tool because
      // only the tool knows what it queried FROM; rendered here so every tool
      // spells it identically. Same self-gating/never-throw contract as seeAlso.
      result = applyDenominator(result, exec.tool.guidance?.denominator, input, handlerCtx);
      // Host ambient annotator (agent-managed-compaction P-013): the host may append a
      // banded context-usage gauge to EVERY result so a heads-down session that never
      // calls a coord tool still sees its usage. Default no-op; never throws.
      result = applyResultAnnotator(result, handlerCtx);
      // ok-on-abort race: the timeout/idle watchdog (or the caller's signal) fired
      // mid-handler, but the handler returned normally without observing
      // ctx.signal.aborted.
      //   - MUTATION (tier != 'low'): the abort stays AUTHORITATIVE — never report
      //     success for a possibly-cancelled write (the caller may have given up or
      //     re-dispatched). Surfaces as a timeout error.
      //   - IDEMPOTENT READ (tier 'low'): the completed result is valid +
      //     side-effect-free, so RETURN it. Discarding it wastes the read AND —
      //     under load, when wall-clock exceeds the timeout even for a CHEAP handler
      //     — floods the improvement-watchdog with false "tool errored" timeouts
      //     (the repeated-tool-error cluster: plans:list / plans:search /
      //     coord:inbox / activity:recent — EI-98/99/105/174/175). The 'low' tier IS
      //     the safety line: per the capability table it's an idempotent read /
      //     low-stakes call, never a governed mutation — so a completed one is safe
      //     to surface even past the deadline.
      if (exec.abort.signal.aborted) {
        // A handler may have cooperatively completed with an explicit failure after the
        // dispatcher was aborted. Preserve that result: capability:bash uses structuredContent
        // to report a child that was killed/timed out, and replacing it with the dispatcher's
        // generic timeout loses the definitive child state and makes code:run classify it as
        // uncertain. This does not weaken write safety: an explicit failure is never surfaced as
        // a success, while an apparent success below remains abort-authoritative for non-low
        // tools. MCP's isError is the equivalent failure signal for handlers without structured
        // content.
        const handlerReportedFailure =
          result.isError === true ||
          (result.structuredContent !== null &&
            typeof result.structuredContent === 'object' &&
            !Array.isArray(result.structuredContent) &&
            (result.structuredContent as { ok?: unknown }).ok === false) ||
          hasExplicitFailurePayload(result);
        // Effective tier from the tool's capabilities (host-registered resolver via
        // tierFor; defaults to 'low'). Low-tier READ ⟺ ≥1 declared capability AND
        // every one resolves to 'low' (the effective tier is the max). No declared
        // capability ⇒ treat as non-low (don't assume an ungated utility is a safe
        // read). `ProjectedTool` carries `capabilities`, not a precomputed `tier`.
        const caps = exec.tool.capabilities;
        // Host late-completion READ seam (WI-10004577): tier is a poor read signal (the host table
        // falls back to 'medium' for ~160 `*:read` tools, and tier also drives auth/watchdog), so
        // the host classifies safe-to-surface-late reads independently. Engine default: false.
        const isLowTierRead =
          (caps.length > 0 && caps.every((c) => tierFor(c) === 'low')) ||
          isLateCompletionSafeRead({ name: toolName, capabilities: caps, effect: exec.tool.effect });
        // Idempotent-completion opt-in (backend-reliability-100pct-2026-07-03 W6/P-007): a
        // MUTATION the tool DECLARES idempotent whose handler RAN TO COMPLETION is safe to
        // surface past the deadline — the write committed (the handler returned a result),
        // and re-applying an idempotent write can never double-effect, so reporting the
        // TRUTHFUL success (instead of a spurious `timeout`) is correct AND stops the agent
        // re-dispatching a write that already landed. This is the 280 `plans:set-status`
        // false-timeout fix: writes that COMMITTED but returned `timeout` because wall-clock
        // beat the deadline under load. Absent/false ⇒ the abort stays authoritative (below),
        // unchanged for every tool that has not opted in.
        const isIdempotentCompletion = exec.tool.idempotent === true;
        let attemptReceipt: AbortCompletionReceipt | null = null;
        if (exec.tool.abortCompletionReceipt) {
          try {
            attemptReceipt =
              exec.tool.abortCompletionReceipt(input, result, {
                callId: exec.callId,
                toolName,
              }) ?? null;
          } catch (error) {
            attemptReceipt = {
              status: 'recovery-incomplete',
              reason: `receipt resolver threw: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        const hasAuthoritativeAttemptReceipt =
          attemptReceipt?.status === 'recorded' || attemptReceipt?.status === 'not-recorded';
        if (!handlerReportedFailure && !isLowTierRead && !isIdempotentCompletion && !hasAuthoritativeAttemptReceipt) {
          const receipt = attemptReceipt ?? {
            status: 'recovery-incomplete' as const,
            reason: 'handler completed after abort without an authoritative attempt receipt',
          };
          return {
            ok: false,
            error: {
              code: 'timeout',
              message: `tool "${toolName}" exceeded timeout of ${exec.timeoutSec}s (handler returned but signal had aborted)`,
              meta: {
                abortCompletionReceipt: {
                  ...receipt,
                  attemptId: exec.callId,
                },
              },
            },
          };
        }
        if (attemptReceipt) {
          result = {
            ...result,
            _meta: {
              ...result._meta,
              abortCompletionReceipt: {
                ...attemptReceipt,
                attemptId: exec.callId,
              },
            },
          };
        }
        // Completed read — OR completed idempotent mutation — despite the abort: return it
        // directly. Skip the outputRef chunk-emit below — the stream is already aborted so
        // the client can't receive it (and emitting could re-throw into the catch); the
        // result still carries outputRef for a later fetch.
        exec.handlerResult = result;
        return { ok: true, result };
      }
      // outputRef auto-emit — the framework injects a `chunk` event
      // when the handler declared outputRef on its result.
      if (result.outputRef) {
        handlerCtx.emit('chunk', {
          ref: result.outputRef,
          ...(typeof result.outputSize === 'number' ? { byteSize: result.outputSize } : {}),
        });
      }
      exec.handlerResult = result;
      return { ok: true, result };
    } catch (err) {
      const isTimeout = exec.abort.signal.aborted;
      if (isTimeout) {
        return {
          ok: false,
          error: {
            code: 'timeout',
            message: `tool "${toolName}" exceeded timeout of ${exec.timeoutSec}s`,
            ...(exec.tool.abortCompletionReceipt
              ? {
                  meta: {
                    abortCompletionReceipt: {
                      status: 'recovery-incomplete',
                      reason: 'handler threw after the dispatch signal aborted before returning a receipt',
                      attemptId: exec.callId,
                    },
                  },
                }
              : {}),
          },
        };
      }
      // Match by stable `name` as well as instanceof: when the host loads a
      // second copy of this module (tsx/vite dual-instance), a handler's
      // UnauthorizedToolError is a DIFFERENT class object and instanceof is
      // false — without the name check the clean 401/precondition codes
      // degrade to a generic handler_error 500.
      const errName = (err as Error | null)?.name;
      if (err instanceof UnauthorizedToolError || errName === 'UnauthorizedToolError') {
        return { ok: false, error: { code: 'unauthorized', message: (err as Error).message } };
      }
      if (err instanceof HarnessRequiredError || errName === 'HarnessRequiredError') {
        return { ok: false, error: { code: 'harness_required', message: (err as Error).message } };
      }
      // Schema-validation failure thrown by defineTool's projected fn (or any
      // handler-level input check). Coding it `invalid_input` (400) instead of
      // `handler_error` (500) keeps caller mistakes out of the structural
      // tool-error telemetry class (EI-334's false-fire leg).
      if (err instanceof InvalidInputError || errName === 'InvalidInputError') {
        const meta = extractInvalidInputErrorMetadata(err);
        return {
          ok: false,
          error: {
            code: 'invalid_input',
            message: (err as Error).message,
            ...(meta ? { meta } : {}),
          },
        };
      }
      const postgresMeta = extractPostgresErrorMetadata(err);
      return {
        ok: false,
        error: {
          code: 'handler_error',
          message: err instanceof Error ? err.message : String(err),
          ...(postgresMeta ? { meta: postgresMeta } : {}),
        },
      };
    }
  },
};

const POSTGRES_SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const POSTGRES_METADATA_STRING_MAX = 256;

function extractInvalidInputErrorMetadata(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = (error as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const row = metadata as Record<string, unknown>;
  if (
    row.source !== PROJECTED_TOOL_REGISTRY_SOURCE ||
    typeof row.registryRevision !== 'string' ||
    typeof row.toolName !== 'string' ||
    !Array.isArray(row.corrections)
  ) return undefined;
  return { invalidInput: metadata };
}

/**
 * Extract the stable, low-cardinality identity of a postgres-js error.
 *
 * Handler errors deliberately stay `handler_error` at the dispatch level, but
 * postgres-js exposes SQLSTATE as `code` and the violated constraint as
 * `constraint`. Keep those fields in structured telemetry so consumers do not
 * have to parse the human-facing error message. Do not copy the complete error
 * object: it may contain query text, values, or driver internals.
 */
function extractPostgresErrorMetadata(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const fields = error as Record<string, unknown>;
  const rawCode = typeof fields.code === 'string' ? fields.code.toUpperCase() : undefined;
  const sqlState = rawCode && POSTGRES_SQLSTATE_RE.test(rawCode) ? rawCode : undefined;
  const rawConstraint = fields.constraint ?? fields.constraint_name;
  const constraintName =
    typeof rawConstraint === 'string' && rawConstraint.length > 0
      ? rawConstraint.slice(0, POSTGRES_METADATA_STRING_MAX)
      : undefined;
  if (!sqlState && !constraintName) return undefined;
  return {
    postgres: {
      ...(sqlState ? { sqlState } : {}),
      ...(constraintName ? { constraintName } : {}),
    },
  };
}

/**
 * Resource-`authorize` gate (RFC tooldef-auth Phase 1b, decision D-F).
 *
 * Runs a tool's `authorize` hook — the fine-grained "can THIS principal act on THIS
 * resource" layer the coarse gates can't express. Additive: a tool with no `authorize`
 * is unaffected. Fail-closed (a throw denies). Sits with the other gates (before timer
 * arming) so denials stay cheap and so it composes with `GateBypass` like its siblings.
 *
 * `GateBypass.policy` (default off, and NOT implied by the role/capability/quota
 * bypasses) skips the hook — but the skip is AUDITED, never silent: break-glass best
 * practice is "policy-governed + mandatorily logged" (RFC §8 D2). Every allow, deny, and
 * bypass emits an `AuthAuditEvent` via `deps.auditAuth`.
 */
const authorizeStep: DispatchStep = {
  name: 'authorize',
  async run(exec) {
    const { tool, toolName, input, ctx, deps } = exec;
    const authorize = tool.authorize;
    if (!authorize) return null; // no resource gate on this tool

    const audit = (decision: 'allow' | 'deny', reason?: string) => {
      deps.auditAuth?.({
        ts: Date.now(),
        principal: ctx.principal
          ? { slug: ctx.principal.slug, workspaceId: ctx.principal.workspaceId }
          : null,
        tool: toolName,
        action: toolName,
        decision,
        gate: 'authorize',
        reason,
      });
    };

    const deny = (reason: string | undefined): DispatchProjectedResult => ({
      ok: false,
      error: {
        code: 'authorization_denied' as DispatchProjectedErrorCode,
        message: reason ?? `Not authorized to call tool "${toolName}"`,
        meta: { tool: toolName, principal: ctx.principal?.slug ?? null },
      },
    });

    // Audited break-glass: skip the hook, but record the bypass.
    if (ctx.gateBypass?.policy) {
      audit('allow', 'gateBypass.policy');
      return null;
    }

    let decision;
    try {
      decision = await authorize({ principal: ctx.principal, input, ctx });
    } catch (err) {
      const reason = `authorize threw: ${err instanceof Error ? err.message : String(err)}`;
      audit('deny', reason);
      return deny(reason);
    }
    if (!decision.allow) {
      audit('deny', decision.reason);
      return deny(decision.reason);
    }
    audit('allow', decision.reason);
    return null;
  },
};

/**
 * Declarative-preconditions gate (autoloop-pot-operator-rebuild D-006) — the
 * preInvoke mirror of `emits:`. Evaluates each `requires:` spec's declarative
 * condition (a `@papercusp/rules` DataCondition over `{ tool, args, ctx,
 * state }`) and, on failure, either REJECTS (`precondition_failed`) or
 * AUTO-CORRECTS: fires the spec's corrective tool through the host's
 * injectable `deps.firePrecondition` port, re-resolves state, re-evaluates
 * ONCE, and rejects if it still fails. Auto-corrections + denials are audited
 * (gate:'precondition') — visible, never silent. Fail-closed throughout: a
 * throwing state resolver / evaluator / fire port denies the call.
 *
 * Runs AFTER `authorize` (cheap declarative checks shouldn't preempt the
 * audited auth chain, and a corrective fire must only happen for an
 * authorized caller) and BEFORE `timeout` (it's a gate — no timers/buffers
 * exist yet on the deny path).
 *
 * Safety invariants stay imperative code (D-007) — `requires:` is for
 * functional preconditions only. See `ToolRequireSpec`.
 */
const preconditionsStep: DispatchStep = {
  name: 'preconditions',
  async run(exec) {
    const { tool, toolName, input, ctx, deps } = exec;
    const requires = tool.requires;
    if (!requires || requires.length === 0) return null;

    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const eventCtx = ctx as unknown as ToolPreInvokeEvent['ctx'];

    const audit = (decision: 'allow' | 'deny', requireId: string, reason: string) => {
      deps.auditAuth?.({
        ts: Date.now(),
        principal: ctx.principal
          ? { slug: ctx.principal.slug, workspaceId: ctx.principal.workspaceId }
          : null,
        tool: toolName,
        action: toolName,
        decision,
        gate: 'precondition',
        reason: `[require:${requireId}] ${reason}`,
      });
    };

    const deny = (requireId: string, message: string, meta?: Record<string, unknown>): DispatchProjectedResult => ({
      ok: false,
      error: {
        code: 'precondition_failed' as DispatchProjectedErrorCode,
        message,
        meta: { tool: toolName, require: requireId, ...meta },
      },
    });

    for (let i = 0; i < requires.length; i++) {
      const spec: ToolRequireSpec = requires[i];
      const requireId = spec.id ?? String(i);
      const failMessage =
        spec.error ?? `Tool "${toolName}" precondition "${requireId}" not met`;

      // Evaluate once: resolve state (fail-closed on a throw), then run the
      // declarative condition over the pre-invoke event.
      const evaluate = async (): Promise<{ holds: boolean; event: ToolPreInvokeEvent }> => {
        let state: Record<string, unknown> = {};
        if (spec.state) state = await spec.state(args, eventCtx);
        const event: ToolPreInvokeEvent = { tool: toolName, args, ctx: eventCtx, state };
        return { holds: evaluateDataCondition(spec.when, event), event };
      };

      let first;
      try {
        first = await evaluate();
      } catch (err) {
        const reason = `precondition evaluation threw: ${err instanceof Error ? err.message : String(err)}`;
        audit('deny', requireId, reason);
        return deny(requireId, `${failMessage} (${reason})`);
      }
      if (first.holds) continue;

      // Failed. Auto-correct path: fire the corrective tool, retry once.
      if (spec.fire) {
        if (!deps.firePrecondition) {
          const reason = `auto-correct fire "${spec.fire}" declared but host wired no firePrecondition port`;
          audit('deny', requireId, reason);
          return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
        }
        try {
          const fireArgs = spec.render ? spec.render(first.event) : {};
          await deps.firePrecondition({
            fire: spec.fire,
            args: fireArgs,
            trigger: toolName,
            requireId,
            ctx: eventCtx,
          });
        } catch (err) {
          const reason = `auto-correct fire "${spec.fire}" failed: ${err instanceof Error ? err.message : String(err)}`;
          audit('deny', requireId, reason);
          return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
        }
        // then: 'retry' — re-resolve state, re-evaluate once.
        let retry;
        try {
          retry = await evaluate();
        } catch (err) {
          const reason = `retry evaluation threw after auto-correct "${spec.fire}": ${err instanceof Error ? err.message : String(err)}`;
          audit('deny', requireId, reason);
          return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
        }
        if (retry.holds) {
          // Visible success: the call proceeds, but the correction is audited.
          audit('allow', requireId, `auto-corrected via "${spec.fire}" + retry`);
          continue;
        }
        const reason = `still failing after auto-correct "${spec.fire}"`;
        audit('deny', requireId, reason);
        return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
      }

      // Plain reject.
      audit('deny', requireId, 'condition not met');
      return deny(requireId, failMessage);
    }
    return null;
  },
};

/**
 * Per-tool cache of the entity-reference SITES in its args schema. The walk is
 * structural (schema-shaped, not value-shaped), so it is computed once on the
 * first call for a tool and reused for every later one — the per-call cost is
 * then just the resolver lookups, which are themselves batched per kind.
 */
const ENTITY_SITES = new WeakMap<object, ReturnType<typeof collectEntityRefs>>();

function entitySitesFor(tool: { args?: unknown }): ReturnType<typeof collectEntityRefs> {
  const key = (tool.args ?? tool) as object;
  const cached = ENTITY_SITES.get(key);
  if (cached) return cached;
  let sites: ReturnType<typeof collectEntityRefs> = [];
  try {
    sites = tool.args ? collectEntityRefs(tool.args) : [];
  } catch {
    sites = []; // a schema shape we cannot walk is simply unvalidated
  }
  ENTITY_SITES.set(key, sites);
  return sites;
}

/**
 * Referential-integrity gate for args that NAME A DURABLE ENTITY
 * (tool-arg-referential-integrity-2026-07-19 P-002 / D-001).
 *
 * An arg declared with `entityRef(kind)` must identify something that EXISTS.
 * JSON Schema cannot express that (it is deliberately I/O-free), so the check
 * lives here, where a host resolver is reachable. Values are grouped by kind
 * and each resolver is consulted ONCE per call (DataLoader-style), so the
 * common case — a host answering from a process-local `Set` — costs no queries
 * at all.
 *
 * Placement: after `preconditions`, before `timeout`. It must not run before
 * the auth gates, because the corrective message names near-matches and can
 * name the valid set — telling an UNAUTHORIZED caller which pots exist would
 * leak the entity namespace. It runs before `invoke` so a bad reference never
 * reaches a handler that would persist it.
 *
 * FAILS OPEN by construction (see resolveEntityRefs): an unregistered kind or a
 * throwing resolver yields no violations. This layer improves diagnostics and
 * catches agent-invented values; the DATABASE's foreign keys remain the
 * authoritative backstop, and an outage in the lookup path must never take down
 * every tool that happens to name an entity. `soft: true` refs warn rather than
 * reject, so a host can adopt the type broadly before its data is clean.
 */
const entityCheckStep: DispatchStep = {
  name: 'entity-check',
  async run(exec) {
    const { tool, toolName, input } = exec;
    const sites = entitySitesFor(tool as { args?: unknown });
    if (!sites.length) return null;

    let violations: Awaited<ReturnType<typeof resolveEntityRefs>>;
    try {
      violations = await resolveEntityRefs(sites, input);
    } catch {
      return null; // fail open — never the reason a tool dies
    }
    if (!violations.length) return null;

    const hard = violations.filter((v) => !v.soft);
    if (!hard.length) {
      // Soft-only ⇒ the call PROCEEDS, but it must not proceed SILENTLY: the
      // entire point of `soft` is to observe how much real traffic a kind would
      // reject before flipping it hard. A soft violation nobody can see makes
      // the staged rollout unmeasurable and the flip a guess.
      exec.ctx.log?.(
        `[entity-check] ${toolName}: ${formatEntityRefViolations(violations)} ` +
          `(soft — allowed through; this WOULD be rejected once the ref is hard)`,
      );
      return null;
    }

    return {
      ok: false,
      error: {
        code: 'invalid_input' as DispatchProjectedErrorCode,
        message: `${toolName}: ${formatEntityRefViolations(hard)}`,
        meta: {
          tool: toolName,
          violations: hard.map((v) => ({ path: v.path, kind: v.kind, value: v.value })),
        },
      },
    };
  },
};

/* ─── Default stack ──────────────────────────────────────────────────── */

/**
 * Default ordered stack the dispatcher runs. Steps execute in this order;
 * the first one to return a `DispatchProjectedResult` short-circuits.
 *
 * Ordering invariants:
 *   - `kernel-preflight` is first so ownership/activation/revocation can be
 *     checked before any other gate, decorator, or handler side effect.
 *   - All gates (role / capability / harness / quota / authorize /
 *     preconditions) come first so denials are cheap (no timer arming, no
 *     buffer allocation, no ctx wrappers). `authorize` runs last among the
 *     AUTH gates — it is the finest-grained and may touch the resource.
 *   - `preconditions` (declarative `requires:` — D-006) runs after
 *     `authorize` and before `timeout`: a corrective auto-fire must only
 *     happen for an authorized caller, and a functional precondition should
 *     not mask an auth denial.
 *   - `entity-check` (referential integrity for `entityRef` args) runs
 *     after `preconditions` and before `timeout`: its corrective message can
 *     name near-matches and the valid set, so it must never run for an
 *     unauthorized caller (that would leak the entity namespace), and it must
 *     run before `invoke` so a bad reference never reaches a handler.
 *   - `timeout` arms the AbortController; every subsequent step that
 *     races against it depends on this having run.
 *   - `idle-watchdog` runs after `timeout` so it composes with the same
 *     controller. It also runs before `ctx-bindings` because the wrapped
 *     emit refreshes `lastEmitMs`.
 *   - `replay-buffer` runs before `ctx-bindings` because the wrapped
 *     emit pushes into the buffer.
 *   - `ctx-bindings` is the last decorator before `kernel-enforce`.
 *   - `kernel-enforce` is immediately before `invoke`, so a changed policy
 *     cannot be hidden behind a stale preflight result.
 *   - `invoke` is always terminal.
 */
export const DEFAULT_DISPATCH_STACK: ReadonlyArray<DispatchStep> = Object.freeze([
  kernelPreflightStep,
  defaultDenyStep,
  roleAllowlistStep,
  capabilityCheckStep,
  capabilityEnvelopeStep,
  roleRequirementStep,
  harnessCheckStep,
  quotaStep,
  authorizeStep,
  preconditionsStep,
  entityCheckStep,
  timeoutStep,
  idleWatchdogStep,
  replayBufferStep,
  ctxBindingsStep,
  kernelEnforceStep,
  invokeStep,
]);

// Exhaustive by step name: adding a step requires classifying it for preflight.
// Derive gate order from the actual default stack, never maintain a second stack.
const PREFLIGHT_STEP: Record<DispatchStepName, boolean> = {
  'kernel-preflight': true, 'default-deny': true, 'role-allowlist': true,
  'capability-check': true, 'capability-envelope': true, 'role-requirement': true,
  'harness-check': true, quota: true, authorize: true, preconditions: true,
  'entity-check': true, timeout: false, 'idle-watchdog': false,
  'replay-buffer': false, 'ctx-bindings': false, 'kernel-enforce': true, invoke: false,
};

/**
 * Re-evaluate canonical gates against the supplied ORIGINAL context, without
 * taking ownership of its run. No handler, corrective tool, timer, replay/card
 * lifecycle, invocation receipt or reaction is run. Gate audits remain enabled.
 * `allowed` is a preflight observation, never evidence of execution or a grant
 * for a later mutation (which must recheck authority).
 */
export async function preflightDispatchStack(
  tool: ProjectedTool, toolName: string, input: unknown,
  ctx: UnifiedToolContext, deps: DispatchProjectedDeps,
): Promise<{ allowed: boolean; error?: DispatchProjectedResult['error'] }> {
  const exec = initExecution(tool, toolName, input, ctx, {
    ...deps, firePrecondition: undefined,
  });
  for (const step of DEFAULT_DISPATCH_STACK) {
    if (!PREFLIGHT_STEP[step.name]) continue;
    const result = await step.run(exec);
    if (result) {
      // These seats normally retain their verdict through invocation telemetry.
      // A preflight owns no invocation, so preserve refusals via the existing
      // auth audit sink instead. Other gates already emit their own audit.
      if (step.name === 'kernel-preflight' || step.name === 'kernel-enforce' ||
          step.name === 'capability-envelope') {
        deps.auditAuth?.({
          ts: Date.now(),
          principal: ctx.principal
            ? { slug: ctx.principal.slug, workspaceId: ctx.principal.workspaceId } : null,
          tool: toolName, action: toolName, decision: 'deny',
          gate: step.name === 'capability-envelope' ? 'capability' : 'authorize',
          reason: `[preflight:${step.name}] ${result.error?.message ?? 'policy refused'}`,
        });
      }
      return { allowed: false, error: result.error };
    }
  }
  return { allowed: true };
}

/* ─── Customization ──────────────────────────────────────────────────── */

/**
 * Derive a stack from the default with one step replaced by name. The
 * returned array is the same length and in the same order — only the
 * named step's `run` is swapped. Hosts override e.g. quota for an
 * embedded test environment, or invoke to slip in a profiler.
 *
 * Insertion / removal is intentionally not supported in v1: the
 * ordering invariants documented on `DEFAULT_DISPATCH_STACK` are tight,
 * and a single replaceable position is the smallest knob that proves
 * the surface is real.
 */
export function withReplacedStep(
  stack: ReadonlyArray<DispatchStep>,
  name: DispatchStepName,
  replacement: DispatchStep['run'],
): ReadonlyArray<DispatchStep> {
  let found = false;
  const out = stack.map((s) => {
    if (s.name === name) {
      found = true;
      return { name, run: replacement };
    }
    return s;
  });
  if (!found) {
    throw new Error(`withReplacedStep: no step named "${name}" in stack`);
  }
  return Object.freeze(out);
}

/* ─── Telemetry (always runs in finally) ─────────────────────────────── */

/** Max chars of a refusal code persisted to the error_code column. */
const REFUSAL_CODE_MAX = 80;
/** Max chars of a self-reported refusal message persisted to error_message. */
const REFUSAL_MESSAGE_MAX = 512;
const REFUSAL_FALLBACK_CODE = 'handler_refusal';
const REFUSAL_FALLBACK_MESSAGE = 'tool returned isError=true without a structured refusal message';

/**
 * Maximum soft-failure reason retained in per-call telemetry.
 *
 * Reasons are operator-authored category labels in normal use, but the result is
 * still handler-controlled input on a hot, append-only ledger. Bounding it here
 * prevents one accidental payload/message from turning metadata_json into a
 * second result store. The watchdog hashes the bounded value for its stable key.
 */
export const SOFT_FAILURE_REASON_MAX = 512;

export interface SoftFailureOutcomeMetadata {
  resultOutcome: 'soft-failure';
  softFailureReason: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Detect the explicit failure marker on a serialized ToolResponse.
 *
 * Nested code-mode dispatches request lossless JSON text rather than
 * `structuredContent`, so a handler returning `{ data: { ok: false, ... } }`
 * reaches this stack as a ToolResult whose first text item contains the
 * serialized data. Preserve that definitive failure after an abort just as we
 * preserve `isError` and structured `ok:false`; an apparent success remains
 * subject to the abort-authoritative tier/idempotency checks below.
 *
 * This intentionally reads only the first JSON text item and only an exact
 * top-level `ok:false` object. It does not infer failure from nested fields,
 * prose, or arbitrary compact encodings.
 */
function hasExplicitFailurePayload(result: Pick<ToolResult, 'content'>): boolean {
  const firstText = result.content.find(
    (item): item is Extract<ToolResult['content'][number], { type: 'text' }> => item.type === 'text',
  );
  if (!firstText) return false;
  try {
    const parsed = JSON.parse(firstText.text) as unknown;
    return objectRecord(parsed)?.ok === false;
  } catch {
    return false;
  }
}

/**
 * Extract the conventional successful-call / unsuccessful-effect outcome.
 *
 * `status` deliberately remains CALL-level: a handler that returned a valid
 * ToolResult succeeded as a call. This adds a separate, queryable EFFECT-level
 * outcome for the house `{ ok:false, reason:'category' }` convention.
 *
 * Structured content is authoritative when it is an object. Only when it is
 * absent/non-object do we parse the first JSON text item; a conflicting compact
 * text representation must never override the lossless structured result. The
 * match is intentionally narrow — exact top-level `ok === false` plus a nonblank
 * string `reason`, or a WHOLLY-failed bulk envelope (see bulkEnvelopeFailureReason)
 * — because a false positive becomes a clean, misleading health signal while an
 * unrecognized shape merely stays unclassified.
 */
export function extractSoftFailureOutcome(result: Pick<ToolResult, 'content' | 'structuredContent'>): SoftFailureOutcomeMetadata | null {
  let candidate = objectRecord(result.structuredContent);
  if (!candidate) {
    const firstText = result.content.find(
      (item): item is Extract<ToolResult['content'][number], { type: 'text' }> => item.type === 'text',
    );
    if (!firstText) return null;
    try {
      candidate = objectRecord(JSON.parse(firstText.text));
    } catch {
      return null;
    }
  }
  if (!candidate || candidate.ok !== false) return null;
  const reason = typeof candidate.reason === 'string'
    ? candidate.reason.trim()
    : bulkEnvelopeFailureReason(candidate);
  if (!reason) return null;
  return {
    resultOutcome: 'soft-failure',
    softFailureReason: reason.slice(0, SOFT_FAILURE_REASON_MAX),
  };
}

/**
 * The house BULK envelope — `{ ok, results: [{ ok, id, error, … }], counts }`, used by
 * work_items:claim / :get / :comment, processes:kill and every other "one failure never
 * fails the rest" verb — carries its cause PER ITEM, never as a top-level `reason`. So a
 * single-id `work_items:claim` refused `not_claimable` was written with no effect-level
 * marker at all: `status='ok'` and no `resultOutcome`, byte-identical in the ledger to a
 * claim that took (WI-10004868).
 *
 * Classified ONLY when the effect failed ENTIRELY — a non-empty `results` array in which
 * EVERY item is `ok:false` with a nonblank string `error`. A partial batch (any item
 * succeeded, or an item whose shape is not that) stays unclassified: reporting a
 * half-successful batch as a failed effect is exactly the false-positive health signal the
 * narrow match above exists to avoid. The reason is the item error codes, de-duplicated and
 * sorted, so the watchdog's stable key does not depend on item order.
 */
function bulkEnvelopeFailureReason(candidate: Record<string, unknown>): string | null {
  const results = candidate.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const codes = new Set<string>();
  for (const item of results) {
    const record = objectRecord(item);
    if (!record || record.ok !== false || typeof record.error !== 'string') return null;
    const code = record.error.trim();
    if (!code) return null;
    codes.add(code);
  }
  return [...codes].sort().join(',');
}

/**
 * Lift a self-reported refusal's own error code out of its payload.
 *
 * The house convention for `isError: true` results is a single text content whose
 * body is JSON with a string `error` field (`{"error":"similar_exists", ...}`).
 * This reads that and nothing else: any other shape yields null rather than a
 * guess, because a WRONG code on a first-class column is worse than an absent one
 * (it would group cleanly and silently mislead, which is the exact failure mode
 * this whole change exists to remove).
 */
function extractRefusalDetails(r: { content?: Array<{ text?: string; [k: string]: unknown }> }): {
  code: string | null;
  message: string | null;
} {
  const text = r.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) return { code: null, message: null };
  // A handler that self-reports `isError` hands back EITHER a structured JSON
  // refusal OR plain prose. Structured fields are preferred, but when there are
  // none the handler's own text is still the only statement of cause we will
  // ever get — so keep it (bounded) instead of discarding it for a generic
  // fallback that names nothing. Dropping it made every third-party MCP refusal
  // (gitnexus, repomix — which refuse in prose, not JSON) land in the ledger as
  // "tool returned isError=true without a structured refusal message", hiding
  // real, actionable causes such as "repo X is not allowed on this bridge".
  const proseMessage = text.trim().slice(0, REFUSAL_MESSAGE_MAX) || null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const fields = parsed as Record<string, unknown>;
      const code = [fields.error, fields.reason, fields.code, fields.errorCode].find(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      const message = [fields.message, fields.errorMessage, fields.detail].find(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      return {
        code: code ? code.slice(0, REFUSAL_CODE_MAX) : null,
        // A structured refusal carrying a code but no message field still says
        // more as its own JSON body than as the generic fallback.
        message: message ? message.slice(0, REFUSAL_MESSAGE_MAX) : proseMessage,
      };
    }
  } catch {
    /* not JSON — fall through and keep the handler's own prose, bounded */
  }
  return { code: null, message: proseMessage };
}

/**
 * Record a tool-invocation row from a completed execution + its final
 * result. Called by the orchestrator after the stack settles (success,
 * gate denial, error, timeout — all paths). Best-effort; thrown
 * recordInvocation errors are swallowed.
 */
async function recordTelemetry(
  exec: DispatchExecution,
  result: DispatchProjectedResult,
): Promise<void> {
  const {
    deps,
    tool,
    toolName,
    ctx,
    windowKey,
    input,
    startedAt,
    eventCount,
    callId,
    kernelPreflight,
    kernelEnforcement,
    executionRevision,
  } = exec;
  if (!deps.recordInvocation) return;
  // Gate denials (no windowKey required); successes + handler errors
  // require windowKey to match pre-refactor behavior (was guarded by
  // `if (deps.recordInvocation && windowKey)`).
  const code = result.ok ? null : result.error?.code;
  const status =
    result.ok
      ? 'ok'
      : code === 'role_not_allowed' || code === 'missing_capability' || code === 'capability_denied' || code === 'authorization_denied'
        ? 'role-not-allowed'
        : code === 'quota_exceeded'
          ? 'quota-exceeded'
          : code === 'timeout'
            ? 'timeout'
            : code === 'invalid_input'
              ? 'invalid-input'
              : 'error';
  const isGateDenial =
    !result.ok &&
    (code === 'role_not_allowed' ||
      code === 'missing_capability' ||
      code === 'capability_denied' ||
      code === 'authorization_denied' ||
      code === 'quota_exceeded');
  const isKernelDenial = kernelPreflight?.decision === 'deny' || kernelEnforcement?.decision === 'deny';
  if (!isGateDenial && !isKernelDenial && !windowKey) return;

  // Keep the original context byte-for-byte on the legacy/no-port path. Once
  // a kernel decision exists, hand sinks the enriched context as well as the
  // dedicated fields so old consumers that inspect `input.ctx` see the same
  // applied revision as newer consumers using `input.executionRevision`.
  const attributedCtx = kernelPreflight || kernelEnforcement || executionRevision
    ? {
        ...ctx,
        kernelPreflight,
        kernelEnforcement,
        executionRevision,
        ...(executionRevision ? { appliedExecutionRevision: executionRevision } : {}),
      }
    : ctx;

  const kernelFields =
    kernelPreflight || kernelEnforcement || executionRevision
      ? {
          executionRevision,
          kernelPreflight,
          kernelEnforcement,
        }
      : {};

  const metadataJson = mergeDispatchErrorMetadata(finalizeMetadata(exec), result);

  try {
    if (result.ok && result.result) {
      const r = result.result;
      const selfReportedFailure = r.isError === true;
      // Capture the SERVED result format (json/toon/csv/tsv/md) into metadata_json so
      // compact-encoding ADOPTION is a measurable signal — `metadata_json->>'format'`
      // GROUP BY gives the toon-vs-json share per tool over time, the success metric
      // for the token-optimization rollout (definetool-usage-insights-tab P-002 / D-002).
      // It rides metadata_json (jsonb) — no DDL. Absent _meta.format ⇒ not recorded
      // (the consumer reads absent as the unmarked JSON default).
      const servedFormat = (r._meta as { format?: unknown } | undefined)?.format;
      // The negotiated freshness mode (full | not_modified), when the call went
      // through delta negotiation (agent-tool-delta-protocol-2026-06-22, P-005).
      // Captured into metadata_json so `metadata_json->>'deltaMode'` GROUP BY gives
      // the not_modified hit-rate per tool over time — the success metric for the
      // delta rollout (mirrors the `format` capture; rides jsonb, no DDL). Absent
      // _meta.delta ⇒ not recorded (the tool wasn't delta-negotiated).
      const servedDeltaMode = (r._meta as { delta?: { mode?: unknown } } | undefined)?.delta?.mode;
      let metaWithFormat = metadataJson;
      if (typeof servedFormat === 'string') {
        metaWithFormat = { ...(metaWithFormat ?? {}), format: servedFormat };
      }
      if (typeof servedDeltaMode === 'string') {
        metaWithFormat = { ...(metaWithFormat ?? {}), deltaMode: servedDeltaMode };
      }
      // EI-9130: a generic, queryable "was this response served as a delta?" breadcrumb.
      // `metadata_json->>'deltaMode'` (above) only fires for tools riding the FORMAL
      // delta protocol (_meta.delta) — a handler with its own bespoke cursor-delta shape
      // (e.g. coord:orient's fleetDelta/planEvents/fleetCatchUp cursors, which don't ride
      // `_meta.delta`) has no equivalent signal, so a delta rollout's live win can't be
      // queried uniformly across mechanisms — only inferred. Fix: normalize BOTH into one
      // boolean field. A handler that already knows it served a delta stamps it directly
      // via `ctx.metadata({ deltaServed: true })` (folded into `metadataJson` above by
      // `finalizeMetadata`) — that explicit stamp always wins. Otherwise, derive it from
      // the formal protocol's mode (anything but 'full' is a delta). Absent ⇒ no delta
      // mechanism was in play at all (never recorded as `false` — mirrors the `format` /
      // `deltaMode` absent-means-unmarked convention above).
      if ((metaWithFormat as { deltaServed?: unknown } | null)?.deltaServed === undefined) {
        const derivedDeltaServed = typeof servedDeltaMode === 'string' ? servedDeltaMode !== 'full' : undefined;
        if (derivedDeltaServed !== undefined) {
          metaWithFormat = { ...(metaWithFormat ?? {}), deltaServed: derivedDeltaServed };
        }
      }
      // EI-20219227925547855: distinguish a successful CALL from a successful
      // EFFECT without changing the long-standing meaning of status='ok'. Merge
      // after handler metadata so these framework-owned keys cannot be spoofed
      // or contradicted by ctx.metadata() on a real soft-failure result.
      const softFailure = selfReportedFailure ? null : extractSoftFailureOutcome(r);
      if (softFailure) {
        metaWithFormat = { ...(metaWithFormat ?? {}), ...softFailure };
      }
      // A handler can fail in TWO ways, and only one of them throws. Dispatch-level
      // failure (throw / gate denial) is `!result.ok` and handled in the else branch
      // below. The other is a SELF-REPORTED refusal: the handler returns normally with
      // `isError: true` on the ToolResult. That path used to be recorded as a flat
      // 'ok' with a NULL error code — indistinguishable in the ledger from a call that
      // actually did the work, which is how a refusal reads as a phantom silent write
      // loss (EI-20184794555427363; the doc comment on RecordInvocation['status']
      // carries the full case). Derive the status from the result the handler actually
      // returned, not merely from the fact that it returned.
      const refusal = selfReportedFailure ? extractRefusalDetails(r) : null;
      await deps.recordInvocation({
        toolName,
        pluginName: tool.pluginName,
        ctx: attributedCtx,
        windowKey: windowKey ?? '',
        callId,
        durationMs: Date.now() - startedAt,
        status: selfReportedFailure ? 'refused' : 'ok',
        // Lift the refusal's OWN code/reason onto the first-class column so a
        // consumer can group refusals without LIKE-matching a payload blob. The
        // bounded fallback keeps malformed/plain-text refusals auditable too.
        ...(selfReportedFailure
          ? {
              errorCode: refusal?.code ?? REFUSAL_FALLBACK_CODE,
              errorMessage: refusal?.message ?? REFUSAL_FALLBACK_MESSAGE,
            }
          : {}),
        outputSize: r.outputSize ?? JSON.stringify(r.content).length,
        ...(r.outputRef ? { outputRef: r.outputRef } : {}),
        args: input,
        eventCount,
        metadataJson: metaWithFormat,
        ...kernelFields,
      });
    } else {
      await deps.recordInvocation({
        toolName,
        pluginName: tool.pluginName,
        ctx: attributedCtx,
        windowKey: windowKey ?? '',
        callId,
        durationMs: Date.now() - startedAt,
        status,
        // Persist the dispatcher error CLASS (computed above, then historically
        // discarded) so the watchdog can tell a deterministic config bug from a
        // transient crash without LIKE-matching errorMessage (P-007 / D-009).
        errorCode: code ?? null,
        errorMessage: result.error?.message ?? '',
        args: input,
        eventCount,
        metadataJson,
        ...kernelFields,
      });
    }
  } catch {
    // best-effort
  }
}

function finalizeMetadata(exec: DispatchExecution): Record<string, unknown> | null {
  if (exec.ctx.uiClientId) {
    const base = exec.metadataJson ?? {};
    if (base.uiClientId === undefined) {
      return { ...base, uiClientId: exec.ctx.uiClientId };
    }
  }
  return exec.metadataJson;
}

function mergeDispatchErrorMetadata(
  metadataJson: Record<string, unknown> | null,
  result: DispatchProjectedResult,
): Record<string, unknown> | null {
  const errorMeta = !result.ok ? result.error?.meta : undefined;
  const postgres = errorMeta?.postgres;
  const invalidInput = errorMeta?.invalidInput;
  const hasPostgres = !!postgres && typeof postgres === 'object' && !Array.isArray(postgres);
  const hasInvalidInput = !!invalidInput && typeof invalidInput === 'object' && !Array.isArray(invalidInput);
  if (!hasPostgres && !hasInvalidInput) return metadataJson;
  return {
    ...(metadataJson ?? {}),
    ...(hasPostgres ? { postgres } : {}),
    ...(hasInvalidInput ? { invalidInput } : {}),
  };
}

/* ─── Orchestrator ───────────────────────────────────────────────────── */

/**
 * Drive a stack to completion. Initializes execution state, iterates
 * the stack, records telemetry, and runs cleanup. Returns the result
 * the first short-circuiting step produced — or the result `invoke`
 * returned, if no gate fired.
 */
export async function runDispatchStack(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
  stack: ReadonlyArray<DispatchStep> = DEFAULT_DISPATCH_STACK,
): Promise<DispatchProjectedResult> {
  const exec = initExecution(tool, toolName, input, ctx, deps);
  // P-007: a 1219ms plans:get invocation contained only a 53ms body read.
  // Attribute the existing dispatch pipeline in its invocation metadata,
  // including authority waits, rather than treating handler timing as total
  // server time. These sequential wall-time intervals exclude the telemetry
  // sink itself; nested handler read intervals must not be added to them.
  const dispatchStarted = deps.recordInvocation ? performance.now() : null;
  const dispatchSteps: Array<{ name: DispatchStepName; elapsedMs: number }> = [];
  // Notify the host before any gate or handler work begins. This is deliberately
  // best-effort: a liveness marker must not be able to change dispatch behavior,
  // and it must run before a long-lived handler becomes in-flight.
  if (deps.onDispatchStart) {
    try {
      deps.onDispatchStart({
        toolName,
        pluginName: tool.pluginName,
        args: input,
        ctx,
        callId: exec.callId,
      });
    } catch {
      // Start observers are advisory and must never break their trigger.
    }
  }
  let result: DispatchProjectedResult | null = null;
  try {
    for (const step of stack) {
      const stepStarted = dispatchStarted === null ? null : performance.now();
      try {
        result = await step.run(exec);
      } finally {
        if (stepStarted !== null) {
          dispatchSteps.push({
            name: step.name,
            elapsedMs: Math.max(0, performance.now() - stepStarted),
          });
        }
      }
      if (result) break;
    }
    if (!result) {
      // Stack ended without producing a result — this would be a bug
      // (e.g. a custom stack missing the `invoke` step). Surface clearly.
      result = {
        ok: false,
        error: {
          code: 'handler_error',
          message: `dispatch stack completed without a result (missing 'invoke' step?)`,
        },
      };
    }
    return result;
  } finally {
    const settled = result ?? {
      ok: false,
      error: { code: 'handler_error' as const, message: 'no result' },
    };
    if (dispatchStarted !== null) {
      exec.metadataJson = {
        ...(exec.metadataJson ?? {}),
        dispatchStages: {
          schemaVersion: 'dispatch-stages-v1',
          unit: 'ms',
          timing: 'wall-time-sequential-steps',
          elapsedMs: Math.max(0, performance.now() - dispatchStarted),
          steps: dispatchSteps,
        },
      };
    }
    await recordTelemetry(exec, settled);
    // Event-reaction observation point (D-001). Fired AFTER telemetry, on every
    // path. Best-effort + non-blocking: the host's postInvoke matches rules and
    // SCHEDULES reactions (durable queue / fire-and-forget), it must not run a
    // reaction inline here. We deliberately do NOT await it, and swallow throws,
    // so a reaction can never delay or break its trigger.
    if (deps.postInvoke) {
      try {
        const eventCtx = exec.kernelPreflight || exec.kernelEnforcement || exec.executionRevision
          ? {
              ...ctx,
              kernelPreflight: exec.kernelPreflight,
              kernelEnforcement: exec.kernelEnforcement,
              executionRevision: exec.executionRevision,
              ...(exec.executionRevision ? { appliedExecutionRevision: exec.executionRevision } : {}),
            }
          : ctx;
        deps.postInvoke({
          toolName,
          pluginName: tool.pluginName,
          args: input,
          result: settled,
          ctx: eventCtx,
          durationMs: Date.now() - exec.startedAt,
          capabilities: tool.capabilities,
          envelopeVerdict: exec.envelopeVerdict,
          kernelPreflight: exec.kernelPreflight,
          kernelEnforcement: exec.kernelEnforcement,
          executionRevision: exec.executionRevision,
        });
      } catch {
        // a reaction must never break its trigger
      }
    }
    if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
    if (exec.idleTimer) clearInterval(exec.idleTimer);
    if (ctx.runId) {
      cancelPendingCardsForRun(ctx.runId);
      closeRun(ctx.runId);
    }
  }
}
