/**
 * overwatch/snapshot — the read surface for the Overwatch UI pane
 * (overwatch-role-2026-06-15 B-08).
 *
 * Two reads, one per sync resolver the pane subscribes to:
 *
 *   - `getOverwatchSnapshot()` → the current `OverwatchBrief` (health panels +
 *     anomalies). Per D-006 ("one health aggregation, two consumers") it does NOT
 *     re-aggregate — it reuses the SAME cached `SystemHealth` the Health tab
 *     serves (`lastSystemHealth` / `runSystemHealthTick`) and maps it onto the
 *     actionable C-1 subset via the pure `mapSystemHealthToBrief` + `withAnomalies`
 *     (B-03). Reading the shared cache keeps the pane cheap and consistent with the
 *     Health tab; on a cold/stale cache it warms it with one tick.
 *
 *   - `getOverwatchControlState()` → the persisted Start/Pause bit + cadence
 *     (B-07 control-state.ts) + the live wake liveness (B-09 liveness.ts) + the
 *     `papercusp-overwatch` activation flag (D-009). This is what the pane's header
 *     renders and what `kettle:start` / `kettle:pause` invalidate
 *     (`overwatch.controlState`, already wired in B-07).
 *
 * This is the DB-touching read surface — the SPA never imports it; it imports
 * only the pure `OverwatchBrief` / `OverwatchControlState` types from
 * `./brief-types`.
 */
import { getOrgPg } from "@papercusp/db-org";
import { FLAGS } from "@papercusp/flags";
import { getFlag } from "@papercusp/flags/server";
import { activeWorkspaceId } from "../workspace-registry";
import { resolvePotHomeSlug } from "../pot/wake";
import { resolveSystemHealth } from "../system-health";
import { mapSystemHealthToBrief, withAnomalies } from "./compute-brief";
import {
  emptyOverwatchBrief,
  type OverwatchBrief,
  type OverwatchControlState,
  type OverwatchLiveness,
  type OverwatchRun,
} from "./brief-types";
import {
  getOverwatchStarted,
  getOverwatchCadenceSec,
  listStartedOverwatches,
  DEFAULT_OVERWATCH_CADENCE_SEC,
} from "./control-state";
import {
  overwatchLivenessCheck,
  OVERWATCH_ROLE,
  OVERWATCH_INVOKE_TIMEOUT_MS,
  OVERWATCH_SCORECARD_DEADLINE_GRACE_MS,
} from "./liveness";

/** Reuse the shared SystemHealth cache when it is at most this fresh (matches the
 *  Health tab's read floor); past it, warm the cache with one tick. */
const SNAPSHOT_MAX_AGE_MS = 30_000;

/**
 * The current `OverwatchBrief` for the overwatch's hive — the actionable subset
 * of the shared `SystemHealth` model (D-006). Fail-soft: a catastrophic compute
 * failure (or a cold cache that can't warm) degrades to the neutral
 * `emptyOverwatchBrief` (healthy + no anomalies) rather than erroring the pane.
 */
export async function getOverwatchSnapshot(opts?: {
  workspaceId?: string;
  potSlug?: string;
  maxAgeMs?: number;
}): Promise<OverwatchBrief> {
  const ws = opts?.workspaceId ?? activeWorkspaceId();
  const maxAgeMs = opts?.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS;

  // D-006: ONE health aggregation, TWO consumers. Read the SAME cache the Health
  // tab serves; recompute on a cold/stale miss. We deliberately do NOT gate on
  // SYSTEM_HEALTH_TAB here (that gates the tab/getSystemHealth) — the overwatch
  // brief stays on its OWN flag, surfaced via the pane's flag gate + control state.
  // D-006: ONE health aggregation, TWO consumers. `resolveSystemHealth` serves the
  // SAME cache the Health tab serves, stale-while-revalidate. On a reader process
  // that never runs the 30s tick (the :3170 staging operator, a utility host, or
  // any process in the ~30s window right after boot) it serves the cross-process
  // SHARED snapshot the tick writes (a plain SELECT) instead of blocking on the
  // full ~15-collector aggregation on the pane's read path (P-001, the 1.6-2.0s the
  // audit measured). A tick host keeps its local SWR refresh, so the 30s
  // status-change SSE liveness is unchanged. Fail-soft to the neutral brief on a
  // catastrophic cold-compute failure (or a cold cache that can't warm).
  const health = await resolveSystemHealth(ws, maxAgeMs).catch(() => null);

  const potSlug =
    opts?.potSlug ??
    health?.panels.queen.data?.potSlug ??
    resolvePotHomeSlug() ??
    ws;
  if (!health) return emptyOverwatchBrief(potSlug);
  return withAnomalies(mapSystemHealthToBrief(health, potSlug));
}

/** Resolve the hive the overwatch supervises (v1 single-hive, D-005): an explicit
 *  slug → the env home slug → the first started overwatch (this workspace first). */
async function resolveOverwatchInstallSlug(
  ws: string,
  explicit?: string,
): Promise<string | null> {
  const direct = explicit ?? resolvePotHomeSlug();
  if (direct) return direct;
  const started = await listStartedOverwatches().catch(() => []);
  const fromStarted =
    started.find((s) => s.workspaceId === ws)?.installSlug ?? started[0]?.installSlug ?? null;
  if (fromStarted) return fromStarted;
  // REGISTRY FALLBACK (owner bug 2026-07-25). Every source above is empty in the
  // one state that matters most: PAUSED. `resolvePotHomeSlug()` is env-only and
  // PAPERCUSP_POT_HOME_SLUG is unset on the dev/green operators, and
  // listStartedOverwatches() is by definition empty while the Kettle is paused —
  // so the control-state used to report `potSlug: null` the moment you paused.
  // The pane derives its Start argument from that field, so Start then fired with
  // no harness and the tool refused with `no_home_harness`: the owner clicked
  // Start and NOTHING happened. This is the same defect, and the same fix, as
  // mug-steering-panel GAP 1 (2026-06-17) — resolveHomePotSlug() falls back to the
  // registry's first formal pot, which is exactly the slug the steering UI writes
  // to, so read and write agree. Imported lazily: _resolve lives in the agent-tools
  // layer above this one, and a static import would invert the dependency.
  try {
    const { resolveHomePotSlug } = await import("../agent-tools/pot/_resolve");
    return await resolveHomePotSlug(ws);
  } catch {
    return null;
  }
}

/**
 * The overwatch's persisted control state + liveness — the pane header's data.
 * `started && !flagEnabled` means PRE-ARMED (the bit is set, awaiting the flag
 * flip, B-12). Every read is independently fail-soft so a degraded source greys
 * its field instead of erroring the whole pane.
 */
export async function getOverwatchControlState(opts?: {
  workspaceId?: string;
  potSlug?: string;
}): Promise<OverwatchControlState> {
  const ws = opts?.workspaceId ?? activeWorkspaceId();
  const installSlug = await resolveOverwatchInstallSlug(ws, opts?.potSlug);
  const flagEnabled = await getFlag(FLAGS.OVERWATCH, `overwatch:${ws}`).catch(
    () => false,
  );

  if (!installSlug) {
    return {
      potSlug: null,
      started: false,
      cadenceSec: DEFAULT_OVERWATCH_CADENCE_SEC,
      flagEnabled,
      armed: false,
      nextWakeAt: null,
      lastWakeAt: null,
      staleForMs: null,
    };
  }

  const { sql } = getOrgPg();
  const [started, cadenceSec, liveness] = await Promise.all([
    getOverwatchStarted(ws, installSlug).catch(() => false),
    getOverwatchCadenceSec(ws, installSlug).catch(
      () => DEFAULT_OVERWATCH_CADENCE_SEC,
    ),
    overwatchLivenessCheck(sql, installSlug, { workspaceId: ws }).catch(() => ({
      armed: false,
      nextFireAt: null,
      lastFiredAt: null,
      staleForMs: null,
    })),
  ]);

  return {
    potSlug: installSlug,
    started,
    cadenceSec,
    flagEnabled,
    armed: liveness.armed,
    nextWakeAt: liveness.nextFireAt ? liveness.nextFireAt.toISOString() : null,
    lastWakeAt: liveness.lastFiredAt
      ? liveness.lastFiredAt.toISOString()
      : null,
    staleForMs: liveness.staleForMs,
  };
}

/** STALE-after threshold: a started+enabled loop is STALE once its last fire is
 *  older than this multiple of the cadence (one missed cycle is tolerable jitter;
 *  past 2× the loop is genuinely not firing). */
const STALE_CADENCE_MULTIPLE = 2;

/** The raw `autoloop_state` fire row (role='overwatch') the strip rests on. */
interface OverwatchFireRow {
  lastFiredAt: Date | null;
  lastStatus: string | null;
  consecutiveErrors: number;
}

/** A status reads "ok" unless it is an explicit `error:` fire (the loop stamps
 *  `error: …` on a failed launch; `firing` / `ok` / `no-session-now` are not errors). */
function statusIsOk(status: string | null): boolean {
  if (!status) return false;
  return !status.startsWith("error");
}

/**
 * The PURE liveness derivation — given the fire row, cadence, control bits, and
 * `now`, compute the whole `OverwatchLiveness` projection (next-run estimate +
 * ALIVE/STALE verdict). Pure + deterministic so it unit-tests with no DB.
 */
export function deriveOverwatchLiveness(input: {
  potSlug: string | null;
  started: boolean;
  flagEnabled: boolean;
  cadenceSec: number;
  fire: OverwatchFireRow;
  now?: number;
}): OverwatchLiveness {
  const now = input.now ?? Date.now();
  const { potSlug, started, flagEnabled, cadenceSec, fire } = input;
  const lastMs = fire.lastFiredAt ? fire.lastFiredAt.getTime() : null;
  const ageMs = lastMs != null ? Math.max(0, now - lastMs) : null;
  const nextMs = lastMs != null ? lastMs + cadenceSec * 1000 : null;
  const enabledLoop = started && flagEnabled;
  const staleThresholdMs = cadenceSec * 1000 * STALE_CADENCE_MULTIPLE;
  const inFlight =
    fire.lastStatus === "firing" &&
    ageMs != null &&
    ageMs <=
      OVERWATCH_INVOKE_TIMEOUT_MS + OVERWATCH_SCORECARD_DEADLINE_GRACE_MS;

  // ALIVE = the loop is meant to be running AND it has fired within the stale
  // window. STALE = meant to be running but the last fire is past the window
  // (or it never fired despite being enabled). A paused/dark loop is neither.
  const firedRecently = ageMs != null && ageMs <= staleThresholdMs;
  const alive = enabledLoop && firedRecently;
  const stale = enabledLoop && !firedRecently;

  const recentRuns: OverwatchRun[] =
    fire.lastFiredAt && lastMs != null
      ? [
          {
            firedAt: fire.lastFiredAt.toISOString(),
            status: fire.lastStatus ?? "unknown",
            ok: statusIsOk(fire.lastStatus),
          },
        ]
      : [];

  return {
    potSlug,
    started,
    flagEnabled,
    cadenceSec,
    lastRunAt: fire.lastFiredAt ? fire.lastFiredAt.toISOString() : null,
    lastStatus: fire.lastStatus,
    consecutiveErrors: fire.consecutiveErrors,
    ageMs,
    inFlight,
    nextRunAt: nextMs != null ? new Date(nextMs).toISOString() : null,
    nextRunInMs: nextMs != null ? nextMs - now : null,
    alive,
    stale,
    recentRuns,
  };
}

/** Read the overwatch fire row from `autoloop_state` (role='overwatch') for the
 *  given (workspace, install). Fail-soft to an empty/never-fired row. */
async function readOverwatchFireRow(
  ws: string,
  installSlug: string,
): Promise<OverwatchFireRow> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        last_fired_at: Date | string | null;
        last_status: string | null;
        consecutive_errors: number | string | null;
      }>
    >`
      SELECT last_fired_at, last_status, consecutive_errors
        FROM harness_shared.autoloop_state
       WHERE workspace_id = ${ws} AND harness_slug = ${installSlug} AND role = ${OVERWATCH_ROLE}
       LIMIT 1
    `;
    if (rows.length === 0)
      return { lastFiredAt: null, lastStatus: null, consecutiveErrors: 0 };
    const r = rows[0];
    const lastFiredAt =
      r.last_fired_at == null
        ? null
        : r.last_fired_at instanceof Date
          ? r.last_fired_at
          : new Date(r.last_fired_at);
    return {
      lastFiredAt:
        lastFiredAt && !Number.isNaN(lastFiredAt.getTime())
          ? lastFiredAt
          : null,
      lastStatus: r.last_status ?? null,
      consecutiveErrors: Number(r.consecutive_errors ?? 0),
    };
  } catch {
    return { lastFiredAt: null, lastStatus: null, consecutiveErrors: 0 };
  }
}

/**
 * The overwatch LIVENESS / heartbeat projection — the "is-it-alive?" strip's data
 * (the `overwatch.liveness` sync resolver). Unlike `getOverwatchControlState`,
 * whose `armed`/`lastWakeAt` come from the one-shot `overwatch-wake` routine row
 * (deactivated between fires, so it can't prove a healthy-between-runs loop), this
 * rests on the `autoloop_state` row that EVERY actual fire stamps via `recordFire`.
 * Every read is independently fail-soft so a degraded source greys the field
 * instead of erroring the strip.
 */
export async function getOverwatchLiveness(opts?: {
  workspaceId?: string;
  potSlug?: string;
  now?: number;
}): Promise<OverwatchLiveness> {
  const ws = opts?.workspaceId ?? activeWorkspaceId();
  const installSlug = await resolveOverwatchInstallSlug(ws, opts?.potSlug);
  const flagEnabled = await getFlag(FLAGS.OVERWATCH, `overwatch:${ws}`).catch(
    () => false,
  );

  if (!installSlug) {
    return deriveOverwatchLiveness({
      potSlug: null,
      started: false,
      flagEnabled,
      cadenceSec: DEFAULT_OVERWATCH_CADENCE_SEC,
      fire: { lastFiredAt: null, lastStatus: null, consecutiveErrors: 0 },
      now: opts?.now,
    });
  }

  const [started, cadenceSec, fire] = await Promise.all([
    getOverwatchStarted(ws, installSlug).catch(() => false),
    getOverwatchCadenceSec(ws, installSlug).catch(
      () => DEFAULT_OVERWATCH_CADENCE_SEC,
    ),
    readOverwatchFireRow(ws, installSlug),
  ]);

  return deriveOverwatchLiveness({
    potSlug: installSlug,
    started,
    flagEnabled,
    cadenceSec,
    fire,
    now: opts?.now,
  });
}
