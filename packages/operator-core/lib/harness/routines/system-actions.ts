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
   * Durable child-workflow fires the engine starts AFTER this action's step, from
   * the workflow context (the action cannot start them from inside its own step).
   * Each must carry a STABLE idempotencyKey (derived from durable state, not a
   * clock) so a recovery replay dedups rather than double-fires.
   */
  durableSpawns?: DurableSpawnFireInput[];
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
}

/** How a system action's routine row is expected to exist. See `SystemActionOptions.scheduling`. */
export type SystemActionScheduling = 'standing' | 'on-demand';

export interface SystemActionEntry {
  fn: SystemAction;
  ownSteps: boolean;
  scheduling: SystemActionScheduling;
  routineTimeoutMs?: number;
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
