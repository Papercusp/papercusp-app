/**
 * fleet-scope-admission-blocks.ts — the leader-facing READ half of fleet-scope
 * admission (EI-18680302159738037).
 *
 * `fleet-scope-admission.ts` owns the REFUSAL: a member's claim is checked against
 * the fleet claim spec, refused before mutation, and the leader is notified. That
 * notice is an ordinary coord message, and an ordinary coord message is exactly
 * what gets buried — the filing incident measured an inbox at total=11990 with
 * coalesced_dupes=11000, where one action-required row does not survive. This
 * module recovers those refusals so `fleet:leader-brief` — the surface a leader
 * actually reads every wake — can name them.
 *
 * The remedy for an admission block is a claim-spec write only the LEADER can
 * make, so the block is leader-actionable by construction and belongs on the
 * leader's dashboard rather than in their mail.
 *
 * Read-side only: no side table and no second write path. The refusal already
 * stamps `fleetAdmissionBlock` on its envelope (see `notifyFleetScopeRefusal`),
 * so this scans coord_event_log the same way directive-effect-read.ts recovers
 * `expectEffect` stamps — and, like that module, it reads the COORD handle, which
 * is why it lives here beside the other coord readers rather than next to the
 * brief that consumes it.
 */
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import type { FleetDependencyEscape } from '../../scheduler/fleet-scope-admission';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

/** The coord message category every fleet-scope admission notice is sent under. */
export const FLEET_ADMISSION_BLOCK_CATEGORY = 'fleet-scope-admission';

/** The envelope key `notifyFleetScopeRefusal` stamps its structured payload on. */
export const FLEET_ADMISSION_BLOCK_STAMP = 'fleetAdmissionBlock';

/**
 * How far back a refusal still counts as fleet health.
 *
 * Deliberately shorter than DIRECTIVE_EFFECT_LOOKBACK_MS (3d): a claim spec is
 * re-authored in one call, so a block the leader has already widened past is
 * noise within the hour — and stale rows here would push the brief toward the
 * very "so much output that the signal is buried" failure this exists to fix.
 */
export const FLEET_ADMISSION_BLOCK_LOOKBACK_MS = 24 * 3600 * 1000;

/** Hard cap on envelopes scanned per read, so one refusal loop cannot bloat a brief. */
export const FLEET_ADMISSION_BLOCK_SCAN_CAP = 200;

/** Rows surfaced to the leader after de-duplication. Bounds the brief's own array. */
export const FLEET_ADMISSION_BLOCK_ROW_CAP = 20;

/** One admission block, as the leader needs to act on it. */
export interface FleetAdmissionBlock {
  /** The work-item / plan-item the member was refused. */
  itemId: string | null;
  /** The member that was refused — the agent whose lane is too narrow. */
  member: string | null;
  /** Which spec refused it, and at which revision (the thing the leader edits). */
  specId: string | null;
  specRevision: number | null;
  /** The admission code: fleet_scope_missing | fleet_scope_violation | fleet_winding_down. */
  code: string | null;
  /** The attempted action, e.g. `work_items:claim WI-5891 → su-b0971`. */
  action: string | null;
  /** The refusal's own reason text, clipped. */
  reason: string | null;
  msgId: string;
  atMs: number;
  /** How many times this same (item, member) pair was refused inside the window. */
  occurrences: number;
  /** Typed critical-path escape, present only when this refusal blocks held work. */
  dependencyEscape: FleetDependencyEscape | null;
  /**
   * The refused subject's own harness, stamped by the refusal site (EI-24439258189705130).
   * Lets revalidation resolve a bare WI-/F- id when the fleet has no claim spec to
   * name a harness. Absent on stamps written before the field existed.
   */
  harness?: string | null;
}

/** The row shape the SQL below selects — one envelope carrying a stamp. */
export interface FleetAdmissionBlockRow {
  msg_id: string;
  /** epoch ms; bigint arrives as a string from postgres-js. */
  ts_ms: string | number;
  stamp: unknown;
}

/**
 * Availability-preserving read result.
 *
 * An empty `blocks` array is a measured zero. `available:false` means the read
 * did not produce a measurement and MUST NOT be coerced to that zero by a
 * health consumer.
 */
export type FleetAdmissionBlockRead =
  | { available: true; blocks: FleetAdmissionBlock[] }
  | { available: false; blocks: null; reason: string };

export interface FleetAdmissionBlockRowReadArgs {
  workspaceId: string;
  audience: string;
  sinceMs: number;
  scanCap: number;
}

/** The authored fleet claim-spec head used to validate historical refusals. */
export interface FleetAdmissionSpecHead {
  specId: string | null;
  revision: number | null;
}

export type FleetAdmissionBlockTerminalResolver = (
  block: FleetAdmissionBlock,
  harness: string | null,
) => Promise<boolean>;

/** Resolves a fleet's CURRENT registered leader ownerId, or null when unknown. */
export type FleetAdmissionBlockLeaderResolver = (
  fleetSlug: string,
  workspaceId: string,
) => Promise<string | null>;

/** Resolves the fleet's CURRENT durable control state, or null when unknown. */
export type FleetAdmissionBlockControlStateResolver = (
  fleetSlug: string,
  workspaceId: string,
) => Promise<'active' | 'winding-down' | null>;

/**
 * Resolves a dependency work-item's CURRENT assignee ownerId, or null when the
 * item is absent/unassigned. Test seam for `admissionBlockResolvedByLeaderClaim`
 * so it (and `filterCurrentAdmissionBlocks`) is unit-testable without a live DB
 * for `getWorkItem` (EI-22066839645010639).
 */
export type FleetAdmissionDependencyAssigneeResolver = (
  dependencyId: string,
  harness: string | null,
) => Promise<string | null>;

export interface FetchFleetAdmissionBlocksOptions {
  nowMs?: number;
  lookbackMs?: number;
  scanCap?: number;
  rowCap?: number;
  /** Concrete harness from the caller when it already has one (leader-brief). */
  harness?: string | null;
  /** Test seam; production resolves the target from the canonical work/plan ledger. */
  isTargetTerminal?: FleetAdmissionBlockTerminalResolver;
  /** Test seam; production reads the fleet sentinel's authored claim-spec harness. */
  resolveFleetHarness?: (fleetSlug: string, workspaceId: string) => Promise<string | null>;
  /**
   * Current fleet claim-spec head. A null/partial head is treated as unknown and
   * therefore fails open: an unreadable spec must not hide a live refusal.
   */
  resolveFleetSpec?: (fleetSlug: string, workspaceId: string) => Promise<FleetAdmissionSpecHead | null>;
  /**
   * Test seam; production reads the fleet registry's current `leaderOwnerId`
   * (EI-22066839645010639). Used to revalidate a dependency-escape block against
   * the documented `leader_claim` route.
   */
  resolveFleetLeader?: FleetAdmissionBlockLeaderResolver;
  /**
   * Test seam; production reads the fleet registry's current controlState.
   * A resolved `active` state retires historical `fleet_winding_down` rows;
   * null/read failure fails open and keeps them.
   */
  resolveFleetControlState?: FleetAdmissionBlockControlStateResolver;
  /**
   * Test seam; production reads the dependency work-item's current assignee via
   * `getWorkItem` (EI-22066839645010639). Paired with `resolveFleetLeader` to
   * decide whether the fleet leader has already claimed the blocking dependency.
   */
  resolveDependencyAssignee?: FleetAdmissionDependencyAssigneeResolver;
  /**
   * Authoritative post-liveness member ids from fleet:leader-brief. When supplied,
   * refusals from dead/removed members are historical noise and are dropped. An
   * empty set is meaningful (the fleet has no live members), unlike an omitted set.
   */
  liveMemberIds?: readonly string[] | ReadonlySet<string>;
  /** Test seam for the PG capability check. */
  hasPgFastPath?: () => boolean;
  /** Test seam for the bounded coord-event row read. */
  readRows?: (args: FleetAdmissionBlockRowReadArgs) => Promise<readonly FleetAdmissionBlockRow[]>;
}

const clipReason = (value: unknown, max = 240): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const asId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const asDependencyEscape = (value: unknown): FleetDependencyEscape | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const dependency = rec.dependency as Record<string, unknown> | undefined;
  const routes = Array.isArray(rec.routes) ? rec.routes : [];
  const routeKinds = routes.map((route) =>
    route && typeof route === 'object' && !Array.isArray(route) ? (route as Record<string, unknown>).kind : null,
  );
  if (
    rec.kind !== 'dependency_escape' ||
    rec.ownershipPreserved !== true ||
    !asId(dependency?.id) ||
    !asId(dependency?.kind) ||
    !asId(rec.member) ||
    !Array.isArray(rec.blockedHeldItemIds) ||
    rec.blockedHeldItemIds.length === 0 ||
    !rec.blockedHeldItemIds.every((id) => Boolean(asId(id))) ||
    !routeKinds.includes('spec_widen') ||
    !routeKinds.includes('outside_lane_placement') ||
    !routeKinds.includes('leader_claim')
  )
    return null;
  return value as FleetDependencyEscape;
};

/**
 * PURE: parse a stamped envelope payload into a block.
 *
 * Returns null unless the stamp names BOTH the refused item and the refused
 * member. That pair is the whole actionable content — a row missing either one
 * tells the leader something was refused somewhere, which is strictly worse than
 * silence on a dashboard whose entire purpose is "here is the thing only you can
 * unblock". An envelope from an older sender (before the stamp existed) has no
 * stamp at all and is SKIPPED here rather than prose-parsed out of the body:
 * guessing at the body text would manufacture rows whose itemId is whatever the
 * remedy sentence happened to mention.
 */
export function parseAdmissionBlockStamp(
  raw: unknown,
  meta: { msgId: string; atMs: number },
): FleetAdmissionBlock | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const itemId = asId(rec.itemId);
  const member = asId(rec.member);
  if (!itemId || !member) return null;
  if (!Number.isFinite(meta.atMs) || meta.atMs <= 0) return null;
  const revision = typeof rec.specRevision === 'number' && Number.isFinite(rec.specRevision) ? rec.specRevision : null;
  return {
    itemId,
    member,
    specId: asId(rec.specId),
    specRevision: revision,
    code: asId(rec.code),
    action: clipReason(rec.action, 160),
    reason: clipReason(rec.reason),
    msgId: meta.msgId,
    atMs: meta.atMs,
    occurrences: 1,
    dependencyEscape: asDependencyEscape(rec.dependencyEscape),
    harness: asId(rec.harness),
  };
}

/**
 * PURE: collapse repeat refusals of the SAME (item, member) pair to one row,
 * newest first, counting the repeats.
 *
 * A refused member retries on its own schedule, so one mis-scoped spec can emit
 * the identical refusal every wake. Collapsing keeps the brief's row list a list
 * of DISTINCT problems, while `occurrences` preserves the signal that actually
 * distinguishes a one-off from a member stuck in a refusal loop — which is the
 * more urgent read, and the one a plain cap would have truncated away.
 */
export function dedupeAdmissionBlocks(
  blocks: readonly FleetAdmissionBlock[],
  cap = FLEET_ADMISSION_BLOCK_ROW_CAP,
): FleetAdmissionBlock[] {
  const byPair = new Map<string, FleetAdmissionBlock>();
  for (const block of blocks) {
    const key = `${block.itemId}\x00${block.member}`;
    const seen = byPair.get(key);
    if (!seen) {
      byPair.set(key, { ...block });
      continue;
    }
    seen.occurrences += 1;
    // Keep the NEWEST row's detail: the spec revision on the latest refusal is
    // the one the leader is about to edit, so an older revision here would send
    // them to re-widen a spec that has already moved on.
    if (block.atMs > seen.atMs) {
      byPair.set(key, { ...block, occurrences: seen.occurrences });
    }
  }
  return [...byPair.values()].sort((a, b) => b.atMs - a.atMs).slice(0, cap);
}

const PLAN_ITEM_ADDRESS = /^(.+)#(P-\d+)$/;

/** The two work-item facts refusal revalidation reads: lifecycle state and holder. */
export type FleetAdmissionTargetItemReader = (
  itemId: string,
  harness: string | undefined,
) => Promise<{ state: string; assignee?: string | null } | null>;

async function readTargetItem(
  itemId: string,
  harness: string | undefined,
): Promise<{ state: string; assignee?: string | null } | null> {
  const { getWorkItem } = await import('../../work-items');
  return getWorkItem(itemId, harness);
}

/**
 * Revalidate a historical refusal against the target's CURRENT state.
 *
 * A refusal envelope is append-only evidence that a block once happened; it is
 * not evidence that the target is still actionable. Return true only when the
 * refusal is positively resolved:
 *   - the target is terminal, or
 *   - the target is now HELD by the very member it was refused to
 *     (EI-24439258189705130). A direct assignment superseded the refusal, so the
 *     member is not starved for it and there is nothing for the leader to widen
 *     or route. Measured: two p013-bcd refusals from 15:51Z sat in the brief for
 *     a day and re-fired `fleet:admission-blocked` after every sweep-process
 *     restart, while both items had been held by their refused members since 15:52Z.
 *
 * The refusal's own stamped harness is preferred over the fleet's, because a
 * fleet without a claim spec has no harness at all, and a bare WI/F id is only
 * unique inside one. Missing targets, missing harness scope, and read failures
 * all fail open (the caller keeps the block), because hiding a genuine live
 * refusal is more expensive than retaining an uncertain advisory.
 */
export async function admissionBlockTargetIsResolved(
  block: FleetAdmissionBlock,
  harness: string | null,
  readItem: FleetAdmissionTargetItemReader = readTargetItem,
): Promise<boolean> {
  const itemId = block.itemId?.trim();
  if (!itemId) return false;
  const scopeHarness = block.harness?.trim() || harness?.trim() || null;

  const planItem = PLAN_ITEM_ADDRESS.exec(itemId);
  if (planItem) {
    if (!scopeHarness) return false;
    const [{ planItemEffectiveStatus }, { isTerminalStatus }] = await Promise.all([
      import('../../plan-items/assignments'),
      import('../plans/set-status'),
    ]);
    const state = await planItemEffectiveStatus(scopeHarness, planItem[1]!, planItem[2]!);
    return state != null && isTerminalStatus(state);
  }

  // A bare WI/F id is only unique inside a harness. EI snowflakes are globally
  // unique, so they remain safely resolvable when a legacy fleet has no authored
  // harness. Unknown id families retain the historical block.
  if (!/^(?:WI|EI|F)-/.test(itemId)) return false;
  if (!scopeHarness && !itemId.startsWith('EI-')) return false;
  const item = await readItem(itemId, scopeHarness ?? undefined);
  if (item == null) return false;
  if (ANY_FAMILY_TERMINAL_STATES.includes(item.state as (typeof ANY_FAMILY_TERMINAL_STATES)[number])) return true;
  const member = block.member?.trim();
  return !!member && item.assignee?.trim() === member;
}

async function currentFleetLeaderOwnerId(fleetSlug: string, workspaceId: string): Promise<string | null> {
  const { getFleet } = await import('../../agent-fleets-store');
  const record = await getFleet(workspaceId, fleetSlug);
  return record?.leaderOwnerId?.trim() || null;
}

async function currentDependencyAssignee(dependencyId: string, harness: string | null): Promise<string | null> {
  const { getWorkItem } = await import('../../work-items');
  const item = await getWorkItem(dependencyId, harness ?? undefined);
  return item?.assignee?.trim() || null;
}

/**
 * Revalidate a dependency-escape block against whether the fleet's LEADER has
 * already exercised the documented `leader_claim` route — directly claiming the
 * blocking dependency (`dependencyEscape.dependency.id`, the SAME id as
 * `block.itemId`; see `notifyFleetScopeRefusal`) without releasing the refused
 * member's own held work (`ownershipPreserved: true`).
 *
 * EI-22066839645010639: `admissionBlockTargetIsResolved` only clears a block once
 * the dependency reaches a TERMINAL state, but a leader who claims a dependency
 * to become "the sole live gate fixer" is actively WORKING it, not done with it —
 * so the block sat on the leader's own dashboard as a still-actionable "you must
 * widen the spec / place outside the lane / claim it yourself" advisory for up to
 * 24h (and re-fired after every restart's snapshot reset) even though the leader
 * had already taken exactly that third route. `buildFleetDependencyEscape`'s
 * `leader_claim` call passes no `assignee` — invoked by the leader, it claims
 * under the caller's own identity — so "the dependency's current assignee is
 * this fleet's registered leader" is the positive signal that route was taken.
 *
 * Fails OPEN like its terminal-check sibling: a missing escape/dependency id, an
 * unresolvable leader, or a read failure all retain the block — an admission
 * block only a leader can act on must never be hidden by absent data.
 */
export async function admissionBlockResolvedByLeaderClaim(
  block: FleetAdmissionBlock,
  fleetSlug: string | null,
  workspaceId: string | null,
  harness: string | null,
  opts: {
    resolveFleetLeader?: FleetAdmissionBlockLeaderResolver;
    resolveDependencyAssignee?: FleetAdmissionDependencyAssigneeResolver;
  } = {},
): Promise<boolean> {
  if (!fleetSlug || !workspaceId) return false;
  const dependencyId = block.dependencyEscape?.dependency.id?.trim();
  if (!dependencyId) return false;
  const leaderOwnerId = await (opts.resolveFleetLeader ?? currentFleetLeaderOwnerId)(fleetSlug, workspaceId);
  if (!leaderOwnerId) return false;
  const assignee = await (opts.resolveDependencyAssignee ?? currentDependencyAssignee)(dependencyId, harness);
  return assignee != null && assignee === leaderOwnerId;
}

/**
 * Drop blocks whose referenced target is proven terminal right now, OR whose
 * dependency escape the fleet's own leader has already resolved by claiming the
 * dependency directly. Both checks are additive and independently fail-open.
 */
export async function filterCurrentAdmissionBlocks(
  blocks: readonly FleetAdmissionBlock[],
  opts: Pick<
    FetchFleetAdmissionBlocksOptions,
    'harness' | 'isTargetTerminal' | 'resolveFleetLeader' | 'resolveDependencyAssignee'
  > & {
    fleetSlug?: string | null;
    workspaceId?: string | null;
  } = {},
): Promise<FleetAdmissionBlock[]> {
  const isTargetTerminal = opts.isTargetTerminal ?? admissionBlockTargetIsResolved;
  const harness = opts.harness?.trim() || null;
  const fleetSlug = opts.fleetSlug?.trim() || null;
  const workspaceId = opts.workspaceId?.trim() || null;
  const filtered = await Promise.all(
    blocks.map(async (block) => {
      const terminal = await isTargetTerminal(block, harness).catch(() => false);
      if (terminal) return null;
      const resolvedByLeader = await admissionBlockResolvedByLeaderClaim(block, fleetSlug, workspaceId, harness, {
        resolveFleetLeader: opts.resolveFleetLeader,
        resolveDependencyAssignee: opts.resolveDependencyAssignee,
      }).catch(() => false);
      return resolvedByLeader ? null : block;
    }),
  );
  return filtered.filter((block): block is FleetAdmissionBlock => block !== null);
}

/**
 * Keep only refusals that still belong to the current fleet lane.
 *
 * Both filters fail open when their authoritative input is absent or incomplete:
 * an unavailable claim-spec read or a legacy stamp without spec metadata must not
 * manufacture a green dashboard by hiding evidence the leader may still need.
 */
export function filterCurrentFleetAdmissionBlocks(
  blocks: readonly FleetAdmissionBlock[],
  opts: {
    currentSpec?: FleetAdmissionSpecHead | null;
    currentControlState?: 'active' | 'winding-down' | null;
    liveMemberIds?: readonly string[] | ReadonlySet<string>;
  } = {},
): FleetAdmissionBlock[] {
  const liveMemberIds = opts.liveMemberIds == null ? null : new Set(opts.liveMemberIds);
  const currentSpec = opts.currentSpec ?? null;
  const currentControlState = opts.currentControlState ?? null;
  const canCompareSpec = currentSpec?.specId != null && currentSpec.specId.length > 0 && currentSpec.revision != null;

  return blocks.filter((block) => {
    if (liveMemberIds && !liveMemberIds.has(block.member ?? '')) return false;
    // A winding-down refusal is actionable only while the fleet remains wound
    // down. Once the canonical fleet row says active, the prescribed remedy
    // (`fleet:resume`) has already happened; retaining the append-only refusal
    // would manufacture a false live block for the rest of the 24h lookback.
    // Unknown control state deliberately fails open and retains the row.
    if (block.code === 'fleet_winding_down' && currentControlState === 'active') return false;
    // Older refusal stamps may not carry one or both spec-head fields. Keep those
    // rows rather than guessing that a missing field means "not current".
    if (
      canCompareSpec &&
      block.specId != null &&
      block.specRevision != null &&
      (block.specId !== currentSpec!.specId || block.specRevision !== currentSpec!.revision)
    ) {
      return false;
    }
    return true;
  });
}

async function claimSpecHarnessForFleet(fleetSlug: string, workspaceId: string): Promise<string | null> {
  const { fleetSpecBeeKey, getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
  const record = await getClaimSpecRecord({ cupId: fleetSpecBeeKey(fleetSlug), workspaceId });
  return record.harnessSlug?.trim() || null;
}

async function claimSpecHeadForFleet(fleetSlug: string, workspaceId: string): Promise<FleetAdmissionSpecHead | null> {
  const { fleetSpecBeeKey, getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
  const record = await getClaimSpecRecord({ cupId: fleetSpecBeeKey(fleetSlug), workspaceId });
  const specId = asId(record.spec?.specId);
  const revision = typeof record.revision === 'number' && Number.isFinite(record.revision) ? record.revision : null;
  return { specId, revision };
}

async function currentFleetControlState(
  fleetSlug: string,
  workspaceId: string,
): Promise<'active' | 'winding-down' | null> {
  const { getFleet } = await import('../../agent-fleets-store');
  const record = await getFleet(workspaceId, fleetSlug);
  return record?.controlState ?? null;
}

/**
 * Fleet-health read: the distinct admission blocks raised against THIS fleet's
 * spec inside the lookback window.
 *
 * Best-effort like its sibling decorations (fetchDirectiveActuationSummaries /
 * fetchUnansweredDirected), but availability-preserving: a measured empty set is
 * `{ available:true, blocks:[] }`; an unavailable read is explicitly typed and
 * carries no array. A decoration must never be able to fail the brief it
 * decorates, but it also must never manufacture a green zero from a failed read.
 */
export async function readFleetAdmissionBlocks(
  fleetSlug: string,
  opts: FetchFleetAdmissionBlocksOptions = {},
): Promise<FleetAdmissionBlockRead> {
  if (!fleetSlug) return { available: false, blocks: null, reason: 'fleet slug is missing' };
  try {
    if (!(opts.hasPgFastPath ?? coordHasPgFastPath)()) {
      return { available: false, blocks: null, reason: 'coordination PostgreSQL fast path is unavailable' };
    }
    const nowMs = opts.nowMs ?? Date.now();
    const sinceMs = nowMs - (opts.lookbackMs ?? FLEET_ADMISSION_BLOCK_LOOKBACK_MS);
    const ws = coordWorkspaceId();
    // The durable audience KEY, not the expanded `to`: `@fleet-leader:<slug>` is
    // recorded at send time and survives a leadership change, whereas `to` holds
    // whichever ownerId happened to hold leadership then.
    const audience = `@fleet-leader:${fleetSlug}`;
    const scanCap = opts.scanCap ?? FLEET_ADMISSION_BLOCK_SCAN_CAP;
    const rows = opts.readRows
      ? await opts.readRows({ workspaceId: ws, audience, sinceMs, scanCap })
      : await coordSql()<FleetAdmissionBlockRow[]>`
          SELECT e.body->>'msg_id' AS msg_id,
                 (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms,
                 e.body->${FLEET_ADMISSION_BLOCK_STAMP} AS stamp
            FROM harness_shared.coord_event_log e
           WHERE e.workspace_id = ${ws}
             AND e.surface = 'messages'
             AND e.body->>'category' = ${FLEET_ADMISSION_BLOCK_CATEGORY}
             AND e.body ? ${FLEET_ADMISSION_BLOCK_STAMP}
             AND jsonb_typeof(e.body->'audience') = 'array'
             AND e.body->'audience' ? ${audience}
             AND (e.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
           ORDER BY (e.body->>'ts')::timestamptz DESC
           LIMIT ${scanCap}`;
    const parsed: FleetAdmissionBlock[] = [];
    for (const row of rows) {
      const block = parseAdmissionBlockStamp(row.stamp, {
        msgId: String(row.msg_id ?? ''),
        atMs: Number(row.ts_ms),
      });
      if (block) parsed.push(block);
    }
    const deduped = dedupeAdmissionBlocks(parsed, opts.rowCap ?? FLEET_ADMISSION_BLOCK_ROW_CAP);
    if (deduped.length === 0) return { available: true, blocks: [] };
    const [currentSpec, currentControlState] = await Promise.all([
      (opts.resolveFleetSpec ?? claimSpecHeadForFleet)(fleetSlug, ws).catch(() => null),
      (opts.resolveFleetControlState ?? currentFleetControlState)(fleetSlug, ws).catch(() => null),
    ]);
    const currentFleetBlocks = filterCurrentFleetAdmissionBlocks(deduped, {
      currentSpec,
      currentControlState,
      liveMemberIds: opts.liveMemberIds,
    });
    if (currentFleetBlocks.length === 0) return { available: true, blocks: [] };
    const harness =
      opts.harness?.trim() ||
      (await (opts.resolveFleetHarness ?? claimSpecHarnessForFleet)(fleetSlug, ws).catch(() => null));
    return {
      available: true,
      blocks: await filterCurrentAdmissionBlocks(currentFleetBlocks, {
        harness,
        isTargetTerminal: opts.isTargetTerminal,
        fleetSlug,
        workspaceId: ws,
        resolveFleetLeader: opts.resolveFleetLeader,
        resolveDependencyAssignee: opts.resolveDependencyAssignee,
      }),
    };
  } catch {
    return { available: false, blocks: null, reason: 'fleet admission-block read failed' };
  }
}

/**
 * Legacy array-only wrapper for callers that have not migrated to the typed
 * availability contract. New health/transition consumers must use
 * `readFleetAdmissionBlocks` so failure cannot masquerade as a measured zero.
 */
export async function fetchFleetAdmissionBlocks(
  fleetSlug: string,
  opts: FetchFleetAdmissionBlocksOptions = {},
): Promise<FleetAdmissionBlock[]> {
  const read = await readFleetAdmissionBlocks(fleetSlug, opts);
  return read.available ? read.blocks : [];
}
