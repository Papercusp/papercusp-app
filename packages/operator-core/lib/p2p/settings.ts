/**
 * p2p/settings — the host-sovereign P2P work-sharing settings store + the
 * foreign-work admission contract (p2p-work-distribution-2026-07-02 P-002).
 *
 * STORAGE (reuse-first): rides the existing `harness_shared.operator_settings`
 * KV — the exact queen/overwatch settings store (overwatch/control-state.ts) —
 * with the item's mandated TWO-LAYER keying:
 *
 *   p2p:settings:default             — the workspace-DEFAULT layer (all
 *                                      workspaces on this host)
 *   p2p:settings:ws:<workspaceId>    — the current-workspace OVERRIDE layer
 *
 * Effective settings = field-level merge of baked defaults ← default layer ←
 * workspace override. These settings are HOST-LOCAL by design (never federated):
 * they are the host's sovereignty over what foreign work it accepts — "local
 * always wins" (plan D-011/P-107). Grants (P-001) federate; the host's opt-in
 * does not.
 *
 * THE ADMISSION CONTRACT (what Phase 1 consumes): `resolveForeignWorkAdmission`
 * is the ONE authoritative read the standing puller (P-103), the local-authority
 * spawn (P-104), and revocation reaping (P-106) consult before claiming or
 * continuing foreign work. Baked amendments carried here:
 *
 *   M10 — the kill-switch means STOP NEW CLAIMS + graceful wind-down of in-flight
 *         foreign work WITH receipts. It never hard-freezes running sessions.
 *   X13 — wind-down is BOUNDED: grace period `windDownGraceSec`, then the host
 *         mechanically kills (cgroup) and emits a receipt. Graceful is the
 *         default; enforced termination is the backstop.
 *   M16 — a mid-run grant DOWNGRADE routes in-flight foreign work through the
 *         SAME wind-down (revocation-lite): consumers reuse `windDownGraceSec`
 *         from this contract rather than inventing a second grace knob.
 *   m18 — `P2P_STARTER_PROFILE` is the one-click adoption preset (triple-zero
 *         defaults kill adoption; the baked default is still fully off per M11).
 *
 * Every fn takes an optional `sql` client so integration tests can pass a
 * per-file test schema (hive-settings-store convention).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { resolveMaxRolloutTier, type P2pEffectiveTier } from './rollout-tiers';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A weekly schedule window (host-LOCAL time). `days` are JS `Date.getDay()`
 *  values (0 = Sunday). A window may wrap midnight (startMin > endMin). */
export interface P2pScheduleWindow {
  days: number[];
  /** Minutes from local midnight, 0..1439. */
  startMin: number;
  /** Minutes from local midnight, 0..1439. End-exclusive; < startMin wraps. */
  endMin: number;
}

export type P2pOptInMode = 'off' | 'selected-fleets' | 'any-fleet';

export interface P2pWorkOptIn {
  /** 'off' = accept no foreign work (the M11 zero/empty baked default). */
  mode: P2pOptInMode;
  /** Fleet slugs accepted when mode === 'selected-fleets'. */
  fleets: string[];
  /** Concurrency cap on simultaneously-running foreign sessions. */
  maxConcurrentForeign: number;
  /** Accept-new-claims windows (empty = always, when otherwise opted in). */
  windows: P2pScheduleWindow[];
}

export interface P2pKillSwitch {
  /** The GLOBAL pause-all-foreign-work switch (P-002). */
  engaged: boolean;
  /** Epoch ms the switch was engaged (null when disengaged). */
  engagedAtMs: number | null;
  /** Operator-entered reason, surfaced on receipts. */
  reason: string | null;
  /** X13: bounded wind-down grace (seconds) before mechanical kill. */
  windDownGraceSec: number;
}

export interface P2pSettings {
  optIn: P2pWorkOptIn;
  killSwitch: P2pKillSwitch;
}

/** A stored layer is a PARTIAL settings object (sections/fields may be absent). */
export type P2pSettingsPatch = {
  optIn?: Partial<P2pWorkOptIn>;
  killSwitch?: Partial<P2pKillSwitch>;
};

export interface P2pSettingsLayers {
  workspaceId: string;
  /** Baked code defaults (M11: fully off / empty). */
  baked: P2pSettings;
  /** The stored workspace-DEFAULT layer (null when unset). */
  defaultLayer: P2pSettingsPatch | null;
  /** The stored current-workspace OVERRIDE layer (null when unset). */
  overrideLayer: P2pSettingsPatch | null;
  /** baked ← defaultLayer ← overrideLayer, field-level. */
  effective: P2pSettings;
}

// ── Keys + defaults ───────────────────────────────────────────────────────────

export const P2P_SETTINGS_DEFAULT_KEY = 'p2p:settings:default';
export const p2pSettingsWorkspaceKey = (workspaceId: string): string =>
  `p2p:settings:ws:${workspaceId}`;

export const MIN_WIND_DOWN_GRACE_SEC = 30;
export const MAX_WIND_DOWN_GRACE_SEC = 24 * 3600;
export const DEFAULT_WIND_DOWN_GRACE_SEC = 600;
export const MAX_CONCURRENT_FOREIGN_CEILING = 64;

/** M11: the baked default is structurally inert — no opt-in, nothing accepted. */
export function bakedP2pDefaults(): P2pSettings {
  return {
    optIn: { mode: 'off', fleets: [], maxConcurrentForeign: 0, windows: [] },
    killSwitch: {
      engaged: false,
      engagedAtMs: null,
      reason: null,
      windDownGraceSec: DEFAULT_WIND_DOWN_GRACE_SEC,
    },
  };
}

/** m18: the one-click starter profile — a working, bounded opt-in in one action.
 *  Accept work from any fleet the (tier-gated, P-005) grant layer admits, two
 *  concurrent foreign sessions, no schedule restriction. Applied to the
 *  CURRENT-WORKSPACE override layer by the settings route. */
export const P2P_STARTER_PROFILE: P2pSettingsPatch = {
  optIn: { mode: 'any-fleet', fleets: [], maxConcurrentForeign: 2, windows: [] },
  killSwitch: { engaged: false, reason: null },
};

// ── Sanitization ─────────────────────────────────────────────────────────────

const OPT_IN_MODES: readonly P2pOptInMode[] = ['off', 'selected-fleets', 'any-fleet'];

function clampInt(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeWindows(v: unknown): P2pScheduleWindow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: P2pScheduleWindow[] = [];
  for (const w of v.slice(0, 20)) {
    if (typeof w !== 'object' || w === null) continue;
    const win = w as Partial<P2pScheduleWindow>;
    // Days validate STRICTLY (an out-of-range day is dropped, never clamped into
    // a different weekday — clamping would silently WIDEN the window).
    const days = Array.isArray(win.days)
      ? [...new Set(win.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))]
      : [];
    const startMin = clampInt(win.startMin, 0, 1439);
    const endMin = clampInt(win.endMin, 0, 1439);
    if (days.length === 0 || startMin === undefined || endMin === undefined) continue;
    out.push({ days, startMin, endMin });
  }
  return out;
}

/** Sanitize an untrusted patch (route input) into a storable layer patch.
 *  Unknown fields are dropped; invalid values are dropped (never coerced into
 *  a surprising grant of MORE access). */
export function sanitizeP2pSettingsPatch(raw: unknown): P2pSettingsPatch {
  const out: P2pSettingsPatch = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const p = raw as { optIn?: unknown; killSwitch?: unknown };

  if (typeof p.optIn === 'object' && p.optIn !== null) {
    const o = p.optIn as Partial<Record<keyof P2pWorkOptIn, unknown>>;
    const optIn: Partial<P2pWorkOptIn> = {};
    if (OPT_IN_MODES.includes(o.mode as P2pOptInMode)) optIn.mode = o.mode as P2pOptInMode;
    if (Array.isArray(o.fleets)) {
      optIn.fleets = o.fleets
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && f.length <= 120)
        .slice(0, 200);
    }
    const cap = clampInt(o.maxConcurrentForeign, 0, MAX_CONCURRENT_FOREIGN_CEILING);
    if (cap !== undefined) optIn.maxConcurrentForeign = cap;
    const windows = sanitizeWindows(o.windows);
    if (windows !== undefined) optIn.windows = windows;
    if (Object.keys(optIn).length > 0) out.optIn = optIn;
  }

  if (typeof p.killSwitch === 'object' && p.killSwitch !== null) {
    const k = p.killSwitch as Partial<Record<keyof P2pKillSwitch, unknown>>;
    const killSwitch: Partial<P2pKillSwitch> = {};
    if (typeof k.engaged === 'boolean') killSwitch.engaged = k.engaged;
    if (typeof k.engagedAtMs === 'number' || k.engagedAtMs === null) {
      killSwitch.engagedAtMs = k.engagedAtMs as number | null;
    }
    if (typeof k.reason === 'string') killSwitch.reason = k.reason.trim().slice(0, 500) || null;
    else if (k.reason === null) killSwitch.reason = null;
    const grace = clampInt(k.windDownGraceSec, MIN_WIND_DOWN_GRACE_SEC, MAX_WIND_DOWN_GRACE_SEC);
    if (grace !== undefined) killSwitch.windDownGraceSec = grace;
    if (Object.keys(killSwitch).length > 0) out.killSwitch = killSwitch;
  }

  return out;
}

// ── Layer merge ───────────────────────────────────────────────────────────────

/** Field-level merge: later layers win per FIELD (not per section), so an
 *  override can flip one knob without restating its section. */
export function mergeP2pLayers(
  baked: P2pSettings,
  ...layers: Array<P2pSettingsPatch | null | undefined>
): P2pSettings {
  const eff: P2pSettings = {
    optIn: { ...baked.optIn, fleets: [...baked.optIn.fleets], windows: [...baked.optIn.windows] },
    killSwitch: { ...baked.killSwitch },
  };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.optIn) {
      const { fleets, windows, ...scalars } = layer.optIn;
      Object.assign(eff.optIn, scalars);
      if (fleets !== undefined) eff.optIn.fleets = [...fleets];
      if (windows !== undefined) eff.optIn.windows = windows.map((w) => ({ ...w, days: [...w.days] }));
    }
    if (layer.killSwitch) Object.assign(eff.killSwitch, layer.killSwitch);
  }
  return eff;
}

// ── KV access (the operator_settings queen/overwatch store) ──────────────────

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

async function readLayer(key: string, sql?: Sql): Promise<P2pSettingsPatch | null> {
  const rows = await pg(sql)`
    SELECT value FROM harness_shared.operator_settings WHERE key = ${key} LIMIT 1`;
  const raw = (rows[0] as { value?: string } | undefined)?.value;
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Re-sanitize on read so a hand-edited/legacy row can't smuggle bad values.
    const clean = sanitizeP2pSettingsPatch(parsed);
    return Object.keys(clean).length > 0 ? clean : null;
  } catch {
    return null; // a corrupt row reads as unset (baked defaults) — never throws
  }
}

async function writeLayer(
  key: string,
  value: P2pSettingsPatch | null,
  description: string,
  workspaceId: string,
  sql?: Sql,
): Promise<void> {
  const s = pg(sql);
  if (value === null || Object.keys(value).length === 0) {
    await s`DELETE FROM harness_shared.operator_settings WHERE key = ${key}`;
    return;
  }
  await s`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (${key}, ${JSON.stringify(value)}, ${description}, ${Date.now()}, ${workspaceId})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Read both layers + the effective settings for a workspace. */
export async function readP2pSettings(workspaceId?: string, sql?: Sql): Promise<P2pSettingsLayers> {
  const ws = workspaceId ?? activeWorkspaceId();
  const baked = bakedP2pDefaults();
  const [defaultLayer, overrideLayer] = await Promise.all([
    readLayer(P2P_SETTINGS_DEFAULT_KEY, sql),
    readLayer(p2pSettingsWorkspaceKey(ws), sql),
  ]);
  return {
    workspaceId: ws,
    baked,
    defaultLayer,
    overrideLayer,
    effective: mergeP2pLayers(baked, defaultLayer, overrideLayer),
  };
}

/**
 * Merge `patch` into one stored layer (or clear it with `patch: null`).
 * The patch is sanitized; fields it names overwrite the layer's stored fields,
 * fields it omits are preserved. Returns the fresh layers view.
 */
export async function writeP2pSettings(
  opts: {
    workspaceId?: string;
    layer: 'default' | 'workspace';
    patch: P2pSettingsPatch | null;
  },
  sql?: Sql,
): Promise<P2pSettingsLayers> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const key = opts.layer === 'default' ? P2P_SETTINGS_DEFAULT_KEY : p2pSettingsWorkspaceKey(ws);
  const description =
    opts.layer === 'default'
      ? 'P2P work-sharing settings — workspace-DEFAULT layer (p2p-work-distribution P-002).'
      : 'P2P work-sharing settings — current-workspace OVERRIDE layer (p2p-work-distribution P-002).';

  if (opts.patch === null) {
    await writeLayer(key, null, description, ws, sql);
  } else {
    const clean = sanitizeP2pSettingsPatch(opts.patch);
    const existing = (await readLayer(key, sql)) ?? {};
    const next: P2pSettingsPatch = {
      ...(existing.optIn || clean.optIn ? { optIn: { ...existing.optIn, ...clean.optIn } } : {}),
      ...(existing.killSwitch || clean.killSwitch
        ? { killSwitch: { ...existing.killSwitch, ...clean.killSwitch } }
        : {}),
    };
    await writeLayer(key, next, description, ws, sql);
  }
  return readP2pSettings(ws, sql);
}

/** Engage/disengage the GLOBAL kill-switch (always the workspace override layer —
 *  it is an operator action about THIS workspace NOW, not a default). */
export async function setP2pKillSwitch(
  opts: { workspaceId?: string; engage: boolean; reason?: string | null; nowMs?: number },
  sql?: Sql,
): Promise<P2pSettingsLayers> {
  const now = opts.nowMs ?? Date.now();
  return writeP2pSettings(
    {
      workspaceId: opts.workspaceId,
      layer: 'workspace',
      patch: {
        killSwitch: {
          engaged: opts.engage,
          engagedAtMs: opts.engage ? now : null,
          reason: opts.engage ? (opts.reason ?? null) : null,
        },
      },
    },
    sql,
  );
}

// ── The admission contract (M10 / X13 / M16) ─────────────────────────────────

export type P2pRefusalReason = 'kill-switch' | 'opt-in-off' | 'outside-window';

export interface ForeignWorkAdmission {
  /** May the host claim NEW foreign work right now? */
  admitNewClaims: boolean;
  /** Why not (null when admitting). Receipts (P-004) name this verbatim. */
  refusalReason: P2pRefusalReason | null;
  /** X13/M16: the bounded wind-down grace consumers apply before mechanical
   *  kill — for kill-switch engagement AND grant downgrades alike. */
  windDownGraceSec: number;
  /** Concurrency cap on running foreign sessions (enforced by P-104). */
  maxConcurrentForeign: number;
  /** M10: engaged kill-switch ⇒ in-flight work winds down gracefully (never a
   *  hard freeze); false means in-flight work continues normally. */
  windDownInFlight: boolean;
  /** Opted-in fleet slugs (null = any fleet passes the opt-in check; the
   *  grant/tier layer — P-001/P-005 — still gates independently). */
  optedInFleets: string[] | null;
  /** P-005: the MAX rollout tier this host may reach right now (0 = P2P off,
   *  1 = same-owner machines, 2 = cross-user ≤ Delegate, 3 = Operator). Surfaced
   *  in the ONE authoritative read so the puller (P-103) / local-authority spawn
   *  (P-104) apply the rollout gate ALONGSIDE opt-in — cross-user reach (tier ≥ 2)
   *  is FS-D5-gated on §5.4 per-scope crypto + the X1 loopback boundary (P-105),
   *  so this is 1 today. */
  maxRolloutTier: P2pEffectiveTier;
}

/** Is host-local `nowMs` inside any window? Empty windows = always. */
export function isWithinP2pWindows(windows: P2pScheduleWindow[], nowMs: number): boolean {
  if (windows.length === 0) return true;
  const d = new Date(nowMs);
  const day = d.getDay();
  const min = d.getHours() * 60 + d.getMinutes();
  for (const w of windows) {
    if (!w.days.includes(day)) {
      // A midnight-wrapping window that STARTED yesterday still covers early today.
      const yesterday = (day + 6) % 7;
      if (w.startMin > w.endMin && w.days.includes(yesterday) && min < w.endMin) return true;
      continue;
    }
    if (w.startMin <= w.endMin) {
      if (min >= w.startMin && min < w.endMin) return true;
    } else if (min >= w.startMin) {
      return true; // wrapping window, pre-midnight half (post-midnight handled above)
    }
  }
  return false;
}

/**
 * The ONE authoritative admission read for foreign work (P-103/P-104/P-106).
 * Pure — pass the effective settings + now. Precedence: kill-switch beats
 * opt-in beats windows (receipts name the FIRST refusal).
 *
 * `opts.maxRolloutTier` (P-005) is the rollout gate the caller has already
 * resolved from the flag state (resolveMaxRolloutTier). It defaults to the
 * flag-ON tier (1 today) so a caller that only cares about opt-in keeps the
 * old behaviour; a caller that has the flag state passes it so the rollout tier
 * is surfaced in this one read.
 */
export function resolveForeignWorkAdmission(
  s: P2pSettings,
  nowMs: number,
  opts?: { maxRolloutTier?: P2pEffectiveTier },
): ForeignWorkAdmission {
  const base = {
    windDownGraceSec: s.killSwitch.windDownGraceSec,
    maxConcurrentForeign: s.optIn.maxConcurrentForeign,
    optedInFleets: s.optIn.mode === 'selected-fleets' ? [...s.optIn.fleets] : null,
    maxRolloutTier: opts?.maxRolloutTier ?? resolveMaxRolloutTier({ flagEnabled: true }),
  };
  if (s.killSwitch.engaged) {
    return {
      ...base,
      admitNewClaims: false,
      refusalReason: 'kill-switch',
      windDownInFlight: true, // M10: graceful wind-down, never freeze
    };
  }
  if (s.optIn.mode === 'off') {
    return { ...base, admitNewClaims: false, refusalReason: 'opt-in-off', windDownInFlight: false };
  }
  if (!isWithinP2pWindows(s.optIn.windows, nowMs)) {
    // Outside the window: no NEW claims; in-flight work runs to completion
    // (windows gate intake, not execution — only the kill-switch winds down).
    return { ...base, admitNewClaims: false, refusalReason: 'outside-window', windDownInFlight: false };
  }
  return { ...base, admitNewClaims: true, refusalReason: null, windDownInFlight: false };
}
