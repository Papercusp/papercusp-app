/**
 * context-pressure.ts — the coarse per-member context-pressure BUCKET
 * (fleet-deltas-leader-primitives-2026-07-10 P-007).
 *
 * A leader watching a fleet needs "who is about to compact / already over"
 * WITHOUT reading raw tokens off every member — the same three-way judgment
 * the ambient context gauge (agent-managed-compaction D-009 / P-013) already
 * makes per-caller. Reuse-first: this is a THIN reduction of the SAME
 * `contextGaugeBand` thresholds (inbox-context-usage.ts, the one definition
 * the client hook + statusline gauge already band on) to a coarser 3-state
 * shape a fleet roster / monitor delta can carry as one short string:
 *
 *   ok       — below the LOUD band (untracked, or comfortably under limit).
 *   high     — at/above LOUD (≥80% of the soft limit): should wrap up soon.
 *   critical — at/above CRITICAL (≥90% of the soft limit): should compact now.
 *
 * `null` (not one of the three buckets) means UNKNOWN — no compactionLimit /
 * contextTokens tracked for this owner yet (an untracked owner, a federated
 * peer, or a CLI this system doesn't estimate for — mirrors the nullable
 * `sessionState`/`wakeable` liveness fields, never coerced to 'ok').
 *
 * `deriveContextPressure` is PURE (unit-testable with no PG); `fetchContextPressure`
 * is the IO seam — ONE batch query keyed by the roster's ownerIds, the same
 * per-owner enrichment shape as `fetchPresenceFleet` / `fetchWakeability`, so
 * enriching N agents is a constant read, not N.
 *
 * STALENESS (EI-18729596985129261): `contextTokens`/`compactionLimit` are cached
 * on `coord_presence` by the compaction-compliance watchdog on a 2-MINUTE cadence
 * (compaction-compliance-watchdog.ts), NOT the per-turn hot path — a session's own
 * ambient `context: N/L (X%)` injection is computed fresh every turn and can
 * disagree with this cached bucket for up to a sweep interval, MORE under host
 * load (a delayed/skipped sweep leaves the cache reflecting an arbitrarily older
 * snapshot — observed live: a fleet member's `coord:orient` row read "critical"
 * moments after its own live gauge read 12%). The watchdog already stamps
 * `context_estimated_at` alongside `context_tokens` for exactly this reason, but
 * that timestamp went unread here — so a badly-stale cached reading was reported
 * with the SAME confidence as a fresh one. `deriveContextPressure` now takes the
 * estimate's age and degrades a stale reading to `null` (honest "unknown", the
 * same non-coercing contract as a missing estimate) rather than asserting a
 * bucket a caller could act on (a leader benching a member, an agent
 * self-compacting) against data that may no longer be true.
 */
import { getOrgPg } from '@papercusp/db-org';
import { contextGaugeBand, contextUsagePct } from './tools/inbox-context-usage';
import { fetchPresenceFleet } from './presence-fleet';

export type ContextPressureBucket = 'ok' | 'high' | 'critical';

/** The bucket plus the provenance needed to judge how much to trust it. */
export interface ContextPressureReading {
  bucket: ContextPressureBucket | null;
  estimatedAt: string | null;
  ageSec: number | null;
}

/**
 * Executable fresh-context boundaries available to a caller refused for
 * critical cached context pressure.
 */
export type ContextPressureRecoveryPath =
  | 'self-compaction'
  | 'warm-loop'
  | 'cold-loop'
  | 'no-path'
  | 'unknown';

export interface ContextPressureRecoveryResolution {
  path: ContextPressureRecoveryPath;
  selfCompactionAvailable: boolean | null;
  /** A cold-loop note is verified only when this is true. */
  carryNoteVerified: boolean | null;
  reason:
    | 'host-backed'
    | 'active-warm-loop'
    | 'active-cold-loop'
    | 'active-cold-loop-needs-checkpoint'
    | 'no-live-pty-or-loop'
    | 'host-predates-carry-respawn'
    | 'read-failed';
}

/** PURE: resolve the remedy vocabulary from already-read availability facts. */
export function deriveContextPressureRecoveryPath(input: {
  selfCompaction:
    | { available: boolean; reason?: string | null }
    | null
    | undefined;
  loop?: {
    active?: boolean;
    carry?: 'warm' | 'cold';
    harnessSlug?: string | null;
  } | null;
  carryNote?: { note?: string | null; readFailed?: boolean } | null;
}): ContextPressureRecoveryResolution {
  const selfCompaction = input.selfCompaction;
  if (selfCompaction?.available === true) {
    return {
      path: 'self-compaction',
      selfCompactionAvailable: true,
      carryNoteVerified: null,
      reason: 'host-backed',
    };
  }
  if (!selfCompaction) {
    return {
      path: 'unknown',
      selfCompactionAvailable: null,
      carryNoteVerified: null,
      reason: 'read-failed',
    };
  }
  if (selfCompaction.reason === 'host_predates_carry_respawn') {
    return {
      path: 'no-path',
      selfCompactionAvailable: false,
      carryNoteVerified: null,
      reason: 'host-predates-carry-respawn',
    };
  }

  const loop = input.loop;
  if (loop?.active && loop.harnessSlug && loop.carry === 'warm') {
    return {
      path: 'warm-loop',
      selfCompactionAvailable: false,
      carryNoteVerified: null,
      reason: 'active-warm-loop',
    };
  }
  if (loop?.active && loop.harnessSlug && loop.carry === 'cold') {
    const carryNoteVerified =
      input.carryNote?.readFailed !== true && Boolean(input.carryNote?.note?.trim());
    return {
      path: 'cold-loop',
      selfCompactionAvailable: false,
      carryNoteVerified,
      reason: carryNoteVerified ? 'active-cold-loop' : 'active-cold-loop-needs-checkpoint',
    };
  }
  return {
    path: 'no-path',
    selfCompactionAvailable: false,
    carryNoteVerified: null,
    reason: 'no-live-pty-or-loop',
  };
}

/**
 * IO seam for the refusal callers. The request-compaction tool owns the actual
 * no-PTY mutation; this helper only answers which remedy it can recommend.
 */
export async function resolveContextPressureRecoveryPath(
  ownerId: string,
  workspaceId?: string | null,
): Promise<ContextPressureRecoveryResolution> {
  try {
    const { selfCompactionAvailability } = await import('../../events/await/psu-pty-discovery');
    const availability = selfCompactionAvailability(ownerId);
    if (availability.available || availability.reason === 'host_predates_carry_respawn') {
      return deriveContextPressureRecoveryPath({ selfCompaction: availability });
    }

    const { getLoopStatus } = await import('../../harness/routines/loop');
    const loop = await getLoopStatus(ownerId);
    if (!loop?.active || !loop.harnessSlug) {
      return deriveContextPressureRecoveryPath({ selfCompaction: availability, loop });
    }

    const { getLoopCarryNoteWithMeta } = await import('../../carry-note');
    const carryNote = await getLoopCarryNoteWithMeta({
      harness: loop.harnessSlug,
      ownerId,
      workspaceId: workspaceId ?? undefined,
    });
    return deriveContextPressureRecoveryPath({
      selfCompaction: availability,
      loop,
      carryNote,
    });
  } catch {
    return {
      path: 'unknown',
      selfCompactionAvailable: null,
      carryNoteVerified: null,
      reason: 'read-failed',
    };
  }
}

/** How stale a cached (contextTokens, compactionLimit) estimate may be before it
 *  is no longer trustworthy enough to assert a bucket from. Several multiples of
 *  the watchdog's own 2-minute sweep cadence (compaction-compliance-watchdog.ts'
 *  DEFAULT_INTERVAL_MS) so a normally-delayed sweep under host load doesn't
 *  false-negative a genuinely fresh reading — only a reading old enough that the
 *  watchdog has very likely skipped multiple sweeps (or the owner rotated
 *  sessions since) is discarded. Not imported from the watchdog module directly
 *  to avoid pulling its DB/scheduler wiring into this pure, unit-tested file. */
export const CONTEXT_ESTIMATE_STALE_MS = 15 * 60_000; // 15 min

/** PURE: derive the non-negative age of a cached estimate, or null when its
 * timestamp is absent/unparseable. This is deliberately separate from the
 * bucket staleness guard: stale readings still carry their age as provenance. */
export function deriveContextPressureAgeSec(
  estimatedAt: string | number | Date | null | undefined,
  now: number = Date.now(),
): number | null {
  if (estimatedAt == null) return null;
  const estimatedAtMs = estimatedAt instanceof Date ? estimatedAt.getTime() : new Date(estimatedAt).getTime();
  if (!Number.isFinite(estimatedAtMs)) return null;
  return Math.max(0, Math.round((now - estimatedAtMs) / 1000));
}

/**
 * PURE: reduce (contextTokens, compactionLimit, estimatedAt) to the coarse
 * 3-state bucket. null when usage can't be computed (no limit set / no estimate
 * yet), OR when the estimate is stale beyond {@link CONTEXT_ESTIMATE_STALE_MS} —
 * an honest "unknown" either way, never defaulted to 'ok' and never asserted
 * from data that may no longer reflect the session's real usage.
 *
 * `estimatedAt` is OPTIONAL and defaults to "unknown age" (no staleness check) —
 * a caller that doesn't carry `context_estimated_at` gets today's behavior
 * unchanged; only callers that DO thread it through get the staleness guard.
 * `now` is injectable for deterministic tests.
 */
export function deriveContextPressure(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
  estimatedAt?: string | number | Date | null,
  now: number = Date.now(),
): ContextPressureBucket | null {
  const pct = contextUsagePct(contextTokens, compactionLimit);
  if (pct == null) return null;
  if (estimatedAt != null) {
    const estimatedAtMs = estimatedAt instanceof Date ? estimatedAt.getTime() : new Date(estimatedAt).getTime();
    // An unparseable timestamp is a data bug, not evidence of freshness — treat
    // it the same as "too stale to trust" rather than silently ignoring it.
    if (!Number.isFinite(estimatedAtMs) || now - estimatedAtMs > CONTEXT_ESTIMATE_STALE_MS) return null;
  }
  const band = contextGaugeBand(pct);
  if (band == null || band === 'quiet') return 'ok'; // below LOUD — not yet actionable pressure
  if (band === 'loud') return 'high';
  return 'critical';
}

/**
 * IO seam: batch-read context pressure for a set of ownerIds. ownerIds should be
 * the LOCAL roster (a federated `fed:…` id never matches a local coord_presence
 * row, so passing them just wastes a comparison). Only owners with a resolvable,
 * non-stale bucket (a non-null derivation) come back — an untracked OR stale
 * owner is simply absent from the map, mirroring `fetchPresenceFleet`'s
 * "absent ⇒ default" contract.
 */
export async function fetchContextPressure(
  ownerIds: string[],
): Promise<Map<string, ContextPressureBucket>> {
  const readings = await fetchContextPressureReadings(ownerIds);
  const out = new Map<string, ContextPressureBucket>();
  for (const [ownerId, reading] of readings) {
    if (reading.bucket != null) out.set(ownerId, reading.bucket);
  }
  return out;
}

/** IO seam returning the bucket and its estimate age in one batch read. */
export async function fetchContextPressureReadings(
  ownerIds: string[],
  now: number = Date.now(),
): Promise<Map<string, ContextPressureReading>> {
  const out = new Map<string, ContextPressureReading>();
  if (ownerIds.length === 0) return out;
  const { sql } = getOrgPg();
  const rows = await sql<
    { owner_id: string; context_tokens: number | null; compaction_limit: number | null; context_estimated_at: string | null }[]
  >`
    SELECT owner_id, context_tokens, compaction_limit, context_estimated_at
      FROM harness_shared.coord_presence
     WHERE owner_id = ANY(${ownerIds}::text[])
  `;
  for (const r of rows) {
    const bucket = deriveContextPressure(r.context_tokens, r.compaction_limit, r.context_estimated_at, now);
    out.set(r.owner_id, {
      bucket,
      estimatedAt: r.context_estimated_at,
      ageSec: deriveContextPressureAgeSec(r.context_estimated_at, now),
    });
  }
  return out;
}

/**
 * IO seam: ONE owner's cached context size in tokens, or null when no estimate
 * is recorded. The turn-start owner-directive reminder (P-006 of
 * owner-directive-delivery-redesign-2026-09-22) paces itself on its growth.
 * Throws on a read failure; callers own their fail-soft.
 */
export async function readContextTokens(ownerId: string): Promise<number | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ context_tokens: number | null }[]>`
    SELECT context_tokens
      FROM harness_shared.coord_presence
     WHERE owner_id = ${ownerId}
     LIMIT 1
  `;
  return rows[0]?.context_tokens ?? null;
}

/**
 * IO seam (EI-23744538757758407): the three facts `raisingLimitWouldClear` needs for ONE owner —
 * its cached estimate, the soft limit that estimate was bucketed against, and the ceiling
 * `config:set-compaction-limit` would actually ACCEPT for it.
 *
 * Structurally compatible with `ContextPressureHeadroom` in
 * `scheduler/context-pressure-claim-gate.ts` and deliberately NOT importing it: that gate is PURE
 * by contract (no PG, no clock) and importing this module, so naming its type here would close an
 * import cycle. TypeScript's structural typing checks the compatibility at each call site.
 *
 * Resolve fleet role from the same presence-fleet source as the self-set tool. Fleet members have
 * a lower self-set ceiling, so omitting that role can suggest a limit the named config tool refuses.
 *
 * Fails SOFT: any unreadable leg yields nulls, and the predicate treats unknown as "do not
 * assert", so the remedy falls back to the legacy recovery-path wording rather than guessing.
 */
export async function resolveContextPressureHeadroom(ownerId: string): Promise<{
  contextTokens: number | null;
  softLimit: number | null;
  selfSetCeiling: number | null;
}> {
  const unknown = { contextTokens: null, softLimit: null, selfSetCeiling: null };
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ context_tokens: number | null; compaction_limit: number | null }[]>`
      SELECT context_tokens, compaction_limit
        FROM harness_shared.coord_presence
       WHERE owner_id = ${ownerId}
       LIMIT 1
    `;
    const row = rows[0];
    if (row == null) return unknown;

    const fleetMembership = await fetchPresenceFleet([ownerId]);
    const fleetRole = fleetMembership.get(ownerId)?.fleetRole ?? null;
    const fleetMember = fleetRole != null && fleetRole !== 'leader';

    const { estimateContextWindowForOwner, resolveModelSpecForOwner } = await import(
      '../../compaction-usage'
    );
    const { selfSetCeilingForSpec, selfSetCeilingForWindow } = await import(
      '../../agent-config-constants'
    );
    // Same precedence as the self-set tool: a MEASURED window beats a spec inference, because a
    // CLI can apply a smaller window than the spec implies and we would otherwise suggest a limit
    // that is above the session's real ceiling.
    const measuredWindow = await estimateContextWindowForOwner(ownerId).catch(() => null);
    const spec = measuredWindow == null ? await resolveModelSpecForOwner(ownerId).catch(() => null) : null;
    const selfSetCeiling =
      measuredWindow != null
        ? selfSetCeilingForWindow(measuredWindow, { fleetMember })
        : selfSetCeilingForSpec(spec, { fleetMember });

    return {
      contextTokens: row.context_tokens,
      softLimit: row.compaction_limit,
      selfSetCeiling: Number.isFinite(selfSetCeiling) ? selfSetCeiling : null,
    };
  } catch {
    return unknown;
  }
}
