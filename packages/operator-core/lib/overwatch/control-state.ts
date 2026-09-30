/**
 * control-state.ts — the persisted Start/Pause-Overwatch state + wake cadence
 * (overwatch-role-2026-06-15 B-07).
 *
 * The overwatch is a sibling autonomous loop to the Queen (D-005, per-hive). Like
 * the hive's `hive_started` bit (hive/started.ts), THIS is the load-bearing
 * control signal the overwatch loop (B-04) and its liveness watchdog (B-09) gate
 * on: a wake is armed WHILE STARTED, nothing fires while paused. The control
 * tools `kettle:start` / `kettle:pause` (B-07) are its only writers — the
 * loop/watchdog are pure readers (exactly the hive split, where the watchdog
 * re-arms a wake purely from `hive_started`).
 *
 * Stored in the `operator_settings` KV (PG, per storage policy — the same home
 * as `hive_started` and the wake-mode default), one row per (workspace, install):
 *   key `overwatch_started:<workspaceId>:<installSlug>`     → 'true' | 'false'
 *   key `overwatch_cadence_sec:<workspaceId>:<installSlug>` → '<int seconds>'
 *
 * No migration: it reuses the existing KV table + its `ON CONFLICT (key)` upsert,
 * exactly as hive/started.ts does.
 *
 * K1 workspace-brain re-key (workspace-scoped-coordination-2026-06-20 P-004 /
 * D-006/D-007 — Phase C, a direct mirror of the Queen's Phase A in hive/started.ts
 * and the Scout's Phase P-002 in scout/scheduler.ts): when
 * FLAGS.WORKSPACE_COORDINATION is ON, the overwatch's started bit + cadence
 * collapse to ONE row per WORKSPACE — the install dimension is replaced by the
 * shared workspace SENTINEL (= workspaceId) via `workspaceBrainScopeKey`, so the
 * one workspace Overwatch has a single control state spanning all the workspace's
 * hives. Every read ships a READ-FALLBACK to the legacy per-hive row
 * (`workspaceBrainReadKeys`) so the live single-hive workspace stays
 * zero-regression pre-backfill. Writes keep the sentinel and legacy rows
 * converged while the flag is ON; otherwise a stale legacy `true` can make the
 * watchdog think there is work to guard while the sentinel `false` makes the
 * actual re-arm path skip. Flag OFF (the dark default) ⇒ the legacy
 * per-(ws,install) keying, BYTE-IDENTICAL to today.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  isWorkspaceCoordinationOn,
  workspaceBrainScopeKey,
  workspaceBrainReadKeys,
} from '../workspace-brain-scope';
import { activeWorkspaceId } from '../workspace-registry';

const STARTED_PREFIX = 'overwatch_started:';
const CADENCE_PREFIX = 'overwatch_cadence_sec:';

/**
 * Default wake cadence. The overwatch is a SHORT-TERM control loop (catch drift +
 * nudge it back in real time), so it runs MORE responsively than the Queen's
 * ~30 min scheduler cadence (plan architecture: "Queen = scheduler, NOW;
 * Overwatch = control-loop, SHORT-TERM").
 *
 * WI-4401: this is the FALLBACK/floor value `kettle:declare-wake` uses when the
 * persona doesn't pass an explicit time — it is NOT the expected steady-state
 * average. The kettle persona's own guidance (blueprints/coding/prompts/kettle.md
 * "ALWAYS call kettle:declare-wake") explicitly picks `inSeconds: 600–1800`
 * (10–30 min) whenever the system reads healthy, and only drops to 60–180s while
 * actively watching an unresolved drift. A calm system therefore naturally
 * averages somewhere in the ~10-20min band (measured 2026-07-12: ~18-19min over
 * a 10-card window) — that is EXPECTED behavior, not a delivery-latency bug or a
 * missed target. Don't re-open a "cadence is slower than 10min" investigation
 * without first checking the actual wake choices the loop made (kettle.md's
 * 600-1800s healthy range) against the observed average.
 */
export const DEFAULT_OVERWATCH_CADENCE_SEC = 600; // 10 min
/** Floor — the anti-spin guard (a control loop must not thrash, D-002). */
export const MIN_OVERWATCH_CADENCE_SEC = 60; // 1 min
/** Ceiling — beyond this the loop is too slow to be a live supervisor. */
export const MAX_OVERWATCH_CADENCE_SEC = 3600; // 1 h

const startedKey = (workspaceId: string, installSlug: string): string =>
  `${STARTED_PREFIX}${workspaceId}:${installSlug}`;
const cadenceKey = (workspaceId: string, installSlug: string): string =>
  `${CADENCE_PREFIX}${workspaceId}:${installSlug}`;

/** Clamp a requested cadence into [MIN, MAX]; non-finite → the default. */
export function clampOverwatchCadenceSec(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_OVERWATCH_CADENCE_SEC;
  return Math.min(MAX_OVERWATCH_CADENCE_SEC, Math.max(MIN_OVERWATCH_CADENCE_SEC, Math.round(sec)));
}

async function readSetting(key: string): Promise<string | undefined> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT value FROM harness_shared.operator_settings WHERE key = ${key} LIMIT 1`;
  return (rows[0] as { value?: string } | undefined)?.value;
}

async function writeSetting(key: string, value: string, description: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (${key}, ${value}, ${description}, ${Date.now()}, ${activeWorkspaceId()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

async function writeExistingStartedRowsForWorkspace(
  workspaceId: string,
  value: string,
  description: string,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.operator_settings
    SET value = ${value}, description = ${description}, updated_at = ${Date.now()}
    WHERE key LIKE ${STARTED_PREFIX + workspaceId + ':%'}
      AND key <> ${startedKey(workspaceId, workspaceId)}
  `;
}

/** Whether the overwatch is started (default false — born paused/idle, like the hive).
 *  K1: ON ⇒ read the workspace-sentinel row first, then fall back to the legacy
 *  per-hive row (zero regression pre-backfill). OFF ⇒ the per-hive row only,
 *  byte-identical to today (exactly one key = installSlug). */
export async function getOverwatchStarted(workspaceId: string, installSlug: string): Promise<boolean> {
  const on = await isWorkspaceCoordinationOn();
  for (const scope of workspaceBrainReadKeys(workspaceId, installSlug, on)) {
    const v = await readSetting(startedKey(workspaceId, scope));
    if (v != null) return v === 'true';
  }
  return false;
}

/** K1: ON ⇒ write the workspace-sentinel row (the install dimension collapses)
 *  and converge the legacy fallback rows. OFF ⇒ the per-hive row,
 *  byte-identical to today. */
export async function setOverwatchStarted(
  workspaceId: string,
  installSlug: string,
  started: boolean,
): Promise<void> {
  const on = await isWorkspaceCoordinationOn();
  const scope = workspaceBrainScopeKey(workspaceId, installSlug, on);
  const value = started ? 'true' : 'false';
  const description =
    'Start/Pause Kettle state (overwatch-role B-07). true = the overwatch supervisor loop should be running; the loop (B-04) + liveness watchdog (B-09) hold the wake-armed invariant only while true.';
  await writeSetting(startedKey(workspaceId, scope), value, description);
  if (on && installSlug !== scope) {
    await writeSetting(startedKey(workspaceId, installSlug), value, description);
  }
  if (on && !started) {
    await writeExistingStartedRowsForWorkspace(workspaceId, value, description);
  }
}

/** The configured wake cadence (seconds), clamped; the default when unset/invalid.
 *  K1: ON ⇒ prefer the workspace-sentinel row, then fall back to the legacy
 *  per-hive row. OFF ⇒ the per-hive row only, byte-identical to today. */
export async function getOverwatchCadenceSec(workspaceId: string, installSlug: string): Promise<number> {
  const on = await isWorkspaceCoordinationOn();
  for (const scope of workspaceBrainReadKeys(workspaceId, installSlug, on)) {
    const raw = await readSetting(cadenceKey(workspaceId, scope));
    if (raw !== undefined) {
      const n = Number(raw);
      return Number.isFinite(n) ? clampOverwatchCadenceSec(n) : DEFAULT_OVERWATCH_CADENCE_SEC;
    }
  }
  return DEFAULT_OVERWATCH_CADENCE_SEC;
}

/** Persist the wake cadence (clamped); returns the clamped value actually stored.
 *  K1: ON ⇒ write the workspace-sentinel row; OFF ⇒ the per-hive row, byte-identical. */
export async function setOverwatchCadenceSec(
  workspaceId: string,
  installSlug: string,
  sec: number,
): Promise<number> {
  const clamped = clampOverwatchCadenceSec(sec);
  const scope = workspaceBrainScopeKey(workspaceId, installSlug, await isWorkspaceCoordinationOn());
  await writeSetting(
    cadenceKey(workspaceId, scope),
    String(clamped),
    'Kettle wake cadence in seconds (overwatch-role B-07). The loop (B-04) declares its next wake this far out while started.',
  );
  return clamped;
}

/** Parse the raw `overwatch_started:<ws>:<install>` rows currently marked started. */
async function readStartedRows(): Promise<Array<{ workspaceId: string; installSlug: string }>> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT key FROM harness_shared.operator_settings
    WHERE key LIKE ${STARTED_PREFIX + '%'} AND value = 'true'
  `;
  const out: Array<{ workspaceId: string; installSlug: string }> = [];
  for (const r of rows as unknown as Array<{ key: string }>) {
    const rest = r.key.slice(STARTED_PREFIX.length);
    // workspace ids and install slugs are colon-free (slug charset is
    // [a-z0-9-]); the FIRST ':' is the separator (same parse as listStartedHives).
    const i = rest.indexOf(':');
    if (i <= 0) continue;
    out.push({ workspaceId: rest.slice(0, i), installSlug: rest.slice(i + 1) });
  }
  return out;
}

/**
 * Every (workspace, install) currently marked started — the raw set, mirroring
 * `listStartedHives()`.
 *
 * Byte-identical to today: the raw per-(ws,install) started rows, parsed. The
 * workspace-brain de-dup (K1, when WORKSPACE_COORDINATION is ON) lives in
 * `listStartedWorkspaceOverwatches()` — this raw read stays untouched so the
 * pane's hive-resolver (snapshot.ts `resolveOverwatchInstallSlug`) keeps seeing
 * real hive slugs, exactly as the Queen's `listStartedHives` stays raw for the
 * per-hive placement gate.
 */
export async function listStartedOverwatches(): Promise<Array<{ workspaceId: string; installSlug: string }>> {
  return readStartedRows();
}

/**
 * The DE-DUPED Overwatch-supervisor loop set (K1, workspace-scoped-coordination
 * P-004 / D-006 — Phase C, the exact mirror of the Queen's
 * `listStartedWorkspaceLoops()` in hive/started.ts). The supervisor seams (the
 * watchdog boot/sweep, the cross-monitor, the scorecard-backstop) must run ONE
 * supervisor per workspace under the workspace Overwatch, not N per-hive
 * supervisors.
 *
 * - OFF (the dark default) ⇒ the raw per-(ws,install) set, BYTE-IDENTICAL to
 *   `listStartedOverwatches()` — every existing supervisor seam is unchanged.
 * - ON ⇒ collapse to ONE entry per started workspace, seated at the workspace's
 *   home hive (`resolvePotHomeSlug`, = `PAPERCUSP_POT_HOME_SLUG`), so the single
 *   workspace supervisor's liveness/wake keys resolve against the same install the
 *   overwatch-wake routine (./liveness) is keyed to. The seat-home falls back to
 *   the row's own install slug when no env home is set (multi-home pre-flip stays
 *   sane); for the live single-hive workspace papercusp==papercusp-workspace the
 *   seat-home IS that hive → zero regression.
 */
export async function listStartedWorkspaceOverwatches(): Promise<
  Array<{ workspaceId: string; installSlug: string }>
> {
  const rows = await readStartedRows();
  if (!(await isWorkspaceCoordinationOn())) return rows;
  // ON: one supervisor per workspace, seated at the workspace home hive. Lazy
  // import of resolvePotHomeSlug keeps this module free of hive/wake.ts's
  // import-time side effects (the same lazy-import discipline hive/started.ts
  // uses for its own listStartedWorkspaceLoops).
  const { resolvePotHomeSlug } = await import('../pot/wake');
  // A workspace-sentinel started row is not an install. Validate the seat
  // against the live harness registry before returning it to watchdogs; an
  // unvalidated synthetic slug strands the supervisor on a dead target.
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; installSlug: string }> = [];
  for (const r of rows) {
    if (seen.has(r.workspaceId)) continue;
    seen.add(r.workspaceId);
    let registeredPotSlugs: Set<string>;
    try {
      const { loadHarnessRegistry } = await import('../harness-registry');
      const registry = await loadHarnessRegistry(r.workspaceId);
      registeredPotSlugs = new Set(
        registry.projects.filter((p) => p.harness_kind === 'hive').map((p) => p.slug),
      );
    } catch {
      continue;
    }
    // Prefer the configured home only when it exists; otherwise choose a real
    // started hive in this workspace. Never seat on the workspace sentinel.
    const envHome = resolvePotHomeSlug(undefined, undefined);
    const seatHome = [
      envHome,
      ...rows
        .filter((candidate) => candidate.workspaceId === r.workspaceId)
        .map((candidate) => candidate.installSlug),
    ].find((candidate) => candidate && registeredPotSlugs.has(candidate));
    if (seatHome) out.push({ workspaceId: r.workspaceId, installSlug: seatHome });
  }
  return out;
}
