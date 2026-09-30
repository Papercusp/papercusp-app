/**
 * Context-door / compaction-threshold constant overrides (deterministic-context-carry
 * P-023).
 *
 * Two layers over the BAKED constants in context-doors.ts, both DELIBERATE decisions —
 * never runtime feedback (plan D-001):
 *   defaults  — workspace-level overrides set via `config:doors-set` (SU roles, audited
 *               through the gateway-control harness).
 *   sessions  — per-ownerId overrides set via `config:doors-set-session`, bound to the
 *               CALLER's resolved agent identity (TTL = session: entries are stamped
 *               { setBy, setAt, provenance }, age-filtered on read, pruned on write).
 *
 * Resolution: BAKED ⟵ workspace defaults ⟵ session override (per key; doorSplit is
 * all-or-nothing since its proportions must sum to 1). Every patch is SANITIZED on write
 * AND on read (a hand-edited row can never poison the doors): floor ≤ cap, divisor ≥ 1,
 * overhead ≥ 0, split sums to 1 ± 1e-6 with an integer slot count.
 *
 * CONSUMPTION IS SYNC (the door enforcement sites — result-door.ts, wake-executor's
 * injection door — are synchronous functions on hot paths): `getDoorConstantsSync`
 * serves a module-level snapshot and kicks a BACKGROUND refresh when it is stale
 * (~15s TTL). Fail-soft by construction: before the first refresh lands (or if PG is
 * unreachable) it serves BAKED_DOOR_CONSTANTS — exactly the un-configured behavior.
 * Kill-switch: PAPERCUSP_DOORS_CONFIG_OFF=1 pins BAKED everywhere.
 *
 * Storage: harness_shared.operator_context_doors_config (migration 604), the
 * operator-state single-row-per-workspace JSONB idiom. Registered as a runtime-config
 * override concern so config:list-overrides / config:reset-overrides cover it.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { BAKED_DOOR_CONSTANTS, type DoorConstants } from './context-doors';

/** A partial override of the door constants. `doorSplit` is all-or-nothing (the four
 *  proportions are meaningful only together — they must sum to 1). */
export interface DoorConstantsPatch {
  maxTurnFloorTokens?: number;
  maxTurnCapTokens?: number;
  maxTurnWindowDivisor?: number;
  doorSplit?: { output: number; resultEach: number; resultSlots: number; injections: number };
  compactionOverheadTokens?: number;
}

/** One session's override — provenance-stamped so the audit trail and the readback both
 *  show WHO bound it and on what authority. */
export interface SessionDoorsOverride {
  overrides: DoorConstantsPatch;
  /** The resolved agent ownerId that set it (resolveAgentIdentity — the binding key). */
  setBy: string;
  /** epoch ms */
  setAt: number;
  /** Free-form provenance, e.g. 'role:superuser source:omp-hook-session'. */
  provenance: string;
}

/** The stored row: workspace defaults + the per-session override map. */
export interface ContextDoorsConfigRow {
  defaults?: DoorConstantsPatch;
  sessions?: Record<string, SessionDoorsOverride>;
}

const STATE_TABLE = 'operator_context_doors_config' as const;

/** TTL=session is enforced without a per-read liveness probe: an override is only ever
 *  consulted while serving ITS OWN session's traffic (a dead session makes no tool calls
 *  and receives no wakes), so the age cap is a GC bound, not the liveness mechanism —
 *  it stops a long-forgotten override from silently governing a resumed/recycled id. */
export const SESSION_DOORS_OVERRIDE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Write-time bound on the session map (oldest pruned first) so it can never grow unbounded. */
export const SESSION_DOORS_OVERRIDE_MAX_ENTRIES = 256;

const SPLIT_SUM_EPSILON = 1e-6;

function finitePositive(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Sanitize one patch: drop every invalid field (never throw — applied on read AND write).
 *  Cross-field rule floor ≤ cap is enforced against the EFFECTIVE values at resolve time. */
export function sanitizeDoorPatch(raw: unknown): DoorConstantsPatch {
  if (raw == null || typeof raw !== 'object') return {};
  const p = raw as Record<string, unknown>;
  const out: DoorConstantsPatch = {};
  const floor = finitePositive(p.maxTurnFloorTokens);
  if (floor !== undefined) out.maxTurnFloorTokens = Math.floor(floor);
  const cap = finitePositive(p.maxTurnCapTokens);
  if (cap !== undefined) out.maxTurnCapTokens = Math.floor(cap);
  const divisor = finitePositive(p.maxTurnWindowDivisor);
  if (divisor !== undefined && divisor >= 1) out.maxTurnWindowDivisor = divisor;
  const overhead = Number((p as { compactionOverheadTokens?: unknown }).compactionOverheadTokens);
  if (Number.isFinite(overhead) && overhead >= 0) out.compactionOverheadTokens = Math.floor(overhead);
  const split = p.doorSplit as Record<string, unknown> | undefined;
  if (split != null && typeof split === 'object') {
    const output = finitePositive(split.output);
    const resultEach = finitePositive(split.resultEach);
    const slots = finitePositive(split.resultSlots);
    const injections = finitePositive(split.injections);
    if (
      output !== undefined &&
      resultEach !== undefined &&
      injections !== undefined &&
      slots !== undefined &&
      Number.isInteger(slots) &&
      slots >= 1 &&
      Math.abs(output + slots * resultEach + injections - 1) <= SPLIT_SUM_EPSILON
    ) {
      out.doorSplit = { output, resultEach, resultSlots: slots, injections };
    }
  }
  return out;
}

/** Pure merge: BAKED ⟵ workspace defaults ⟵ session override. Floor>cap after the merge
 *  resolves by clamping the floor DOWN to the cap (never inverted output). */
export function resolveDoorConstants(row: ContextDoorsConfigRow | null, ownerId?: string | null): DoorConstants {
  const layers: DoorConstantsPatch[] = [];
  if (row?.defaults) layers.push(sanitizeDoorPatch(row.defaults));
  const session = ownerId ? row?.sessions?.[ownerId] : undefined;
  if (session && Date.now() - session.setAt <= SESSION_DOORS_OVERRIDE_MAX_AGE_MS) {
    layers.push(sanitizeDoorPatch(session.overrides));
  }
  let c: DoorConstants = BAKED_DOOR_CONSTANTS;
  for (const patch of layers) {
    c = {
      maxTurnFloorTokens: patch.maxTurnFloorTokens ?? c.maxTurnFloorTokens,
      maxTurnCapTokens: patch.maxTurnCapTokens ?? c.maxTurnCapTokens,
      maxTurnWindowDivisor: patch.maxTurnWindowDivisor ?? c.maxTurnWindowDivisor,
      doorSplit: patch.doorSplit ?? c.doorSplit,
      compactionOverheadTokens: patch.compactionOverheadTokens ?? c.compactionOverheadTokens,
    };
  }
  if (c.maxTurnFloorTokens > c.maxTurnCapTokens) c = { ...c, maxTurnFloorTokens: c.maxTurnCapTokens };
  return c;
}

export async function readContextDoorsConfig(): Promise<ContextDoorsConfigRow> {
  return (await readOperatorState<ContextDoorsConfigRow>(STATE_TABLE)) ?? {};
}

/** Drop expired session entries; keep the newest SESSION_DOORS_OVERRIDE_MAX_ENTRIES. */
function pruneSessions(sessions: Record<string, SessionDoorsOverride> | undefined): Record<string, SessionDoorsOverride> {
  const now = Date.now();
  const live = Object.entries(sessions ?? {}).filter(
    ([, s]) => s && typeof s.setAt === 'number' && now - s.setAt <= SESSION_DOORS_OVERRIDE_MAX_AGE_MS,
  );
  live.sort((a, b) => b[1].setAt - a[1].setAt);
  return Object.fromEntries(live.slice(0, SESSION_DOORS_OVERRIDE_MAX_ENTRIES));
}

/** Replace the workspace-default overrides ({} clears back to baked). Returns the stored row. */
export async function writeContextDoorsDefaults(patch: DoorConstantsPatch): Promise<ContextDoorsConfigRow> {
  const cur = await readContextDoorsConfig();
  const next: ContextDoorsConfigRow = { defaults: sanitizeDoorPatch(patch), sessions: pruneSessions(cur.sessions) };
  if (Object.keys(next.defaults ?? {}).length === 0) delete next.defaults;
  await writeOperatorState(STATE_TABLE, next);
  invalidateDoorConstantsSnapshot();
  return next;
}

/** Bind (or with null: clear) one session's override. Returns the stored row. */
export async function writeSessionDoorsOverride(
  ownerId: string,
  override: (Omit<SessionDoorsOverride, 'setAt'> & { setAt?: number }) | null,
): Promise<ContextDoorsConfigRow> {
  const cur = await readContextDoorsConfig();
  const sessions = pruneSessions(cur.sessions);
  if (override == null) {
    delete sessions[ownerId];
  } else {
    sessions[ownerId] = {
      overrides: sanitizeDoorPatch(override.overrides),
      setBy: override.setBy,
      setAt: override.setAt ?? Date.now(),
      provenance: override.provenance,
    };
  }
  const next: ContextDoorsConfigRow = { ...(cur.defaults ? { defaults: sanitizeDoorPatch(cur.defaults) } : {}), sessions };
  if (Object.keys(sessions).length === 0) delete next.sessions;
  await writeOperatorState(STATE_TABLE, next);
  invalidateDoorConstantsSnapshot();
  return next;
}

// ── Sync consumption: snapshot + background refresh ─────────────────────────────
//
// The door sites (applyResultDoor / applyInjectionDoor) are synchronous, per-event hot
// paths — they can neither await a PG read nor tolerate one per call. They read a
// module-level snapshot of the whole row; a stale snapshot (or a read before the first
// refresh lands) serves BAKED-equivalent behavior, and a change propagates within the
// refresh TTL. The same-process write paths above invalidate immediately.

function snapshotTtlMs(): number {
  const raw = Number(process.env.PAPERCUSP_DOORS_CONFIG_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

let snapshot: { row: ContextDoorsConfigRow | null; at: number } | null = null;
let refreshInFlight = false;

/** Same-process read-after-write consistency (write paths call this). Exported for tests. */
export function invalidateDoorConstantsSnapshot(): void {
  snapshot = null;
}

function refreshSnapshot(): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  readContextDoorsConfig()
    .then((row) => {
      snapshot = { row, at: Date.now() };
    })
    .catch(() => {
      // PG unreachable: keep serving the previous snapshot (or baked); retry next call.
      if (snapshot) snapshot = { ...snapshot, at: Date.now() };
    })
    .finally(() => {
      refreshInFlight = false;
    });
}

/**
 * The EFFECTIVE door constants for a session (or the workspace when ownerId is absent),
 * synchronously. Serves the last-known snapshot and refreshes it in the background when
 * stale; before the first refresh (or under PAPERCUSP_DOORS_CONFIG_OFF=1) this is exactly
 * BAKED_DOOR_CONSTANTS.
 */
export function getDoorConstantsSync(ownerId?: string | null): DoorConstants {
  if (process.env.PAPERCUSP_DOORS_CONFIG_OFF === '1') return BAKED_DOOR_CONSTANTS;
  if (!snapshot || Date.now() - snapshot.at > snapshotTtlMs()) refreshSnapshot();
  return resolveDoorConstants(snapshot?.row ?? null, ownerId);
}

// ── Runtime-config override concern (config:list-overrides / config:reset-overrides) ──

const PATCH_KEYS = [
  'maxTurnFloorTokens',
  'maxTurnCapTokens',
  'maxTurnWindowDivisor',
  'doorSplit',
  'compactionOverheadTokens',
] as const;

const BAKED_BY_KEY: Record<(typeof PATCH_KEYS)[number], unknown> = {
  maxTurnFloorTokens: BAKED_DOOR_CONSTANTS.maxTurnFloorTokens,
  maxTurnCapTokens: BAKED_DOOR_CONSTANTS.maxTurnCapTokens,
  maxTurnWindowDivisor: BAKED_DOOR_CONSTANTS.maxTurnWindowDivisor,
  doorSplit: BAKED_DOOR_CONSTANTS.doorSplit,
  compactionOverheadTokens: BAKED_DOOR_CONSTANTS.compactionOverheadTokens,
};

registerOverrideConcern({
  name: 'context-doors-config',
  description: 'context-door / compaction-threshold constant overrides (workspace defaults + per-session, P-023)',
  auditAction: 'config:doors-set',
  diff: async () => {
    const row = await readContextDoorsConfig();
    const entries: OverrideEntry[] = [];
    const defaults = sanitizeDoorPatch(row.defaults);
    for (const k of PATCH_KEYS) {
      if (defaults[k] !== undefined) {
        entries.push({ key: k, effective: defaults[k], default: BAKED_BY_KEY[k], layer: 'pg-settings' });
      }
    }
    const sessions = Object.entries(row.sessions ?? {});
    if (sessions.length > 0) {
      entries.push({
        key: 'sessions',
        effective: sessions.map(([ownerId, s]) => ({ ownerId, setBy: s.setBy, setAt: s.setAt, keys: Object.keys(sanitizeDoorPatch(s.overrides)) })),
        default: [],
        layer: 'pg-settings',
      });
    }
    return entries;
  },
  capture: () => readContextDoorsConfig(),
  reset: async () => {
    await writeOperatorState(STATE_TABLE, {} satisfies ContextDoorsConfigRow, activeWorkspaceId());
    invalidateDoorConstantsSnapshot();
    return {};
  },
  restore: async (snap) => {
    await writeOperatorState(STATE_TABLE, (snap as ContextDoorsConfigRow) ?? {}, activeWorkspaceId());
    invalidateDoorConstantsSnapshot();
  },
});
