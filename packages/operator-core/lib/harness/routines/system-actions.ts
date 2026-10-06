/**
 * System-action registry for the routines engine (git-sync-auto-commit P-002).
 *
 * A routine whose `target_role` is `system:<action>` is NOT spawned as an agent —
 * the `routinesTick` workflow runs the registered handler **inline, as a single
 * durable DBOS step** (git-sync-auto-commit D-006). This is the seam git-sync (the
 * first consumer) registers into via `registerSystemAction('git-sync', …)`; future
 * per-harness system tasks register here too. Role-target routines take the spawn
 * path instead (see `lib/dbos/routines-workflow.ts`).
 *
 * Handlers run as ONE step, so a crash mid-action replays the whole handler on
 * recovery — handlers must therefore be safe to re-run from the top (git-sync is:
 * commit is a no-op when clean, push is a no-op when up-to-date, merge re-fetches).
 *
 * DURABLE CHILD SPAWNS (EI-403-A): a handler that wants to start a durable child
 * workflow (e.g. the auto-implement lane firing its worker) CANNOT do so from
 * inside its step — `DBOS.startWorkflow` is forbidden from within a step. Instead
 * the handler RETURNS the spawn requests as `SystemActionResult.durableSpawns`;
 * the routine workflow drains them AFTER the step returns, at the workflow layer
 * where `startWorkflow` is legal (see `routines-workflow.ts` →
 * `startDurableSpawns`). Recovery-safe: the step's return value is checkpointed,
 * so on replay the same requests are re-drained and the per-request idempotency
 * key dedups the re-fire. A handler returning `void` is unchanged.
 */
import type { DurableSpawnFireInput } from '../../dbos/durable-spawn';

export interface SystemActionCtx {
  /** Harness slug (routines.install_slug). */
  installSlug: string;
  /** Owning workspace (routines.workspace_id); the call already runs inside its ALS scope. */
  workspaceId: string;
  /** The routine row whose action is running, when dispatched by routineFire. */
  routineId?: string;
  /** The exact DBOS workflow_status.workflow_uuid for this routineFire execution. */
  workflowId?: string;
  /** The routine's trigger_config (e.g. `{ cron, push, push_submodules }`). */
  triggerConfig: Record<string, unknown>;
  /** The routine's payload_template, if any. */
  payloadTemplate: Record<string, unknown> | null;
}

/**
 * What a system action MAY return so the routine engine starts durable work on
 * its behalf at the workflow layer (EI-403-A). Returning nothing (`void`) is the
 * common case and changes nothing. An interface (not a bare field) so future
 * post-step engine hooks can be added without re-widening every handler.
 */
export interface SystemActionResult {
  /**
   * Compact, JSON-serializable evidence retained in the action's DBOS
   * operation_output. A handler that intentionally fails soft still needs to
   * distinguish "healthy and empty" from "shed" or "completed with per-target
   * errors" after the fact; logs alone are not a durable measurement surface.
   */
  diagnostics?: Record<string, unknown>;
  /**
   * WI-10005164: the action did its primary job, but a fail-soft SUB-PASS failed.
   * Both executors (routines-workflow and ephemeral-executor) record this as the
   * routine's `last_error` without failing the fire, so routines:list and the
   * routine-failure watchdog see it. The next fire that returns no `softError`
   * clears it, the same as a clean fire after a throw.
   *
   * Use it instead of swallowing a sub-pass error to console.warn. A catch that
   * only logs kept the routine reporting healthy while the task-lifecycle sweep
   * threw 42703 on every pass for a day (WI-10005157). For a sub-pass slower
   * than the routine's own cadence, keep the failure set across ticks
   * (`createSubPassHealth`), or the next tick's clean return erases it.
   */
  softError?: string;
  /**
   * Durable child-workflow fires the engine starts AFTER this action's step, from
   * the workflow context (the action cannot start them from inside its own step).
   * Each must carry a STABLE idempotencyKey (derived from durable state, not a
   * clock) so a recovery replay dedups rather than double-fires.
   */
  durableSpawns?: DurableSpawnFireInput[];
  /**
   * WI-10004472: set ONLY by an `ownSteps` action whose DBOS recovery replay
   * cannot reproduce the step sequence its original execution recorded (git-sync:
   * the original fire held its locks and recorded post-lock sub-steps, but the
   * replay's live re-acquire was refused). The engine then ends the fire at once
   * and issues NO further DBOS operation: no `system:<action>:settle`, no
   * `clear-reaper-last-error`, no durable spawns. Any later step would land on a
   * function id the original run recorded under a different name, and DBOS fails
   * the whole workflow with DBOSUnexpectedStepError ("… was recorded when … was
   * expected"). The next scheduled tick redoes the work.
   */
  replayAbandoned?: { reason: string };
}

export type SystemAction = (ctx: SystemActionCtx) => Promise<void | SystemActionResult>;

/** Per-action registration options. */
export interface SystemActionOptions {
  /**
   * WI-1416 (bg-host-freeze-eventloop-stall P-006): the handler manages its OWN
   * `DBOS.runStep` checkpoints (a multi-step action — git-sync is the first). The
   * routine engine must then run it at the WORKFLOW layer, NOT wrapped in the
   * engine's single `system:<action>` step: nested inside a step, `DBOS.runStep`
   * silently degrades to a plain call (isInStep() → direct execution, no
   * operation_output), so the executor reaper would still see an opaque no-progress
   * fire. Such handlers MUST make every sub-step replay-safe — the engine no longer
   * provides the one-big-step "re-run from the top" recovery semantics.
   */
  ownSteps?: boolean;
  /**
   * Optional workflow deadline for the routine fire that runs this action.
   *
   * Most actions use the routine engine's short dead-executor release valve.
   * A genuinely long, bounded action may opt into a larger deadline here so
   * the outer DBOS workflow does not cancel healthy work before the action's
   * own progress/termination guards can run. The scheduler validates the
   * value and falls back to its default when it is absent or invalid.
   */
  routineTimeoutMs?: number;
  /**
   * EI-18752496371939475 — how this action's routine ROW is expected to come into
   * existence. This is the third direction of the handler/registration cross-check:
   * a handler can be perfectly registered and still be dead code because no
   * `harness_shared.routines` row targets `system:<name>`, so it never fires. Two
   * guards already cover the other directions (an ACTIVE row whose handler is not
   * registered; a handler that is never `registerSystemAction`ed at all) — nothing
   * compared the registered set against the rows that actually exist, which is the
   * code↔DATA direction. A seed script that is written but never RUN is green code
   * doing nothing, invisible to every test in the tree.
   *
   *  - `'standing'` (the DEFAULT): a row is expected to exist in any workspace that
   *    runs routines, normally created once by a `seed-<name>-routine.ts` script. Its
   *    absence means the seed was never run → reported by `validateActiveRoutines`
   *    as an `unscheduledSystemActions` offender.
   *  - `'on-demand'`: rows are materialized per OBJECT at runtime (per goal, plan,
   *    blueprint, harness, hive…) or the handler is invoked directly. Having zero
   *    rows is normal — the action is exempt from that check.
   *
   * The default is deliberately the LOUD one: a new action added without a thought
   * about scheduling should surface, not sit silent. Declaring it here rather than in
   * a separate allowlist keeps the fact next to the thing it describes, so it cannot
   * drift out of step with the registration it is about.
   */
  scheduling?: SystemActionScheduling;
  /**
   * WI-10005745 (D-012): the handler spawns a process that EXECUTES code from the integration tree
   * (`PAPERCUSP_INTEGRATION_ROOT` / the module repo root — on bg-host, the live shared tree): a tsx
   * or node script, a CLI bin, `cargo test`, a test runner. While a session holding an active
   * personal disclosure has writes held in that tree, the dispatcher SKIPS such a fire (recorded on
   * the routine row, never silent) rather than run that code with the network. Reading files, git
   * plumbing, systemctl and parse-only work do not count. restricted-tree-actions.test.ts derives
   * the candidate set from source and fails until each action is declared or justified.
   */
  executesIntegrationTreeCode?: boolean;
}

/** How a system action's routine row is expected to exist. See `SystemActionOptions.scheduling`. */
export type SystemActionScheduling = 'standing' | 'on-demand';

export interface SystemActionEntry {
  fn: SystemAction;
  ownSteps: boolean;
  scheduling: SystemActionScheduling;
  routineTimeoutMs?: number;
  /** See `SystemActionOptions.executesIntegrationTreeCode`. */
  executesIntegrationTreeCode: boolean;
}

/** The reserved `target_role` prefix that routes a routine to a system action. */
export const SYSTEM_TARGET_PREFIX = 'system:';

const REGISTRY = new Map<string, SystemActionEntry>();

/** Register a `system:<name>` action handler. Idempotent (last registration wins). */
export function registerSystemAction(name: string, fn: SystemAction, opts: SystemActionOptions = {}): void {
  const entry: SystemActionEntry = {
    fn,
    ownSteps: opts.ownSteps === true,
    // Default 'standing' — see SystemActionOptions.scheduling. An action registered with no
    // opinion about scheduling is treated as one that SHOULD have a routine row, so a missing
    // row is reported rather than silently accepted.
    scheduling: opts.scheduling === 'on-demand' ? 'on-demand' : 'standing',
    executesIntegrationTreeCode: opts.executesIntegrationTreeCode === true,
  };
  if (opts.routineTimeoutMs !== undefined) entry.routineTimeoutMs = opts.routineTimeoutMs;
  REGISTRY.set(name, entry);
}

/** Look up a registered system action by name (the part after `system:`). */
export function getSystemAction(name: string): SystemAction | undefined {
  return REGISTRY.get(name)?.fn;
}

/** Look up the full registry entry (handler + dispatch options). */
export function getSystemActionEntry(name: string): SystemActionEntry | undefined {
  return REGISTRY.get(name);
}

/** All registered system-action names (diagnostics / tests). */
export function listSystemActions(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * Registered actions declared `scheduling: 'standing'` — i.e. the ones a
 * `harness_shared.routines` row is expected to exist for (EI-18752496371939475).
 *
 * This is the code half of the code↔DATA cross-check run by
 * `startup/validate-active-routines.ts`; the data half is the set of `system:<action>`
 * `target_role`s that actually have rows. An action in this list with NO row never fires,
 * however green its tests are.
 *
 * Read the LIVE registry rather than grepping for `registerSystemAction(` — a grep also
 * picks up handlers registered inside test files (the `dogfood-*` fixtures in
 * `dbos/ephemeral-cadence-dogfood.integration.test.ts`), which are not production actions
 * and would be permanent false positives.
 */
export function listStandingSystemActions(): string[] {
  return [...REGISTRY.entries()].filter(([, e]) => e.scheduling === 'standing').map(([name]) => name);
}

/** `last_error` is truncated to this many characters by both executors. */
const SOFT_ERROR_MAX_CHARS = 600;

/** One failing sub-pass, as reported in `diagnostics.subPassFailures`. */
export interface SubPassFailure {
  name: string;
  message: string;
  /** ISO time of the first failure in the current streak. */
  since: string;
  consecutive: number;
}

/**
 * WI-10005164: tracks a system action's fail-soft sub-passes ACROSS ticks.
 * A sub-pass's failure stays set until that same sub-pass next succeeds.
 *
 * Keep the tracker in module scope beside the action. Many sub-passes run on
 * their own slower cadence (task-reconcile ticks every 30 s; its lifecycle
 * sweep runs hourly). Recording the failure only on the tick that ran the
 * sweep would let the next tick's clean return clear `last_error` within 30 s.
 */
export interface SubPassHealth {
  /** Record one attempt: `null` means it succeeded (clears its streak); anything else is the failure. */
  record(name: string, error: unknown, nowMs?: number): void;
  /** Sub-passes whose last attempt failed, in first-failure order. */
  failures(): SubPassFailure[];
  /**
   * The fields to return from the action: `softError` plus diagnostics while
   * any sub-pass is failing, `undefined` when all are healthy.
   */
  result(): SystemActionResult | undefined;
}

export function createSubPassHealth(): SubPassHealth {
  const failing = new Map<string, SubPassFailure>();
  return {
    record(name, error, nowMs = Date.now()) {
      if (error === null) {
        failing.delete(name);
        return;
      }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, SOFT_ERROR_MAX_CHARS);
      const prior = failing.get(name);
      failing.set(name, {
        name,
        message,
        since: prior?.since ?? new Date(nowMs).toISOString(),
        consecutive: (prior?.consecutive ?? 0) + 1,
      });
    },
    failures() {
      return [...failing.values()];
    },
    result() {
      const list = [...failing.values()];
      if (list.length === 0) return undefined;
      const softError = list
        .map((f) => `${f.name} sub-pass failing (${f.consecutive}x since ${f.since}): ${f.message}`)
        .join('; ')
        .slice(0, SOFT_ERROR_MAX_CHARS);
      return { softError, diagnostics: { subPassFailures: list } };
    },
  };
}
