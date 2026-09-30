/**
 * presence.ts — operator host adapter for the L1 liveness layer.
 *
 * The store implementation (upsert / heartbeat / delete / roster-join
 * over harness_shared.coord_presence + power_user_sessions) lives in
 * @papercusp/coordination/presence's PgPresenceStore; here we wire its
 * two host seams — the org PG handle and the table bootstrap — and keep
 * the original function surface so all callers + the /api/coord route
 * are unchanged.
 *
 * agent-coordination-architecture-v2 §4.2. Held locks are intentionally
 * NOT stored here — they live in the separate papercusp_su DB.
 */

import { hostname } from 'node:os';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  PgPresenceStore,
  PRESENCE_STALE_MS,
  type PresenceInput,
  type PresenceRecord,
} from '@papercusp/coordination/presence';
import { deriveAgentRole, deriveFleetMembership, type AgentIdentity } from './identity';
import { getCachedMachineCapabilityTags } from './machine-capability-tags';
import { writeSessionBrief } from '../../session-brief';
import { appendFleetMembershipEvent, appendFleetMembershipIfAbsent } from '../../fleet-membership-store';
import { refreshControlAnchorAfterMutation } from './control-anchor';

export { PRESENCE_STALE_MS };
export type { PresenceInput, PresenceRecord };

const store = new PgPresenceStore({
  getSql: () => getOrgPg().sql,
  // Tables are defined by the migration baseline now; the host seam is a no-op.
  ensureSchema: async () => {},
});

// WI-3898 P1 (coord:presence liveness parity): `coord_presence.host`/`.pid`
// exist in the schema (baseline) and the PresenceInput/PgPresenceStore write
// path has always accepted them, but NO caller ever passed a value that
// actually MEANS something for liveness verification.
//
// CORRECTNESS NOTE (this file previously defaulted host/pid to the CURRENT
// process's own `hostname()`/`process.pid` here — that was wrong and has been
// removed). `writePresence` runs inside the operator's own long-lived server
// process (`:3070`/`:3170`, node:cluster + SO_REUSEPORT) handling an MCP tool
// call — NOT inside the calling agent's own OS process. Every agent's
// declare-intent call funnels through the SAME shared server, so defaulting
// to `process.pid` here stamped every single agent's row with the identical
// operator-worker pid: plausible-looking but useless (and actively
// misleading) as a per-agent liveness signal — probing it with
// `kill(pid, 0)` would report "alive" for every agent for as long as the
// operator itself is up, regardless of whether any given agent's own process
// had crashed.
//
// The genuinely-verifiable half of remedy #1 is landed on the OTHER write
// path instead: `touchHeartbeat`'s optional `liveness` param, fed by the psu
// launcher's supervisor beat (packages: bootstrap-su.ts heartbeat route +
// apps/operator/scripts/psu-launcher.mjs's startSupervisorBeat) — that beat
// genuinely runs AS the agent's own parent process (the process whose death
// IS the session's death), so its self-reported pid/host means something a
// local `kill(pid, 0)` probe can trust. See `probeProcessLiveness` below.
//
// declare-intent's `writePresence` call is therefore left to pass host/pid
// through UNCHANGED (undefined) — the store's ON CONFLICT is unconditional
// (EXCLUDED.host/EXCLUDED.pid), so an undefined `input.host`/`input.pid` here
// resolves to PgPresenceStore's own column defaults (''/null), never a
// fabricated value. The `suspect`/`draining` SessionState is derived on the
// read path once these values are present; the confirmLiveness UX hint remains
// the separate follow-up.
//
// `LOCAL_HOSTNAME` below is still legitimate: it is the OPERATOR's own
// hostname, used only as the comparison target in `probeProcessLiveness` (the
// psu launcher and the operator it beats are loopback-paired on the same
// physical machine, so this correctly answers "is this recorded row's
// process on THIS machine, i.e. probe-able" — a different use from the
// removed per-agent write-default above).
const LOCAL_HOSTNAME = hostname();

/**
 * Upsert the caller's presence row — "set my presence to exactly this".
 * Always bumps heartbeat_at AND last_active_at (a declared write is genuine
 * activity, D-003). Resolves the populate-once scalars agentRole (D-004, from
 * the identity) + potSlug (from `harnessSlug` via potHomeSlugForHarness) when
 * the caller hasn't already set them. Omitted optional fields reset to defaults.
 */
export async function writePresence(
  identity: AgentIdentity,
  input: PresenceInput = {},
  harnessSlug?: string | null,
): Promise<string | null> {
  const agentRole = input.agentRole ?? deriveAgentRole(identity);
  let potSlug = input.potSlug ?? null;
  if (harnessSlug && harnessSlug !== '*') {
    try {
      const { potHomeSlugForHarness } = await import('../../hive-federation');
      const derived = await potHomeSlugForHarness(identity.workspaceId ?? 'default', harnessSlug);
      if (potSlug == null) {
        potSlug = derived;
      } else {
        // workspace-work-scope-policy-2026-09-04 P-010: a requested pot that disagrees
        // with the pot DERIVED from the session's harness is how sessions got homed in
        // `sb-devboard-hive` while doing papercusp work (EI-22374455128414213). The
        // derivation wins; the disagreement is logged, never silently persisted.
        const { reconcilePresencePot } = await import('../../work-scope-policy');
        const r = reconcilePresencePot({ requested: potSlug, derived, harnessSlug });
        if (r.corrected) console.warn(`[presence] ${identity.ownerId}: ${r.note}`);
        potSlug = r.potSlug;
      }
    } catch {
      // best-effort: presence must write even if hive lookup fails
      if (potSlug == null) potSlug = null;
    }
  }
  // WI-3898 P1: do NOT default host/pid from the operator's OWN process — see
  // the file-header note above. Pass `input.host`/`input.pid` through exactly
  // as given (undefined for every current in-repo caller); the store's own
  // column defaults apply.
  //
  // WI-1546 (Gate DG-3 follow-up): capability tags ARE safe to resolve from
  // this process — unlike host/pid they're a MACHINE-level fact (docker/pg
  // availability), true for every process on this box, not a specific agent's
  // OS process. Memoized per-process (see machine-capability-tags.ts) so only
  // the first write on a given operator instance pays the docker probe.
  const capabilityTags = input.capabilityTags ?? (await getCachedMachineCapabilityTags());
  const previousIntent = await store.write(identity, { ...input, agentRole, potSlug, capabilityTags });

  // Fleet membership (named-su-agent-fleets-2026-06-29 P-005): the SOFT presence label,
  // sourced from env at registration (PAPERCUSP_FLEET_SLUG / PAPERCUSP_FLEET_ROLE), the
  // per-agent mirror of hive_slug. The @papercusp/coordination store SELECT/INSERT does
  // not touch the fleet columns, so a follow-up FILL-IF-ABSENT update sets them here
  // (mig 407 added fleet_slug/fleet_role to coord_presence). COALESCE(existing, env)
  // means: the first declared write populates them, every later declare/heartbeat
  // PRESERVES them (like hive_slug's populate-once-then-keep), and a leader role a
  // handoff (P-007) promoted this row to is never clobbered back to the env default.
  // Only runs when the process actually carries a fleet, so non-fleet agents pay nothing.
  const { fleetSlug, fleetRole } = deriveFleetMembership();
  if (fleetSlug) {
    // WI-1345: membership is an APPEND-ONLY fact, never a direct coord_presence UPDATE
    // (a DB guard now rejects that). Populate-once: append the env-declared fleet fact
    // ONLY if this agent has no membership fact yet — the durable analog of the old
    // COALESCE(fleet_slug, env) "first write populates, later ones preserve" fill. A DB
    // projection trigger mirrors the fact onto the presence row (created by store.write
    // above), so the live fleet_slug label lands exactly as before.
    await appendFleetMembershipIfAbsent({
      workspaceId: identity.workspaceId ?? 'default',
      ownerId: identity.ownerId,
      ownerLabel: identity.ownerLabel,
      fleetSlug,
      fleetRole,
    });
  }

  // (WI-1893: the in-memory "pending fleet placement" that used to be applied here
  // is GONE. It lived in ONE :3070 cluster worker's memory and was lost whenever
  // the agent's first presence write landed on a different worker — every spawn
  // path now appends the DURABLE membership fact at boot instead
  // (appendFleetMembershipIfAbsent; bootstrap-su / bootstrap-role / operator-spawn),
  // and the mig-430 triggers materialize it onto the presence row in either order.)

  // WI-573 (honest-presence): a declared presence write is GENUINE activity — so if this owner's
  // adv_sessions row still carries a stale `ended_at` from a PRIOR incarnation (resumed via a path
  // that never re-POSTed bootstrap-su, e.g. harness compaction), clear it now so a LIVE agent never
  // reads as `ended`. Generalizes psu-launcher's `reportSessionResumed` (psu --resume only) to ANY
  // resume. Fully best-effort + idempotent (0-row no-op when already live); never affects the write
  // above or the brief below.
  try {
    const { reactivateAdvSessionByOwner } = await import('../../adv-sessions');
    await reactivateAdvSessionByOwner(identity.ownerId);
  } catch {
    /* best-effort: presence already wrote; honesty-reactivation must never block it */
  }

  // EI-1742: persist a durable successor brief on this write path so the agent's last
  // declared lane survives the coord_presence reaper sweep + abrupt session death
  // (a continuing session reads it instead of doing transcript archaeology). Fully
  // isolated/best-effort — never affects the presence write above.
  await writeSessionBrief(identity, {
    intent: input.intent,
    currentPlanSlug: input.currentPlanSlug,
    currentFiles: input.currentFiles,
    ambientExcludedRefs: input.ambientExcludedRefs,
    harnessSlug: harnessSlug ?? null,
    potSlug,
  });
  return previousIntent;
}

/**
 * EXPLICIT named-fleet membership setter (named-su-agent-fleets-2026-06-29 P-004;
 * WI-1345 made it append-only).
 *
 * `writePresence`'s fleet fill-if-absent is populate-once-then-keep — it can NEVER
 * OVERWRITE a label, which is exactly what the fleet REGISTRY tools must do: promote the
 * caller to `leader` on create / take-leadership, demote a prior leader to `member`, set
 * `member` on join, or clear both on leave. They go through this AUTHORITATIVE path.
 *
 * WI-1345: canonical membership is an APPEND-ONLY fact (harness_shared.fleet_membership_events),
 * so this APPENDS the fact rather than UPDATE-ing coord_presence.fleet_slug directly (a DB
 * guard now rejects a direct write). The DB projection trigger mirrors the latest fact onto
 * the live presence row and re-materializes it after the reaper deletes the row on death, so
 * membership survives death instead of vanishing. Pass (null, null) to record a leave. The
 * live effect on the presence row is unchanged: the projection is a no-op when the owner has
 * no presence row (a dead prior-leader's live label is untouched — D-002 — though the durable
 * fact is still recorded). `sql?` threads a transaction (atomic leadership transfer) or a test
 * schema.
 */
export async function setPresenceFleet(
  workspaceId: string,
  ownerId: string,
  fleetSlug: string | null,
  fleetRole: string | null,
  sql?: Sql,
): Promise<void> {
  await appendFleetMembershipEvent({ workspaceId, ownerId, fleetSlug, fleetRole }, sql);
  await refreshControlAnchorAfterMutation({
    ownerId,
    workspaceId,
    origin: 'agent',
    actorId: ownerId,
    source: 'fleet:membership',
    sql,
  });
}

// (WI-1893: the per-worker in-memory pending-fleet map — setPendingFleet /
// takePendingFleet — was REMOVED. :3070 is node:cluster + SO_REUSEPORT, so a
// placement registered in the bootstrap worker was invisible to the worker that
// served the agent's first presence write; the 2026-07-03 backlog-clearance
// launch lost all 10 members' fleet membership this way. Fleet membership is now
// stamped as a DURABLE append-only fact at spawn/boot time
// (appendFleetMembershipIfAbsent → harness_shared.fleet_membership_events); the
// mig-430 triggers cover fact-first AND row-first ordering. Do NOT reintroduce a
// per-worker map for cross-request hand-offs — write the durable fact.)

/** Bump heartbeat_at ONLY — the keepalive path (the 60s supervisor beat). No-op
 *  if the row does not exist. NEVER bumps last_active_at (D-003).
 *
 *  `liveness` (WI-3898 P1): the psu supervisor beat's self-reported
 *  { pid, host, tty } — see the file-header note. Omitted/undefined fields leave
 *  the stored value UNTOUCHED (never clobbered to null). `tty` (EI-19948333346987654)
 *  is the terminal device path the launcher resolved for itself (PAPERCUSP_TTY) —
 *  same honesty rule as pid/host: only the beat's own call site can report it. */
export async function touchHeartbeat(
  ownerId: string,
  liveness?: { pid?: number | null; host?: string | null; tty?: string | null },
): Promise<void> {
  await store.touchHeartbeat(ownerId, liveness);
}

/**
 * Local-only process-liveness probe (WI-3898 P1 remedy #1's third leg).
 * `kill(pid, 0)` only means something on the SAME machine the caller is
 * running on — a federated/remote row's pid lives in a different machine's
 * pid namespace, and a coincidental pid match there would be actively
 * misleading, not liveness. So this ONLY probes when `record.host` matches
 * the CALLING process's own hostname; anything else (remote host, or no
 * pid/host ever recorded — declare-intent-only rows) comes back `null`
 * ("cannot be determined here"), never a guess.
 *
 * Returns:
 *  - `true`  — kill(pid, 0) succeeded: the process exists and is ours to see.
 *  - `false` — ESRCH: the process is confirmed gone.
 *  - `null`  — inconclusive (remote/unknown host, no pid, or EPERM — a pid
 *    reused by a different-UID process would also read EPERM, which must
 *    NOT be reported as "dead").
 *
 * The presence snapshot calls this primitive on the read path; the claim lease
 * reaper uses the same probe to remove a confirmed-dead owner from its live set.
 */
export function probeProcessLiveness(record: { host?: string | null; pid?: number | null }): boolean | null {
  if (!record.pid || !record.host || record.host !== LOCAL_HOSTNAME) return null;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    return null; // EPERM (pid reused by another user) or anything else: inconclusive
  }
}

/** Bump last_active_at AND heartbeat_at — the ACTIVITY path (tool dispatch via
 *  dispatch-heartbeat). No-op if the row does not exist (D-003). */
export async function touchActivity(ownerId: string): Promise<void> {
  await store.touchActivity(ownerId);
}

/** Set a per-session SOFT compaction limit in tokens. No-op if the presence row
 * does not exist. `explicit` marks a deliberate runtime override; omitted
 * provenance is reserved for derived/watchdog repairs that must preserve the
 * existing marker. agent-managed-compaction-2026-07-01. */
export async function setCompactionLimit(
  ownerId: string,
  limit: number,
  opts: { explicit?: boolean } = {},
): Promise<void> {
  await store.setCompactionLimit(ownerId, limit, opts);
}

/** Cache the compaction-compliance watchdog's context-size estimate (tokens) for a
 *  session. No-op if the presence row does not exist. agent-managed-compaction. */
export async function setContextEstimate(ownerId: string, tokens: number): Promise<void> {
  await store.setContextEstimate(ownerId, tokens);
}

/** Invalidate a cached context estimate after the native session is replaced.
 *  NULL is the honest bridge state until the successor transcript is measured. */
export async function clearContextEstimate(ownerId: string): Promise<void> {
  await store.clearContextEstimate(ownerId);
}

/** Ensure a presence row + bump heartbeat WITHOUT clobbering a declared
 *  intent — the read-driven liveness signal (piggybacked on coord:inbox).
 *  Makes coord:presence a complete live roster of active agents. */
export async function heartbeatPresence(identity: AgentIdentity): Promise<void> {
  await store.heartbeat(identity);
}

/** Remove the caller's presence row — the session_shutdown path. */
export async function clearPresence(ownerId: string): Promise<void> {
  await store.clear(ownerId);
}

/** List presence records in deterministic ownerId order (P-005), optionally
 *  scoped to a workspace and/or a Hive (potSlug — the P-004 hive-scoped read).
 *  `ownerIds` is a bounded targeted selector list pushed into the store query. */
export async function listPresence(
  opts: { workspaceId?: string | null; potSlug?: string | null; ownerIds?: readonly string[] } = {},
): Promise<PresenceRecord[]> {
  return store.list(opts);
}

/** Read one presence record by owner id, or null. */
export async function getPresence(ownerId: string, db?: Sql): Promise<PresenceRecord | null> {
  return store.get(ownerId, db);
}

/** Delete presence rows whose heartbeat is older than maxAgeMs (true dead
 *  sessions). Best-effort GC so the roster doesn't accumulate hundreds of
 *  long-ended rows. Returns rows removed. */
export async function sweepStalePresence(maxAgeMs: number): Promise<number> {
  return store.sweepStale(maxAgeMs);
}
