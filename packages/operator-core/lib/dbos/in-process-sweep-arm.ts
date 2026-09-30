/**
 * Durable ON/OFF state for the code-declared in-process sweeps (EI-19294826146331487).
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * Owner, 2026-07-27, looking at the System pane: *"the pane is listing sweeps you can neither
 * see running nor turn off."* WI-6447 fixed the SEEING half. This is the TURNING-OFF half.
 *
 * The population is `buildDefaultChecks()` in `./in-process-periodic` — 17 host sweeps declared
 * in code and armed all-or-nothing by `armInProcessPeriodicChecks()`. They are singletons with a
 * coherent switch; they simply had no surface for one, so `routineControl()` reported them as
 * `control:'none', reason:'ephemeral-tier'` and the pane rendered an inert padlock.
 *
 * ── Where the state lives, and why ───────────────────────────────────────────
 * In `harness_shared.routines`, as a row per sweep with `tier='in-process'` (migration 1046).
 * NOT a new parallel table and NOT a per-sweep feature flag — both were ruled out on the item,
 * and both would have meant a second control plane for the pane to learn.
 *
 * The row is ARM-STATE ONLY. Nothing fires it: `listDueCronRoutines` filters `tier='durable'`
 * and `listActiveEphemeralRoutines` filters `tier='ephemeral'`, so a third value matches neither
 * executor and the sweep can never be double-driven. Its `active` column is the switch, and the
 * pane's EXISTING toggle already knows how to write it (`routines:set { installSlug, name,
 * active }`) — the catalog collapses the routines row and the inventory row that share
 * (kind, name) into one row whose control comes from the routines half.
 *
 * ── ARM-THEN-RECONCILE, never read-then-arm ──────────────────────────────────
 * Boot behaviour is deliberately UNCHANGED: `armInProcessPeriodicChecks()` still arms everything
 * synchronously with no database read on the boot path. The reconciler below then converges the
 * live set onto the durable one. So a slow, wedged, or unmigrated database cannot delay or
 * suppress host boot — the worst case is that a sweep the owner disabled keeps running for one
 * reconcile interval, which is strictly better than a host that will not start.
 *
 * Every failure mode here is FAIL-OPEN: a read error, an absent table, a missing row, or a
 * malformed row all resolve to "armed". A sweep is stopped only on an explicit `active=false`.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getOrgPg, listInProcessSweepRoutines } from '@papercusp/db-org';
import { backgroundWorkspaceIds } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
// The role string is owned by the classification module (the leaf the UI-facing catalog reads),
// so the pane's spend classification and the row this file WRITES cannot drift apart.
import { IN_PROCESS_SWEEP_TARGET_ROLE } from '../automation/routine-classification';

export { IN_PROCESS_SWEEP_TARGET_ROLE };

/** How often the live timer set is reconciled onto the durable arm state. */
export const SWEEP_ARM_RECONCILE_INTERVAL_MS = 30_000;

/**
 * The reconciler's OWN name. It is never itself disableable — see `startInProcessSweepArmReconciler`
 * for why that is a correctness requirement rather than a convenience.
 */
export const SWEEP_ARM_RECONCILER_NAME = 'in-process-sweep-arm-reconcile';

/** One code-declared sweep, as the arm-state layer sees it. */
export interface SweepArmSpec {
  name: string;
  intervalMs: number;
}

/** What one reconcile pass decided. Names only — the caller owns the handles. */
export interface SweepReconcilePlan {
  /** Armed here but disabled durably — stop these. */
  toStop: string[];
  /** Durably enabled but not armed here — (re-)start these. */
  toStart: string[];
}

/**
 * Pure core: what to change so the live set matches the durable one.
 *
 * `eligible` is the set this process is allowed to run at all (the cluster-scope filter has
 * already been applied by the caller), so a host-scoped sweep left to the cluster primary is
 * never "started" here by a reconcile.
 */
export function planSweepReconcile(input: {
  eligible: readonly string[];
  armed: readonly string[];
  disabled: ReadonlySet<string>;
}): SweepReconcilePlan {
  const armed = new Set(input.armed);
  const toStop: string[] = [];
  const toStart: string[] = [];
  for (const name of input.eligible) {
    const shouldRun = !input.disabled.has(name);
    if (shouldRun && !armed.has(name)) toStart.push(name);
    else if (!shouldRun && armed.has(name)) toStop.push(name);
  }
  return { toStop, toStart };
}

/**
 * The DISABLED set across every background workspace.
 *
 * A sweep is host-scoped but a routines row is workspace-scoped, so one sweep can have several
 * rows. Disabled ⇔ ANY of them says `active=false`. That is what the click MEANS: an owner who
 * turns `system-health` off in the pane is asking for the host sweep to stop, not for it to stop
 * in one workspace and keep running in another (which the single host timer cannot express
 * anyway). Re-enabling in that same workspace clears it; a sweep another workspace also disabled
 * stays off, which is likewise the honest answer.
 */
export async function readDisabledSweeps(): Promise<Set<string>> {
  const disabled = new Set<string>();
  for (const ws of backgroundWorkspaceIds()) {
    const rows = await runWithWorkspace(ws, () => {
      const { sql } = getOrgPg();
      return listInProcessSweepRoutines(sql);
    });
    for (const r of rows) if (r.active === false) disabled.add(r.name);
  }
  return disabled;
}

/**
 * Materialize one arm-state row per declared sweep, so the pane has something to toggle.
 *
 * `active` is deliberately NOT re-applied on conflict (the same discipline as every seed in
 * `harness/routines/`, EI-19301170070808928): a re-seed on every host boot must never clobber an
 * operator's pause. `reschedule_interval_sec` carries the cadence so the collapsed pane row can
 * still render "every 1m" — it is display truth, not a schedule; nothing reads it to fire.
 */
export async function seedInProcessSweepRoutines(specs: readonly SweepArmSpec[]): Promise<number> {
  if (specs.length === 0) return 0;
  const slug = operatorHomeHarnessSlug();
  let written = 0;
  for (const ws of backgroundWorkspaceIds()) {
    await runWithWorkspace(ws, async () => {
      const { sql } = getOrgPg();
      for (const spec of specs) {
        const id = `rt_${slug}_${spec.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
        await sql`
          INSERT INTO harness_shared.routines
            (id, install_slug, name, trigger_kind, trigger_config, target_role,
             concurrency, catchup, active, tier, next_fire_at, reschedule_interval_sec, workspace_id)
          VALUES (
            ${id}, ${slug}, ${spec.name}, 'in-process',
            ${'{}'}::text::jsonb, ${IN_PROCESS_SWEEP_TARGET_ROLE},
            'skip', 'skip-old', TRUE, 'in-process', NULL,
            ${Math.max(1, Math.round(spec.intervalMs / 1000))}, ${ws}
          )
          ON CONFLICT (install_slug, name) DO UPDATE SET
            trigger_kind            = EXCLUDED.trigger_kind,
            target_role             = EXCLUDED.target_role,
            tier                    = EXCLUDED.tier,
            reschedule_interval_sec = EXCLUDED.reschedule_interval_sec,
            -- active intentionally NOT re-applied: a boot-time re-seed must never undo a pause.
            workspace_id            = EXCLUDED.workspace_id,
            updated_at              = now()
        `;
        written += 1;
      }
    });
  }
  return written;
}

/** The seam the reconciler drives. Injected so the unit test needs no database and no timers. */
export interface SweepArmReconcilerDeps {
  /** The sweeps this process may run (cluster-scope already applied). */
  eligible: () => SweepArmSpec[];
  /** The sweeps actually armed in this process right now. */
  armed: () => string[];
  /** Apply a plan; returns what it actually changed. */
  apply: (plan: SweepReconcilePlan) => SweepReconcilePlan;
  /** Durable disabled-set read. */
  readDisabled: () => Promise<Set<string>>;
  /** Best-effort row materialization, run once before the first reconcile. */
  seed?: (specs: readonly SweepArmSpec[]) => Promise<number>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * One reconcile pass. NEVER throws and NEVER returns a stop decision it did not derive from a
 * successful read — on any error it returns an empty plan, which leaves every sweep armed.
 */
export async function reconcileSweepArmStateOnce(
  deps: SweepArmReconcilerDeps,
): Promise<SweepReconcilePlan> {
  let disabled: ReadonlySet<string>;
  try {
    disabled = await deps.readDisabled();
  } catch (err) {
    // FAIL-OPEN. A database that cannot answer must never be read as "the owner disabled
    // everything" — that would silently stop system-health and the stale-claim sweeps fleet-wide.
    deps.warn?.(
      `[in-process-sweep-arm] arm-state read failed; leaving every sweep ARMED: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { toStop: [], toStart: [] };
  }
  const plan = planSweepReconcile({
    eligible: deps.eligible().map((s) => s.name),
    armed: deps.armed(),
    disabled,
  });
  if (plan.toStop.length === 0 && plan.toStart.length === 0) return plan;
  const applied = deps.apply(plan);
  if (applied.toStop.length > 0 || applied.toStart.length > 0) {
    deps.log?.(
      `[in-process-sweep-arm] reconciled: stopped [${applied.toStop.join(', ')}], ` +
        `started [${applied.toStart.join(', ')}]`,
    );
  }
  return applied;
}

let reconciler: ManagedHandle | null = null;

/**
 * Arm the reconciler. Idempotent; a second call is a no-op.
 *
 * Registered as `category:'watchdog'`, which is the honest classification rather than a
 * convenience: `routineControl` gives a watchdog `control:'none'` with "stopping it is a code
 * change, by design", and that is a REQUIREMENT here — a reconciler that could itself be
 * disabled from the pane would, once disabled, permanently wedge every other sweep's switch,
 * with no surface left to undo it. It is outside the control plane for the same reason the
 * routines-tick watchdog is.
 *
 * The seed runs once, before the first reconcile, and its failure is non-fatal: without rows the
 * pane simply shows the pre-existing padlock, which is the correct degraded state.
 */
export function startInProcessSweepArmReconciler(deps: SweepArmReconcilerDeps): { stop: () => void } {
  if (reconciler) return { stop: stopInProcessSweepArmReconciler };
  const seedThenReconcile = async (): Promise<void> => {
    if (deps.seed) {
      try {
        await deps.seed(deps.eligible());
      } catch (err) {
        deps.warn?.(
          `[in-process-sweep-arm] seeding arm-state rows failed (pane keeps its padlock): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      deps.seed = undefined; // once per process
    }
    await reconcileSweepArmStateOnce(deps);
  };
  // Keep the registry name literal: recovery-dependency-audit statically extracts watchdog
  // registrations so every out-of-band timer has a declaration in RECOVERY_MECHANISMS.
  reconciler = managedSetInterval('in-process-sweep-arm-reconcile', SWEEP_ARM_RECONCILE_INTERVAL_MS, seedThenReconcile, {
    category: 'watchdog',
    // The writer is a DIFFERENT process (the operator serving `routines:set`), and no push
    // channel reaches the background host from there today, so a bounded poll of the durable
    // intent is the only available reading. Same constraint the ephemeral tier lives under.
    classification: 'must-sample',
    fireOnArm: true,
  });
  return { stop: stopInProcessSweepArmReconciler };
}

/** Stop the reconciler (tests; graceful shutdown). */
export function stopInProcessSweepArmReconciler(): void {
  if (!reconciler) return;
  reconciler.stop();
  reconciler = null;
}

/** Whether the reconciler is armed in this process (tests / introspection). */
export function inProcessSweepArmReconcilerArmed(): boolean {
  return reconciler !== null;
}

/** Production wiring: the real PG read + seed. */
export function productionSweepArmDeps(
  local: Pick<SweepArmReconcilerDeps, 'eligible' | 'armed' | 'apply'>,
): SweepArmReconcilerDeps {
  return {
    ...local,
    readDisabled: readDisabledSweeps,
    seed: seedInProcessSweepRoutines,
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
}
