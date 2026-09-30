/**
 * wake-mode.ts — the per-agent wake MODE store (hive-agent-tabs-psu-tui-2026-06-09
 * P-015 / D-005).
 *
 * Each agent's wake mode is `auto` (DEFAULT — a wake fires immediately, the
 * shipped behavior) or `manual` (the wake is STAGED for owner release/edit — the
 * P-007 gate in `wakeRecipients` consumes this). Resolution precedence: a
 * per-agent override wins over the global default, which itself defaults to
 * `auto`. So with nothing configured every agent is `auto` ⇒ the fleet-wide wake
 * path is unchanged (default-preserving).
 *
 * Stored in the `operator_settings` KV (PG, per storage policy — no new table for
 * the mode itself; the staged wakes get their own table in P-007):
 *   - global default       → key `wake_mode:default`
 *   - per-agent override    → key `wake_mode:agent:<ownerId>`
 *
 * Orthogonal to driveMode (D-005): driveMode decides whether an agent is SENT
 * wakes at all; wake-mode decides how RECEIVED wakes are handled.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

export const WAKE_MODES = ['auto', 'manual'] as const;
export type WakeMode = (typeof WAKE_MODES)[number];

/** The mode an agent has when nothing (override or global default) is set. */
export const DEFAULT_WAKE_MODE: WakeMode = 'auto';

const DEFAULT_KEY = 'wake_mode:default';
const agentKey = (ownerId: string): string => `wake_mode:agent:${ownerId}`;

/** Narrow an arbitrary stored string to a WakeMode (garbage / null → null). */
export function coerceWakeMode(v: string | null | undefined): WakeMode | null {
  return v === 'auto' || v === 'manual' ? v : null;
}

/** Pure resolution: per-agent override wins over the global default, else auto. */
export function resolveWakeModeFrom(
  override: WakeMode | null,
  globalDefault: WakeMode | null,
): WakeMode {
  return override ?? globalDefault ?? DEFAULT_WAKE_MODE;
}

async function readSetting(key: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql`SELECT value FROM harness_shared.operator_settings WHERE key = ${key} LIMIT 1`;
  return (rows[0] as { value?: string } | undefined)?.value ?? null;
}

async function writeSetting(key: string, value: string, description: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (${key}, ${value}, ${description}, ${Date.now()}, ${activeWorkspaceId()})
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = EXCLUDED.updated_at
  `;
}

/** The global default wake mode (auto unless an owner set it). */
export async function getDefaultWakeMode(): Promise<WakeMode> {
  return coerceWakeMode(await readSetting(DEFAULT_KEY)) ?? DEFAULT_WAKE_MODE;
}

/**
 * EI-597 idempotent-skip: a caller (or a caller LOOP — the runaway 'palette'
 * pattern that hammered this ~37×/min for hours in the 2026-06-18 decision-ledger,
 * ~490 rows/hour of pure pollution + wasted PG writes) may repeatedly set the mode
 * to the value it's ALREADY at. Skip the write (and its `operator_settings` UPDATE)
 * when the stored value already equals the target — a plain read-then-maybe-write,
 * default-preserving for every existing caller since the observable result
 * (getDefaultWakeMode() afterwards) is identical either way. This does not by
 * itself silence the decision-ledger row for the *call* (that's logged at the
 * dispatch chokepoint per governed call, not per mutation) — it hardens the STORE
 * against a hammering caller wasting real PG writes, and is a no-regret change
 * regardless of whether the specific caller is ever pinned down.
 */
export async function setDefaultWakeMode(mode: WakeMode, description?: string): Promise<void> {
  if ((await getDefaultWakeMode()) === mode) return;
  await writeSetting(
    DEFAULT_KEY,
    mode,
    description ?? 'Global default agent wake mode (hive-agent-tabs P-015 / D-005).',
  );
}

/** This agent's per-agent override, or null when unset (→ falls back to default). */
export async function getWakeModeOverride(ownerId: string): Promise<WakeMode | null> {
  return coerceWakeMode(await readSetting(agentKey(ownerId)));
}

/** EI-597 idempotent-skip (see setDefaultWakeMode above) — same reasoning, per-agent. */
export async function setWakeMode(ownerId: string, mode: WakeMode, description?: string): Promise<void> {
  if ((await getWakeModeOverride(ownerId)) === mode) return;
  await writeSetting(agentKey(ownerId), mode, description ?? `Per-agent wake mode for ${ownerId} (hive-agent-tabs P-015).`);
}

/**
 * fleet-member-wake-immunity (WI-2185): make a freshly-spawned fleet MEMBER immune to a
 * `manual` GLOBAL default (the D-005 pause/edit gate) by writing it a per-agent
 * `auto` override at boot.
 *
 * Why members specifically: a member's only steering channel is its LEADER's
 * `coord:send` wakes. Under a manual global default a member with no override inherits
 * `manual`, so every steering wake is STAGED for owner release — and the member's leader
 * (often a weak local model) neither knows to flip it nor CAN release a staged wake (only
 * the owner can). The fleet then deadlocks on steering it can never receive. The owner
 * isn't conversing with each member directly, so the manual gate buys nothing there but
 * the deadlock. A LEADER under a manual default is deliberately left gated — the owner IS
 * present, and releasing the leader's staged routing-gate wake is the gate working as
 * intended.
 *
 * Scoped per-agent so the owner's global default is UNTOUCHED for every non-member, and
 * reversible (the owner can flip a specific member back with `coord:wake-mode`). No-op
 * for a leader or a non-fleet launch. Returns the mode written, or null when it did
 * nothing. The member's owner id is freshly minted at boot, so there is never a
 * pre-existing override to clobber.
 */
export async function ensureFleetMemberWakeAuto(
  ownerId: string,
  fleetRole: string | null | undefined,
): Promise<WakeMode | null> {
  return ensureLaunchedWakeAuto(ownerId, { fleetRole, launchedByAgent: false });
}

/**
 * agent-launched-wake-auto (EI-19965557940158384): generalizes WI-2185's
 * fleet-member reasoning above to EVERY session an AGENT launched, not just fleet
 * members. `capability:launch-agent` / `capability:terminal` stamp
 * `--launched-by=<callerOwnerId>` on every TOOL-driven psu launch (an
 * agent-launched-only signal — a human typing `psu su` at their own terminal never
 * carries it, see session/end.ts's PAPERCUSP_LAUNCHED_BY note). Before this, a
 * FLEETLESS agent-launched session (e.g. `capability:launch-agent` with no
 * `--fleet`) fell through the `fleetRole !== 'member'` check untouched, so under a
 * `manual` GLOBAL default it inherited `manual` with no override — its launcher's
 * `coord:send { wake:'required' }` then silently STAGED every steering wake instead
 * of delivering it, `ok:true` and all (measured impact: a peer blocked ~36min on an
 * unanswered directed question, see EI-19965557940158384). Same deadlock shape as
 * the original WI-2185 fleet case, just without a fleet.
 *
 * Applies the auto override when EITHER holds:
 *   - `fleetRole === 'member'` (the original WI-2185 case, behavior UNCHANGED)
 *   - `launchedByAgent` is true AND `fleetRole` is not `'leader'` (the new case)
 *
 * A LEADER stays gated regardless of who launched it — unchanged from WI-2185: the
 * owner is assumed present for a fleet's designated leader, and releasing its
 * staged routing-gate wake is the gate working as intended.
 */
export async function ensureLaunchedWakeAuto(
  ownerId: string,
  opts: { fleetRole: string | null | undefined; launchedByAgent: boolean },
): Promise<WakeMode | null> {
  const { fleetRole, launchedByAgent } = opts;
  if (fleetRole === 'leader') return null;
  if (fleetRole !== 'member' && !launchedByAgent) return null;
  await setWakeMode(
    ownerId,
    'auto',
    fleetRole === 'member'
      ? `Fleet MEMBER ${ownerId} pinned to auto wake-mode at boot (WI-2185) — immune to a manual global default so its leader's steering wakes land.`
      : `Agent-launched session ${ownerId} pinned to auto wake-mode at boot (EI-19965557940158384) — immune to a manual global default so its launcher's steering wakes land.`,
  );
  return 'auto';
}

/** Effective wake mode for an agent: override ?? global default ?? auto. */
export async function resolveWakeMode(ownerId: string): Promise<WakeMode> {
  return resolveWakeModeFrom(await getWakeModeOverride(ownerId), await getDefaultWakeMode());
}

/**
 * ALL per-agent overrides in one read, keyed by ownerId — for the roster, where
 * resolveWakeMode per agent would be N round-trips (P-008 badge). Agents without a
 * row fall back to the global default (resolve in-memory with getDefaultWakeMode).
 */
export async function getAllWakeModeOverrides(): Promise<Map<string, WakeMode>> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT key, value FROM harness_shared.operator_settings
    WHERE key LIKE 'wake_mode:agent:%'
  `;
  const out = new Map<string, WakeMode>();
  const prefix = 'wake_mode:agent:';
  for (const r of rows as unknown as Array<{ key: string; value: string }>) {
    const ownerId = r.key.slice(prefix.length);
    const mode = coerceWakeMode(r.value);
    if (ownerId && mode) out.set(ownerId, mode);
  }
  return out;
}
