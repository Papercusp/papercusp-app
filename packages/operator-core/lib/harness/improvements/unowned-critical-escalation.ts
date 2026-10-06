/**
 * Unowned-critical escalation (WI-5213, owner-prompted 2026-07-17): "our system
 * should have a better way to handle this, to prevent this kind of thing from
 * happening in the first place." — EI-13306 (claim-spec NULL-poisoning) was
 * filed severity:critical and left UNASSIGNED for 8h, during which the same
 * defect nearly re-starved the same fleet a second time. The filer was also
 * the victim. Filing is not fixing: severity existed but drove no escalation.
 *
 * This is the standing sweep. Pure detection (`unownedAgedCriticals`) + the
 * same claim-spec predicate the scheduler uses (`matchesWorkItemClaimSpec`,
 * reused verbatim, not reimplemented) to answer "which FLEET would be bitten
 * by this" — the leader most likely to hit it is the leader whose fleet pulls
 * through that subsystem. `readUnownedCriticalsForFleet` is the thin IO shell
 * `fleet:leader-brief` calls each monitor tick, so an orphaned critical
 * surfaces on the leader's brief WITHOUT anyone asking (the acceptance bar).
 *
 * No new scheduler, no new store: `listWorkItems` (the existing cross-family
 * read) + `getClaimSpec`/`fleetSpecBeeKey` (the existing fleet-spec resolver)
 * + `matchesWorkItemClaimSpec` (the existing claim-spec predicate) are the
 * whole substrate.
 */
import { issueToWorkItem, ISSUE_FAMILY_KINDS, type WorkItem } from '../../work-items';
import { listIssues, issuesScopeWorkspace } from '../../issues-engineer';
import { ownNodeAuthoredRemoteIds } from '../../work-items-admission';
import { matchesWorkItemClaimSpec } from '../../scheduler/claim-spec-match';
import { getClaimSpec, fleetSpecBeeKey } from '../../scheduler/claim-spec-store';

/** Default staleness bar (hours) before an unowned critical escalates. Config,
 *  not hardcoded — callers (the leader-brief tool) may override it. */
export const DEFAULT_UNOWNED_CRITICAL_AGE_HOURS = 4;

export interface UnownedCriticalCandidate {
  id: string;
  kind: string;
  title: string;
  harness: string | null;
  /** WI-6846: `item.origin` ('local' | 'remote' | null, defaulted to 'local' below).
   *  'remote' means this node did NOT author the row — it can neither claim NOR
   *  close it (`work_items:set_state` refuses remote-authored mutation; the
   *  claimable pre-filter already excludes it from self-select). Only the
   *  authoring peer resolving it (or federation delivering that resolution)
   *  clears a 'remote' row — see `partitionUnownedCriticalsByOrigin` below. */
  origin: string | null;
  /** WI-10006515: an origin='remote' row authored by one of THIS node's keys (origin records how
   *  a row ARRIVED, not who wrote it — WI-10003565). The claim gate admits it and the write paths
   *  heal it, so it is actionable here, not federated. Absent ⇒ unknown ⇒ treated as false. */
  ownNode?: boolean;
  /** Hours since the item was filed, rounded to 1 decimal. */
  ageHours: number;
  createdAt: string;
}

/**
 * Pure: severity='critical' AND state='open' (the issue-family's single
 * unresolved state — feature-family items don't carry `severity` at all, so
 * this is inherently issue-family: bug/change/task, matching EI-13306's own
 * kind) AND assignee IS NULL AND age >= ageHours. Unparseable createdAt is
 * dropped (never escalate on a timestamp we can't trust).
 */
export function unownedAgedCriticals(
  items: readonly WorkItem[],
  opts: { ageHours?: number; nowMs?: number } = {},
): UnownedCriticalCandidate[] {
  const ageHours = opts.ageHours ?? DEFAULT_UNOWNED_CRITICAL_AGE_HOURS;
  const nowMs = opts.nowMs ?? Date.now();
  const out: UnownedCriticalCandidate[] = [];
  for (const item of items) {
    if (item.severity !== 'critical') continue;
    if (item.assignee != null) continue;
    if (item.state !== 'open') continue;
    const createdMs = Date.parse(item.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    const hours = (nowMs - createdMs) / 3_600_000;
    if (hours < ageHours) continue;
    out.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      harness: item.harness,
      origin: item.origin ?? 'local',
      ageHours: Math.round(hours * 10) / 10,
      createdAt: item.createdAt,
    });
  }
  return out;
}

/**
 * Pure (WI-5213's routing rule): the subset of already-unowned-aged criticals
 * a given FLEET's claim spec would ADMIT — reuses `matchesWorkItemClaimSpec`
 * (the SAME predicate scheduler:get_next evaluates), so "would this fleet
 * pull it" here and at claim time can never drift apart.
 *
 * Deliberately does NOT filter by `origin` here — `matchesWorkItemClaimSpec` is
 * the shared claim-spec predicate and must stay identical to what claim-time
 * evaluates. The remote-origin exclusion `scheduler:get_next` applies is a
 * SEPARATE structural pre-filter (`federationDetector`), not part of the spec
 * predicate — so this can (correctly) admit remote-origin rows. Callers that
 * need to distinguish actionable from federation-blocked rows should use
 * {@link partitionUnownedCriticalsByOrigin} on the result.
 */
export function unownedCriticalsMatchingFleetSpec(
  items: readonly WorkItem[],
  spec: Parameters<typeof matchesWorkItemClaimSpec>[1],
  opts: { ageHours?: number; nowMs?: number } = {},
): UnownedCriticalCandidate[] {
  const admitted = items.filter((item) => matchesWorkItemClaimSpec(item, spec));
  return unownedAgedCriticals(admitted, opts);
}

/**
 * WI-6846: a leader reading `unownedCriticals` cannot act on a `origin:'remote'`
 * row from this node — it can neither claim it (the claimable pre-filter already
 * excludes remote-origin rows from self-select) nor close it
 * (`work_items:set_state` refuses to mutate a remote-authored row locally; only
 * the authoring peer, or federation delivering that peer's resolution, clears
 * it). Left unpartitioned, a majority-remote backlog reads as urgent unowned
 * work a leader is expected to act on, when in fact most of it is inert here.
 *
 * `actionable` = this node COULD claim/resolve it (origin is 'local', or any
 * value other than the literal 'remote' — unset/unknown origin defaults to
 * 'local' upstream in {@link unownedAgedCriticals}, so it is never silently
 * dropped from the actionable bucket by an absent value).
 * `federatedUnresolvable` = origin === 'remote': visible so nothing is hidden,
 * but explicitly called out as NOT this node's to resolve.
 */
export interface PartitionedUnownedCriticals {
  actionable: UnownedCriticalCandidate[];
  federatedUnresolvable: UnownedCriticalCandidate[];
}

export function partitionUnownedCriticalsByOrigin(
  candidates: readonly UnownedCriticalCandidate[],
): PartitionedUnownedCriticals {
  const actionable: UnownedCriticalCandidate[] = [];
  const federatedUnresolvable: UnownedCriticalCandidate[] = [];
  for (const c of candidates) {
    if (c.origin === 'remote' && c.ownNode !== true) federatedUnresolvable.push(c);
    else actionable.push(c);
  }
  return { actionable, federatedUnresolvable };
}

/**
 * IO: read the workspace's open+critical+unassigned issue-family backlog and
 * narrow it to what `fleet`'s claim spec would admit — the one-call shell
 * `fleet:leader-brief` uses. Queries `listIssues` with `severity`+`state`
 * pushed server-side (NOT `listWorkItems`'s recency-capped cross-family scan,
 * which would systematically miss exactly the OLD stale items this sweep
 * exists to catch once the backlog exceeds the cap). Fails soft to `[]` on
 * any read error (this must never break the health brief it decorates);
 * callers that need to distinguish "none found" from "read failed" should
 * call the two pure halves directly instead.
 */
export async function readUnownedCriticalsForFleet(args: {
  fleet: string;
  harness?: string;
  workspaceId?: string;
  ageHours?: number;
}): Promise<UnownedCriticalCandidate[]> {
  try {
    const [issues, spec] = await Promise.all([
      listIssues({
        state: 'open',
        severity: 'critical',
        kinds: ISSUE_FAMILY_KINDS,
        scope: args.harness ? `harness:${args.harness}` : undefined,
        limit: 100,
      }),
      getClaimSpec({ cupId: fleetSpecBeeKey(args.fleet), workspaceId: args.workspaceId }),
    ]);
    const items: WorkItem[] = issues.map(issueToWorkItem);
    const candidates = unownedCriticalsMatchingFleetSpec(items, spec, { ageHours: args.ageHours });
    // WI-10006515: mark own-node rows stranded at origin='remote' so the partition does not
    // report this node's own work as a peer's. One batch read, only when a remote row exists.
    const remoteIds = candidates.filter((c) => c.origin === 'remote').map((c) => c.id);
    if (remoteIds.length === 0) return candidates;
    const own = await ownNodeAuthoredRemoteIds(args.workspaceId ?? issuesScopeWorkspace(), remoteIds);
    return candidates.map((c) => (own.has(c.id) ? { ...c, ownNode: true } : c));
  } catch {
    return [];
  }
}

/**
 * EI-18693470222331709 (2026-07-26): "an item RELEASED mid-flight is
 * indistinguishable from one nobody ever started." WI-6006 sat state=open /
 * assignee=NULL for 23 minutes with a checkpoint reading "all 6 signals
 * implemented, full suite green, next: work_items:complete" — the ONLY thing
 * blocking the plan's closing item — and nothing flagged it: unownedAgedCriticals
 * above answers a DIFFERENT question (severity='critical' AND age>=4h; this item
 * had no severity and was 23 minutes old), and benchSuggestion flags the idle
 * AGENT, never the stranded ITEM.
 */
export interface OrphanedInFlightCandidate {
  id: string;
  kind: string;
  title: string;
  harness: string | null;
  /** Minutes since the item's last REAL progress (state transition / checkpoint
   *  write) — how long it has sat back in the pool since being handed back,
   *  rounded to 1 decimal. */
  minutesSinceProgress: number;
  lastProgressAt: string;
}

/**
 * Pure: state='open' AND assignee IS NULL AND lastProgressAt IS NOT NULL.
 *
 * `lastProgressAt` can only be set while an item is actively HELD — a state
 * transition (`setWorkItemState`) or a checkpoint write both require a live
 * holder (see `markIssueProgress`/`markFeatureProgress` and the checkpoint
 * store's progress-anchor bump) — so a row that is CURRENTLY unclaimed yet still
 * carries one was necessarily handed back mid-flight (voluntary release, a stale-
 * claim reaper, or a dead session), never "nobody ever started it". No new
 * schema/column needed: `last_released_by` provenance is NOT required to make
 * this call — the progress signal alone already proves prior real work, and the
 * assignee IS NULL clause already proves it isn't a legitimate live re-dispatch.
 *
 * Deliberately NOT age-gated by default (unlike `unownedAgedCriticals`'s 4h bar):
 * this work is nearly complete, so the cost of leaving it stranded is HIGHEST
 * immediately after release — an age floor would defeat the point. Callers that
 * want a grace window (avoid flagging an item mid a legitimate re-dispatch that
 * simply hasn't been re-claimed yet) pass `minAgeMinutes`.
 */
export function unownedInFlightOrphans(
  items: readonly WorkItem[],
  opts: { minAgeMinutes?: number; nowMs?: number } = {},
): OrphanedInFlightCandidate[] {
  const minAgeMinutes = opts.minAgeMinutes ?? 0;
  const nowMs = opts.nowMs ?? Date.now();
  const out: OrphanedInFlightCandidate[] = [];
  for (const item of items) {
    if (item.assignee != null) continue;
    if (item.state !== 'open') continue;
    if (!item.lastProgressAt) continue;
    const progressMs = Date.parse(item.lastProgressAt);
    if (!Number.isFinite(progressMs)) continue;
    const minutes = (nowMs - progressMs) / 60_000;
    if (minutes < minAgeMinutes) continue;
    out.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      harness: item.harness,
      minutesSinceProgress: Math.round(minutes * 10) / 10,
      lastProgressAt: item.lastProgressAt,
    });
  }
  return out;
}

/**
 * Pure (mirrors `unownedCriticalsMatchingFleetSpec`): the subset of orphaned
 * in-flight items a given FLEET's claim spec would ADMIT.
 */
export function unownedInFlightOrphansMatchingFleetSpec(
  items: readonly WorkItem[],
  spec: Parameters<typeof matchesWorkItemClaimSpec>[1],
  opts: { minAgeMinutes?: number; nowMs?: number } = {},
): OrphanedInFlightCandidate[] {
  const admitted = items.filter((item) => matchesWorkItemClaimSpec(item, spec));
  return unownedInFlightOrphans(admitted, opts);
}

/**
 * IO: mirrors {@link readUnownedCriticalsForFleet} — the one-call shell
 * `fleet:leader-brief` uses. No severity filter (an orphaned in-flight item
 * carries no severity signal at all — WI-6006 had none), so this queries the
 * open issue-family backlog broadly and narrows client-side; fails soft to `[]`.
 */
export async function readOrphanedInFlightForFleet(args: {
  fleet: string;
  harness?: string;
  workspaceId?: string;
  minAgeMinutes?: number;
}): Promise<OrphanedInFlightCandidate[]> {
  try {
    const [issues, spec] = await Promise.all([
      listIssues({
        state: 'open',
        kinds: ISSUE_FAMILY_KINDS,
        scope: args.harness ? `harness:${args.harness}` : undefined,
        limit: 100,
      }),
      getClaimSpec({ cupId: fleetSpecBeeKey(args.fleet), workspaceId: args.workspaceId }),
    ]);
    const items: WorkItem[] = issues.map(issueToWorkItem);
    return unownedInFlightOrphansMatchingFleetSpec(items, spec, { minAgeMinutes: args.minAgeMinutes });
  } catch {
    return [];
  }
}
