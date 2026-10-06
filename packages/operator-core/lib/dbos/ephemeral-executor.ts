/**
 * Per-host EPHEMERAL executor (schedule-inventory-and-ephemeral-tier-2026-06-26 P-012 / D-006).
 *
 * The ephemeral tier is the FREQUENT, non-DBOS cadence class. Where the durable tier rides DBOS
 * `routinesTick` (cron, `listDueCronRoutines` — `tier='durable'` only), an ephemeral routine
 * (`tier='ephemeral'`) rides the SAME in-process scheduled-registry that drives the host sweeps
 * (D-006: ONE in-process mechanism, not three). On harness boot, under the single-owner gate
 * (`backgroundWorkers && !utilityHost`), this executor arms ONE `managedSetInterval` PER active
 * ephemeral routine — each a dynamic registration in `@papercusp/scheduled-registry`
 * (category `'ephemeral-harness'`) so every cadence is individually VISIBLE in `schedule:inventory`
 * with its own interval + last-fire (the plan's total-visibility thesis). Disarmed on teardown/pause.
 *
 * Each tick fires the routine's deterministic ACTION via the system-actions dispatch registry
 * (`getSystemAction` — `blueprint:validate` guarantees an ephemeral action is a concrete
 * `system:<x>`, never `system:blueprint-run`), then records DURABLE per-schedule liveness by
 * UPDATEing the ONE routine row (D-004: never an INSERT per fire — this is how the EI-1622
 * `workflow_status` bloat is avoided by construction). The registry supplies the unref'd timer,
 * the per-timer re-entrancy guard (a slow tick never piles up a second run), and the shed gate.
 *
 * Pure core over injected deps (the `EphemeralExecutorDeps` seam) so unit tests drive it with a
 * fake registry/clock and a stub fire/list; `productionEphemeralExecutorDeps()` wires the real
 * PG query + system-action dispatch.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getOrgPg, listActiveEphemeralRoutines, recordEphemeralFire } from '@papercusp/db-org';
import { getSystemAction, getSystemActionEntry, SYSTEM_TARGET_PREFIX, type SystemActionResult } from '../harness/routines/system-actions';
import { restrictedTreeSkipReason } from '../harness/routines/restricted-tree-skip';
// host-bootstrap imports this executor directly, without importing routines-workflow. Keep the
// side-effect registry load on this production fire path or every `system:` ephemeral action is
// absent and each cadence silently records "no system action ... registered" on every tick.
import '../harness/routines/register-system-actions';
import { backgroundWorkspaceIds } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';

/** Min cadence floor (seconds) — mirrors blueprint:validate's EPHEMERAL_MIN_INTERVAL_SEC. */
export const EPHEMERAL_MIN_INTERVAL_SEC = 1;
/**
 * WI-1406487: cadence CEILING (seconds) — mirrors blueprint:validate's
 * EPHEMERAL_MAX_INTERVAL_SEC, which rejects a coarser ephemeral schedule outright.
 *
 * This runtime check is NOT redundant with that validator: a routine row can be seeded
 * straight into `harness_shared.routines` without ever passing through blueprint:validate,
 * which is exactly how `corpus-term-df` reached production at 21600s. `armOne` uses an
 * in-process `managedSetInterval` that restarts from zero on every bg-host boot, so a
 * period longer than host uptime never reaches its deadline — it fired ZERO times in 35.7h
 * while reporting `active:true` and logging "armed" on every boot.
 *
 * Deliberately a LOUD WARNING rather than a skip. The defect being fixed is SILENCE, not
 * the arming itself, and refusing to arm would change behaviour for a host whose uptime
 * genuinely does exceed the period. This makes the un-fireable case say so; it does not
 * decide the routine's fate.
 */
export const EPHEMERAL_MAX_INTERVAL_SEC = 3600;
/** Global-heartbeat cadence: a single inventory-visible managed timer proving the executor is alive. */
export const EPHEMERAL_HEARTBEAT_INTERVAL_MS = 30_000;

/** One ephemeral cadence to arm. */
export interface EphemeralRoutineSpec {
  id: string;
  workspaceId: string;
  installSlug: string;
  name: string;
  /** The deterministic action the cadence fires (a `system:<x>` target). */
  targetRole: string;
  /** Cadence in seconds (from `trigger_config.interval_sec`). */
  intervalSec: number;
  payloadTemplate: Record<string, unknown> | null;
  triggerConfig: Record<string, unknown>;
}

export interface EphemeralExecutorDeps {
  /** The ACTIVE ephemeral routines to arm. */
  list: () => Promise<EphemeralRoutineSpec[]>;
  /**
   * Fire one routine's action (resolve + run). Throws on a missing/failed action.
   * Resolves with the action's result: a `softError` there is recorded as
   * `last_error` without counting as a failed fire (WI-10005164).
   */
  fire: (r: EphemeralRoutineSpec) => Promise<void | SystemActionResult>;
  /** Durable per-schedule liveness — UPDATE the ONE routine row (D-004), never INSERT per fire. */
  recordFire: (r: EphemeralRoutineSpec, error: string | null) => Promise<void>;
  /** Optional durable global heartbeat (best-effort). The inventory-visible heartbeat timer is the
   *  process-liveness signal regardless; this is the durable backstop when supplied. */
  heartbeat?: () => Promise<void>;
  log?: (msg: string) => void;
}

interface ArmedEphemeral {
  spec: EphemeralRoutineSpec;
  handle: ManagedHandle;
}

// Module-singleton arm-set. One executor per host (single-owner gated at the boot call site).
let armed: Map<string, ArmedEphemeral> | null = null;
let heartbeatHandle: ManagedHandle | null = null;
let liveDeps: EphemeralExecutorDeps | null = null;
let invalidationSubscription: { close: () => void } | null = null;
let invalidationListenHookStop: (() => void) | null = null;

const logWith = (deps: EphemeralExecutorDeps, msg: string): void =>
  (deps.log ?? ((m: string) => console.log(`[ephemeral-executor] ${m}`)))(msg);

/** Arm ONE ephemeral routine as a managed timer (category 'ephemeral-harness'). */
function armOne(spec: EphemeralRoutineSpec, deps: EphemeralExecutorDeps): ArmedEphemeral {
  const intervalSec = Math.max(EPHEMERAL_MIN_INTERVAL_SEC, Math.floor(spec.intervalSec));
  const handle = managedSetInterval(
    `ephemeral:${spec.id}`,
    intervalSec * 1000,
    async () => {
      let err: string | null = null;
      try {
        const result = await deps.fire(spec);
        // WI-10005164: a fail-soft sub-pass failure. Recorded like a throw so the
        // routine stops reading healthy, but not logged here: the action logs it
        // when it happens, and a sticky failure would repeat this line every tick.
        if (result && typeof result.softError === 'string' && result.softError) err = result.softError;
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
        logWith(deps, `fire failed for ${spec.id} (${spec.targetRole}): ${err}`);
      }
      // D-004: per-schedule durable liveness — UPDATE one row, never INSERT per fire.
      try {
        await deps.recordFire(spec, err);
      } catch {
        /* best-effort: liveness must never crash the tick */
      }
    },
    // The registry's re-entrancy guard + shed gate; ephemeral fires are bounded sweeps → shed-eligible.
    { category: 'ephemeral-harness', shed: true },
  );
  return { spec, handle };
}

/**
 * Arm the per-host ephemeral executor. IDEMPOTENT (a second call is a no-op). Call ONCE from
 * host-bootstrap under the single-owner gate (`backgroundWorkers && !utilityHost`).
 */
export async function armEphemeralExecutor(deps: EphemeralExecutorDeps): Promise<{ stop: () => void }> {
  if (armed) return { stop: disarmEphemeralExecutor };
  armed = new Map();
  liveDeps = deps;
  const specs = await deps.list();
  for (const spec of specs) armed.set(spec.id, armOne(spec, deps));
  if (deps.heartbeat) {
    heartbeatHandle = managedSetInterval(
      'ephemeral-executor-heartbeat',
      EPHEMERAL_HEARTBEAT_INTERVAL_MS,
      async () => {
        try {
          await deps.heartbeat!();
        } catch {
          /* best-effort */
        }
      },
      { category: 'ephemeral-harness' },
    );
  }
  logWith(deps, `armed ${specs.length} ephemeral cadence(s): ${specs.map((s) => s.name).join(', ') || '(none)'}`);
  return { stop: disarmEphemeralExecutor };
}

/**
 * Re-sync ONE routine in place (event-driven, D-006 — NOT a polling rescan): re-arm on an
 * add/edit (the cadence may have changed), idempotent. No-op when the executor is not armed on
 * this host. Pair with `unarmEphemeralRoutine` on delete/pause.
 */
export function syncEphemeralRoutine(spec: EphemeralRoutineSpec): void {
  if (!armed || !liveDeps) return;
  armed.get(spec.id)?.handle.stop();
  armed.set(spec.id, armOne(spec, liveDeps));
}

function sameSpec(a: EphemeralRoutineSpec, b: EphemeralRoutineSpec): boolean {
  return (
    a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.installSlug === b.installSlug &&
    a.name === b.name &&
    a.targetRole === b.targetRole &&
    a.intervalSec === b.intervalSec &&
    JSON.stringify(a.payloadTemplate) === JSON.stringify(b.payloadTemplate) &&
    JSON.stringify(a.triggerConfig) === JSON.stringify(b.triggerConfig)
  );
}

/**
 * Reconcile the live timer set with durable routine rows. Unchanged timers keep
 * their original deadline; only added/changed rows re-arm and removed/paused rows
 * disarm. This is the cross-process consumer for routines:set's existing
 * `automation.catalog` invalidation and the reconnect catch-up path.
 */
export async function refreshEphemeralExecutor(): Promise<{ synced: number; unarmed: number }> {
  if (!armed || !liveDeps) return { synced: 0, unarmed: 0 };
  const fresh = await liveDeps.list();
  const byId = new Map(fresh.map((spec) => [spec.id, spec]));
  let synced = 0;
  let unarmed = 0;

  for (const [id, current] of [...armed.entries()]) {
    const next = byId.get(id);
    if (!next) {
      current.handle.stop();
      armed.delete(id);
      unarmed += 1;
      continue;
    }
    if (sameSpec(current.spec, next)) continue;
    current.handle.stop();
    armed.set(id, armOne(next, liveDeps));
    synced += 1;
  }
  for (const next of fresh) {
    if (armed.has(next.id)) continue;
    armed.set(next.id, armOne(next, liveDeps));
    synced += 1;
  }
  if (synced > 0 || unarmed > 0) logWith(liveDeps, `refreshed timers: synced=${synced} unarmed=${unarmed}`);
  return { synced, unarmed };
}

/** Start the existing sync-invalidation bus consumer in the bg-host process. */
export async function startEphemeralRoutineInvalidationSync(): Promise<void> {
  if (invalidationSubscription) return;
  const { registerInvalidationListenHook, subscribe } = await import('../sync-sse');
  const refresh = async (): Promise<void> => {
    try {
      await refreshEphemeralExecutor();
    } catch (e) {
      console.warn('[ephemeral-executor] invalidation refresh failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  };
  invalidationListenHookStop = registerInvalidationListenHook(refresh);
  invalidationSubscription = await subscribe((event) => {
    if (event.name === 'automation.catalog') void refresh();
  });
}

/** Stop + drop ONE ephemeral routine's timer (event-driven disarm on delete/pause). */
export function unarmEphemeralRoutine(routineId: string): void {
  if (!armed) return;
  const a = armed.get(routineId);
  if (a) {
    a.handle.stop();
    armed.delete(routineId);
  }
}

/** Disarm the whole executor (teardown / pause / test cleanup). Deregisters every timer from the inventory. */
export function disarmEphemeralExecutor(): void {
  if (armed) {
    for (const a of armed.values()) a.handle.stop();
    armed = null;
  }
  if (heartbeatHandle) {
    heartbeatHandle.stop();
    heartbeatHandle = null;
  }
  liveDeps = null;
  invalidationSubscription?.close();
  invalidationSubscription = null;
  invalidationListenHookStop?.();
  invalidationListenHookStop = null;
}

/** Whether the executor is currently armed on this host (tests / introspection). */
export function ephemeralExecutorArmed(): boolean {
  return armed !== null;
}

/** The routine ids currently armed (tests / introspection). */
export function armedEphemeralIds(): string[] {
  return armed ? [...armed.keys()] : [];
}

/**
 * Production deps: the real PG arm-set + the system-action dispatch. `list` enumerates every
 * background workspace's active ephemeral routines (per-window-workspace-context P-020 — a
 * background reader has no request to scope it); `fire` resolves `getSystemAction` inside the
 * routine's workspace ALS scope; `recordFire` stamps the durable per-schedule liveness.
 */
export function productionEphemeralExecutorDeps(): EphemeralExecutorDeps {
  return {
    list: async () => {
      const out: EphemeralRoutineSpec[] = [];
      for (const ws of backgroundWorkspaceIds()) {
        const rows = await runWithWorkspace(ws, () => {
          const { sql } = getOrgPg();
          return listActiveEphemeralRoutines(sql);
        });
        for (const r of rows) {
          const intervalSec = Number(r.triggerConfig?.interval_sec);
          if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
            console.warn(`[ephemeral-executor] skipping ${r.id}: missing/invalid interval_sec`);
            continue;
          }
          if (intervalSec > EPHEMERAL_MAX_INTERVAL_SEC) {
            // WI-1406487: still armed (see EPHEMERAL_MAX_INTERVAL_SEC), but never again
            // silently. Without this line the ONLY trace of an unfireable routine is a
            // cheerful "armed" log, which is what made corpus-term-df invisible for 35.7h.
            console.warn(
              `[ephemeral-executor] UNFIREABLE-CADENCE ${r.name} (${r.id}): interval_sec ${intervalSec}s ` +
                `> ${EPHEMERAL_MAX_INTERVAL_SEC}s. This timer re-arms from zero on every host restart, so it ` +
                `only fires if the host stays up ${Math.ceil(intervalSec / 60)}min continuously — it will most ` +
                `likely NEVER fire. Move it to tier:durable with a cron (next_fire_at survives restarts).`,
            );
          }
          out.push({
            id: r.id,
            workspaceId: r.workspaceId,
            installSlug: r.installSlug,
            name: r.name,
            targetRole: r.targetRole,
            intervalSec,
            payloadTemplate: r.payloadTemplate,
            triggerConfig: r.triggerConfig,
          });
        }
      }
      return out;
    },
    fire: async (r) => {
      // Deterministic-action-only: blueprint:validate guarantees an ephemeral action is a concrete
      // system:<x>. A non-system role is out of contract for this bounded in-process fire path.
      if (!r.targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
        throw new Error(`ephemeral routine ${r.id} targetRole "${r.targetRole}" is not a ${SYSTEM_TARGET_PREFIX}action`);
      }
      const name = r.targetRole.slice(SYSTEM_TARGET_PREFIX.length);
      const action = getSystemAction(name);
      if (!action) throw new Error(`no system action "${name}" registered (ephemeral routine ${r.id})`);
      // WI-10005745 (D-012): same restricted-hold skip as the durable routine workflow.
      const skip = await restrictedTreeSkipReason(name, getSystemActionEntry(name));
      if (skip) {
        console.warn(`[ephemeral] ${skip} (routine ${r.id})`);
        return { diagnostics: { restrictedHoldSkip: skip } };
      }
      return await runWithWorkspace(r.workspaceId, () =>
        action({
          installSlug: r.installSlug,
          workspaceId: r.workspaceId,
          triggerConfig: r.triggerConfig,
          payloadTemplate: r.payloadTemplate,
        }),
      );
    },
    recordFire: async (r, error) => {
      await runWithWorkspace(r.workspaceId, () => {
        const { sql } = getOrgPg();
        return recordEphemeralFire(sql, r.id, error);
      });
    },
  };
}
