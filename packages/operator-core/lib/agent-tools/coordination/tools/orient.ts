/**
 * coord:orient — the COMPOUND agent wake-orientation + session-bootstrap read
 * (code-execution-tool-orchestration B-CX-1B; extended by tool-call-batching-wrappers
 * P-005). The worker's "where do I stand / what should I work on / what do I know /
 * what changed" in ONE call: my assignments (+ lane + load), the claimable backlog, my
 * inbox summary, the recent plan-events delta, and — when I pass `intent` — a memory
 * recall for it plus a coord:declare-intent so peers see me.
 *
 * Measured (harness_shared.tool_invocations, mcp transport, 14d): the
 * `fleet:assignments ↔ coord:inbox ↔ work_items:list/get` cluster is the dominant
 * orientation flow — triples like `memory:search → coord:inbox → fleet:assignments`
 * (36), `fleet:assignments → coord:inbox → work_items:get` (35). The MANDATED
 * session-bootstrap (memory:search + coord:inbox + coord:plan-events +
 * coord:declare-intent) is four MORE round-trips agents pay every wake — this collapses
 * the whole ritual into one.
 *
 * orient composes: fleet:assignments(me) + work_items:list(claimable) +
 * coord:inbox(summary) + coord:plan-events(delta) [+ memory:search(intent) +
 * coord:declare-intent(intent) when `intent` is passed] → 1 round-trip. It is the
 * worker/work-centric sibling of coord:glance (the fleet-HEALTH read). Composition is
 * the in-process re-dispatch pattern (see `_compound-dispatch.ts`) — each sub-read is
 * gated + telemetry-logged like a direct call, run SEQUENTIALLY so they never contend on
 * the caller's single ctx connection. The bootstrap folds are BEST-EFFORT (a slow/timed-
 * out memory recall, or a declare the caller lacks coord:write for, degrades to a null/
 * false field rather than failing orientation) and the result is bounded/COMPACT
 * (tool-call-batching-wrappers D-008): a wrapper that dumped raw concatenated sub-results
 * would re-introduce the very token cost it exists to remove.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, deriveFleetMembership } from '../identity';
// P-008 (b): the cell-read identity injected into the standing-facts fold.
import { cellReaderFromCtx, type CellReaderCtxLike } from '../../cell-reader-ctx';
import type { FactDependencyStaleness } from '../../facts/dependency-staleness';
import type { FactContestMark } from '../../facts/contested-fold';
import type { CellReadEnv } from '../../../cell-read';
import type { CellReader } from '../../../cell-registry';
import { resolvePresenceFleet } from '../presence-fleet';
import { resolveSelfRef } from '../self-marker';
import { COORD_READ_ROLES } from '../roles';
import { inProcessCall, type InnerCall } from '../../_compound-dispatch';
import { hardText, LIMITS } from '../../limits';
import { withBoundedTimeout } from '../../../bounded-timeout';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../../capability/foreground-transport-cap';
import { getHostSnapshot, type HostSnapshot } from '../../../host-snapshot';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from '../compaction-recovery';
import { shapeOrient } from './orient-shape';
import { shapeLeaderBrief } from '../../fleet/leader-brief-shape';
import { ORIENT_CORE_RESULT_KEYS, ORIENT_OPTIONAL_PRIORITY } from './orient-priority';
// Type-only: the runtime half (interestFold) is dynamically imported at its use site,
// like the other advisory folds, so a module-load failure cannot cost orientation.
import type { InterestContext } from '../../../interest-profiles';
import type { OrientPipeline } from '../pipeline-health';
import { classifyOwnerDriveMode } from '../agent-drive-mode';
import { withholdQueenLoopControl, QUEEN_LOOP_WITHHELD_REASON } from '../queen-loop-facts';
import { admitRecallHits, MEMORY_TEXT_CAP } from '../../../memory/recall-admission';
import type { ScoreScale } from '../../../memory/backend';
import { annotateSupersededMemory } from '../../../memory/temporal-render';
import { readOwnerPresence } from '../../../power-user-sessions';
import { countActiveAwaitsByPrefixes, listActiveAnnouncements } from '../../../events/await/store';
import { announcementVisibleTo } from '../../../events/await/announce-key';
import { resolveAnnouncementOwnership, type AnnouncementOwnership } from '../../events/status';
import { buildAnnouncedGateWarning } from '../../../turn-start-orientation';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from '../../../workspace-registry';
import { getModes } from '../../../modes/store';
import { modeById } from '../../../modes/registry';
import { goalIdFromModes } from '../../../modes/goal-session';
import type { GoalOwnerReportObligation } from '../../../system-health/goal-owner-report-watchdog';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { fixedCohortIds } from '../../../scheduler/claim-spec';
import { goalRefSchema } from '../../../agent-goal-ref';
import type { AckResult, CursorState } from '../read-cursors';
import {
  FLEET_DELTA_SCHEMA_VERSION,
  fingerprintFleet,
  diffFleet,
  slimAssignmentsForDelta,
  type FleetFingerprint,
  type FleetDelta,
} from './fleet-monitor-delta';
import { fingerprintIdList, idListUnchanged, rowKey } from './orient-list-delta';
import { collectOrientDisclosures, recordOrientDisclosures } from '../../../agent-orient-disclosures';
import type { ClaimableHarnessScope } from '../../work_items/claimable';
import type { ControlAnchor } from '../control-anchor';

type ControlAnchorFleetRoute = Extract<ControlAnchor['state']['route'], { kind: 'fleet' }>;
type ControlAnchorRouteState = Pick<ControlAnchor['state'], 'route'>;

export interface RecoveredFleetScope {
  fleetSlug: ControlAnchorFleetRoute['fleet'];
  fleetRole: ControlAnchorFleetRoute['role'];
}

export const ORIENT_LEADER_BRIEF_SCHEMA_VERSION = 'orient-leader-brief-v1' as const;
export const ORIENT_FLEET_HEALTH_SCHEMA_VERSION = 'orient-fleet-health-v1' as const;

/** Extract the fleet route from the post-compaction control anchor without widening
 * the recovery seam to an untyped object. A self/mug route (or missing anchor) leaves
 * the presence-derived scope authoritative for this call. */
export function extractRecoveredFleetScope(
  control: { state: ControlAnchorRouteState } | null | undefined,
): RecoveredFleetScope | null {
  const route = control?.state?.route;
  if (route?.kind !== 'fleet' || !route.fleet) return null;
  return { fleetSlug: route.fleet, fleetRole: route.role };
}

/**
 * WI-38349 — the pid anchor for locating a session's REAL `CLAUDE_CONFIG_DIR`.
 *
 * `coord_presence.pid` is the psu-launcher process; the claude CLI is its child, and
 * only the child carries `CLAUDE_CONFIG_DIR`. Handing this pid to the resolver turns
 * the lookup into ~3 file reads instead of a scan of every pid on the box. Fail-soft:
 * a missing pid degrades resolution to the transcript scan, never to a guess.
 */
async function readSessionPidHint(ownerId: string): Promise<number | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ pid: number | null }>>`
      SELECT pid FROM harness_shared.coord_presence WHERE owner_id = ${ownerId} LIMIT 1
    `;
    const pid = rows[0]?.pid ?? null;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** D-008 COMPACT bounds — keep the folded payload small so it doesn't re-enter
 *  context as bulk input on every later turn. (MEMORY_TEXT_CAP lives with the admission
 *  gates in lib/memory/recall-admission.ts — the char budget is charged against the
 *  truncated text, so the canary must truncate identically to model the same fold.) */
const MEMORY_HITS_CAP = 10;
/** P-003: the non-exhaustive advisory folded alongside a non-empty recall — agents
 *  must neither re-search the intent they just got recall for, NOR treat this fold
 *  as complete (absence here ≠ absence in store). Duplicate-over-missing is the
 *  designed asymmetry (su-agent-behavior `recall-utilization`, D-002). */
export const ORIENT_MEMORY_NOTE =
  'auto-recall (non-exhaustive): do not re-search this same intent; DO memory:search for specifics not shown — absence here is not absence in store.';
const PLAN_EVENTS_FOLD = 10;
const FLEET_CATCHUP_FOLD = 8;
const FLEET_CATCHUP_CAP = 25;
/** Reuse-at-orient bounds (code-run-adoption): surface a few intent-relevant recipes so an
 *  agent reuses an EXISTING code:run script instead of hand-looping/re-authoring — kept tiny
 *  so it never re-enters context as bulk on later turns. */
const RECIPES_DEFAULT = 3;
const RECIPES_CAP = 5;
const RECIPE_TITLE_CAP = 120;
/** WI-3818: fleet:assignments (`me`) and coord:glance (`fleetHealth`) fan out to
 *  presence/assignments/Tier-1 reads with no internal budget — during the
 *  2026-07-10 host-load storm either could hang orient until the 55s MCP
 *  client timeout, in BOTH monitor and full mode (`me` runs unconditionally).
 *  Bound each so a slow leg degrades to an empty/null fallback instead. */
const ORIENT_FLEET_LEG_TIMEOUT_MS = 8_000;
/** EI-21127719036550806: the claimable backlog (work_items:list/claimable/observe),
 *  coord:inbox, coord:plan-events, and coord:declare-intent legs carried NO internal
 *  budget — under genuine host memory-pressure (PSI mem full, tasks stalled on
 *  reclaim/swap) any ONE of these sequential DB round-trips could hang past the
 *  caller's own deadline with the whole orient call reporting NOTHING back (an MCP
 *  request_timeout), instead of the bounded degrade-to-fallback every other core leg
 *  already gets (WI-3818). Same contract, same budget as the fleet leg above. */
const ORIENT_CORE_LEG_TIMEOUT_MS = 8_000;
/**
 * Preflight reads run before composeOrient can report its first useful core
 * snapshot. Keep them shorter than the core-leg budget and run them together so
 * one stalled metadata read cannot consume the aggregate deadline before the
 * assignments/backlog snapshot begins.
 */
export const ORIENT_PREFLIGHT_LEG_TIMEOUT_MS = 5_000;
/** WI-4533: the pipeline leg is a DECORATION on the wake read — cached, and started by the handler
 *  before the legs above, so by the time it is awaited it is almost always already resolved. Bound
 *  it tightly anyway: an agent must never wait on "is the gate green" to find out what it's
 *  assigned. Blowing this budget drops the block; it never fails the orient. */
const ORIENT_PIPELINE_TIMEOUT_MS = 3_000;
/** P-016 (voice-public-release-readiness-2026-07-12): the papercup pane-context
 *  fold gathers FOUR ready-made digests (salience feed, overwatch brief, corpus
 *  digest, live fleet — papercup-context.ts) — heavier than a single fleet leg,
 *  so it gets its own budget. Degrades to null past it (WI-3818 contract). */
const ORIENT_PANE_CONTEXT_TIMEOUT_MS = 10_000;
/** EI-18162666491500151: buildCompactionRecovery (afterCompaction:true) fans out
 *  to FIVE independent legs — a self-transcript FORCE-TAIL/ingest (unbounded on a
 *  large/first-time-seen session file), an armed-loop + control-anchor read, a
 *  held-work-items query, and a staleness-warnings scan — none individually
 *  budgeted, so any one hanging (observed: a healthy MCP connection where
 *  SIBLING tool calls in the SAME turn returned instantly) silently wedged the
 *  WHOLE orient call for the full 300s MCP tool-idle timeout instead of the
 *  bounded-timeout contract (WI-3818) every other orient leg already gets.
 *  Generous vs the other legs (15s, not 8-10s) because it does genuinely more
 *  work and only runs on the FIRST post-compaction orient (low frequency), but
 *  still an order of magnitude under the 300s wedge this exists to prevent. */
const ORIENT_COMPACTION_RECOVERY_TIMEOUT_MS = 15_000;
/**
 * EI-21223537749399745 / EI-21307071637678068: individual fold budgets do not bound the
 * sequential sum of composeOrient plus the handler-owned enrichment folds. The aggregate
 * fence must beat the MCP transport cap, not merely the server's 120s dispatch budget;
 * otherwise a direct coord:orient caller gets an opaque -32001 before this honest unknown
 * fallback can be serialized. Reuse the shared 50s foreground ceiling, which carries the
 * transport's required response-serialization headroom.
 */
export const ORIENT_AGGREGATE_TIMEOUT_MS = FOREGROUND_TIMEOUT_CEILING_MS;

export function withOrientAggregateTimeout<T>(work: Promise<T> | (() => Promise<T>), fallback: T): Promise<T> {
  return withBoundedTimeout(work, {
    fallback,
    timeoutMs: ORIENT_AGGREGATE_TIMEOUT_MS,
    label: 'orient:aggregate',
  }).then(({ value }) => value);
}

/**
 * EI-21589715378243224: the aggregate timeout fallback must be a stable object
 * because composeOrient can finish useful core reads before a later fold stalls.
 * Keep the response explicitly partial/degraded so a caller cannot mistake the
 * snapshot for a complete orientation.
 */
export interface OrientAggregateFallback {
  data: Record<string, unknown>;
}

export function createOrientAggregateFallback(): OrientAggregateFallback {
  return {
    data: {
      ok: true,
      status: 'unknown',
      degraded: true,
      degradedReason: 'aggregate_timeout',
      partial: true,
    },
  };
}

/** Replace the stable fallback's data with the latest composed orientation while
 * retaining the aggregate-timeout markers. This is synchronous and intentionally
 * side-effect free beyond the supplied fallback, so it cannot add latency to the
 * sequential composition path. */
export function snapshotOrientAggregate(
  fallback: OrientAggregateFallback,
  snapshot: Partial<OrientResult> & { recovery?: import('../compaction-recovery').CompactionRecovery },
): void {
  Object.assign(fallback.data, snapshot, {
    status: 'unknown',
    degraded: true,
    degradedReason: 'aggregate_timeout',
    partial: true,
  });
}

export interface OrientArgs {
  harness?: string;
  /**
   * Legacy launch/checkpoint callers may still provide the fleet they believe
   * they are joining.  Membership remains session-inferred; this annotation
   * is accepted for wire compatibility and does not scope the read.
   */
  fleet?: string;
  claimableState?: string;
  claimableLimit?: number;
  inboxLimit?: number;
  /**
   * Deprecated launch/checkpoint alias: false suppresses both fleet catch-up and
   * fleet-health folds. Explicit canonical controls take precedence.
   */
  includeFleet?: boolean;
  /** Deprecated alias: false maps to inboxLimit=0 unless inboxLimit is explicit. */
  includeInbox?: boolean;
  /** Deprecated no-op: assignments are a core orient fold and are always retained. */
  includeAssignments?: boolean;
  /**
   * EI-8300: a repeating LEADER/MONITOR loop pays the full fresh-task bootstrap
   * cost (claimable backlog + facts + plan-events + mem0 recall + fleet
   * catch-up + recipes) every wake even though a monitoring tick only needs
   * "what changed in the fleet" — a major driver of that loop's compaction
   * frequency (measured: ~4 compactions in one lean-monitoring session).
   * `'monitor'` skips those heavy legs ENTIRELY (no sub-call, not just a capped
   * output): no `work_items:list` claimable read, no `coord:plan-events` fold, no
   * fleet catch-up, no recipes search, no memory recall (even when
   * `intent`/`memoryQuery` is set).
   *
   * ONE deliberate exception, EI-18725816532600240: the facts fold is NARROWED,
   * not skipped. The never-drop slots (`dead-end:` + `wall:` + `guard-rail:`) fold on every tick —
   * they are small, bounded, and exist to OVERRIDE a stale plan, so eliding them
   * defeated exactly the cold-wake reconcile a monitor tick is often doing. The
   * payload marks the narrowing via `factsNarrowed`; ordinary standing facts still
   * wait for a full orient. Passing `afterCompaction:true` takes the FULL fold
   * whatever the mode. It KEEPS `fleet:assignments`
   * (the live/parked/stalled/orphaned counts a monitor loop actually watches),
   * the inbox read (still your directed-message signal), and — if `intent` is
   * passed — the `coord:declare-intent` write (cheap, and peers still see your
   * status). Default `'full'` — every existing caller is byte-identical.
   */
  mode?: 'full' | 'monitor';
  // P-005 — the session-bootstrap folds (tool-call-batching-wrappers):
  /** Your one-line intent for THIS turn. When set: DECLARED to peers
   *  (coord:declare-intent) AND used as the memory:search recall query — the
   *  two halves of the bootstrap that need an intent, folded into the one call. */
  intent?: string;
  /** Optional typed goal refs explicitly covered by the declaration. Generated
   *  goal slugs and WI-/EI- work-item refs are accepted; blank/bare numeric
   *  refs are rejected. */
  declared_goal_refs?: string[];
  /** Explicit memory:search query (overrides `intent` for the recall fold). */
  memoryQuery?: string;
  /** Plan slug for the declared lane (used with `intent`). */
  planSlug?: string | null;
  /** Plan items to CLAIM as your lane (used with `intent` + `planSlug`). */
  planItems?: string[];
  /** Max memory hits to fold (default 5, hard-capped 10). */
  memoryLimit?: number;
  /** Opt into closed memory validity windows for an explicit history recall. */
  memoryIncludeSuperseded?: boolean;
  /** Fold the recent plan-events delta (default true). */
  includePlanEvents?: boolean;
  /** Only plan-events strictly later than this ISO timestamp. */
  planEventsSince?: string;
  /** Surface reusable code:run recipes relevant to `intent`/`memoryQuery` (default true). */
  includeRecipes?: boolean;
  /** Max relevant recipes to surface (default 3, hard-capped 5). */
  recipesLimit?: number;
  /** Fold a peers-know hint when the declared `intent` semantically matches a CLOSED
   *  consult in the archive (default true; consult-revival-and-honest-min-2026-08-18 P-006). */
  includePeersKnow?: boolean;
  /** Fold a bounded catch-up slice of YOUR fleet's audience-history when you belong to a
   *  named fleet — the auto "what did my fleet say while I was away" at wake (default true). */
  includeFleetCatchUp?: boolean;
  /** Back-compat alias for the stale camelcase spelling includeFleetCatchup. */
  includeFleetCatchup?: boolean;
  /** Back-compat alias for includeFleetCatchUp (EI-20224878072252879). */
  includeCatchup?: boolean;
  /** Max fleet catch-up messages to fold (default 8, hard-capped 25; 0 skips the fold). */
  fleetCatchUpLimit?: number;
  /** Fold a versioned fleet-health availability/reference when you belong to a
   *  named fleet. Rich health remains behind coord:glance; default true, full mode only. */
  includeFleetHealth?: boolean;
  /** Set true on your FIRST orient after a compaction. Beefs the inbox fold (more
   *  entries + fuller bodies — a just-compacted agent lost its message context), and
   *  the handler ALSO folds the recovery block (held checkpoints + self-recall). */
  afterCompaction?: boolean;
}

export interface OrientMemoryHit {
  id?: unknown;
  memory?: string;
  score?: unknown;
  /** EI-20113865649946366: this hit's body was cut at MEMORY_TEXT_CAP. Present ONLY
   *  when clipped, so its absence positively means "this is the whole fact". */
  truncated?: true;
  /** The body's real length, so the reader can judge how much is missing. */
  fullChars?: number;
}

/** Normalize the wire label from memory:search before it reaches admission. Invalid or absent
 * labels remain unknown (undefined here), which makes the scale-sensitive floor fail open. */
function normalizeScoreScale(value: unknown): ScoreScale | undefined {
  return value === 'cosine' || value === 'rrf' || value === 'lexical' || value === 'unknown'
    ? value
    : undefined;
}

/** Disclosure for a claimable list that was cut. EI-20113865649946366.
 *
 *  `total` and `truncatedByLimit` are deliberately NOT interchangeable, and a reader
 *  should branch on which one is present: `total` is a measured population, while
 *  `truncatedByLimit` is only "the fetch came back full, so assume more". Collapsing
 *  them into one optimistic number is the defect this type exists to prevent. */
export interface OrientClaimableTruncated {
  /** Rows actually in `claimable` after every filter. */
  shown: number;
  /** Authoritative population, when one was measured. Absent ⇒ genuinely unknown. */
  total?: number;
  /** What `total` counts — stops it being read as "everything claimable". */
  totalScope?: string;
  /** The row cap this call fetched under. */
  limit?: number;
  /** Set when the fetch returned a full page and no authoritative count exists. */
  truncatedByLimit?: true;
  /** The verb(s) that return the rest. A marker without this is half a disclosure. */
  more: string;
}

export interface OrientResult {
  ok: boolean;
  /** fleet:assignments scoped to me (assignments, lane, load, orphans). */
  me: unknown;
  /** The claimable backlog. EI-19452326548245557: the issue-family lane (bug/change/
   *  task) is SOURCED from `work_items:claimable` — the same all-floors oracle
   *  `scheduler:get_next` runs — and the feature-family lane from `work_items:list`
   *  ({ kind:'feature', admissibleOnly }); a caller passing no `harness` keeps the
   *  older list-only read, since the oracle requires one. It used to be a single
   *  `work_items:list({ admissibleOnly:true })`, which applies remote-origin +
   *  observation-lane ONLY, so floor-excluded rows (federationDetector, needsHuman,
   *  crossMachineRig, planLaneReserved, loopNoise, externalBlocker, blockedDep) were
   *  advertised here and bounced on the real claim. EI-6468: this list
   *  rides work_items:list's cachedRead (≤20s soft TTL, tag-invalidated on write) —
   *  advisory, NOT a live claim guarantee. A row can lag a just-completed/claimed
   *  state for a few seconds under normal cache-ECA propagation. Treat an id here as
   *  a CANDIDATE to attempt, never as pre-verified available; a real self-select
   *  (work_items:claim / scheduler:get_next / work_items:claim_next) re-checks live
   *  and is authoritative — a `not_claimable` bounce off a stale candidate is
   *  expected and cheap, not a bug to chase. */
  claimable: unknown[];
  /** Scope envelope from work_items:claimable, preserved through this compound fold. */
  claimableHarnessScope?: ClaimableHarnessScope;
  /** Present ONLY when the claimable list above is genuinely incomplete — absence is a
   *  positive statement that nothing was cut, which is what makes the marker readable.
   *  `total` appears only when an authoritative count was available; the fallback legs
   *  carry `truncatedByLimit` instead, because they cannot know the population and a
   *  fabricated total is worse than an admitted bound. EI-20113865649946366. */
  claimableTruncated?: OrientClaimableTruncated;
  /** coord:inbox folded down to its summary + the most-recent bounded entries.
   *  EI-18667514339699744: `entries` is aliased alongside `recent` (same array,
   *  same reference) so a caller reading either coord:orient's or coord:inbox's
   *  key name gets the real rows instead of a silent [] on a mismatched read. */
  inbox: { summary?: unknown; recent?: unknown; entries?: unknown };
  /** Bounded capless-governor state; never includes per-request or per-queue rows. */
  governor?: import('../../../resource-governor/state-snapshot').GovernorOrientSummary | null;
  /** memory:search recall for `intent`/`memoryQuery` — bounded hits; null if the
   *  recall failed/timed out; absent when no query was given. `withheld` counts
   *  queen-loop-steering hits stripped for a responsive caller (P-002). EI-9031:
   *  `degraded` (+ `degradedReason`) is propagated from memory:search when the
   *  embedder is on a reduced-breadth fallback — so an empty `hits` is NOT read as
   *  "nothing relevant exists" during an embedding-backend outage.
   *  WI-36046: a hit whose `memory` OPENS with a `⚠ STALE — dead anchors:` banner has
   *  referents the nightly sweep found no longer resolve — evidence to reconcile, not
   *  binding guidance. The fold reduces each hit to { id, memory, score }, so the
   *  warning rides the BODY by design (a sibling field would be dropped right here);
   *  it is prepended, so it survives the MEMORY_TEXT_CAP slice below and costs no
   *  extra recall budget — it displaces body chars inside the same per-hit cap. */
  memory?: {
    query: string;
    hits: OrientMemoryHit[];
    withheld?: number;
    filteredLowScore?: number;
    /** P-002 (orient-recall-quality): hits dropped by the AGGREGATE char budget
     *  (orientMemoryBudgetChars) — loud, never silent; pull them via memory:search. */
    withheldBudget?: number;
    /** P-003: the non-exhaustive advisory (ORIENT_MEMORY_NOTE) — present iff hits>0. */
    note?: string;
    /** EI-20113865649946366: how many DELIVERED hits had their body clipped, plus the
     *  verb that returns the full text. Distinct from `note`, which says the RECALL is
     *  non-exhaustive (other facts may exist) — this says the facts you WERE given are
     *  themselves cut. Present only when at least one delivered hit was clipped. */
    bodiesTruncated?: { hits: number; cap: number; more: string };
    degraded?: boolean;
    degradedReason?: string;
    /** The score scale declared by memory:search; absent/unknown keeps admission fail-open. */
    scoreScale?: ScoreScale;
  } | null;
  /** STANDING FACTS (queen-memory-hybrid L1c) — deterministic scoped conclusions
   *  (workspace + owner + harness scopes), delivered VERBATIM every orient (unlike
   *  the fuzzy memory recall above). Assert via facts:assert; retract when stale.
   *  null on failure; absent when none stand. For an OWNER-DIRECTED (responsive)
   *  caller, queen-loop steering facts (pauseNewWork/maxBees) are withheld here —
   *  see `factsWithheld` — since they govern the queen-bee loop, not the caller's
   *  owner-directed task (P-002 / D-001).
   *  P-007: audience-filtered by the CALLER's fleet (an `aud`-scoped fact folds
   *  only for its fleet's members), and `src` is provenance-hydrated — a typed
   *  verified sourceRef renders `<ref> ✓ "<verbatim quote>"`, an unresolvable
   *  one renders `✗unverified` loudly. */
  /** P-008 (c): `changed` marks a fact asserted/superseded since this caller last
   *  oriented (D-012's watermark surface). Absent = unchanged, or a bootstrap read. */
  facts?: Array<{
    scope: string;
    ref: string | null;
    body: string;
    src: string | null;
    aud?: string;
    changed?: true;
    /** P-006 read side (WI-7236): other agents wrote a DIFFERENT answer to this key, or
     *  someone already settled it as UNDECIDABLE. Present only when contested — carries
     *  the reader-facing note, the prior authors, and any `settledBy` exit condition. */
    contested?: FactContestMark;
  }> | null;
  /** Present iff queen-loop steering facts were withheld from a responsive caller
   *  (P-002) — transparent, never a silent drop. Pull live state via pot:get-steering. */
  factsWithheld?: { count: number; reason: string };
  /** Present iff the facts fold above was NARROWED to the never-drop slots
   *  (`dead-end:` + `wall:` + `guard-rail:`) rather than run in full — i.e. a plain mode:'monitor'
   *  tick (EI-18725816532600240). `facts` then carries ONLY those slots, so its
   *  contents are NOT a census of standing facts and their absence is NOT evidence
   *  none stand. Absent ⇒ the fold was full. A monitor tick passing
   *  afterCompaction:true gets the full fold and no marker. */
  factsNarrowed?: { fold: 'never-drop'; prefixes: string[]; reason: string };
  /** P-004 / D-006: present iff the per-selector fold LIMIT dropped facts the scope
   *  actually holds — i.e. `facts` is the NEWEST N of that scope, not its population.
   *  Absent ⇒ every selector's whole live population reached the fold.
   *
   *  ⚠ NOT the same as `factsTruncated`, and the two COMPOSE — read both or you will
   *  under-count by an order of magnitude. `factsFoldTruncated` is the DATABASE bound
   *  (the `ORDER BY updated_at DESC LIMIT n` never returned the rest);
   *  `factsTruncated` is the PAYLOAD bound (rows the fold DID return, dropped to fit
   *  the output budget). Measured live 2026-09-02 on one orient: the fold returned 12
   *  of 495 workspace + 12 of 366 harness, then the payload showed 4 of those 24 — so
   *  `factsTruncated` alone reads as "24 exist", against a true population of 861. */
  factsFoldTruncated?: {
    limitPerSelector: number;
    scopes: Array<{ scope: string; scopeRef: string | null; shown: number; total: number }>;
    reason: string;
  };
  /** EI-19485000346355077: present iff one of this fold's selectors (workspace /
   *  owner / harness) had facts CAP-EVICTED recently — so a fact you expect but
   *  don't see in `facts` above may have been evicted, not never-asserted. Never
   *  computed on a narrowed (mode:'monitor', non-afterCompaction) fold — see
   *  `factsNarrowed`. Absent ⇒ either the full fold ran and found nothing to
   *  disclose, or the fold was narrowed. */
  factEvictionDisclosures?: Array<{
    scope: string;
    scopeRef: string | null;
    recentEvictedCount: number;
    latestEvictedAt: string;
    meaning: string;
  }>;
  /** The four scalars agents otherwise shell out for — current UTC instant, core
   *  count, load average, free memory (bash-to-tool-substitution-2026-07-26,
   *  P-026 + P-027). Measured over the 7d corpus: 852 `date` atoms across 50 of
   *  86 sessions (69% of them a bare `date`/`date -u`) and 283 load/mem/core
   *  atoms across 47 of 86 sessions, spread over ~26 distinct zero-argument
   *  shapes. A near-constant answer asked that often does not want a VERB — a
   *  verb still costs the inference round-trip that IS the measured cost — so it
   *  rides here, on a call already made 1,207 times in the same window. Always
   *  present (it cannot fail beyond `now`); ~25 tokens. See host-snapshot.ts for
   *  what deliberately stays bash (`du`/`df`, and `$(date …)` interpolation). */
  host?: HostSnapshot;
  /** coord:plan-events delta — newest few + the true total; null on failure;
   *  absent when includePlanEvents:false. P-005 (full-mode delta rollout):
   *  `unchanged:true` ⇒ `recent` is deliberately empty — the newest events are
   *  byte-identical to what this caller already saw on a prior orient (server-
   *  side cursor, surface 'orient:planEvents'); `total` is still fresh. Absent
   *  `unchanged` ⇒ normal full delivery (baseline, changed, or no cursor injected). */
  planEvents?: { total: number; recent: unknown[]; unchanged?: boolean } | null;
  /** WI-5228 (kickoff-prompt-absorption-2026-07-17 P-002): orient-first plan
   *  bootstrap. For a PLAN-BOUND caller — `planSlug` was passed, or (when
   *  omitted) the self row's `declaredPlanSlug` already sitting on `me`
   *  (fleet:assignments' presence-sourced self-declared current plan)
   *  resolves one — folds the plan's `## Now` block + the next actionable
   *  item + the caller's own claim state within that plan, so a plan-bound
   *  kickoff can reduce to "call coord:orient" with no separate
   *  plans:get/plans:items round-trip. `nextActionable` is the first item
   *  with `effectiveStatus:'todo'`, no unresolved blockers, and
   *  `needsHuman:false` (the same admissibility plans:get already computes)
   *  — null when nothing qualifies (plan fully claimed/blocked/done).
   *  `myClaims` is ALSO derived from the already-fetched `me` (no extra
   *  round-trip beyond plans:get itself). null on failure or no resolvable
   *  plan; absent only when this leg never ran (a monitor tick). */
  planNow?: {
    planSlug: string;
    state: string | null;
    next: string | null;
    nextActionable: { id: string; title: string; phase: string | null } | null;
    /** The caller's own claimed item ids WITHIN this plan. `null` — never `[]` —
     *  when the claim ROWS were not derivable, because an empty array is
     *  indistinguishable from "I hold nothing in this plan", which is a false
     *  zero for a caller who in fact holds claims. `myClaimsUnavailable` says
     *  why (EI-20108229813877389). */
    myClaims: string[] | null;
    myClaimsUnavailable?: string;
    /** Set ONLY when this leg could not resolve the plan (timeout or error).
     *  Every sibling field is then null and means NOT MEASURED — never
     *  "empty". Before EI-20108229813877389 a failure degraded to a bare
     *  `null` planNow, which read exactly like "this plan has no Now": two
     *  independent defects hid behind that for an unknown length of time. */
    status?: 'unknown';
    why?: string;
  } | null;
  /** Reusable code:run recipes relevant to `intent`/`memoryQuery` (recipes:search) —
   *  compact identity/similarity plus the exact authority-preserving runArgs.
   *  Reuse via runArgs instead of hand-looping or re-authoring. Entity-bound
   *  recipes were already filtered against this orient's live lane context. */
  recipes?: Array<{
    id?: unknown;
    title?: string;
    runCount?: unknown;
    similarity?: unknown;
    authorityRefs?: unknown;
    runArgs?: unknown;
  }> | null;
  /** EI-20113865649946366: this fold exists to close an AWARENESS gap ("I didn't know a
   *  recipe existed"), so a silent drop defeats its own purpose. No authoritative total
   *  exists — recipes:search was itself called with a limit — hence `truncatedByLimit`
   *  rather than a fabricated count. `titlesClipped` covers the separate per-title cut. */
  recipesTruncated?: {
    shown: number;
    truncatedByLimit?: true;
    limit?: number;
    titlesClipped?: number;
    titleCap?: number;
    more: string;
  };
  /** A CLOSED consult already settled a question semantically matching this orient's
   *  declared `intent` (consult-revival-and-honest-min-2026-08-18 P-006). Read-only twin
   *  of consult:get_feedback's archive-first serve — same corpus, same embedder space,
   *  same precision-biased floor — surfaced HERE so the agent learns a peer already
   *  answered before starting the work. ABSENT on no-match / short intent / monitor
   *  tick / any embedder-or-pgvector degrade (zero payload cost on the common path). */
  peersKnow?: {
    /** The settled answer's one-liner (outcome.answer, capped). */
    answer: string;
    /** Source consult conversation id. */
    ref: string;
    responder: string | null;
    closedAt: string | null;
    sim: number;
    /** How to read the full thread / re-ask fresh. */
    more: string;
  };
  /** Whether the optional coord:declare-intent succeeded (present only when
   *  `intent` was passed; false = the caller lacked coord:write). */
  intentDeclared?: boolean;
  /** EI-20013545515660920: the OUTCOME of the `planItems` lane claim that
   *  coord:declare-intent performs on this call's behalf. Present only when
   *  `planItems` was passed.
   *
   *  `intentDeclared: true` says only that the declaration CALL succeeded — it
   *  says nothing about whether the lane was actually claimed. declare-intent
   *  already computes a full `claims` diagnostic (unknown ids plus a `hint`
   *  naming exactly why nothing was claimed: a plan that does not resolve in the
   *  scope, or ids that do not parse as items of it), and this call site used to
   *  DISCARD that entire response. The result was a silent no-op: an agent
   *  believed it held a lane it did not hold, with nothing at the call site to
   *  tell it apart from success. That matters because the su persona routes lane
   *  claiming through this tool as the one-call wake bootstrap and states that an
   *  unclaimed lane is invisible to peers and the Mug — so the failure only
   *  surfaces later, as a double-placement.
   *
   *  `warning` is set whenever NONE of the requested items ended up held. */
  laneClaim?: OrientLaneClaim;
  /** A bounded slice of the caller's fleet audience-history (coord:catch-up on
   *  @fleet:<own slug>) — present only when the caller belongs to a fleet; null on a
   *  failed fold. The auto-catch-up at wake. P-005: `unchanged:true` ⇒ `recent` is
   *  deliberately empty (server-side cursor, surface 'orient:fleetCatchUp') — see
   *  `planEvents.unchanged`. */
  fleetCatchUp?: { fleet: string; total: number; recent: unknown[]; unchanged?: boolean } | null;
  /** A deliberately tiny general fleet-health reference. Rich fleet state belongs
   *  to leaderBrief (D-002); this field carries only availability and the recovery
   *  handle so non-leaders do not pay for a second rich payload. */
  fleetHealth?: {
    schemaVersion: typeof ORIENT_FLEET_HEALTH_SCHEMA_VERSION;
    status: 'available' | 'unavailable';
    ref: 'coord:glance';
    reason?: string;
  };
  /** P-009 (coord-authority-hardening H4): the caller's fleet TYPED control state,
   *  folded whenever it is NOT plain 'active' — how a LATE JOINER (or a member who
   *  missed the cue) learns the fleet is winding down without any message having
   *  reached them. Read from the durable registry row (mig 575). Absent for a
   *  non-fleet caller / an active fleet / a failed read (best-effort). */
  fleetControl?: {
    fleet: string;
    state: string;
    reason: string | null;
    by: string | null;
    since: number | null;
  };
  /** EI-9270: declared-but-unfired ANNOUNCED gate events visible to this caller's
   *  fleet/plan/harness (+ global) — "what should I events:await", with zero leader
   *  messages. Absent when none are visible (or on a monitor tick). */
  announcedGates?: Array<{
    event: string;
    note: string | null;
    scope: string;
    announcedBy: string;
    expires_ts: string | null;
    /** Stable logical gate identity, when the declarer supplied one. */
    logical_gate?: string | null;
    /** Number of live non-announce awaits on this event key, when measured. */
    live_awaiters?: number;
    /** Live successors that can declare a replacement for a stale binding. */
    live_successor_ids?: string[];
    /** True only when the declarer ended and no live successor owns the binding. */
    stale_owner?: boolean;
    /** Actionable warning about a stranded or ambiguous announced gate. */
    warning?: string;
  }>;
  /** EI-20113865649946366: gates visible to this caller that the fold did not show.
   *  Load-bearing rather than cosmetic — an undisclosed drop here means the agent
   *  never learns a gate key exists, so it parks on the wrong event or on none. */
  announcedGatesTruncated?: { shown: number; total: number; more: string };
  /** A registered fleet leader's bounded, actionable leaderBrief summary. The
   *  regular orient path reuses shapeLeaderBrief's 5 KB projection; monitor and
   *  recovery paths retain their richer internal fold before outer shaping. */
  leaderBrief?: unknown | null;
  /** Count-only summaries for every fleet led by the caller on monitor and
   * post-compaction recovery. `null` means the led-fleet read failed; an
   * unavailable row is kept explicit instead of reading as an all-clear. */
  fleetSummaries?: OrientFleetSummary[] | null;
  fleetSummariesTruncated?: { total: number; shown: number; more: string };
  /** P-012 (goal-mode-hardening-2026-08-10): the authoritative, timestamped
   *  portfolio snapshot for a caller that holds GOAL mode with a subject. The
   *  handler resolves the mode subject and performs the canonical read; this
   *  composition only folds the injected result. Absent for a non-GOAL caller;
   *  null means the caller is a GOAL holder but the portfolio read degraded. */
  goalPortfolio?: import('../../../goal-launch-settings').GoalPortfolioBrief | null;
  /** P-007 (shared-agent-obligations-and-briefs): the canonical complete
   *  obligation agenda for a resolved GOAL holder. The embedded turn-start
   *  projection remains bounded, while `primary` and `evaluations` are the
   *  complete recovery payload promised by its detailRef. Absent for a
   *  non-GOAL caller; null means the canonical read degraded. */
  obligations?: import('../../../agent-obligation-reader').AgentObligationBrief | null;
  /** EI-18731216945970087 / EI-20201050911711528: present ONLY when composeOrient
   *  caught a presence/registry leadership DRIFT — the caller's presence projection
   *  showed no fleet or a non-leader role, but `agent_fleets.leader_owner_id` says
   *  they lead one. The `leaderBrief` above is still folded for the recovered fleet;
   *  this field makes the disagreement LOUD instead of silently omitting the brief.
   *  Absent on the agreeing path. */
  presenceDrift?: { fleet: string; note: string };
  /** EI-21239843876346650: present when post-compaction control recovery supplied a
   *  fleet route that overrode the presence-derived self scope for this call. The
   *  marker makes the widened `fleet:assignments` read explicit and auditable. */
  recoveredFleetScope?: { fleet: string; role: string | null; note: string };
  /** Versioned fleet DELTA (fleet-deltas-leader-primitives P-004/P-006): what changed
   *  in the fleet since this caller's last orient, diffed server-side
   *  against the (owner, 'fleet:monitor') read cursor — the caller carries nothing.
   *  `baseline:true` or `fullReplacement:true` ⇒ `me` carries the FULL roster.
   *  Otherwise `me.agents` is slimmed to the caller's own row
   *  (`peerRowsElidedFromScope` says how many peers were withheld — WI-6762: relative
   *  to the already scope-filtered set, NOT to the fleet) and `changes` carries the
   *  member transitions plus canonical metric/lifecycle/capacity/gate/promotion axes.
   *  Population/unit/window labels make unlike scopes reset rather than compare.
   *  At-least-once: a wake that dies mid-turn
   *  re-receives the same delta next call. Absent in full mode / flag off. */
  fleetDelta?: {
    schemaVersion: typeof FLEET_DELTA_SCHEMA_VERSION;
    baseline: boolean;
    changes?: FleetDelta['rows'];
    unchanged?: number;
    orphaned?: { from: number; to: number };
    stalled?: { from: number; to: number };
    axes?: FleetDelta['axes'];
    reset?: FleetDelta['reset'];
    fullReplacement?: true;
  };
  /** ownerPresent (flush-to-proceed-stretch-discipline-2026-07-04 P-004): whether a human
   *  power-user session is live for this workspace (readOwnerPresence — a fresh, non-revoked
   *  auth session), so presence-adaptive cadence keys off a MECHANICAL signal rather than
   *  inferring from who sent the last message. `present:true` ⇒ owner is around: run units
   *  back-to-back and converse; `present:false` ⇒ owner absent: settle per unit so wakes stay
   *  injection points. null when the read failed; absent when the handler did not resolve it. */
  ownerPresent?: { present: boolean; lastSeenAgoMs: number | null; activeSessions: number } | null;
  /** P-016 (voice-public-release-readiness-2026-07-12): the papercup FAST pane's
   *  standing live-system digest — the SAME rendered block the converse brain walks
   *  in with (papercup-context.ts: anomalies → live signals → open deep delegations
   *  → standing patterns → live fleet), folded so a coord-side fast-pane turn
   *  orients with the whole pot picture in this ONE call instead of re-deriving it
   *  from raw reads. Present only for a `papercup`-role caller in full mode
   *  (orientRoleFolds); null on a failed/timed-out gather — never breaks orientation. */
  paneContext?: string | null;
  /** P-016: the papercup-deep pane's OPEN QUESTION THREAD — directed messages
   *  awaiting ITS reply (the unanswered-directed aggregate, newest-first capped
   *  list + true count). The deep brain's work unit IS the delegated question, so
   *  its orient leads with "what do I still owe an answer to" — count 0 is the
   *  honest "nothing pending, park". Present only for a `papercup-deep`-role
   *  caller in full mode (orientRoleFolds); null on a failed read. */
  deepWork?: {
    count: number;
    oldestAgeMs: number;
    newest: Array<{ msgId: string; from: string; summary?: string; ageMs: number }>;
    /** The answer-before-parking advisory — rides only a non-empty thread. */
    note?: string;
  } | null;
  /** WI-4533 (P-006): the release PIPELINE's health — the gate's colour + whether the tip is live
   *  — folded into the wake read every agent already makes. An agent that starts editing without
   *  knowing the gate is red is working on something that cannot ship; the fact existed (dev:why)
   *  but 425 agents oriented 2256×/7d and called it 16×. Terse when healthy ({gate,deploy}); when
   *  not, it carries the failing files + the root-cause leaf + what it means for the caller's work.
   *  ABSENT (never a false green) for a harness with no green-checkpoint routine, and on any
   *  read failure/timeout — see pipeline-health.ts. Both modes: a monitor tick wants this most. */
  pipeline?: OrientPipeline | null;
  /** P-011 (state-plane-interest-and-hardening-2026-08-21): the fold tier of the
   *  interest profiles — cells this caller's live contexts say are worth watching,
   *  as HANDLES ONLY (D-001: never an ambient copy of a value). Absent, never an
   *  empty shell, when nothing matched or the audience check dropped everything. */
  interest?: import('../../../interest-fold').InterestFoldBlock | null;
  /** P-006 / EI-11409: compact schemas for the exact task/mode pack orient
   *  activated on this session. Re-delivered after compaction with a stable
   *  content watermark and replace-full resync contract. */
  taskToolSchemaPack?: import('./orient-task-schema-pack').TaskToolSchemaPack & {
    activation: { requested: boolean; surfaceChanged: boolean | null };
  };
}

/**
 * Claude Code owns its deferred tool surface through ToolSearch. Automatic
 * orient activation would instead emit tools/list_changed and make Claude
 * materialize the activated tools' full schemas in its prompt. Keep the
 * server-side schema pack and tools:invoke fallback available, but leave
 * activation to clients whose dynamic MCP surface is designed to refresh.
 * Unknown callers retain the historical activation behavior.
 */
export function shouldActivateOrientToolSurface(callerAgent?: string | null): boolean {
  return callerAgent !== 'claude';
}

export interface OrientFleetSummary {
  fleet: string;
  summary: Record<string, unknown> | null;
  unavailable?: true;
  reason?: string;
}

type OrientClassifiedResultKey =
  | (typeof ORIENT_CORE_RESULT_KEYS)[number]
  | Extract<(typeof ORIENT_OPTIONAL_PRIORITY.tier4)[number]['fields'][number], keyof OrientResult>
  | 'taskToolSchemaPack';

/** Compile-time drift guard: adding an OrientResult field requires assigning it
 *  to the shared core/tier data before this module can typecheck. */
export const ORIENT_RESULT_PRIORITY_IS_EXHAUSTIVE: Exclude<keyof OrientResult, OrientClassifiedResultKey> extends never
  ? true
  : false = true;

/** P-016: the role-specific fold closures the HANDLER injects (dynamic-import IO
 *  lives in the closures) so composeOrient stays IO-free + unit-testable — the
 *  same injection contract as the cursor/fleetMembership params. */
export interface OrientRoleFolds {
  /** Renders the papercup pane's live-system digest block (null ⇒ nothing to fold). */
  paneContext?: () => Promise<string | null>;
  /** Reads the papercup-deep pane's unanswered directed-question thread. */
  deepWork?: () => Promise<NonNullable<OrientResult['deepWork']> | null>;
}

export type OrientFleetSummariesFold = (
  homeFleetSlug: string,
  homeBrief: unknown | null | undefined,
) => Promise<OrientFleetSummary[] | null>;

export type OrientGoalPortfolioFold = () => Promise<import('../../../goal-launch-settings').GoalPortfolioBrief | null>;
export type OrientObligationsFold = () => Promise<
  import('../../../agent-obligation-reader').AgentObligationBrief | null
>;

/**
 * Overlay the effective membership onto the caller's own fleet-assignment row.
 *
 * `fleet:assignments` is a separate projection from the registry-backed
 * leadership check. During the projection lag that caused EI-20201050911711528,
 * the same orient could therefore say `fleetRole:'member'` in `me` while omitting
 * `leaderBrief` because the registry already knew the caller was the leader. Keep
 * this narrow: only the row belonging to `ownerId` is changed, and an absent or
 * malformed assignments payload is passed through unchanged.
 */
function overlaySelfFleetMembership(
  me: unknown,
  ownerId: string | undefined,
  membership: { fleetSlug: string | null; fleetRole: string | null } | null | undefined,
): unknown {
  if (!ownerId || !membership?.fleetSlug || !membership.fleetRole) return me;
  if (!me || typeof me !== 'object' || Array.isArray(me)) return me;
  const record = me as { agents?: unknown[] };
  if (!Array.isArray(record.agents)) return me;
  let changed = false;
  const agents = record.agents.map((agent) => {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return agent;
    const row = agent as Record<string, unknown>;
    const rowOwnerId = row.agentId ?? row.ownerId;
    if (rowOwnerId !== ownerId) return agent;
    if (row.fleetSlug === membership.fleetSlug && row.fleetRole === membership.fleetRole) return agent;
    changed = true;
    return { ...row, fleetSlug: membership.fleetSlug, fleetRole: membership.fleetRole };
  });
  return changed ? { ...record, agents } : me;
}

/**
 * Keep a failed fleet-assignment leg self-describing in the compound result.
 * `fleet:assignments` is allowed to return a partial `{ ok:false }` envelope,
 * and the bounded wrapper can also synthesize one after a timeout. Without this
 * annotation, callers see an empty `me.agents` array and cannot distinguish an
 * unanswered read from a genuinely empty assignment set.
 */
function annotateDegradedFleetAssignments(
  value: unknown,
  outcome: { degraded: boolean; reason?: 'timeout' | 'aborted' | 'error'; errorMessage?: string },
): unknown {
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  const record: Record<string, unknown> =
    isObject
      ? { ...(value as Record<string, unknown>) }
      : { ok: false, agents: [] as unknown[] };
  const returnedFailure = isObject && (record.ok === false || record.degraded === true);
  if (!outcome.degraded && !returnedFailure) return value;

  const degradedReason =
    (typeof record.degradedReason === 'string' && record.degradedReason) ||
    (typeof record.reason === 'string' && record.reason) ||
    outcome.errorMessage ||
    (outcome.reason === 'timeout'
      ? `fleet:assignments read exceeded ${ORIENT_FLEET_LEG_TIMEOUT_MS}ms`
      : 'fleet:assignments returned an unsuccessful response');

  return {
    ...record,
    ok: record.ok === false ? false : record.ok ?? false,
    degraded: true,
    degradedLeg: 'fleet:assignments',
    degradedReason,
    retryable: true,
  };
}

/** PURE (P-016): which role-specific folds a caller's dispatch role earns.
 *  `papercup` (the user-facing FAST dock pane) → the live-system pane digest;
 *  `papercup-deep` (the hidden deep brain) → its open question thread. FULL mode
 *  only — a monitor tick skips both (the EI-8300 cost discipline every heavy leg
 *  follows). Every other role: neither — these are pane-role standing context,
 *  not general orientation. Exported so the gate is directly unit-testable
 *  without driving the handler. */
export function orientRoleFolds(
  role: string | null | undefined,
  mode: 'full' | 'monitor' | undefined,
): { paneContext: boolean; deepWork: boolean } {
  if (mode === 'monitor') return { paneContext: false, deepWork: false };
  return { paneContext: role === 'papercup', deepWork: role === 'papercup-deep' };
}

/** P-016: the deepWork answer-before-parking advisory (exported for the tests +
 *  any renderer that wants to pin the exact copy). */
export const ORIENT_DEEP_WORK_NOTE =
  'open delegated questions awaiting YOUR reply — answer each on its own thread ' +
  "(coord:send { to: [<from>], related_msg_id: <msgId>, wake: 'required' }) before parking; never go silent.";

/**
 * EI-9130: did this orient's bespoke cursor-delta legs (fleetDelta / planEvents /
 * fleetCatchUp — none of which ride the formal `_meta.delta` protocol) actually SERVE a
 * narrowed/unchanged response? Pure + exported so it's directly unit-testable against a
 * composeOrient result without re-deriving the per-leg logic. The handler stamps
 * `ctx.metadata({ deltaServed: true })` when this is true (see dispatch-stack.ts's
 * recordTelemetry, which folds an explicit stamp like this ahead of its own derivation
 * from `_meta.delta.mode`) — the generic breadcrumb that makes a delta rollout's live win
 * directly queryable (`metadata_json->>'deltaServed'`) instead of only inferable.
 */
export function orientServedDelta(result: Pick<OrientResult, 'fleetDelta' | 'planEvents' | 'fleetCatchUp'>): boolean {
  return (
    result.fleetDelta?.baseline === false ||
    result.planEvents?.unchanged === true ||
    result.fleetCatchUp?.unchanged === true
  );
}

/**
 * Pure composition over an injected `call`, run SEQUENTIALLY. The first three reads are
 * the core orientation (always run); the memory/plan-events/declare folds are the
 * additive session-bootstrap, each gated by its input and BEST-EFFORT. `ownerId` scopes
 * assignments to the caller; when undefined (unresolved loopback identity) assignments
 * are fleet-wide.
 */
export async function composeOrient(
  args: OrientArgs,
  call: InnerCall,
  ownerId: string | undefined,
  /** The caller's drive mode (P-002). When 'responsive' (su/sentinel/planner),
   *  queen-loop steering is withheld from the folded facts + recall. Resolved by
   *  the handler (best-effort); injected here so the composition stays IO-free +
   *  unit-testable. Omitted / 'auto' ⇒ nothing withheld. */
  driveMode?: string,
  /** ownerPresent (P-004): resolved by the handler (a DB read over power_user_sessions) and
   *  INJECTED so composeOrient stays IO-free + unit-testable. Folded verbatim into the result
   *  when provided; undefined ⇒ the leg is absent (e.g. a test that doesn't exercise it). */
  ownerPresent?: OrientResult['ownerPresent'],
  /** fleet-deltas-leader-primitives P-004 (monitor mode) / P-005 (full mode):
   *  the (owner,'fleet:monitor') read-cursor ack — resolved by the handler (flag
   *  + identity + mode) and INJECTED so composeOrient stays IO-free. ONE surface
   *  regardless of which mode reads it (D-002: "server owns baseline+delta" — a
   *  single roster truth an agent alternating monitor/full calls shares).
   *  Undefined ⇒ no delta (full roster fold, pre-P-004 behavior). */
  fleetCursor?: (next: CursorState) => Promise<AckResult>,
  /** P-005: the (owner,'orient:planEvents') read-cursor ack for the plan-events
   *  fold — same injection contract as `fleetCursor`. Undefined ⇒ full delivery
   *  every call (pre-P-005 behavior). Applies in FULL mode only (monitor already
   *  skips this fold entirely). */
  planEventsCursor?: (next: CursorState) => Promise<AckResult>,
  /** P-005: the (owner,'orient:fleetCatchUp') read-cursor ack for the fleet
   *  catch-up fold — same contract. Undefined ⇒ full delivery every call. */
  fleetCatchUpCursor?: (next: CursorState) => Promise<AckResult>,
  /** fleet-reliability-verification-2026-07-10 P-007: the caller's authoritative
   *  presence-backed fleet membership (fleetSlug/fleetRole), falling back to launch
   *  environment only when the presence read fails. Resolved by the handler and
   *  INJECTED so composeOrient stays IO-free + unit-testable.
   *  Drives the leaderBrief fold below (monitor mode + fleetRole==='leader' only). */
  fleetMembership?: { fleetSlug: string | null; fleetRole: string | null } | null,
  /** P-016 (voice-public-release-readiness-2026-07-12): the role-specific fold
   *  closures — resolved by the handler (ctx.role through the PURE orientRoleFolds
   *  gate) and INJECTED so composeOrient stays IO-free + unit-testable. Absent ⇒
   *  neither fold (every non-pane role, and every monitor tick). */
  roleFolds?: OrientRoleFolds,
  /** WI-4533 (P-006): the release-pipeline health fold. The handler STARTS the read before calling
   *  composeOrient and passes a closure over the in-flight promise, so its latency overlaps the
   *  sequential legs below instead of adding to them. Injected (not called inline) so composeOrient
   *  stays IO-free + unit-testable — the same contract as ownerPresent / roleFolds. Undefined ⇒
   *  the leg is absent. */
  pipelineFold?: () => Promise<OrientPipeline | null>,
  /** EI-18731216945970087: cross-checks `harness_shared.agent_fleets.leader_owner_id`
   *  (the durable, single-leader-invariant registry fact) for a caller whose presence-
   *  derived `fleetMembership` resolved to NO fleet at all — the exact shape that used
   *  to silently drop `leaderBrief` on a monitor tick for a caller who genuinely IS a
   *  registered leader (presence/registry disagreement, not "not a leader"). Resolves
   *  to the led fleet's slug, or null when the registry agrees the caller leads
   *  nothing. Injected so composeOrient stays IO-free + unit-testable — the same
   *  contract as pipelineFold / roleFolds. Undefined ⇒ the check never runs. */
  presenceDriftCheck?: () => Promise<string | null>,
  /** EI-20201050911711528: cross-checks the registry when presence resolves a
   *  named fleet but labels this caller as a member. The registry's
   *  `agent_fleets.leader_owner_id` is authoritative for the single-leader role;
   *  resolving the current fleet slug (or null when the registry disagrees) keeps
   *  a stale presence projection from silently suppressing `leaderBrief`. Injected
   *  so composeOrient remains IO-free and unit-testable. */
  fleetLeadershipCheck?: () => Promise<string | null>,
  /** P-008 (b) (unified-agent-state-plane-2026-07-27): the cell-read identity the
   *  standing-facts fold re-checks declared dependencies under. Resolved by the
   *  handler via `cellReaderFromCtx(identity, ctx)` and INJECTED — same contract
   *  as roleFolds / pipelineFold, and for a sharper reason than testability:
   *  BOTH halves are access-control inputs (P-019 audience + the resolver's role
   *  gate, D-058), and composeOrient has no ctx, so a value derived in here would
   *  have to be GUESSED. A guessed role either fails closed (useless) or fails
   *  open (a leak). Undefined ⇒ the dependency re-check simply does not run and
   *  facts fold exactly as they did before. */
  cellIdentity?: { reader: CellReader; env: CellReadEnv },
  /** consult-revival-and-honest-min-2026-08-18 P-006: the peers-know archive lookup —
   *  "a CLOSED consult already settled a question like this intent". Resolved by the
   *  handler (ctx workspace + the router's query embedder + PG, all heavy seams) and
   *  INJECTED so composeOrient stays IO-free + unit-testable — the same contract as
   *  pipelineFold / roleFolds. Undefined ⇒ the leg is absent. */
  peersKnowFold?: (intent: string) => Promise<{
    answer: string;
    ref: string;
    responder: string | null;
    closedAt: string | null;
    sim: number;
  } | null>,
  /** EI-203907: handler-owned, memoized all-led-fleet summary read. */
  fleetSummariesFold?: OrientFleetSummariesFold,
  /** EI-21239843876346650: post-compaction control-anchor fleet route. The handler
   *  starts recovery before composeOrient and injects this promise so the first
   *  assignments read cannot use a stale self-only scope. */
  recoveredFleetScopeFold?: () => Promise<RecoveredFleetScope | null>,
  /** EI-21589715378243224: report useful snapshots to the handler-owned aggregate
   *  timeout fallback. The callback is best-effort and never load-bearing. */
  progress?: (snapshot: OrientResult) => void,
  /** P-012: the GOAL-holder portfolio read. The handler resolves the caller's
   *  mode subject, starts the canonical DB projection before composition, and
   *  injects this closure over that in-flight promise. Undefined means the
   *  caller is not a resolved GOAL holder. */
  goalPortfolioFold?: OrientGoalPortfolioFold,
  /** P-007: complete obligation-agenda recovery for a GOAL holder. The handler
   *  starts the canonical reader beside the portfolio read and injects this
   *  closure so composition remains IO-free and the two waits overlap. */
  obligationsFold?: OrientObligationsFold,
): Promise<OrientResult> {
  const monitor = args.mode === 'monitor';
  const reportProgress = (snapshot: OrientResult): void => {
    try {
      progress?.(snapshot);
    } catch {
      /* best-effort: a fallback observer must never break orientation */
    }
  };
  // EI-18748795522559631: memory recall is independent of the roster, backlog,
  // inbox, and leader folds below, but it used to START only after all of them.
  // Launch it now and consume it at the existing admission point so its
  // embed/lexical latency overlaps that useful bootstrap work. The promise is
  // settled here (rather than left rejectable until a much later await) so an
  // early backend failure cannot become an unhandled rejection; the existing
  // fold still renders that failure as `memory: null`.
  const memQuery = monitor ? undefined : (args.memoryQuery ?? args.intent);
  const memLimit = Math.min(args.memoryLimit ?? 5, MEMORY_HITS_CAP);
  const inFlightMemory =
    memQuery && memLimit > 0
      ? (async () => {
          try {
            return {
              ok: true as const,
              value: await call('memory:search', {
                query: memQuery,
                ...(args.harness ? { harness_slug: args.harness } : {}),
                limit: memLimit,
                ...(args.memoryIncludeSuperseded ? { include_superseded: true } : {}),
              }),
            };
          } catch (error) {
            return { ok: false as const, error };
          }
        })()
      : null;
  // EI-18731216945970087: exercised when presence itself found no fleet at all.
  // P-007 extends this registry-authority check to ordinary orient: registered
  // leaders receive the bounded leader summary on every path, even when the soft
  // presence projection has not settled yet. EI-20201050911711528
  // adds the same registry authority check for a named fleet whose role projection
  // is stale. A caught drift is treated as authoritative 'leader' for the REST of
  // this call (the leaderBrief gate + the fleet-scoped legs below), and reported
  // LOUDLY via `result.presenceDrift` rather than silently fixed.
  let effectiveFleetMembership = fleetMembership;
  let presenceDrift: OrientResult['presenceDrift'];
  if (!fleetMembership?.fleetSlug && presenceDriftCheck) {
    try {
      const ledFleet = await presenceDriftCheck();
      if (ledFleet) {
        effectiveFleetMembership = { fleetSlug: ledFleet, fleetRole: 'leader' };
        presenceDrift = {
          fleet: ledFleet,
          note:
            `PRESENCE DRIFT: the registry (agent_fleets.leader_owner_id) says you LEAD fleet ` +
            `'${ledFleet}', but your presence row (coord_presence.fleet_slug/fleet_role) showed no ` +
            `fleet at all — the exact shape that used to silently drop \`leaderBrief\` and read as ` +
            `"my whole fleet is gone". Recovered from the registry for THIS call; leaderBrief below ` +
            `is real. If this repeats, your presence row is not settling after fleet:take-leadership ` +
            `— do not relaunch live members on the strength of a bare orient read alone; corroborate ` +
            `with fleet:assignments { fleet } / fleet:status first.`,
        };
      }
    } catch {
      /* best-effort — never break orientation over a drift cross-check */
    }
  }
  if (fleetMembership?.fleetSlug && fleetMembership.fleetRole !== 'leader' && fleetLeadershipCheck) {
    try {
      const ledFleet = await fleetLeadershipCheck();
      if (ledFleet === fleetMembership.fleetSlug) {
        effectiveFleetMembership = { fleetSlug: ledFleet, fleetRole: 'leader' };
        presenceDrift = {
          fleet: ledFleet,
          note:
            `PRESENCE DRIFT: the registry (agent_fleets.leader_owner_id) says you LEAD fleet ` +
            `'${ledFleet}', but your presence/assignment projection reported fleetRole ` +
            `'${fleetMembership.fleetRole ?? 'null'}'. Recovered the registry role for THIS call; ` +
            `leaderBrief below is real. If this repeats, the membership projection is stale after ` +
            `fleet:take-leadership — corroborate with fleet:assignments { fleet } / fleet:status ` +
            `before treating the self-scoped role as authoritative.`,
        };
      }
    } catch {
      /* best-effort — never break orientation over a drift cross-check */
    }
  }
  // EI-21239843876346650: a post-compaction successor can recover a durable fleet
  // route after the live presence projection was resolved. That route is authoritative
  // for THIS call's roster scope: the old self-only read made a live peer look absent
  // and enabled a destructive false reclaim. Keep this await before the first
  // fleet:assignments call, and disclose the widened scope in the core result.
  let recoveredFleetMembership: RecoveredFleetScope | null = null;
  let recoveredFleetScope: OrientResult['recoveredFleetScope'];
  if (args.afterCompaction === true && recoveredFleetScopeFold) {
    try {
      const recovered = await recoveredFleetScopeFold();
      if (recovered) {
        recoveredFleetMembership = recovered;
        effectiveFleetMembership = recovered;
        recoveredFleetScope = {
          fleet: recovered.fleetSlug,
          role: recovered.fleetRole,
          note:
            `RECOVERED FLEET SCOPE: the post-compaction control anchor named fleet ` +
            `'${recovered.fleetSlug}' (role '${recovered.fleetRole ?? 'unknown'}'). ` +
            `Used fleet-scoped assignments for THIS call because the presence-derived ` +
            `self scope may be stale; corroborate with fleet:assignments { fleet } / ` +
            `fleet:status before acting on peer liveness.`,
        };
      }
    } catch {
      /* best-effort — preserve the presence-derived scope on recovery failure */
    }
  }
  // WI-3818: unconditional in BOTH modes (monitor's one fleet-related read) — a
  // hang here used to block the whole orient call. Degrades to a minimal
  // empty-roster shape (never throws) so downstream folds — already
  // try/catch-guarded (fingerprintFleet, slimAssignmentsForDelta) — see an
  // empty-but-well-shaped roster instead of hanging past the deadline.
  // Assignments and the backlog/inbox reads below have no data dependency.
  // Start the bounded read after fleet-scope recovery, but join it only at
  // result assembly so their latencies overlap. Publish its early snapshot
  // on settlement even if the backlog chain is still waiting.
  const mePromise = withBoundedTimeout(
    call('fleet:assignments', {
      ...(recoveredFleetMembership ? { fleet: recoveredFleetMembership.fleetSlug } : ownerId ? { agent: ownerId } : {}),
      ...(args.harness ? { harness: args.harness } : {}),
    }),
    {
      fallback: { ok: false, degraded: true, agents: [] } as unknown,
      timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS,
      label: 'orient:fleet:assignments',
    },
  ).then((meResult) => {
    const me = annotateDegradedFleetAssignments(
      overlaySelfFleetMembership(meResult.value, ownerId, effectiveFleetMembership),
      meResult,
    );
    // EI-21589715378243224: retain useful reconciliation in the aggregate
    // fallback even when a slower backlog/inbox/fold exhausts its budget.
    reportProgress({
      ok: true,
      me,
      claimable: [],
      inbox: {},
      host: getHostSnapshot(),
    });
    return me;
  });
  // EI-19452326548245557: this fold must BE the claim oracle, not a cheaper
  // lookalike. It used to be `work_items:list({ admissibleOnly: true })` — which by
  // that flag's OWN contract is "a cheap STRUCTURAL pre-filter ... NOT the full
  // claim-floor verdict". (That flag has since grown the rest of the ROW-INTRINSIC
  // floors — WI-4405/WI-37761/WI-37774 — so the "remote-origin + observation-lane only"
  // reading this comment was written against no longer holds; the CONCLUSION below is
  // unaffected, because it still cannot apply the context floors: blocked-dep, cooldown,
  // rig, swarm-affinity, redundancy.) So the ~12
  // floors `work_items:claim` / `claim_next` / `scheduler:get_next` really enforce
  // were never applied here and this list advertised work the real claim path
  // refuses. Measured 2026-08-04 on `papercusp`: 16 of the 20 rows it returned were
  // `[replication-liveness]` EIs held out by the `federationDetector` floor (113
  // rows) — p2p conditions harness/improvements/policy.ts states a generic worker
  // structurally CANNOT resolve (WI-2633/EI-8455). needsHuman (201), crossMachineRig
  // (18), planLaneReserved (16), loopNoise (14), externalBlocker and blockedDep were
  // invisible here too. That is precisely the failure the EI-7841 note below was
  // written to fix, recurring through a different floor.
  //
  // FILTERING the old list through the oracle would be UNSOUND: the oracle returns a
  // spec-ordered WINDOW (claimableCount was 1677 here), so a row that is genuinely
  // claimable but ranks outside that window would be dropped as "not claimable" —
  // trading false-positives for false-negatives. The issue-family lane is therefore
  // SOURCED from the oracle, which also inherits get_next's spec ordering.
  //
  // `work_items:claimable` is issue-family (bug/change/task) ONLY and REQUIRES a
  // harness, so the feature-family lane keeps the list path (its G2 admission gate is
  // what `admissibleOnly` was added for — EI-7841), and a caller with no `harness`
  // keeps the old behaviour wholesale. Both legs are best-effort: an oracle failure
  // degrades to the previous list rather than emptying an agent's backlog.
  const claimableLimit = args.claimableLimit ?? 20;
  // work-item-status-full-unify P-007: the unified claimable token is 'open' (feature
  // `todo`→`open`; issue claimable was already `open`). work_items:list filters
  // `status = <state>` EXACTLY (no alias-expand), so defaulting to the legacy 'todo'
  // matched ~nothing post-backfill — every agent's orient claimable backlog read empty.
  const claimableStateArg = args.claimableState ?? 'open';
  const unwrapRows = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    const o = v as { claimable?: unknown[]; data?: unknown[]; items?: unknown[] } | null;
    return o?.claimable ?? o?.data ?? o?.items ?? [];
  };
  const listLane = (extra: Record<string, unknown>) =>
    call('work_items:list', {
      ...(args.harness ? { harness: args.harness } : {}),
      state: claimableStateArg,
      limit: claimableLimit,
      admissibleOnly: true,
      ...extra,
    });
  /** EI-21127719036550806: bound a core orient leg to ORIENT_CORE_LEG_TIMEOUT_MS,
   *  degrading to `fallback` on EITHER a hang or a rejection — one call site for the
   *  same fail-open contract every other WI-3818 leg already gets. */
  const boundedCore = <T>(work: Promise<T>, fallback: T, label: string): Promise<T> =>
    withBoundedTimeout(work, { fallback, timeoutMs: ORIENT_CORE_LEG_TIMEOUT_MS, label }).then((r) => r.value);
  let list: unknown;
  /** EI-20113865649946366 — the AUTHORITATIVE issue-family claimable population, taken
   *  from the oracle's own `claimableCount` (work_items/claimable.ts: "rows passing
   *  spec_match AND every claim floor"). It is NOT `list.length`: that is bounded by
   *  `claimableLimit` above, and reporting it as a total is how a limit-bounded 20 gets
   *  read as "there are 20" when the oracle's count has been ~1677 on this harness.
   *  The oracle already returns this in the SAME response we fetch the rows from, so
   *  keeping it costs no extra round-trip — `unwrapRows` was simply discarding it.
   *  Stays `undefined` on the legs where no oracle answered (no-harness, oracle
   *  failure), which is why the disclosure below degrades to a boundedness marker
   *  rather than inventing a total it cannot know. */
  let claimableOracleTotal: number | undefined;
  let claimableHarnessScope: ClaimableHarnessScope | undefined;
  if (monitor) {
    // EI-8300: a monitor tick doesn't self-select work — skip the claimable read
    // entirely (no round-trip), not just cap its output.
    list = [];
  } else if (claimableLimit === 0) {
    // EI-20224338630649725: zero is an explicit "do not enumerate backlog" request
    // used by recovery/bootstrap callers. The underlying claimable/list tools require
    // a positive limit, so skip both legs rather than forwarding an invalid zero and
    // turning a deliberately lean orient into an argument error.
    list = [];
  } else if (!args.harness) {
    list = await boundedCore(listLane({}), [], 'orient:claimable:list');
  } else {
    const [issueRes, featureRows] = await Promise.all([
      boundedCore(
        call('work_items:claimable', {
          harness: args.harness,
          limit: claimableLimit,
          // Only override the oracle's state floor when the caller asked for one —
          // otherwise the resolved claim-spec's own states win, as get_next uses them.
          ...(args.claimableState ? { states: [args.claimableState] } : {}),
        }),
        null,
        'orient:claimable:issues',
      ),
      boundedCore(listLane({ kind: 'feature' }).then(unwrapRows), null, 'orient:claimable:features'),
    ]);
    // Unwrap AFTER capturing the count — the count lives on the envelope `unwrapRows`
    // throws away. `null` (the caught failure) must stay distinguishable from `[]`
    // (an oracle that answered with no rows), so it is not routed through unwrapRows.
    const issueRows = issueRes === null ? null : unwrapRows(issueRes);
    const issueScope = (issueRes as { claimableHarnessScope?: unknown } | null)?.claimableHarnessScope;
    if (
      issueScope &&
      typeof issueScope === 'object' &&
      !Array.isArray(issueScope) &&
      typeof (issueScope as Record<string, unknown>).requested === 'string' &&
      typeof (issueScope as Record<string, unknown>).resolved === 'string' &&
      ((issueScope as Record<string, unknown>).resolution === 'requested' ||
        (issueScope as Record<string, unknown>).resolution === 'hive-home')
    ) {
      claimableHarnessScope = issueScope as ClaimableHarnessScope;
    }
    const oracleCount = (issueRes as { claimableCount?: unknown } | null)?.claimableCount;
    if (typeof oracleCount === 'number' && Number.isFinite(oracleCount)) {
      claimableOracleTotal = oracleCount;
    }
    if (issueRows === null) {
      // Oracle unavailable ⇒ previous behaviour, never an empty backlog.
      list = await boundedCore(listLane({}), [], 'orient:claimable:list-fallback');
    } else {
      // Reserve room for the feature lane first: features are few and would
      // otherwise be truncated away by a full issue window.
      const feat = featureRows ?? [];
      list = [...issueRows.slice(0, Math.max(0, claimableLimit - feat.length)), ...feat];
    }
  }
  // afterCompaction (fold #2, compaction-fold-audit-2026-07-06): a just-compacted
  // agent lost its message context and 79% immediately re-read coord:inbox, so fold
  // MORE entries + fuller bodies (the shaper relaxes its inbox re-cap when a recovery
  // block is present). Ambient broadcasts stay excluded by coord:inbox's default —
  // the directed-message bias the audit asked for is already the default.
  //
  // fleet-leader-frictions P-004: a MONITOR tick re-paid the full recent-inbox fold
  // every wake — mostly entries the [coord+N] channel already showed. Scope a monitor
  // read to SINCE-LAST-SHOWN via the caller's `messages_shown_ts` watermark (the
  // read-receipt cursor both the injection channel AND this very read advance), so a
  // 60s loop folds only the genuinely-new delta. NOT under afterCompaction — a
  // just-compacted agent lost its context, so "already shown" no longer means
  // "already known"; it keeps the fuller unscoped re-read. BEST-EFFORT + fail-open:
  // an absent/failed watermark ⇒ the unfiltered read, never a broken orient.
  // D-013 R1: `coord:inbox` is a VIEW, not a delta — orient's inbox leg is an
  // agent-facing fold, so it takes the recent-N view bounded by `limit` (the
  // WI-6939 `enough` window makes that bound the cheap one) rather than a
  // caller-carried floor. This also drops the `coord:watermark` round-trip that
  // existed only to derive that floor: monitor mode previously narrowed to
  // "newer than read_through_ts", which could HIDE mail the agent had been shown
  // but not acted on. `unanswered` remains the actionable signal, and it is
  // computed independently of this window.
  const inboxLimit = args.inboxLimit ?? (args.includeInbox === false ? 0 : args.afterCompaction ? 25 : 10);
  // EI-20287600163306401: callers that already consumed the inbox can pass zero
  // to suppress this duplicate fold. The nested coord:inbox tool requires a
  // positive limit, so do not forward an explicit zero as an invalid call.
  const inbox =
    inboxLimit === 0
      ? undefined
      : ((await boundedCore(
          call('coord:inbox', {
            limit: inboxLimit,
            max_body_chars: args.afterCompaction ? 800 : 300,
          }),
          undefined,
          'orient:coord:inbox',
        )) as { summary?: unknown; entries?: unknown } | undefined);

  // work_items:list returns the bare array (its `result` schema), but be defensive
  // about the wrapped shapes the unwrap may yield.
  const claimableRaw = Array.isArray(list)
    ? list
    : ((list as { data?: unknown[]; items?: unknown[] } | null)?.data ??
      (list as { data?: unknown[]; items?: unknown[] } | null)?.items ??
      []);

  // WI-5343: work_items:list({admissibleOnly:true}) above only applies the G2/
  // origin structural gates — it does NOT consult a durable claim-hold (WI-2797),
  // an assignee already on the row, or a linked plan-item's effective/live-claim
  // status, so a row that would bounce with not_claimable / claim_hold_blocked /
  // a silent plan-lane retry on a REAL claim attempt still surfaced here as bare
  // "claimable" — the exact double-placement trap on a heavily-parallel fleet
  // (evidence: WI-321 under a claim-hold, WI-4998 carrying an assignee, WI-5137's
  // linked plan item live-claimed by a different session, WI-3509/WI-3506
  // effectively blocked via their plan item — all four surfaced with zero gating
  // annotation). Batch-observe the fetched rows through the SAME floors
  // work_items:observe already applies (claim-hold / G2-origin / plan-item
  // effectiveStatus+live-claim — work-items.ts's observeWorkItem) and drop
  // anything that isn't really available. Best-effort: an observe failure (or a
  // row missing/renamed by the time it's checked) degrades to keeping that row
  // rather than breaking orientation — this list was always advisory (see the
  // `claimable` doc comment), never a live guarantee.
  let claimable = claimableRaw;
  if (!monitor && claimableRaw.length > 0) {
    try {
      const ids = claimableRaw
        .map((row) => (row as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) {
        const obs = (await boundedCore(
          call('work_items:observe', {
            ids,
            ...((claimableHarnessScope?.resolved ?? args.harness)
              ? { harness: claimableHarnessScope?.resolved ?? args.harness }
              : {}),
          }),
          undefined,
          'orient:claimable:observe',
        )) as { results?: Array<{ id: string; ok?: boolean; available?: boolean }> } | undefined;
        const gatedIds = new Set(
          (obs?.results ?? []).filter((r) => r && r.ok !== false && r.available === false).map((r) => r.id),
        );
        if (gatedIds.size > 0) {
          claimable = claimableRaw.filter((row) => !gatedIds.has((row as { id?: unknown } | null)?.id as string));
        }
      }
    } catch {
      /* fail-open: keep the unfiltered list rather than break orientation */
    }
  }

  /** EI-20113865649946366 (owner criterion, 2026-08-10: a trim must announce itself
   *  AND name the fetch path — a DISCLOSED trim is fine, a SILENT one is the bug).
   *
   *  Two different trims narrow this list and only one of them can know the real
   *  population, so this deliberately emits two different shapes rather than one
   *  uniform-looking number:
   *    · oracle leg  → `total` is authoritative (the oracle counted the whole lane).
   *    · fallback legs → only `truncatedByLimit`. Asking for N and getting N back is
   *      evidence that MORE exist; it is not a count of them. Publishing `shown` as a
   *      total there would be the very defect this fixes, one layer down.
   *
   *  `total` is issue-family scoped because that is what the oracle counts — saying so
   *  costs one field and stops the number being read as "everything claimable". */
  let claimableTruncated: OrientClaimableTruncated | undefined;
  if (!monitor) {
    const shown = claimable.length;
    // The FETCH was bounded (pre-observe count), which is the honest signal for
    // "there may be more" — `claimable` itself is post-filter and reads short.
    const fetchHitLimit = claimableLimit > 0 && claimableRaw.length >= claimableLimit;
    if (typeof claimableOracleTotal === 'number' && claimableOracleTotal > shown) {
      claimableTruncated = {
        shown,
        total: claimableOracleTotal,
        totalScope: 'issue-family (bug/change/task) — the feature lane is fetched separately and not counted here',
        limit: claimableLimit,
        more: 'work_items:claimable { harness } for the authoritative count + per-floor breakdown; scheduler:get_next or work_items:list for more rows',
      };
    } else if (claimableOracleTotal === undefined && fetchHitLimit) {
      claimableTruncated = {
        shown,
        truncatedByLimit: true,
        limit: claimableLimit,
        more: 'work_items:claimable { harness } for the authoritative count; work_items:list for more rows',
      };
    }
  }

  let me = await mePromise;
  const result: OrientResult = {
    ok: true,
    me,
    claimable,
    ...(claimableHarnessScope ? { claimableHarnessScope } : {}),
    ...(claimableTruncated ? { claimableTruncated } : {}),
    // EI-18667514339699744: alias `entries` alongside `recent` — coord:inbox's own
    // key name — so a caller who reads either name off this fold gets real rows
    // instead of a silent empty array on a mismatched accessor.
    inbox: { summary: inbox?.summary, recent: inbox?.entries, entries: inbox?.entries },
    // P-026/P-027: the shell-out-avoidance scalars. Unconditional and in-process
    // (no await, no round-trip) — the whole point is that the answer has already
    // arrived by the time an agent would have thought to run `date` or `uptime`.
    host: getHostSnapshot(),
    // P-004: fold the mechanical owner-present bit when the handler resolved it (undefined ⇒
    // leg absent; the handler passes null on a read failure).
    ...(ownerPresent !== undefined ? { ownerPresent } : {}),
    // EI-18731216945970087: loud, never silent — see the presenceDriftCheck doc above.
    ...(presenceDrift !== undefined ? { presenceDrift } : {}),
    ...(recoveredFleetScope !== undefined ? { recoveredFleetScope } : {}),
  };
  // P-012: this is a CORE orientation leg for a resolved GOAL holder, not an
  // optional advisory. The handler already started the IO before composeOrient;
  // awaiting the injected promise here keeps this function IO-free and lets the
  // portfolio overlap the core assignments/backlog/inbox reads above. A failure
  // is explicit null rather than a silent absence that reads as "not a holder".
  if (goalPortfolioFold) {
    const portfolio = await withBoundedTimeout(goalPortfolioFold(), {
      fallback: null,
      timeoutMs: ORIENT_CORE_LEG_TIMEOUT_MS,
      label: 'orient:goalPortfolio',
    });
    result.goalPortfolio = portfolio.value;
  }
  if (obligationsFold) {
    const obligations = await withBoundedTimeout(obligationsFold(), {
      fallback: null,
      timeoutMs: ORIENT_CORE_LEG_TIMEOUT_MS,
      label: 'orient:obligations',
    });
    result.obligations = obligations.value;
  }
  // EI-21589715378243224: preserve the core assignment/backlog/inbox snapshot
  // before the optional folds below can consume the aggregate budget.
  reportProgress(result);

  // ── leaderBrief fold (fleet-reliability-verification-2026-07-10 P-007): a MONITOR
  // tick belonging to a resolvable FLEET LEADER also gets the whole fleet's per-member
  // health brief in this SAME round-trip — the lever that collapses "monitor orient +
  // a separate fleet:assignments scan" into one call. Gated the OPPOSITE way from the
  // full-mode fleet legs below (monitor-only); BEST-EFFORT, absent for a non-leader /
  // non-fleet caller or any failure. Reads `effectiveFleetMembership` (not the raw
  // presence-only `fleetMembership`) so a caught presence/registry drift (above) still
  // gets its leaderBrief instead of silently dropping it a second time.
  //
  // EI-19282566865609166: ALSO fold it on an `afterCompaction` RECOVERY orient, even in
  // full mode. That is the one moment a leader has the least context and is most likely
  // to misread the self-scoped `me` block — whose summary carries FLEET-SHAPED field
  // names (agents / orphaned_claims / coverage_collisions) and `agentsElided: 0` — as the
  // whole fleet. Measured live 2026-08-01: a leader of an ELEVEN-member fleet ran
  // `coord:orient { afterCompaction: true }`, read `agents: 1`, and opened its turn
  // reporting the fleet as dead; `fleet:leader-brief` seconds later showed 11 members,
  // 0 dead, with 5 idle-with-claimable and 2 unanswered directed messages — none of which
  // the full-mode payload surfaced. That is the SAME "my whole fleet is gone" misreading
  // the presence-drift recovery above already defends against, arriving through the one
  // door that defence does not cover. A recovery orient happens once per compaction, so
  // the extra fold is negligible against the cost the monitor-only gate is protecting.
  if (effectiveFleetMembership?.fleetRole === 'leader' && effectiveFleetMembership.fleetSlug) {
    const fleetSlug = effectiveFleetMembership.fleetSlug;
    const leaderBriefFold = await withBoundedTimeout(
      (async () => {
        try {
          const brief = await call('fleet:leader-brief', {
            fleet: fleetSlug,
            ...(args.harness ? { harness: args.harness } : {}),
          });
      // P-015: hydrate the EXISTING leader brief instead of introducing a parallel
      // monitor surface. These are authoritative reads a leader otherwise re-calls
      // immediately after orient; each remains independently fail-soft.
      const hydrated: Record<string, unknown> =
        brief && typeof brief === 'object' && !Array.isArray(brief)
          ? { ...(brief as Record<string, unknown>) }
          : { fleetHealth: brief };
      let claimSpec: unknown = null;
      try {
        claimSpec = await call('scheduler:get_claim_spec', {
          fleet: effectiveFleetMembership.fleetSlug,
        });
        hydrated.claimSpec = claimSpec;
      } catch {
        hydrated.claimSpec = null;
      }
      // Fixed-wave scope is already encoded in the fleet claim spec. Reuse that
      // literal cohort to drive work_items:burn_down's exact-ID audit; never ask a
      // leader to maintain a second list or infer scope from current assignments.
      const specRecord =
        claimSpec && typeof claimSpec === 'object' ? (claimSpec as { spec?: unknown; harnessSlug?: unknown }) : null;
      const cohortIds = fixedCohortIds(
        specRecord?.spec && typeof specRecord.spec === 'object'
          ? (specRecord.spec as { view?: { filter?: unknown } })
          : null,
      );
      const cohortHarness =
        args.harness ?? (typeof specRecord?.harnessSlug === 'string' ? specRecord.harnessSlug : undefined);
      if (cohortIds && cohortHarness) {
        try {
          const scoped = await call('work_items:burn_down', {
            harness: cohortHarness,
            ids: cohortIds.slice(0, 200),
          });
          hydrated.scopedBurndown = scoped;
          const allowed = new Set(cohortIds);
          const members = Array.isArray(hydrated.members) ? (hydrated.members as Array<Record<string, unknown>>) : [];
          hydrated.outOfScopeAssignments = members.flatMap((member) => {
            const ids = Array.isArray(member.workItemIds)
              ? member.workItemIds.filter((id): id is string => typeof id === 'string')
              : [];
            return ids.filter((id) => !allowed.has(id)).map((id) => ({ agentId: member.agentId ?? null, id }));
          });
          const auditRows =
            scoped &&
            typeof scoped === 'object' &&
            Array.isArray((scoped as { cohortAudit?: { rows?: unknown[] } }).cohortAudit?.rows)
              ? (scoped as { cohortAudit: { rows: Array<Record<string, unknown>> } }).cohortAudit.rows
              : [];
          hydrated.integrityWarnings = auditRows
            .filter((row) => row.reopenRecommended === true || row.bucket === 'missing')
            .map((row) => ({
              id: row.id,
              title: row.title ?? null,
              state: row.state ?? null,
              evidenceVerdict: row.evidenceVerdict ?? null,
              reopenRecommended: row.reopenRecommended === true,
              recommendation: row.recommendation ?? null,
            }));
        } catch {
          hydrated.scopedBurndown = null;
        }
      } else {
        hydrated.scopedBurndown = {
          available: false,
          reason: cohortIds ? 'claim-spec-harness-unresolved' : 'claim-spec-not-a-fixed-id-cohort',
        };
      }
      try {
        hydrated.walls = await call('coord:walls', {
          ...(args.harness ? { harness: args.harness } : {}),
        });
      } catch {
          hydrated.walls = null;
      }
          return hydrated;
        } catch {
          return {
            orientProjection: {
              schemaVersion: ORIENT_LEADER_BRIEF_SCHEMA_VERSION,
              status: 'unavailable',
              reason: 'fleet:leader-brief read failed',
              recoverVia: `fleet:leader-brief { fleet: '${fleetSlug}' }`,
            },
          };
        }
      })(),
      { fallback: null, timeoutMs: ORIENT_CORE_LEG_TIMEOUT_MS, label: 'orient:fleet:leader-brief' },
    );
    result.leaderBrief =
      leaderBriefFold.value ?? {
        orientProjection: {
          schemaVersion: ORIENT_LEADER_BRIEF_SCHEMA_VERSION,
          status: 'unavailable',
          reason: 'fleet:leader-brief fold timed out',
          recoverVia: `fleet:leader-brief { fleet: '${fleetSlug}' }`,
        },
      };
    // Preserve the safety-critical leader projection in the aggregate fallback
    // before later advisory folds can consume the outer deadline.
    reportProgress(result);
  }

  if (
    (monitor || args.afterCompaction === true) &&
    effectiveFleetMembership?.fleetRole === 'leader' &&
    effectiveFleetMembership.fleetSlug &&
    fleetSummariesFold
  ) {
    try {
      result.fleetSummaries = await fleetSummariesFold(effectiveFleetMembership.fleetSlug, result.leaderBrief);
    } catch {
      result.fleetSummaries = null;
    }
  }

  // ── memory:search recall — only when a query is available (a query-less recall is
  // meaningless). BEST-EFFORT: memory p95 is multi-second and can time out; that must
  // not break orientation. EI-8300: a monitor tick skips the recall ENTIRELY, even
  // when `intent`/`memoryQuery` is set — declare-intent (below) still fires, so peers
  // still see the caller's status.
  if (inFlightMemory && memQuery) {
    try {
      const settledMemory = await inFlightMemory;
      if (!settledMemory.ok) throw settledMemory.error;
      const mem = settledMemory.value as
        | {
            results?: Array<OrientMemoryHit & { metadata?: unknown }>;
            degraded?: boolean;
            reason?: string;
            degraded_reason?: string;
            score_scale?: unknown;
          }
        | undefined;
      // EI-20113865649946366: a body cut at MEMORY_TEXT_CAP (200) used to end
      // mid-sentence with NOTHING saying so, so a clipped fact read as the whole fact.
      // `ORIENT_MEMORY_NOTE` does not cover this: it says the RECALL is non-exhaustive
      // (there may be other facts), which is a different claim from "the text of THIS
      // fact is cut". memory/injection.ts already stamps this same disclosure on the
      // same underlying bodies — this brings orient's fold in line with it.
      // Per-hit stays minimal (a flag + the real length); the fetch verb rides once on
      // the fold below rather than being repeated on every hit.
      const rawHits = (mem?.results ?? []).slice(0, memLimit).map((r) => {
        const full = typeof r.memory === 'string' ? annotateSupersededMemory(r.memory, r.metadata) : undefined;
        const clipped = full !== undefined && full.length > MEMORY_TEXT_CAP;
        return {
          id: r.id,
          memory: clipped ? full.slice(0, MEMORY_TEXT_CAP) : full,
          score: r.score,
          ...(clipped ? { truncated: true as const, fullChars: full.length } : {}),
        };
      });
      // EI-9031 markers first — the floor below is REGIME-SCOPED on them.
      const memDegraded = mem?.degraded === true;
      const memDegradedReason = mem?.degraded_reason ?? mem?.reason;
      const memScoreScale = normalizeScoreScale(mem?.score_scale);
      // EI-10666: the consumer-admission gates (relevance floor → queen-loop withhold →
      // aggregate char budget) live in ONE shared module, because the memory recall canary
      // must probe THE PATH A CONSUMER ACTUALLY TAKES. A canary that re-implemented these
      // gates would drift from them and go green while orient's fold went dark — the exact
      // failure it exists to catch. See lib/memory/recall-admission.ts.
      // P-002 / D-001: a responsive caller doesn't receive queen-loop steering as a binding
      // recall hit (it self-drained fleet leaders). Auto callers keep all.
      const { admitted, filteredLowScore, withheld, withheldBudget, decisions } = admitRecallHits(rawHits, {
        degraded: memDegraded,
        scoreScale: memScoreScale,
        withhold: (hs) => withholdQueenLoopControl(hs, driveMode, (h) => ({ body: h.memory })),
      });
      // EI-10619 — SHIP THE DECISIONS. `tool_invocations` records that orient returned ok; it
      // cannot see that the relevance floor discarded every hit on the way. That blind spot IS
      // EI-10372, and it is why a gate's decision has to be an event of its own. Fire-and-forget,
      // dynamic import, never load-bearing: a telemetry outage must never fail an orientation.
      if (decisions.length > 0) {
        void (async () => {
          try {
            const [{ getOrgPg }, { recordGateDecisions }] = await Promise.all([
              import('@papercusp/db-org'),
              import('../../../gates/decision'),
            ]);
            await recordGateDecisions(getOrgPg().sql, decisions);
          } catch {
            /* never load-bearing */
          }
        })();
      }
      // Counted over ADMITTED hits, not raw: a clipped hit the budget then dropped is
      // already reported by `withheldBudget`, and counting it here too would overstate
      // what the caller is actually holding.
      const clippedHits = admitted.reduce((n, h) => n + (h.truncated === true ? 1 : 0), 0);
      result.memory = {
        query: memQuery,
        hits: admitted,
        ...(withheld > 0 ? { withheld } : {}),
        ...(filteredLowScore > 0 ? { filteredLowScore } : {}),
        ...(withheldBudget > 0 ? { withheldBudget } : {}),
        ...(clippedHits > 0
          ? {
              bodiesTruncated: {
                hits: clippedHits,
                cap: MEMORY_TEXT_CAP,
                more: 'memory:search { query } — the hits carry the full body; each clipped hit here marks `truncated` + `fullChars`',
              },
            }
          : {}),
        // P-003: the non-exhaustive advisory rides ONLY a non-empty fold (zero
        // noise on the empty path).
        ...(admitted.length > 0 ? { note: ORIENT_MEMORY_NOTE } : {}),
        ...(memDegraded ? { degraded: true, ...(memDegradedReason ? { degradedReason: memDegradedReason } : {}) } : {}),
        ...(memScoreScale !== undefined ? { scoreScale: memScoreScale } : {}),
      };
      // P-002 (memory-delivery-unification-2026-07-12 D-006): stamp the
      // orient-DELIVERED hits on the session-epoch surfaced-ledger, keyed by
      // the caller's ownerId (the same per-launch SID the MCP initialize
      // prelude and the injection ports key on) — so orient-then-hook/port
      // never double-injects the same memory within an epoch. Fire-and-forget,
      // dynamic imports: never load-bearing for orientation. Only ADMITTED ids
      // stamp (orient-recall-quality P-002): a budget-dropped hit was never
      // delivered, so it must stay eligible at the next injection port.
      if (ownerId && admitted.length > 0) {
        const stampIds = admitted
          .map((h) => h.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (stampIds.length > 0) {
          const sid = ownerId;
          void (async () => {
            try {
              const [{ getOrgPg }, ledger] = await Promise.all([
                import('@papercusp/db-org'),
                import('../../../memory/session-epoch-ledger'),
              ]);
              const { sql } = getOrgPg();
              const epoch = await ledger.currentSessionEpoch(sql, sid);
              await ledger.stampSurfaced(sql, sid, epoch, stampIds, 'orient');
            } catch {
              /* never load-bearing */
            }
          })();
        }
      }
    } catch {
      result.memory = null;
    }
  }

  // ── the caller's fleet (coord:whoami) — resolved ONCE, hoisted ABOVE the facts
  // fold because the P-007 audience filter needs it there; reused by the fleet
  // legs and the announced-gates fold below (EI-9270). A monitor tick reuses the
  // handler's already-resolved authoritative membership instead of paying a
  // coord:whoami sub-call; full mode keeps the existing whoami fold.
  let fleetSlug: string | null = monitor ? (fleetMembership?.fleetSlug ?? null) : null;
  if (!monitor) {
    try {
      const who = (await call('coord:whoami', {})) as { fleetSlug?: string | null } | undefined;
      fleetSlug = who?.fleetSlug ?? null;
    } catch {
      fleetSlug = null;
    }
  }

  // ── standing-facts fold (queen-memory-hybrid L1c) — the deterministic sibling of
  // the fuzzy memory recall above: scoped conclusions delivered VERBATIM every
  // orient (workspace + this owner + the named harness). BEST-EFFORT like every
  // other leg — a facts outage must never break orientation. EI-8300: the full
  // fold is elided on a monitor tick (a leader loop re-reads its own steering
  // facts on every wake for no reason — it already has them from an earlier full
  // orient).
  //
  // EI-18725816532600240: that elision used to be TOTAL, and it deleted exactly
  // the signal a stale carry-note needs. A cold wake reconciled with mode:'monitor'
  // and was told to go implement an approach a `dead-end:` fact had ALREADY
  // falsified — the antidote was absent precisely where the poison was strongest,
  // and monitor is the DEFAULT shape for a long-running loop, not an edge case.
  // So the never-drop slots (dead-ends + walls + guard rails) now fold on EVERY tick:
  // they are small and bounded, and all exist to OVERRIDE a stale plan. An
  // `afterCompaction` reconcile takes the FULL fold whatever the mode — that call
  // is the one that most needs everything.
  const factsFold: 'full' | 'never-drop' = !monitor || args.afterCompaction === true ? 'full' : 'never-drop';
  {
    try {
      const {
        foldFactsWithCensus,
        foldNeverDropFacts,
        NEVER_DROP_KEY_PREFIXES,
        listFactEvictionDisclosures,
        FACTS_FOLD_LIMIT,
      } = await import('../../../agent-facts/store');
      const selectors = [
        { scope: 'workspace' as const },
        ...(ownerId ? [{ scope: 'owner' as const, scopeRef: ownerId }] : []),
        ...(args.harness ? [{ scope: 'harness' as const, scopeRef: args.harness }] : []),
      ];
      // P-007: filter by the RECIPIENT's audience — an audience-scoped fact
      // (audienceScope 'fleet:<slug>') folds only for that fleet's members;
      // a non-fleet caller receives only unrestricted facts.
      const foldOpts = { audiences: fleetSlug ? [`fleet:${fleetSlug}`] : [] };
      // P-004 / D-006: the full fold carries its per-selector CENSUS out of the same
      // statement (a window function, evaluated before the LIMIT), so the truncation
      // disclosure below costs no extra round-trip. The narrowed fold declares its
      // own bound via `factsNarrowed` and needs no census.
      let factsCensus: Awaited<ReturnType<typeof foldFactsWithCensus>>['census'] = [];
      let facts: Awaited<ReturnType<typeof foldNeverDropFacts>>;
      if (factsFold === 'full') {
        const folded = await foldFactsWithCensus(selectors, foldOpts);
        facts = folded.facts;
        factsCensus = folded.census;
      } else {
        facts = await foldNeverDropFacts(selectors, foldOpts);
      }
      // A NARROWED fold must SAY it was narrowed. Otherwise "no ordinary facts in
      // this payload" is indistinguishable from "no ordinary facts exist" — a
      // bounded read rendered as a total, which is the same class of silent
      // miscount the aggregate-boundedness rule exists to stop. Emitted even when
      // the narrowed fold returned nothing, since that is the reading a caller is
      // least entitled to treat as a census.
      if (factsFold === 'never-drop') {
        result.factsNarrowed = {
          fold: 'never-drop',
          prefixes: [...NEVER_DROP_KEY_PREFIXES],
          reason:
            "mode:'monitor' folds ONLY the never-drop slots (dead-ends + walls + guard rails) for context budget — ordinary standing facts were NOT read, so their absence here is not evidence they do not exist. Re-call coord:orient without mode:'monitor' (or with afterCompaction:true) for the full fold.",
        };
      }
      // P-004 / D-006: the SAME rule as factsNarrowed above, applied to the bound
      // that actually fires — the per-selector LIMIT, on every full fold. Without
      // this, `facts` is the newest N of a scope rendered as the scope's standing
      // facts, and an agent reads a fact's absence as evidence it was never
      // asserted. Measured 2026-09-02: workspace 12 of 495, harness:papercusp 12
      // of 366. D-006 rules the recency ORDER BY correct and this disclosure, not
      // a re-ranking, the fix.
      const truncatedScopes = factsCensus.filter((c) => c.truncated);
      if (truncatedScopes.length > 0) {
        result.factsFoldTruncated = {
          limitPerSelector: FACTS_FOLD_LIMIT,
          scopes: truncatedScopes.map((c) => ({
            scope: c.scope,
            scopeRef: c.scopeRef,
            shown: c.shown,
            total: c.total,
          })),
          reason:
            'The facts fold returns the most-recently-updated facts per scope, capped per selector — these scopes hold more than were returned, so `facts` is a SAMPLE, not a census. A fact you expected and do not see may simply not be among the newest; its absence here is not evidence it was never asserted. Read a scope in full with facts:list { scope, scopeRef }, which reports its own total.',
        };
      }
      // P-002 / D-001: withhold queen-loop steering facts (pauseNewWork/maxBees) from
      // an OWNER-DIRECTED (responsive) caller — filter the RAW facts (key + body both
      // inspected) BEFORE projecting, so the structural `queen-loop:` key convention
      // works alongside the body-vocabulary net. Auto callers keep every fact.
      const { kept, withheld } = withholdQueenLoopControl(facts, driveMode, (f) => ({ key: f.key, body: f.body }));
      if (kept.length > 0) {
        // EI-10947: a fact anchored to a work-item that has since CLOSED is still folded
        // here verbatim, as binding context. If it was a carry-note ("NEXT: implement
        // EI-10539") that is now an instruction to REDO finished work — the exact failure
        // that cost su-71d9f8a2 a wasted re-implementation. Mark it (never auto-retract:
        // a durable conclusion the closed item PROVED stays true — see stale-source.ts).
        // Fail-soft: markStaleSourceFacts returns the facts unmarked on any lookup error.
        const { markStaleSourceFacts } = await import('../../facts/stale-source');
        const staleMarked = await markStaleSourceFacts(kept);
        // P-006 READ SIDE (WI-7236): the dispute advisory used to fire ONLY inside
        // facts:assert — so a key already contested, or already settled as UNDECIDABLE,
        // read as an ordinary fact to anyone who merely READS it. A compaction boundary
        // manufactures exactly that agent, who then re-derives the settled question: the
        // whole cost P-006 exists to prevent. Marking it here reaches an agent who did
        // nothing but wake up. ONE batched query, and fail-soft twice over (the helper
        // returns facts unmarked on any failure; this catch covers the import).
        const { markContestedFacts } = await import('../../facts/contested-fold');
        const marked = await markContestedFacts(staleMarked);
        // P-008 (b): re-check DECLARED cell dependencies. This is where D-007's
        // "auto-invalidates ... so no agent has to remember to retract" actually
        // lands — orient runs on every wake, so an assumption whose ground moved
        // is flagged to its author without anyone having to think to look.
        //
        // The cost is proportionate BY CONSTRUCTION: zero dispatches when no
        // folded fact declared a dependency (every fold today), and otherwise
        // one dispatch per DISTINCT cell across the whole fold — not per fact.
        // An agent that files an assumption buys the re-check; nobody else pays.
        // Fail-soft twice over: markStaleDependencyFacts returns facts unmarked
        // on any failure, and this catch covers the imports themselves.
        let withDeps: Array<(typeof marked)[number] & { depsStale?: FactDependencyStaleness }> = marked;
        if (cellIdentity && marked.some((f) => f.dependsOn?.length)) {
          try {
            const { markStaleDependencyFacts } = await import('../../facts/dependency-staleness');
            withDeps = await markStaleDependencyFacts(marked, cellIdentity.reader, cellIdentity.env);
          } catch {
            withDeps = marked;
          }
        }
        // P-008 (c) / D-012: facts are a WATERMARK SURFACE. The fold above stays a
        // FULL read — that is the property D-012 chose watermarks for ("read with
        // watermark 0 and you get current state", so a compacted/respawned agent is
        // correct immediately). What the cursor adds is the separate question layered
        // on top: which of these did I not already have? Marked per-fact below.
        //
        // Best-effort and non-fatal by construction: a watermark outage must degrade
        // to today's unmarked full fold, never break orientation.
        // ONE key function for both the SET and the LOOKUP. They were written as two
        // separate inline templates with DIFFERENT separators (`\x00` when building,
        // spaces when reading), so `has()` could never match and the `changed` mark
        // NEVER fired for any fact — silent, and invisible to the suite because
        // nothing asserted the marker. Deriving both from one function is what makes
        // that class of drift unrepresentable rather than merely fixed.
        const factCellKey = (f: { scope: string; scopeRef?: string | null; key: string }) =>
          `${f.scope}\x00${f.scopeRef ?? ''}\x00${f.key}`;
        let changedCells: ReadonlySet<string> = new Set();
        if (ownerId) {
          try {
            const [{ factsCellDelta, FACTS_CELL_SURFACE }, { readWatermark, writeWatermark }] = await Promise.all([
              import('../../../agent-facts/cells'),
              import('../watermarks'),
            ]);
            const wm = await readWatermark(ownerId);
            const delta = factsCellDelta(withDeps, wm.cursors?.[FACTS_CELL_SURFACE]);
            changedCells = new Set(delta.changed.map(factCellKey));
            // Advance deterministically at fold time, like messages_shown_ts (EI-2042)
            // rather than at turn end: the agent HAS been shown these. Only write when
            // the position actually moved, so a quiet fold costs no row write.
            //
            // ⚠ NEVER advance on a NARROWED fold. nextCursor is the MAX cell version
            // across the folded rows, so a dead-end/wall-only fold would push the
            // cursor PAST ordinary facts the caller was never shown — permanently
            // suppressing their `changed` mark on the next FULL orient. A narrowed
            // fold still READS the cursor (so the never-drop rows it did fold are
            // marked correctly); it just must not claim the caller saw the rest.
            if (factsFold === 'full' && delta.nextCursor && delta.nextCursor !== wm.cursors?.[FACTS_CELL_SURFACE]) {
              await writeWatermark(ownerId, { cursors: { [FACTS_CELL_SURFACE]: delta.nextCursor } });
            }
          } catch {
            changedCells = new Set();
          }
        }
        // EI-19390161700979033: the projection was an inline field WHITELIST here, and a
        // marker that forgot to add itself to it was dropped SILENTLY — no error, no type
        // failure (conditional spreads check neither excess nor missing properties). That
        // landed three times (P-033 e, P-018 `kind`, WI-7236 `contested`). It now lives in
        // projectFactRow, whose FACT_MARKER_FIELDS inventory a completeness test walks, so
        // the next omission fails loudly instead of costing an agent the field.
        const { projectFactRow } = await import('../../facts/project-fact-row');
        result.facts = withDeps.map((f) => projectFactRow(f, { changed: changedCells.has(factCellKey(f)) }));
      }
      if (withheld.length > 0) {
        result.factsWithheld = { count: withheld.length, reason: QUEEN_LOOP_WITHHELD_REASON };
      }
      // EI-19485000346355077: only on the FULL fold — a monitor tick's never-drop
      // fold is EI-8300 budget-constrained and this is a supplementary signal, not
      // a leg that fold already pays for. Reuses the SAME `selectors` this fold
      // already built. OWN fail-soft catch (WI-39420): the enclosing catch nulls
      // result.facts, so a disclosure read error inside it would destroy the
      // PRIMARY facts fold to protect a supplementary signal — exactly the wrong
      // blast radius (this is how 9 orient tests went red: an unmocked live-PG
      // attempt threw here and the catch nulled the whole fold). A disclosure
      // failure now costs only the disclosures.
      if (factsFold === 'full') {
        try {
          // NOT `foldOpts` — that carries `audiences`, which is foldFacts's shape.
          // This reader takes { workspaceId?, windowSec? } and defaults both from
          // the active workspace, so there is nothing to forward.
          const factEvictionDisclosures = await listFactEvictionDisclosures(selectors);
          if (factEvictionDisclosures.length > 0) result.factEvictionDisclosures = factEvictionDisclosures;
        } catch {
          /* supplementary signal — never break the facts fold for it */
        }
      }
    } catch {
      result.facts = null;
    }
  }

  type SelfAgentRow = {
    isSelf?: boolean;
    declaredPlanSlug?: string | null;
    // fleet:assignments collapses claims to a count outside the full payload tier.
    claims?: number | Array<{ planSlug: string | null; id: string | null }>;
  };
  const meAgentsForPlan = (me as { agents?: SelfAgentRow[] } | undefined)?.agents ?? [];
  const selfRow = meAgentsForPlan.find((a) => a.isSelf);
  const effectivePlanSlug: string | null = args.planSlug ?? selfRow?.declaredPlanSlug ?? null;

  // ── coord:plan-events — the "what plans changed" delta (default on; the bootstrap's
  // third leg). Already result-bounded server-side; we keep the newest few.
  // EI-8300: skipped entirely on a monitor tick.
  if (!monitor && args.includePlanEvents !== false) {
    // EI-21127719036550806: bounded (withBoundedTimeout directly, not the
    // boundedCore(fallback) helper) so a HANG is reported the same way a genuine
    // rejection already is below (`result.planEvents = null`) — a fallback of
    // `undefined` here would otherwise read downstream as "zero events happened",
    // which is a false empty rather than the honest "this leg did not answer".
    const peResult = await withBoundedTimeout(
      call('coord:plan-events', {
        ...(args.planEventsSince ? { since_ts: args.planEventsSince } : {}),
        ...(effectivePlanSlug ? { plan_slug: effectivePlanSlug } : {}),
        limit: PLAN_EVENTS_FOLD,
      }) as Promise<{ events?: unknown[]; total?: number } | undefined>,
      { fallback: undefined, timeoutMs: ORIENT_CORE_LEG_TIMEOUT_MS, label: 'orient:coord:plan-events' },
    );
    if (peResult.degraded) {
      result.planEvents = null;
    } else {
      try {
        const pe = peResult.value;
        const events = Array.isArray(pe?.events) ? (pe!.events as unknown[]) : [];
        const total = typeof pe?.total === 'number' ? pe.total : events.length;
        const recent = events.slice(0, PLAN_EVENTS_FOLD);
        // P-005: full-mode delta — the newest batch is ~96% byte-identical to what
        // this caller already saw last orient (D-003 audit). FAIL-OPEN: any cursor
        // error just skips the unchanged check and delivers in full, same as no
        // cursor injected.
        let unchanged = false;
        if (planEventsCursor) {
          try {
            const ack = await planEventsCursor(fingerprintIdList(recent.map(rowKey)));
            unchanged = !ack.baseline && idListUnchanged(ack.committed, recent.map(rowKey));
          } catch {
            /* fail-open: full delivery */
          }
        }
        result.planEvents = unchanged ? { total, recent: [], unchanged: true } : { total, recent };
      } catch {
        result.planEvents = null;
      }
    }
  }

  // ── WI-5228 (kickoff-prompt-absorption-2026-07-17 P-002): orient-first plan
  // bootstrap. Resolve the EFFECTIVE plan slug — the explicit arg, else (for a
  // plan-BOUND session that didn't repeat it) the SELF row's `declaredPlanSlug`
  // already sitting on `me` (fleet:assignments' presence-sourced "self-declared
  // current plan" — no extra IO: reusing the SAME leg fetched + bounded above,
  // never a fresh session-brief/DB read of our own) — then fold that plan's
  // `## Now` block, the next actionable item, and the caller's own claim state
  // within it. `myClaims` is ALSO derived from `me`. This costs exactly one
  // extra call (plans:get) on the common plan-bound path. EI-8300: skipped on a
  // monitor tick like the other plan/fleet legs. WI-3818: bounded like every
  // other fan-out leg — a slow plans:get must never block orient past budget.
  if (!monitor) {
    const planNowResult = await withBoundedTimeout(
      (async () => {
        if (!effectivePlanSlug) return null;
        const planRes = (await call('plans:get', {
          slug: effectivePlanSlug,
          // EI-20108229813877389: `plans:get` REFUSES with `harness_required`
          // when given no harness, and this leg's fallback swallowed that
          // refusal into a bare null — so the common plan-bound caller that
          // omits `harness` silently lost the whole leg. 'all' is the
          // documented cross-harness scope and resolves a plan by slug.
          harness: args.harness ?? 'all',
        })) as
          | {
              results?: Array<{
                now?: { state?: string | null; next?: string | null } | null;
                items?: Array<{
                  id: string;
                  text: string;
                  phase?: string | null;
                  effectiveStatus?: string;
                  unresolvedBlockers?: unknown[];
                  needsHuman?: boolean;
                }>;
              }>;
            }
          | undefined;
        const p = planRes?.results?.[0];
        if (!p) return null;
        const nextActionableItem =
          (p.items ?? []).find(
            (it) => it.effectiveStatus === 'todo' && (it.unresolvedBlockers?.length ?? 0) === 0 && !it.needsHuman,
          ) ?? null;
        // EI-20108229813877389: narrow before filtering — see SelfAgentRow.
        // A collapsed count MUST NOT become `myClaims: []`: that would trade a
        // loud crash for a silent FALSE ZERO ("I hold nothing in this plan")
        // in a caller that holds claims. Report null + the reason instead.
        const rawClaims: unknown = selfRow?.claims;
        const claimRows = Array.isArray(rawClaims)
          ? (rawClaims as Array<{ planSlug: string | null; id: string | null }>)
          : null;
        const myClaims = claimRows
          ? claimRows.filter((c) => c?.planSlug === effectivePlanSlug && c?.id).map((c) => c.id as string)
          : null;
        return {
          planSlug: effectivePlanSlug,
          state: p.now?.state ?? null,
          next: p.now?.next ?? null,
          nextActionable: nextActionableItem
            ? { id: nextActionableItem.id, title: nextActionableItem.text, phase: nextActionableItem.phase ?? null }
            : null,
          myClaims,
          ...(claimRows
            ? {}
            : {
                myClaimsUnavailable:
                  typeof rawClaims === 'number'
                    ? `fleet:assignments collapsed claims[] to a count (${rawClaims}) at this payload tier — re-read with payloadTier:'full' for the rows`
                    : 'the assignments self-row carried no claim rows at this payload tier',
              }),
        };
      })(),
      {
        fallback: null as OrientResult['planNow'],
        timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS,
        label: 'orient:planNow',
      },
    );
    // EI-20108229813877389: surface a degraded leg IN BAND. A bare `null` here
    // is indistinguishable from "this plan has no Now", which is precisely how
    // two independent defects went unnoticed — the console.warn goes to the
    // server log that no agent reads, while the caller sees a clean null.
    result.planNow =
      planNowResult.degraded && effectivePlanSlug
        ? {
            planSlug: effectivePlanSlug,
            state: null,
            next: null,
            nextActionable: null,
            myClaims: null,
            status: 'unknown' as const,
            why:
              planNowResult.errorMessage ??
              (planNowResult.reason === 'timeout'
                ? `the planNow leg exceeded ${ORIENT_FLEET_LEG_TIMEOUT_MS}ms`
                : 'the planNow leg degraded'),
          }
        : planNowResult.value;

    // ── interest fold (P-011, state-plane-interest-and-hardening-2026-08-21) ──────
    // The caller's live contexts, matched against P-010's interest profiles, folded
    // as cell HANDLES (D-001 — never a value; see interest-fold.ts's header).
    //
    // Sited HERE, inside the planNow block, because this is where the two contexts it
    // needs are already resolved: `effectivePlanSlug` (plan-holder) and the self row's
    // claims (item-holder). Deriving either again would be a second, drifting answer to
    // a question orient has already answered once.
    //
    // Runs on monitor ticks too, unlike the EI-8300-skipped legs. Those were skipped
    // for their SUB-CALLS; this one is pure, IO-free, and bounded by the registry at a
    // handful of rows, so there is no per-tick cost to budget away. It does NOT run
    // without `cellIdentity`: the reader is the audience, and inventing one here would
    // be the defaulted-audience failure that fails OPEN.
    if (cellIdentity?.reader) {
      try {
        const contexts: InterestContext[] = [];
        if (effectivePlanSlug) contexts.push('plan-holder');
        // A collapsed claims COUNT is still positive evidence of holding items — the
        // payload tier that collapses `claims[]` (EI-20108229813877389) must not be
        // read as "holds nothing", which is the same false zero `myClaims` guards.
        const rawClaimsForCtx: unknown = selfRow?.claims;
        const holdsItems =
          typeof rawClaimsForCtx === 'number'
            ? rawClaimsForCtx > 0
            : Array.isArray(rawClaimsForCtx) && rawClaimsForCtx.length > 0;
        if (holdsItems) contexts.push('item-holder');

        if (contexts.length > 0) {
          const { interestFold } = await import('../../../interest-fold');
          // No `subjects`: orient does not resolve a held item's primary PATH, so the
          // per-path pipeline cell correctly comes back `unreadable { needs }` rather
          // than as an unqualified handle that would answer about a different path.
          const fold = interestFold({ contexts, reader: cellIdentity.reader });
          if (fold) result.interest = fold;
        }
      } catch {
        /* advisory leg — never break orientation for it */
      }
    }
  }

  // ── fleet legs (full mode only) — the caller's fleet was resolved ONCE above
  // (hoisted for the P-007 facts audience filter); here it folds two bounded
  // slices for a fleet member: (1) catch-up = "what did my fleet say while I was
  // away" (the pull counterpart to @fleet: broadcasts, NOT auto-polled), and
  // (2) fleet-health = the coord:glance health subset agents otherwise re-fetch
  // right after orient (compaction-fold-audit-2026-07-06 — 44%+ did). Both gated
  // + BEST-EFFORT: a non-fleet caller or any failure degrades to absent/null.
  // EI-8300: skipped entirely on a monitor tick (both legs).
  // (fleet-messaging-integrate-and-land P-006)
  // ── fleet CONTROL STATE (P-009 / H4) — folded UNGATED by the catch-up/health
  // flags: a winding-down fleet must reach every member orient, especially a
  // LATE JOINER who never saw the wind-down cue. Only a non-'active' state is
  // surfaced (zero noise on the common path). BEST-EFFORT + dynamic import
  // (orient's static graph unchanged); skipped on a monitor tick like the
  // other fleet legs (a leader's monitor loop reads fleet:status itself).
  if (!monitor && fleetSlug) {
    try {
      const [{ getFleet }, { activeWorkspaceId }] = await Promise.all([
        import('../../../agent-fleets-store'),
        import('../../../workspace-registry'),
      ]);
      // composeOrient carries no ctx (IO arrives injected / dynamically imported,
      // like the facts fold above) — the process-active workspace is the same
      // fallback resolveFleetCaller uses for the registry writes.
      const ws = activeWorkspaceId();
      const fleet = ws && ws !== '*' ? await getFleet(ws, fleetSlug) : null;
      if (fleet && fleet.controlState !== 'active') {
        result.fleetControl = {
          fleet: fleetSlug,
          state: fleet.controlState,
          reason: fleet.controlReason,
          by: fleet.controlBy,
          since: fleet.controlAt,
        };
      }
    } catch {
      /* best-effort — a registry hiccup must never break orientation */
    }
  }

  // Legacy includeFleet controlled both optional fleet folds. Canonical controls
  // win when callers provide them explicitly; undefined preserves the default-on
  // behavior. includeAssignments is intentionally a no-op: assignments are one
  // of orient's core reads and cannot be omitted.
  const includeFleetCatchUp =
    args.includeFleetCatchUp ?? args.includeFleetCatchup ?? args.includeCatchup ?? args.includeFleet;
  const includeFleetHealth = args.includeFleetHealth ?? args.includeFleet;
  if (!monitor && (includeFleetCatchUp !== false || includeFleetHealth !== false)) {
    if (fleetSlug && includeFleetCatchUp !== false) {
      const cuLimit = Math.min(args.fleetCatchUpLimit ?? FLEET_CATCHUP_FOLD, FLEET_CATCHUP_CAP);
      // A zero limit is the explicit lean-bootstrap form: coord:catch-up requires a
      // positive limit, so skip the fold instead of forwarding an invalid request.
      if (cuLimit > 0) {
        try {
          const cu = (await call('coord:catch-up', {
            audience: `@fleet:${fleetSlug}`,
            limit: cuLimit,
          })) as { total?: number; rows?: unknown[] } | undefined;
          const rows = Array.isArray(cu?.rows) ? (cu!.rows as unknown[]) : [];
          const total = typeof cu?.total === 'number' ? cu.total : rows.length;
          const recent = rows.slice(0, cuLimit);
          // P-005: same full-mode delta treatment as plan-events — an append-only
          // message log where "nothing new since last orient" is a safe, fully
          // actionable answer. FAIL-OPEN on any cursor error.
          let unchanged = false;
          if (fleetCatchUpCursor) {
            try {
              const ack = await fleetCatchUpCursor(fingerprintIdList(recent.map(rowKey)));
              unchanged = !ack.baseline && idListUnchanged(ack.committed, recent.map(rowKey));
            } catch {
              /* fail-open: full delivery */
            }
          }
          result.fleetCatchUp = unchanged
            ? { fleet: fleetSlug, total, recent: [], unchanged: true }
            : { fleet: fleetSlug, total, recent };
        } catch {
          result.fleetCatchUp = null;
        }
      }
    }
    // fleet-health (fold #1) — COMPACT: coord:glance's health subset only (bees/wake/
    // governor; audience 'su' + activity_limit:0 skip the human display/tips/activity
    // rows). Kills the post-orient coord:glance re-call for fleet members.
    if (fleetSlug && includeFleetHealth !== false) {
      // WI-3818: bounded — a slow coord:glance used to hang orient until the
      // 55s MCP client timeout; now degrades to null (same as the pre-existing
      // catch-based failure contract) within ORIENT_FLEET_LEG_TIMEOUT_MS.
      const glanceResult = await withBoundedTimeout(
        call('coord:glance', { audience: 'su', activity_limit: 0 }) as Promise<
          { bees?: unknown; wake?: unknown; governor?: unknown } | undefined
        >,
        { fallback: undefined, timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS, label: 'orient:coord:glance' },
      );
      const g = glanceResult.value;
      result.fleetHealth = {
        schemaVersion: ORIENT_FLEET_HEALTH_SCHEMA_VERSION,
        status: g ? 'available' : 'unavailable',
        ref: 'coord:glance',
        ...(!g ? { reason: 'coord:glance read failed or timed out' } : {}),
      };
    }
  }

  // ── Announced gate events (EI-9270) — declared-but-unfired gates visible to this
  // caller's fleet/plan/harness (+ global): the zero-message "what should I await".
  // BEST-EFFORT (absent on any failure). Monitor ticks intentionally KEEP this
  // compact fold: a newly-declared gate is an actionable fleet transition, not
  // heavyweight bootstrap context. TIME-BOUNDED:
  // a hung PG read degrades to absent within its own short budget (a discovery
  // nicety must never stall orientation — the WI-3818 bounded-leg contract).
  try {
    const annsResult = await withBoundedTimeout(listActiveAnnouncements({ unfiredOnly: true, limit: 50 }), {
      fallback: [] as Awaited<ReturnType<typeof listActiveAnnouncements>>,
      timeoutMs: 1_500,
      label: 'orient:announcedGates',
    });
    const anns = annsResult.value ?? [];
    const visibleAll = anns.filter((a) =>
      announcementVisibleTo(a, {
        fleetSlug,
        planSlug: args.planSlug ?? null,
        harnessSlug: args.harness ?? null,
      }),
    );
    const ANNOUNCED_GATES_FOLD = 8;
    const visible = visibleAll.slice(0, ANNOUNCED_GATES_FOLD);
    if (visible.length > 0) {
      // Metadata is advisory and independently bounded. A failure omits only
      // the affected optional fields; it must not erase the gate directory or
      // manufacture `live_awaiters: 0` / `stale_owner: false`.
      const [countsResult, ownershipResult] = await Promise.all([
        withBoundedTimeout(countActiveAwaitsByPrefixes(visible.map((a) => a.eventKey)), {
          fallback: null as Map<string, number> | null,
          timeoutMs: 1_000,
          label: 'orient:announcedGateAwaiters',
        }),
        withBoundedTimeout(resolveAnnouncementOwnership(visible, resolveConcreteWorkspaceId(activeWorkspaceId())), {
          fallback: null as Map<number, AnnouncementOwnership> | null,
          timeoutMs: 1_000,
          label: 'orient:announcedGateOwnership',
        }),
      ]);
      const counts = countsResult.value;
      const ownership = ownershipResult.value;
      result.announcedGates = visible.map((a) => {
        const owned = ownership?.get(a.id);
        const warning = buildAnnouncedGateWarning({
          event: a.eventKey,
          logical_gate: a.logicalGateKey ?? null,
          scope: a.scopeKind ? `${a.scopeKind}${a.scopeRef ? ':' + a.scopeRef : ''}` : 'global',
          announcedBy: a.subscriberId,
          stale_owner: owned?.staleOwner,
        });
        return {
          event: a.eventKey,
          note: a.note,
          scope: a.scopeKind ? `${a.scopeKind}${a.scopeRef ? ':' + a.scopeRef : ''}` : 'global',
          announcedBy: a.subscriberId,
          expires_ts: a.expiresTs,
          logical_gate: a.logicalGateKey ?? null,
          ...(counts ? { live_awaiters: counts.get(a.eventKey) ?? 0 } : {}),
          ...(owned?.liveSuccessorIds.length ? { live_successor_ids: owned.liveSuccessorIds } : {}),
          ...(owned?.staleOwner ? { stale_owner: true } : {}),
          ...(warning ? { warning } : {}),
        };
      });
      // EI-20113865649946366: this fold is the mechanism by which an agent DISCOVERS
      // which gate to park on, so a gate dropped past the fold is not cosmetic — the
      // agent never learns the key exists and can wait on the wrong thing (or nothing).
      // `visibleAll` is the already-visibility-filtered population, so this total is a
      // real count of gates addressed to THIS caller, not the global announcement table.
      if (visibleAll.length > visible.length) {
        result.announcedGatesTruncated = {
          shown: visible.length,
          total: visibleAll.length,
          more: 'events:catalog for the full set of gates visible to you',
        };
      }
    }
  } catch {
    /* best-effort — never break orientation */
  }

  // ── role-specific pane folds (voice-public-release-readiness-2026-07-12 P-016) —
  // injected by the handler ONLY for the papercup / papercup-deep dock-pane roles in
  // full mode (orientRoleFolds). BEST-EFFORT + TIME-BOUNDED like every other leg:
  // withBoundedTimeout NEVER throws (WI-3818), so a slow or failing gather degrades
  // to null instead of breaking orientation.
  if (roleFolds?.paneContext) {
    const pc = await withBoundedTimeout(roleFolds.paneContext, {
      fallback: null as string | null,
      timeoutMs: ORIENT_PANE_CONTEXT_TIMEOUT_MS,
      label: 'orient:paneContext',
    });
    result.paneContext = pc.value;
  }
  if (roleFolds?.deepWork) {
    const dw = await withBoundedTimeout(roleFolds.deepWork, {
      fallback: null as NonNullable<OrientResult['deepWork']> | null,
      timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS,
      label: 'orient:deepWork',
    });
    result.deepWork = dw.value;
  }

  // ── recipes:search — surface reusable code:run RECIPES relevant to this turn's intent,
  // so an agent batches via an EXISTING recipe instead of hand-looping or re-authoring
  // (code-run-adoption: reuse-at-orient closes the "I didn't know one existed" gap — the
  // measured bottleneck is awareness, not authoring). Keyed off the same intent/memoryQuery
  // as the recall. BEST-EFFORT: a missing intel:read cap or a slow search degrades to null,
  // never breaks orientation. COMPACT: id/title/runCount/similarity only.
  // EI-8300: skipped entirely on a monitor tick.
  const recipeQuery = monitor ? undefined : (args.intent ?? args.memoryQuery);
  const recLimit = Math.min(args.recipesLimit ?? RECIPES_DEFAULT, RECIPES_CAP);
  // EI-20233111263340661: zero is the explicit lean-payload cap, matching the
  // memoryLimit/claimableLimit controls. Do not forward zero to recipes:search;
  // that sub-tool requires a positive limit, and the caller asked to skip this
  // optional fold rather than pay a round-trip only to receive no rows.
  if (recipeQuery && args.includeRecipes !== false && recLimit > 0) {
    try {
      const rec = (await call('recipes:search', {
        query: recipeQuery,
        limit: recLimit,
        context: {
          ...(fleetMembership?.fleetSlug ? { fleet: fleetMembership.fleetSlug } : {}),
          ...(args.planSlug ? { plan: args.planSlug } : {}),
          ...(args.harness ? { harness: args.harness } : {}),
          ...(args.planItems?.length ? { items: args.planItems } : {}),
        },
      })) as
        | {
            recipes?: Array<{
              id?: unknown;
              title?: unknown;
              runCount?: unknown;
              similarity?: unknown;
              authorityRefs?: unknown;
              runArgs?: unknown;
            }>;
          }
        | undefined;
      // EI-20113865649946366: two independent cuts here, both previously silent —
      // the LIST (bounded by recLimit, which is also what the search was asked for, so
      // a full page is evidence of more) and each TITLE (RECIPE_TITLE_CAP). This fold
      // exists to close an AWARENESS gap, so a silently-dropped recipe defeats its own
      // purpose: the agent concludes no recipe exists and hand-rolls the loop anyway.
      const recipeRows = rec?.recipes ?? [];
      let recipeTitlesClipped = 0;
      result.recipes = recipeRows.slice(0, recLimit).map((r) => ({
        id: r.id,
        title:
          typeof r.title === 'string'
            ? r.title.length > RECIPE_TITLE_CAP
              ? (recipeTitlesClipped++, `${r.title.slice(0, RECIPE_TITLE_CAP - 1)}…`)
              : r.title
            : undefined,
        runCount: r.runCount,
        similarity: r.similarity,
        ...(r.authorityRefs && typeof r.authorityRefs === 'object' ? { authorityRefs: r.authorityRefs } : {}),
        ...(r.runArgs && typeof r.runArgs === 'object' ? { runArgs: r.runArgs } : {}),
      }));
      // No authoritative total is available here (recipes:search was itself asked for
      // `recLimit`), so this reports the bound honestly rather than inventing a count.
      if (recipeRows.length >= recLimit || recipeTitlesClipped > 0) {
        result.recipesTruncated = {
          shown: Math.min(recipeRows.length, recLimit),
          ...(recipeRows.length >= recLimit ? { truncatedByLimit: true as const, limit: recLimit } : {}),
          ...(recipeTitlesClipped > 0 ? { titlesClipped: recipeTitlesClipped, titleCap: RECIPE_TITLE_CAP } : {}),
          more: 'recipes:search { query, limit } for more matches; recipes:get { id } for a full recipe',
        };
      }
    } catch {
      result.recipes = null;
    }
  }

  // ── peersKnow — when the declared intent semantically matches a CLOSED consult in
  // the archive, surface the settled answer + provenance + the consult:get_feedback
  // pointer (consult-revival-and-honest-min-2026-08-18 P-006). READ-ONLY twin of
  // get_feedback's archive-first serve: the injected fold reuses the router's query
  // embedder + the same corpus/floor, never wakes or writes. BEST-EFFORT +
  // zero-cost on no-match: the field is ABSENT unless a hit clears the
  // precision-biased archive floor, and ANY failure (embedder unavailable,
  // pgvector/column missing, slow leg) degrades to absent. Skipped on a monitor
  // tick (EI-8300); short/generic intents are floored inside the fold.
  const peersKnowQuery = monitor ? undefined : args.intent;
  if (peersKnowQuery && peersKnowFold && args.includePeersKnow !== false) {
    const pkResult = await withBoundedTimeout(peersKnowFold(peersKnowQuery), {
      fallback: null as Awaited<ReturnType<NonNullable<typeof peersKnowFold>>>,
      timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS,
      label: 'orient:peersKnow',
    });
    if (pkResult.value) {
      result.peersKnow = {
        ...pkResult.value,
        more:
          `conversations:get { id: '${pkResult.value.ref}' } reads the full settled thread; ` +
          'consult:get_feedback { question } re-asks fresh (archive-first serves settled questions instantly).',
      };
    }
  }

  // (WI-5951) The open-unanswered-questions fold that used to live here — the PULL
  // half of Q&A from WI-5807 / P-007 — was REMOVED, deliberately, by the same author.
  // It surfaced orphaned peer questions to agents at wake. coord:ask now REQUIRES a
  // recipient, so orphans can no longer be created, and the only questions left are
  // coord:ask-owner ones the OWNER must answer — pushing those at agents would be
  // noise they are not able to act on. Owner-directed questions belong in coord:walls
  // (the "what needs me" surface), not in every agent's wake.

  // ── release-pipeline health (WI-4533 / P-006): can what I'm about to write actually SHIP?
  // Folded in BOTH modes — a monitor tick is precisely where a leader wants the gate's colour —
  // and awaited LAST so the read (kicked off by the handler before any of the legs above) has been
  // running in the background the whole time. Bounded + fail-soft: a slow/failed pipeline read
  // drops the leg, never the orientation.
  if (pipelineFold) {
    const p = await withBoundedTimeout(pipelineFold(), {
      fallback: null as OrientPipeline | null,
      timeoutMs: ORIENT_PIPELINE_TIMEOUT_MS,
      label: 'orient:pipeline',
    });
    if (p.value) result.pipeline = p.value;
  }

  // P-015: gate + release snapshots ride the same hydrated leader brief as
  // member health/claim spec/walls. Keep the established top-level fields too
  // for compatibility: one authoritative read, two projections, no new API.
  if (result.leaderBrief && typeof result.leaderBrief === 'object') {
    const brief = result.leaderBrief as Record<string, unknown>;
    const unavailable =
      brief.orientProjection &&
      typeof brief.orientProjection === 'object' &&
      (brief.orientProjection as { status?: unknown }).status === 'unavailable';
    if (!unavailable) {
      Object.assign(brief, {
        announcedGates: result.announcedGates ?? [],
        release:
          result.pipeline ??
          ({
            status: 'unavailable',
            reason: 'pipeline fold unavailable',
            recoverVia: 'dev:pipeline_position { path }',
          } as const),
      });
      const projection = {
        schemaVersion: ORIENT_LEADER_BRIEF_SCHEMA_VERSION,
        status: 'available' as const,
        kind: !monitor && args.afterCompaction !== true ? 'bounded-summary' : 'rich-fold',
        recoverVia: `fleet:leader-brief { fleet: '${effectiveFleetMembership?.fleetSlug ?? ''}' }`,
      };
      if (!monitor && args.afterCompaction !== true) {
        const shaped = shapeLeaderBrief(brief, 'trimmed');
        result.leaderBrief = {
          ...(shaped && typeof shaped === 'object' && !Array.isArray(shaped)
            ? (shaped as Record<string, unknown>)
            : {}),
          orientProjection: projection,
          release: brief.release,
        };
      } else {
        brief.orientProjection = projection;
      }
    }
  }

  // P-006: stage the cursor only AFTER the canonical leader snapshot and its
  // announced-gate/release decorations are available. The old early fold could
  // diff only roster rows, so it silently omitted every canonical spec-scoped
  // measurement this cursor now promises. A reset keeps the full roster; only a
  // comparable delta slims `me`.
  if (fleetCursor) {
    try {
      const fp = fingerprintFleet(me, {
        leaderBrief: result.leaderBrief,
        announcedGates: result.announcedGates,
        pipeline: result.pipeline,
        fleet: effectiveFleetMembership?.fleetSlug ?? null,
        harness: args.harness ?? null,
      });
      if (fp) {
        const ack = await fleetCursor(fp as unknown as CursorState);
        if (ack.baseline || !ack.committed) {
          result.fleetDelta = {
            schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
            baseline: true,
            fullReplacement: true,
          };
        } else {
          const delta = diffFleet(ack.committed as unknown as FleetFingerprint, fp);
          result.fleetDelta = {
            schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
            baseline: false,
            changes: delta.rows,
            unchanged: delta.unchanged,
            ...(delta.orphaned ? { orphaned: delta.orphaned } : {}),
            ...(delta.stalled ? { stalled: delta.stalled } : {}),
            ...(delta.axes ? { axes: delta.axes } : {}),
            ...(delta.reset ? { reset: delta.reset } : {}),
            ...(delta.fullReplacement ? { fullReplacement: true } : {}),
          };
          if (!delta.fullReplacement) result.me = slimAssignmentsForDelta(me);
        }
      }
    } catch {
      result.fleetDelta = undefined; /* fail-open: full roster */
    }
  }

  // ── coord:declare-intent — only when an intent is given (a WRITE; independently
  // capability-gated at re-dispatch, so a read-only caller gets intentDeclared:false
  // rather than an escalation). BEST-EFFORT.
  if (args.intent) {
    let declared: { claims?: unknown } | undefined;
    // `coord:orient.planItems` is intentionally permissive because recovery callers
    // can carry WI-/EI-/F- work-item refs in the same lane-shaped field. The nested
    // coord:declare-intent.items contract is narrower (P-NNN plan items only), so a
    // recovery ref must not reject the whole presence/intent declaration. Preserve
    // the explicit [] release operation; when a non-empty request contains no plan
    // items, omit `items` so existing plan claims are left untouched and the caller
    // can use the work-item fallback in laneClaim.
    const planItemsForDeclaration =
      args.planItems && args.planItems.length > 0
        ? args.planItems.filter((item) => /^P-\d{3,}$/i.test(item))
        : args.planItems;
    // EI-21127719036550806: bounded — this is a WRITE (claims the caller's plan-item
    // lane), so a hang here used to block the ENTIRE orient call past any external
    // deadline. Bounding it changes nothing about the write itself (it still runs to
    // completion server-side, exactly like every other in-flight-but-abandoned call
    // withBoundedTimeout races against — see bounded-timeout.ts); it only stops an
    // unresponsive declare-intent from silently costing the rest of orientation. A
    // timeout degrades identically to the pre-existing catch-based failure contract
    // (`intentDeclared: false`), so a caller must still re-verify the lane rather than
    // assume the write landed.
    const declareResult = await withBoundedTimeout(
      call('coord:declare-intent', {
        intent: args.intent,
        ...(args.planSlug ? { current_plan_slug: args.planSlug } : {}),
        ...(planItemsForDeclaration !== undefined &&
        (planItemsForDeclaration.length > 0 || args.planItems?.length === 0)
          ? { items: planItemsForDeclaration }
          : {}),
        ...(args.harness ? { harness: args.harness } : {}),
        ...(args.declared_goal_refs ? { declared_goal_refs: args.declared_goal_refs } : {}),
      }),
      { fallback: undefined, timeoutMs: ORIENT_CORE_LEG_TIMEOUT_MS, label: 'orient:coord:declare-intent' },
    );
    if (declareResult.degraded) {
      result.intentDeclared = false;
    } else {
      declared = declareResult.value as { claims?: unknown } | undefined;
      result.intentDeclared = true;
    }
    // EI-20013545515660920: surface the lane-claim OUTCOME instead of dropping it.
    // declare-intent already computed it; discarding it here is what made a failed
    // claim indistinguishable from a successful one at the call site.
    if (args.planItems?.length) {
      result.laneClaim = summarizeLaneClaim(args.planItems, declared?.claims, {
        planSlugGiven: Boolean(args.planSlug),
        declareFailed: result.intentDeclared === false,
      });
    }
  }

  // EI-21589715378243224: publish the latest completed composition as well as the
  // early core snapshot. The handler's stable fallback then retains whichever
  // snapshot was available when the aggregate deadline fired.
  reportProgress(result);
  return result;
}

/** EI-20013545515660920: the outcome of a `planItems` lane claim, as reported
 *  back to the caller of coord:orient. Mirrors coord:declare-intent's own
 *  `claims` block, plus the `requested` lane and an explicit `warning`. */
export type OrientLaneClaim = {
  requested: string[];
  claimed: string[];
  alreadyHeld: string[];
  released: string[];
  conflicts: unknown[];
  unknown: string[];
  hint?: string;
  warning?: string;
};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

// `coord:declare-intent.items` is a P-NNN plan-item lane, while
// `scheduler:get_next` / `work_items:claim` own WI-/EI-/F- work-item lanes.
// Keep the recovery hint aligned with the identifier the caller actually
// supplied; sending an issue-family id to plans:set-status is rejected by its
// P-NNN schema and strands the member on a false fallback.
const WORK_ITEM_ID_RE = /^(?:WI|EI|F)-\d+$/i;

function laneClaimFallback(requested: readonly string[]): string {
  const workItemIds = requested.filter((id) => WORK_ITEM_ID_RE.test(id));
  if (workItemIds.length === requested.length && workItemIds.length > 0) {
    return 'These are WI-/EI-/F- work-item IDs, not P-NNN plan items. Claim with work_items:claim { id } (or scheduler:get_next for fleet-scoped pulls) and check the claim result.';
  }
  if (workItemIds.length > 0) {
    return "For WI-/EI-/F- work-item IDs, use work_items:claim { id } or scheduler:get_next; for P-NNN plan items, use plans:set-status { item, status: 'wip' }.";
  }
  return "Claim explicitly via plans:set-status { item, status: 'wip' } and check the result's claim object.";
}

/** EI-20013545515660920: turn coord:declare-intent's `claims` block into an
 *  UNAMBIGUOUS statement of whether the caller now holds the lane it asked for.
 *
 *  The bug this closes is a silent no-op: orient returned `ok: true` (and
 *  `intentDeclared: true`) while claiming nothing, because the diagnostic
 *  explaining why was thrown away at the call site. So the rule here is that
 *  every path which ends with the caller holding NONE of the requested items
 *  MUST set `warning` — including the paths where declare-intent never even
 *  attempted a claim:
 *    - `planItems` passed without `planSlug` (declare-intent reconciles a lane
 *      only when BOTH are present, so it silently skips);
 *    - the declaration call itself failed (no coord:write);
 *    - no `claims` block came back at all.
 *  An absent warning must mean "you hold at least part of this lane", never
 *  "nothing went wrong as far as I looked".
 *
 *  Pure (no IO) so a regression test asserts the real logic, not a fixture. */
export function summarizeLaneClaim(
  requested: readonly string[],
  claims: unknown,
  opts: { planSlugGiven: boolean; declareFailed?: boolean },
): OrientLaneClaim {
  const req = [...requested];
  const base: OrientLaneClaim = {
    requested: req,
    claimed: [],
    alreadyHeld: [],
    released: [],
    conflicts: [],
    unknown: [],
  };

  if (opts.declareFailed) {
    return {
      ...base,
      warning: `coord:declare-intent FAILED, so NONE of the ${req.length} requested plan item(s) were claimed — you do NOT hold this lane. This usually means the caller lacks coord:write. ${laneClaimFallback(req)}`,
    };
  }

  if (!opts.planSlugGiven) {
    return {
      ...base,
      warning: `planItems was passed WITHOUT planSlug, so NOTHING was claimed — you do NOT hold this lane. A lane is reconciled only when BOTH are given. Re-call with planSlug, or ${laneClaimFallback(req)}`,
    };
  }

  const c = (claims && typeof claims === 'object' ? claims : null) as Record<string, unknown> | null;
  if (!c) {
    return {
      ...base,
      warning: `coord:declare-intent returned no claims block, so NONE of the ${req.length} requested plan item(s) can be confirmed as claimed — do NOT assume you hold this lane. ${laneClaimFallback(req)}`,
    };
  }

  const summary: OrientLaneClaim = {
    requested: req,
    claimed: asStringArray(c.claimed),
    alreadyHeld: asStringArray(c.alreadyHeld),
    released: asStringArray(c.released),
    conflicts: Array.isArray(c.conflicts) ? [...c.conflicts] : [],
    unknown: asStringArray(c.unknown),
    ...(typeof c.hint === 'string' ? { hint: c.hint } : {}),
  };

  const held = summary.claimed.length + summary.alreadyHeld.length;
  if (req.length > 0 && held === 0) {
    const why = summary.conflicts.length > 0 ? ' A live peer holds part of it (see conflicts).' : '';
    summary.warning =
      `NONE of the ${req.length} requested plan item(s) are held — you do NOT hold this lane, ` +
      `even though the declaration itself succeeded.${why} An unclaimed lane is invisible to peers ` +
      `and to your fleet leader, so work gets double-placed. ${summary.hint ?? laneClaimFallback(req)}`;
  }
  return summary;
}

/** WI-5656 + EI-18689334534773965: assembles the final coord:orient response
 *  object with RESULT-DOOR-AWARE key priority. result-door.ts
 *  (`capInjectionText`) caps the FINAL serialized JSON text at a per-result
 *  token budget and keeps only the HEAD, spilling whatever comes after the
 *  cut to scratch — so KEY INSERTION ORDER in this object literal directly
 *  determines what survives in-context.
 *
 *  Priority, highest first:
 *   1. `self` + `recovery` — the one thing a just-compacted successor cannot
 *      get any other way (held-item checkpoints, armed-loop status,
 *      staleness warnings, the self-recall pointer). A just-compacted
 *      agent's MOST fragile turn.
 *   2. The CORE mandate result — `ok` / `me` (assignments) / `claimable`
 *      (backlog) / `inbox` (summary): the entire reason coord:orient is
 *      billed as a one-round-trip bootstrap. EI-18689334534773965: these
 *      previously rode inside `legs.result` spread dead LAST (behind every
 *      preamble leg below), so a large ownerDirectives/instructionPrecedence/
 *      taskToolSchemaPack routinely starved them — degrading the "bootstrap
 *      in ONE call" promise into 3-4 follow-up calls (coord:inbox,
 *      fleet:assignments, work_items:list) to rebuild what orient was
 *      supposed to hand over, on the exact turn (post-compaction) an agent
 *      has the least context left to notice the gap.
 *   2b. `presenceDrift` + `leaderBrief` — fleet-SAFETY critical, and the same
 *      argument as (2) applied to a LEADER. `me.summary.agents` counts only
 *      resolved PRESENCE, so a leader whose `leaderBrief` got spilled reads
 *      `agents: 1` and concludes its whole fleet is dead — the briefing that
 *      would have said `members: 11, dead: 0` is the thing that got cut.
 *      EI-19282566865609166 fixed the FOLD (it now folds on monitor OR
 *      afterCompaction, line ~704) but left the assembled key dead last in
 *      `resultRest`, so on a trimmed payload tier the door reliably ate it
 *      anyway — fold-enabled and never-delivered are indistinguishable to the
 *      reader. Observed live 2026-08-01: two consecutive leader wakes reported
 *      "my 11-member fleet is gone" from a truncated orient whose spilled tail
 *      contained `leaderBrief.summary.members: 11, dead: 0`. `presenceDrift`
 *      was already promoted here (EI-18731216945970087) to make that omission
 *      LOUD; promoting the briefing itself removes the omission.
 *   2c. `laneClaim` (EI-20013545515660920) — whether the caller actually holds
 *      the `planItems` lane it just asked for. Small, and safety-critical in the
 *      same way as (2b): an agent that loses this to the door reads
 *      `intentDeclared: true` and concludes it holds a lane it does not hold,
 *      which is strictly worse than not folding it at all.
 *   3. `ownerDirectives` / `modes` / `instructionPrecedence` / `ideate` /
 *      `captureMiss` / `configIntegrity` / `codexLocks` / `taskToolSchemaPack`
 *      — all re-delivered on subsequent turns via the system prompt +
 *      CTRL:transition (or cheaply re-fetchable), so they are the right
 *      things to spill when the door truncates.
 *   4. The REST of `result` (memory, planEvents, fleetCatchUp,
 *      fleetHealth, announcedGates, paneContext, deepWork, recipes,
 *      pipeline, intentDeclared, fleetDelta, ownerPresent) — genuinely
 *      discretionary supplementary folds, each independently re-fetchable
 *      (memory:search, coord:plan-events, coord:catch-up, …) and the least
 *      costly to lose. Lowest priority, stays last.
 *
 *  Exported (pure, no IO) so a regression test can assert the ordering
 *  directly against the real assembly code, not a mirrored fixture. */
export function assembleOrientOutput(legs: {
  self?: unknown;
  recovery?: unknown;
  continuityProbes?: unknown;
  presenceDrift?: unknown;
  ownerDirectives?: unknown;
  modes?: unknown;
  instructionPrecedence?: unknown;
  ideate?: unknown;
  captureMiss?: unknown;
  configIntegrity?: unknown;
  codexLocks?: unknown;
  taskToolSchemaPack?: unknown;
  result: object;
}): Record<string, unknown> {
  // EI-18731216945970087: `presenceDrift` is destructured OUT here (like ok/me/
  // claimable/inbox) so it rides ONLY the prioritized `legs.presenceDrift` slot
  // below, not also `resultRest` at the bottom — it is a rare, small, safety-
  // critical diagnostic that must survive the result-door's truncation, not get
  // buried behind leaderBrief/memory/planEvents.
  // `leaderBrief` is destructured OUT here (like presenceDrift above it) so it rides
  // the prioritized slot below instead of `resultRest`. See priority tier (2b): a
  // leader that loses this to the result-door reads `me.summary.agents: 1` and
  // concludes its fleet is dead, which is strictly worse than not folding it at all.
  // EI-20013545515660920: `laneClaim` is destructured OUT for the same reason as
  // presenceDrift/leaderBrief above — it is a small, safety-critical diagnostic
  // whose ENTIRE purpose is to stop a failed lane claim from reading as a
  // successful one. Left in `resultRest` (beside `intentDeclared`, tier 4) the
  // result-door would reliably truncate it away on a trimmed payload tier, which
  // would reproduce the exact silent no-op this field was added to kill — the
  // same way EI-19282566865609166 fixed the leaderBrief FOLD but left the key
  // last, so fold-enabled and never-delivered stayed indistinguishable.
  const result = legs.result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (legs.self) out.self = legs.self;
  if (legs.recovery) out.recovery = legs.recovery;
  if (legs.continuityProbes) out.continuityProbes = legs.continuityProbes;

  // CORE mandate (EI-18689334534773965) and the safety-critical leader/lane
  // outcomes. `!== undefined` keeps explicit null ("fold attempted but unknown")
  // distinct from absence ("not applicable"). presenceDrift retains its historical
  // truthy contract because it is sourced from the separately verified handler leg.
  for (const key of ORIENT_CORE_RESULT_KEYS) {
    const value = key === 'presenceDrift' ? legs.presenceDrift : result[key];
    if (key === 'presenceDrift' ? Boolean(value) : value !== undefined) out[key] = value;
  }

  // The authoritative ordering is DATA shared with the floor shaper. Tier 3 is
  // transition-re-delivered; tier 4 is independently re-fetchable. Unknown future
  // keys are appended last as a fail-soft runtime fallback, while the exhaustive
  // type guard above makes adding one without classifying it a build failure.
  const preamble = legs as Record<string, unknown>;
  for (const leg of ORIENT_OPTIONAL_PRIORITY.tier3) {
    for (const key of leg.fields) {
      const value = preamble[key] ?? result[key];
      if (value) out[key] = value;
    }
  }
  for (const leg of ORIENT_OPTIONAL_PRIORITY.tier4) {
    for (const key of leg.fields) {
      if (Object.prototype.hasOwnProperty.call(result, key)) out[key] = result[key];
    }
  }

  const classified = new Set<string>([
    ...ORIENT_CORE_RESULT_KEYS,
    ...ORIENT_OPTIONAL_PRIORITY.tier3.flatMap((leg) => [...leg.fields]),
    ...ORIENT_OPTIONAL_PRIORITY.tier4.flatMap((leg) => [...leg.fields]),
  ]);
  for (const [key, value] of Object.entries(result)) {
    if (!classified.has(key)) out[key] = value;
  }
  return out;
}

/**
 * WI-20183757506064439. coord:orient deliberately skips the result door and the
 * ambient session-tier shaper so the model receives the bootstrap orientation in
 * one call. That exemption is only safe when paired with a tool-local ceiling below
 * the narrowest downstream client cap: the observed unshaped payload was ~110KB and
 * the MCP client rejected it before the agent received any structured result.
 *
 * Keep this ceiling in the measured 15–20KB client-safe band. The orient shaper owns
 * the domain-aware downgrade and has a smaller budget (17KB), leaving room for the
 * transport envelope while preserving the core orientation folds and their fetch
 * pointers. An explicit `payloadTier:'full'` remains the documented escape hatch
 * for callers that knowingly accept the downstream transport's behavior.
 */
export const ORIENT_PAYLOAD_TIER_CEILING_CHARS = 18_000;

/**
 * EI-20226779878046151: the exact tool set re-dispatched by coord:orient's
 * composition. Keep this list in lockstep with the literal `call(<tool>)`
 * sites in composeOrient; the companion regression test fails if a new fold is
 * added without being classified for ambient-transaction behavior.
 *
 * memory:search is the one intentional exception: it is crossWorkspace and is
 * dispatched on the admin handle, so it cannot retain the concrete org-app
 * transaction that this guard protects. Every other entry must declare
 * skipWorkspaceTx:true.
 */
export const ORIENT_FOLD_TOOL_NAMES = [
  'fleet:assignments',
  'work_items:list',
  'work_items:claimable',
  'coord:inbox',
  'work_items:observe',
  'coord:whoami',
  'fleet:leader-brief',
  'scheduler:get_claim_spec',
  'work_items:burn_down',
  'coord:walls',
  'memory:search',
  'coord:plan-events',
  'plans:get',
  'coord:catch-up',
  'coord:glance',
  'recipes:search',
  'coord:declare-intent',
] as const;

export const ORIENT_CROSS_WORKSPACE_FOLD_TOOL_NAMES = ['memory:search'] as const;

/** Bind the one already-assembled orient result and write ONE merged invocation
 * metadata object. The result, priority shape and delivery cursors stay owned by
 * the existing orient path. */
/** Fold the mode rows already read for orientation against ONE selected
 * definition snapshot. Source failure stays explicit while the other orient
 * folds remain available; built-in text must not impersonate an installed mode. */
export async function composeSelectedOrientModes(
  rows: readonly { mode: string; reason: string; setBy: string; ownerDirected: boolean; setAt: unknown }[],
  resolver?: typeof import('../../../agent-identities/source').getSelectedModeDefinitions,
) {
  const active = rows.map((row) => ({
    mode: row.mode, reason: row.reason, setBy: row.setBy,
    ownerDirected: row.ownerDirected, setAt: row.setAt,
  }));
  try {
    const resolve = resolver ?? (await import('../../../agent-identities/source')).getSelectedModeDefinitions;
    const known = rows.filter((row) => modeById(row.mode)).map((row) => row.mode);
    const selected = await resolve(known);
    const missing = known.find((id) => !selected.has(id));
    if (missing) throw new Error('selected definition missing for ' + missing);
    return {
      active,
      contracts: rows.map((row) => selected.get(row.mode)?.contract).filter(Boolean).join('\n\n'),
      definitionRevisions: Object.fromEntries(rows.flatMap((row) => {
        const entry = selected.get(row.mode);
        return entry ? [[row.mode, {
          sourceRevision: entry.sourceRevision, definitionRevision: entry.contractRevision,
        }]] : [];
      })),
    };
  } catch (error) {
    return {
      active, contracts: '',
      definitionUnavailable: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }
}

export async function bindOrientOutputResult<T extends Record<string, unknown>>(
  result: T,
  scope: { ownerId: string | null; workspaceId: string; harness: string | null },
  deltaServed: boolean,
  metadata?: (data: Record<string, unknown>) => void,
  binder?: typeof import('../../../agent-identities/source').bindSelectedIdentityOutputs,
  modeRows?: ReadonlyArray<{ mode: string }> | null,
  assignmentReader?: (ownerId: string) => Promise<Pick<
    import('../presence').PresenceRecord,
    'ownerId' | 'workspaceId' | 'intent' | 'currentPlanSlug' | 'stale'
  > | null>,
): Promise<T> {
  if (!metadata) return result;
  const invocationMetadata: Record<string, unknown> = deltaServed ? { deltaServed: true } : {};
  let bind = binder;
  try {
    bind ??= (await import('../../../agent-identities/source')).bindSelectedIdentityOutputs;
    invocationMetadata.identityContribution = await bind({
      identityId: 'su.practice',
      sourceTier: 'builtin',
      outputs: [{ contributionId: 'coord-orientation', value: result }],
      scope: { ...scope, sink: 'on-demand' },
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    invocationMetadata.identityContribution = {
      identityId: 'su.practice', contributionId: 'coord-orientation',
      status: 'unavailable', errorRef: 'coord:orient:identity-binding-failed',
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }
  if (modeRows !== undefined) {
    if (!scope.ownerId || modeRows === null || !bind) {
      invocationMetadata.rootIdentityContribution = {
        identityId: 'su', status: 'unavailable', errorRef: 'coord:orient:mode-state-unavailable',
      };
    } else {
      const readAssignment = assignmentReader ?? (async (ownerId: string) =>
        (await import('../presence')).getPresence(ownerId));
      const root = await withBoundedTimeout<unknown>(Promise.resolve().then(async () => {
        const presence = await readAssignment(scope.ownerId!);
        if (!presence || presence.stale || presence.ownerId !== scope.ownerId ||
          presence.workspaceId !== scope.workspaceId) {
          throw new Error('current assignment presence is absent, stale or mismatched');
        }
        return bind({
          identityId: 'su', sourceTier: 'builtin',
          outputs: [
            { contributionId: 'coord-orientation', value: result },
            { contributionId: 'current-mode-state', value: modeRows },
            { contributionId: 'current-assignment', value: {
              ownerId: presence.ownerId, intent: presence.intent,
              currentPlanSlug: presence.currentPlanSlug,
            } },
          ],
          scope: { ...scope, sink: 'on-demand' },
          observedAt: new Date().toISOString(),
        });
      }).catch((error) => ({
        identityId: 'su', status: 'unavailable', errorRef: 'coord:orient:root-binding-failed',
        detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      })), {
        fallback: { identityId: 'su', status: 'unavailable', errorRef: 'coord:orient:root-binding-timeout' },
        timeoutMs: ORIENT_PREFLIGHT_LEG_TIMEOUT_MS,
        label: 'orient:root-identity-binding',
      });
      invocationMetadata.rootIdentityContribution = root.value;
    }
  }
  metadata(invocationMetadata);
  return result;
}

export default defineTool({
  name: 'coord:orient',
  description:
    'Wake/session bootstrap in one read: assignments and load, claimable work, inbox, plan events, ' +
    'and fleet health. With `intent`, it also recalls memory and declares the intent. Fleet and ' +
    'workspace are inferred; an optional `fleet` is a compatibility hint only and does not override ' +
    'session membership; pass `harness` only for explicit harness scope.',
  guidance: {
    when:
      'At turn start or wake. Pass `intent` to recall memory and declare it. For repeating leader ' +
      "ticks, pass `mode:'monitor'` to skip heavy backlog/facts/events/catch-up/recipes/recall folds " +
      `while keeping assignments, inbox, and declaration. ${MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION}`,
    notWhen:
      'A human status display or full presence roster; use coord:glance or coord:presence. Do not ' +
      'immediately re-call folds returned here.',
    chaining:
      'Prefer over separate bootstrap calls. A close `recipes` hit → recipes:run it. Then ' +
      'work_items:pickup { id, intent }; claimable[] is advisory (EI-6468).',
    returns:
      'Full mode folds assignments, claimable work, inbox, plan events, memory/recipes when queried, ' +
      'fleet catch-up/health, and post-compaction recovery when requested. Individual folds are ' +
      'bounded and best-effort, so inspect their own degraded/null markers.',
  },
  capability: 'coord:read',
  // tool-call-batching-wrappers P-010 — composite marker: the primitives this bundles.
  // Drives the `composition: 'composite'` tag (agent_tools:list) + the bounded
  // back-pointer on each of these primitives' catalog entries (prompt-assembly).
  replaces: [
    'fleet:assignments',
    'work_items:list',
    'coord:inbox',
    'coord:plan-events',
    'memory:search',
    'recipes:search',
    'coord:declare-intent',
    'coord:catch-up',
    'coord:glance',
    'fleet:leader-brief',
  ],
  requirePrincipal: false,
  // EI-20223970317648049: orient is a compound bootstrap whose sequential
  // best-effort folds can exceed the flat 55s MCP transport deadline during
  // fleet/DB contention. Keep the dispatcher and MCP deadlines aligned with
  // the compound tool's real budget so a healthy server-side orientation is
  // not reported as an unrecoverable request_timeout to a new member.
  timeoutSec: 120,
  // EI-20224868271541667: coord:orient owns its coordination/admin reads and
  // never uses ctx.tx. Holding the ambient org-app workspace transaction
  // across its sequential folds pins a pool slot and can deadlock the
  // bootstrap behind the same pool pressure it is meant to diagnose.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_READ_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(80)
      .optional()
      .describe('Scope assignments + claimable + recall + declare to this harness.'),
    fleet: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Optional compatibility hint from older launch/checkpoint callers; membership remains session-inferred.',
      ),
    claimableState: z
      .string()
      .max(40)
      .optional()
      .describe("Work-item state for the claimable list (default 'open' — the unified claimable token)."),
    claimableLimit: z
      .number()
      .int()
      .nonnegative()
      .max(100)
      .optional()
      .describe('Max claimable items (default 20; 0 skips backlog enumeration).'),
    inboxLimit: z
      .number()
      .int()
      .nonnegative()
      .max(50)
      .optional()
      .describe('Max recent inbox entries (default 10; 0 skips the inbox read).'),
    includeFleet: z
      .boolean()
      .optional()
      .describe(
        'Deprecated alias for the optional fleet folds; false skips both fleet catch-up and fleet health. Explicit canonical controls win.',
      ),
    includeInbox: z
      .boolean()
      .optional()
      .describe('Deprecated alias for inboxLimit; false maps to inboxLimit=0 unless inboxLimit is explicit.'),
    includeAssignments: z
      .boolean()
      .optional()
      .describe(
        'Deprecated no-op accepted for compatibility; assignments are a core orient fold and are always retained.',
      ),
    mode: z
      .enum(['full', 'monitor'])
      .optional()
      .describe(
        "Default 'full'. Pass 'monitor' for a repeating leader/monitor loop tick: skips the claimable backlog, plan-events delta, fleet catch-up, recipes search, and memory recall ENTIRELY (no sub-call, not just capped output) — keeps fleet:assignments (the live/parked/stalled/orphaned counts a monitor loop watches), the inbox read, and coord:declare-intent (when `intent` is passed). The facts fold is NARROWED, not skipped: `dead-end:`/`wall:`/`guard-rail:` still fold every tick (marked `factsNarrowed`); afterCompaction:true forces the full fold. A resolvable FLEET LEADER also gets `leaderBrief` (fleet:leader-brief) folded in — the whole fleet's per-member sessionState/verdict/claims/unanswered/contextPressure in this same round-trip. Sharply cuts per-wake context/token cost for a long-running monitor loop (EI-8300).",
      ),
    intent: hardText(LIMITS.ANNOTATION)
      .optional()
      .describe(
        'Your one-line intent for this turn — DECLARED to peers (coord:declare-intent) AND used as the memory:search recall query. The bootstrap-in-one-call lever.',
      ),
    declared_goal_refs: z
      .array(goalRefSchema)
      .min(1)
      .max(40)
      .optional()
      .describe(
        'Optional typed goal refs explicitly covered by the declared intent — generated goal slugs and WI-/EI- work-item refs are accepted; blank and bare numeric refs are rejected. Omission preserves the untyped path.',
      ),
    memoryQuery: z
      .string()
      .max(500)
      .optional()
      .describe('Explicit memory:search query (overrides `intent` for recall).'),
    planSlug: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe(
        'Plan slug for the declared lane (used with `intent`); null is equivalent to omission for planless lanes.',
      ),
    planItems: z
      .array(z.string().max(20))
      .max(40)
      .optional()
      .describe('Plan items to claim as your lane (used with `intent` + `planSlug`).'),
    memoryLimit: z
      .number()
      .int()
      .nonnegative()
      .max(10)
      .optional()
      .describe('Max memory hits to fold (default 5; 0 skips memory recall).'),
    memoryIncludeSuperseded: z
      .boolean()
      .optional()
      .describe(
        'Explicit history recall: include superseded/soft-forgotten memories in the memory fold. Default false. Returned superseded bodies are prefixed [SUPERSEDED YYYY-MM-DD].',
      ),
    includePlanEvents: z.boolean().optional().describe('Fold the recent plan-events delta (default true).'),
    planEventsSince: z.string().optional().describe('Only plan-events strictly after this ISO timestamp.'),
    includeRecipes: z
      .boolean()
      .optional()
      .describe('Surface reusable code:run recipes relevant to `intent` (default true).'),
    recipesLimit: z
      .number()
      .int()
      .nonnegative()
      .max(5)
      .optional()
      .describe('Max relevant recipes to surface (default 3; 0 skips recipe search).'),
    includePeersKnow: z
      .boolean()
      .optional()
      .describe(
        'Fold a peers-know hint when your declared `intent` semantically matches a CLOSED consult in the archive: the settled answer one-liner + source consult + a consult:get_feedback pointer (default true; absent on no-match — zero cost).',
      ),
    includeFleetCatchUp: z
      .boolean()
      .optional()
      .describe(
        "Fold a bounded catch-up of YOUR fleet's audience-history when you're in a named fleet (default true).",
      ),
    includeFleetCatchup: z
      .boolean()
      .optional()
      .describe(
        'Deprecated alias for includeFleetCatchUp; accepted for compatibility with stale guidance using the older camelcase spelling.',
      ),
    includeCatchup: z
      .boolean()
      .optional()
      .describe(
        'Deprecated alias for includeFleetCatchUp; accepted for compatibility with older launch/checkpoint guidance.',
      ),
    fleetCatchUpLimit: z
      .number()
      .int()
      .nonnegative()
      .max(25)
      .optional()
      .describe('Max fleet catch-up messages to fold (default 8; 0 skips the catch-up fold).'),
    includeFleetHealth: z
      .boolean()
      .optional()
      .describe(
        "Fold a COMPACT fleet-health glance (bees running/working, staged wakes, paused governor buckets) when you're in a named fleet (default true; full mode only) — the coord:glance health read agents otherwise re-fetch right after orient.",
      ),
    afterCompaction: z
      .boolean()
      .optional()
      .describe(
        'Pass true on your FIRST orient after a compaction: folds a recovery block — your held work-items’ checkpoints, armed-loop status, staleness_warnings (presence/fleet/claims that changed AFTER your summary was written — the summary’s view of them is stale), and the self-recall pointer (pre-compaction turns are searchable via sessions:search { session:’self’ }).',
      ),
  }),
  // Orient is a deliberately broad bootstrap aggregate. Keep its structured
  // result open-ended while naming stable roots consumed by callers.
  result: z
    .object({
      ok: z.boolean().optional(),
      status: z.string().optional(),
      self: z.unknown().optional(),
      assignments: z.unknown().optional(),
      claimable: z.unknown().optional(),
      inbox: z.unknown().optional(),
      planEvents: z.unknown().optional(),
      memory: z.unknown().optional(),
      recipes: z.unknown().optional(),
      fleet: z.unknown().optional(),
      leaderBrief: z.unknown().optional(),
      recovery: z.unknown().optional(),
      warning: z.string().optional(),
    })
    .passthrough(),
  // context-trimming-tiers P-012: orient is the fattest bootstrap read (one
  // unshaped call measured ~43k tokens in the 2026-07-01 fleet incident). The
  // tier shapers project the SAME orientation with caps + fetch-pointers;
  // `payloadTier: 'full'` on any call returns the unshaped result.
  shape: {
    standard: (data, sctx) => shapeOrient(data, sctx.tier as 'standard'),
    trimmed: (data, sctx) => shapeOrient(data, sctx.tier as 'trimmed'),
  },
  // WI-37843 [owner 2026-08-10]: "this is a very important tool that is only
  // called once at session start. remove the routine session-tier limit."
  //
  // Orient was cut by THREE independent mechanisms, and each of the three
  // declarations below removes exactly one. Any subset is a half-fix, because
  // whichever you leave keeps cutting on its own:
  //
  //   1. THE RESULT DOOR truncated 1140 of 1140 calls (100%), spilling the
  //      remainder to scratch for the agent to page back — recoverable, but it
  //      costs round-trips on the one turn an agent can least afford them.
  //      → skipResultDoor
  //   2. THE TIER SHAPER. MCP agent sessions carry ctx_tier='trimmed', so
  //      shapeOrient's trimmed projection ran on essentially every agent call
  //      and produced ~24k chars where the real payload is ~66k (~16.5k tok).
  //      THIS is what actually cut agents. → ignoreSessionPayloadTier
  //   3. THE CLIENT-SAFE HARD CEILING (18k chars) — force-shapes above the cap.
  //      → payloadTierCeilingChars. This is intentionally finite: the result-door
  //      exemption must never hand an ordinary orient call to the client at ~110KB.
  //
  // ⚠ CORRECTION (2026-08-10, same work-item). An earlier revision of this
  // comment asserted that "the payload-tier ceiling had ALREADY force-shaped it
  // before the door ever ran". That is WRONG for the sessions that matter, and
  // it was inferred from a percentile shape (p99 = 29,908 of 30,000, read as a
  // clamp signature) rather than from the resolution code. For a trimmed-tier
  // agent, mechanism 2 produces the ~24k result and the ceiling never fires;
  // the ceiling only binds callers who explicitly asked for 'full'. Left as a
  // correction rather than deleted, because the wrong reading is re-derivable
  // from the same measurement and the next reader should meet the refutation.
  //
  // 'oversize-by-design', NOT 'programmatic-caller': orient's reader is a MODEL,
  // so it must keep the prose annotations (the store-identity wrong-database
  // warning above all) that a hook-parsed body has to be spared.
  skipResultDoor: 'oversize-by-design',
  payloadTierCeilingChars: ORIENT_PAYLOAD_TIER_CEILING_CHARS,
  // The load-bearing half of the fix (see mechanism 2 above). Note what this
  // does NOT do: the `shape` shapers declared above stay in place and are still
  // force-applied by the client-safe hard ceiling past ORIENT_PAYLOAD_TIER_CEILING_CHARS.
  // Deleting them to "finish" the uncapping would remove the degradation path
  // and re-open the 2026-07-01 43k-token incident (P-012).
  ignoreSessionPayloadTier: true,
  // Keep the existing handler body byte-stable; the aggregate fence is the only wrapper change.
  // prettier-ignore
  async handler(args, ctx) {
    const aggregateFallback = createOrientAggregateFallback();
    const aggregate = await withOrientAggregateTimeout(
      async () => {
    // Soft identity resolve — orient is a READ; a bare loopback caller without an
    // attributable coord identity still gets a (fleet-wide) orientation.
    let ownerId: string | undefined;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = undefined;
    }
    // P-012: start the caller's canonical mode read at the first point identity
    // exists. The same promise is reused after composition for the modes contract
    // fold, so adding the GOAL portfolio does not add a second agent_modes query.
    const orientWorkspaceId = resolveConcreteWorkspaceId(
      (ctx as { workspaceId?: string | null }).workspaceId,
    );
    // EI-21589715378243224: seed the aggregate fallback before any handler-owned
    // preflight read. A slow preflight must not erase the identity/host anchors
    // that are already available synchronously.
    snapshotOrientAggregate(aggregateFallback, {
      self: resolveSelfRef(ctx),
      host: getHostSnapshot(),
    } as Partial<OrientResult>);
    // Start post-compaction recovery before the other preflight reads. The
    // recovery has its own 15s bound and its result is copied into the aggregate
    // fallback as soon as it settles, so a later preflight stall cannot hide the
    // safety-critical recovery block.
    const compactionRecoveryPromise =
      args.afterCompaction && ownerId
        ? (async () => {
            try {
              const { buildCompactionRecovery } = await import('../compaction-recovery');
              const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
              const sessionHarness =
                args.harness ?? (ctx as { harnessSlug?: string | null }).harnessSlug ?? null;
              const recoveryResult = await withBoundedTimeout(buildCompactionRecovery(ownerId, ws, { sessionHarness }), {
                fallback: undefined,
                timeoutMs: ORIENT_COMPACTION_RECOVERY_TIMEOUT_MS,
                label: 'orient:buildCompactionRecovery',
              });
              return recoveryResult.value;
            } catch {
              return undefined;
            }
          })()
        : undefined;
    if (compactionRecoveryPromise) {
      void compactionRecoveryPromise
        .then((recovery) => {
          if (recovery) snapshotOrientAggregate(aggregateFallback, { recovery });
        })
        .catch(() => {
          /* the main await remains fail-soft; the fallback must stay honest */
        });
    }
    const recoveredFleetScopePromise = compactionRecoveryPromise
      ? compactionRecoveryPromise.then((recovery) => extractRecoveredFleetScope(recovery?.control)).catch(() => null)
      : undefined;
    // P-002 / D-001 and P-004: these handler-owned reads used to run serially and
    // without a leg deadline, so a single stalled preflight prevented composeOrient
    // from ever reaching its own bounded core reads. Start all independent reads
    // together and keep their fallbacks explicit.
    const runtimeModesPromise = ownerId
      ? withBoundedTimeout(
          Promise.resolve()
            .then(() => getModes(orientWorkspaceId, ownerId))
            .catch(() => null),
          { fallback: null, timeoutMs: ORIENT_PREFLIGHT_LEG_TIMEOUT_MS, label: 'orient:modes' },
        ).then((r) => r.value)
      : Promise.resolve(null);
    const driveModePromise = ownerId
      ? withBoundedTimeout(
          Promise.resolve().then(() => classifyOwnerDriveMode(ownerId)),
          { fallback: null, timeoutMs: ORIENT_PREFLIGHT_LEG_TIMEOUT_MS, label: 'orient:driveMode' },
        ).then((r) => r.value?.driveMode)
      : Promise.resolve<string | undefined>(undefined);
    const ownerPresentPromise = withBoundedTimeout(
      Promise.resolve().then(async () => {
        const ws = (ctx as { workspaceId?: string | null }).workspaceId ?? activeWorkspaceId();
        const op = await readOwnerPresence(ws);
        return { present: op.present, lastSeenAgoMs: op.lastSeenAgoMs, activeSessions: op.activeSessions };
      }),
      { fallback: null, timeoutMs: ORIENT_PREFLIGHT_LEG_TIMEOUT_MS, label: 'orient:ownerPresence' },
    ).then((r) => r.value as OrientResult['ownerPresent']);
    const launchFleetMembership = deriveFleetMembership();
    const fleetMembershipPromise = withBoundedTimeout(
      Promise.resolve().then(() => resolvePresenceFleet(ownerId, launchFleetMembership)),
      {
        fallback: launchFleetMembership,
        timeoutMs: ORIENT_PREFLIGHT_LEG_TIMEOUT_MS,
        label: 'orient:fleetMembership',
      },
    ).then((r) => r.value);
    const monitorDeltaFlagPromise =
      args.mode === 'monitor' && ownerId
        ? withBoundedTimeout(
            Promise.resolve()
              .then(() => getFlag(FLAGS.ORIENT_MONITOR_DELTA, 'system'))
              .catch(() => true),
            { fallback: true, timeoutMs: ORIENT_PREFLIGHT_LEG_TIMEOUT_MS, label: 'orient:monitorDeltaFlag' },
          ).then((r) => r.value)
        : Promise.resolve(false);
    const fullDeltaFlagPromise =
      args.mode !== 'monitor' && ownerId
        ? withBoundedTimeout(
            Promise.resolve()
              .then(() => getFlag(FLAGS.ORIENT_FULL_DELTA, 'system'))
              .catch(() => true),
            { fallback: true, timeoutMs: ORIENT_PREFLIGHT_LEG_TIMEOUT_MS, label: 'orient:fullDeltaFlag' },
          ).then((r) => r.value)
        : Promise.resolve(false);
    const [driveMode, ownerPresent, fleetMembership, monitorDeltaOn, fullDeltaOn, runtimeModeRows] =
      await Promise.all([
        driveModePromise,
        ownerPresentPromise,
        fleetMembershipPromise,
        monitorDeltaFlagPromise,
        fullDeltaFlagPromise,
        runtimeModesPromise,
      ]);
    // P-004 (fleet-deltas-leader-primitives): resolve the monitor fleet-delta seam —
    // an attributable caller in monitor mode, with the flag ON, gets the
    // (owner,'fleet:monitor') server-side cursor closure. Fail-open: a flag-read
    // failure defaults ON (it's a read-path economizer); composeOrient itself
    // fail-opens to the full roster on any cursor error.
    let fleetCursor: ((next: CursorState) => Promise<AckResult>) | undefined;
    if (args.mode === 'monitor' && ownerId && monitorDeltaOn) {
        const oid = ownerId;
        fleetCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'fleet:monitor', next);
        };
    }
    // fleet-deltas-leader-primitives P-005: the FULL-mode sibling of the monitor
    // delta above — same ONE 'fleet:monitor' surface (D-002: one roster truth
    // regardless of which mode reads it) plus two new surfaces for the
    // append-only-log folds (plan-events, fleet catch-up). Own flag
    // (ORIENT_FULL_DELTA) so it can be independently killed without touching the
    // separately-shipped, separately-tested monitor path above.
    let planEventsCursor: ((next: CursorState) => Promise<AckResult>) | undefined;
    let fleetCatchUpCursor: ((next: CursorState) => Promise<AckResult>) | undefined;
    if (args.mode !== 'monitor' && ownerId && fullDeltaOn) {
        const oid = ownerId;
        fleetCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'fleet:monitor', next);
        };
        planEventsCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'orient:planEvents', next);
        };
        fleetCatchUpCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'orient:fleetCatchUp', next);
        };
    }
    // P-015: leadership is mutable at runtime (fleet:take-leadership / join / leave),
    // but PAPERCUSP_FLEET_* is immutable launch context. Resolve the live presence
    // row first so a newly-installed leader gets the WHOLE fleet brief and a caller
    // that left a fleet does not resurrect stale membership. Only a failed presence
    // read may fall back to launch context.
    // EI-20201050911711528: presence membership is still the live fleet-slug
    // projection, but the registry is authoritative for WHO LEADS that fleet.
    // A failed fleet:take-leadership projection (or a stale append-only role fact)
    // can leave the caller labeled 'member' even after agent_fleets.leader_owner_id
    // names it as leader. P-007 requires this check on ordinary orient too: the
    // registry, not a stale presence role, decides who receives the leader-only fold.
    const currentFleetSlug = fleetMembership?.fleetSlug;
    const fleetLeadershipCheck =
      ownerId &&
      currentFleetSlug &&
      fleetMembership?.fleetRole !== 'leader'
        ? async () => {
            const { getFleet } = await import('../../../agent-fleets-store');
            const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
            const fleet = await getFleet(ws, currentFleetSlug);
            return fleet?.leaderOwnerId === ownerId ? currentFleetSlug : null;
          }
        : undefined;
    // EI-18731216945970087: a resolvable FLEET LEADER on a monitor tick was seeing
    // `agents:1` (agents:'me' is BY DESIGN caller-scoped — see OrientResult.me) with
    // `leaderBrief` silently ABSENT — byte-indistinguishable from "all quiet" — because
    // presence (coord_presence.fleet_slug/fleet_role, the SOFT membership label
    // resolvePresenceFleet reads) had no row for this caller at the moment of the read,
    // even though `harness_shared.agent_fleets.leader_owner_id` (the durable, single-
    // leader-invariant REGISTRY fact `fleet:take-leadership` writes FIRST — see
    // take-leadership-core.ts step 1) already named them leader. Ground-truthed
    // (fleet:assignments{fleet:<slug>} showed the same caller as live leader in the
    // same window) — a presence/registry disagreement, not a "not a leader" verdict.
    // composeOrient cross-checks the registry via this INJECTED closure (IO stays out
    // of composeOrient, the established pattern for every other fold) — cheap (one
    // indexed lookup on a tiny table) and only actually queried by composeOrient when
    // presence resolved to NO fleet at all in monitor mode (the exact failure shape
    // reported), so every correctly-labeled member's monitor tick (the overwhelmingly
    // common case) pays no extra round-trip.
    // EI-203907: memoize the registry read so presence-drift recovery and the
    // all-led-fleet summary fold share one authoritative list in this orient.
    const readLedFleets = ownerId
      ? (() => {
          let pending: Promise<Array<{ fleetSlug: string }> | null> | undefined;
          return () => {
            pending ??= (async () => {
              const { listFleetsLedBy } = await import('../../../agent-fleets-store');
              const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
              return await listFleetsLedBy(ws, ownerId);
            })().catch(() => null);
            return pending;
          };
        })()
      : undefined;
    const presenceDriftCheck = readLedFleets
      ? async () => {
          const led = await readLedFleets();
          return led?.[0]?.fleetSlug ?? null;
        }
      : undefined;
    // ── role-specific pane folds (voice-public-release-readiness-2026-07-12 P-016):
    // the papercup FAST pane orients with the SAME live-system digest block the
    // converse brain walks in with (papercup-context.ts — one identity, one
    // picture), and the papercup-deep pane orients with its OPEN QUESTION THREAD
    // (directed messages awaiting its reply). The role comes from the dispatch ctx
    // (the signed launch role — same read as agent_tools/list.ts); the gate is the
    // PURE orientRoleFolds. Closures carry the IO (dynamic imports, best-effort)
    // and are INJECTED so composeOrient stays IO-free.
    const roleWants = orientRoleFolds((ctx as { role?: string | null }).role, args.mode);
    let roleFolds: OrientRoleFolds | undefined;
    if (roleWants.paneContext) {
      roleFolds = {
        paneContext: async () => {
          const [pc, { isWorkspaceCoordinationOn }] = await Promise.all([
            import('../../../papercup/papercup-context'),
            import('../../../workspace-brain-scope'),
          ]);
          const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
          // The primary hive the anomalies leg addresses — same resolution as the
          // converse-prompt consumer (first registered project, falling back to
          // the workspace id); an orient scoped by `harness` uses that directly.
          let primaryHive: string | null = args.harness ?? null;
          if (!primaryHive) {
            try {
              const { loadHarnessRegistry } = await import('../../../harness-registry');
              const reg = await loadHarnessRegistry(ws);
              primaryHive = reg.projects[0]?.slug ?? null;
            } catch {
              primaryHive = null;
            }
          }
          const potSlug = primaryHive ?? ws;
          // Heading scope LABEL only (workspace-scoped-coordination D-008) — the
          // anomalies leg's addressing stays potSlug, exactly like converse-prompt.
          const scopeLabel = pc.sentinelScopeLabel(ws, potSlug, await isWorkspaceCoordinationOn().catch(() => false));
          const input = await pc.gatherSentinelContext(pc.buildSentinelContextDeps(ws, potSlug), {
            potSlug: scopeLabel,
          });
          const block = pc.renderSentinelContext(input);
          return block.trim() ? block : null;
        },
      };
    }
    if (roleWants.deepWork && ownerId) {
      const oid = ownerId;
      roleFolds = {
        ...(roleFolds ?? {}),
        deepWork: async () => {
          const { fetchUnansweredDirected } = await import('../unanswered-directed');
          const summary = (await fetchUnansweredDirected([oid])).get(oid);
          if (!summary) return { count: 0, oldestAgeMs: 0, newest: [] };
          return {
            count: summary.count,
            oldestAgeMs: summary.oldestAgeMs,
            newest: summary.newest,
            ...(summary.count > 0 ? { note: ORIENT_DEEP_WORK_NOTE } : {}),
          };
        },
      };
    }
    // P-012: only a session whose GOAL mode carries a concrete subject receives
    // the portfolio. Derivation reuses the board/session canonical predicate;
    // ordinary AUTO/fleet/plan agents therefore pay no portfolio projection.
    // Start before composeOrient so the DB work overlaps its sequential folds.
    const goalSubject = goalIdFromModes(runtimeModeRows);
    const goalPortfolioReadPromise = goalSubject
      ? (async () => {
          const { readGoalPortfolioBrief } = await import('../../../goal-launch-settings');
          return readGoalPortfolioBrief({
            workspaceId: orientWorkspaceId,
            goalId: goalSubject,
            attestOwnerId: ownerId,
          });
        })()
      : undefined;
    // Display can degrade to null, but the obligation provider must receive the
    // original rejection: a fulfilled null means a measured absence of a goal.
    const goalPortfolioPromise = goalPortfolioReadPromise?.catch(() => null);
    const goalObligationsPromise =
      goalSubject && ownerId
        ? (async () => {
            try {
              const { readAgentObligationAgenda, projectAgentTurnStartObligationBrief } = await import(
                '../../../agent-obligation-reader'
              );
              const read = await readAgentObligationAgenda({
                workspaceId: orientWorkspaceId,
                ownerId,
                goalId: goalSubject,
                // Reuse the already-started canonical portfolio read so orient's
                // two GOAL core folds describe one snapshot rather than racing
                // independent reads of the same mutable state.
                deps: {
                  goalPortfolio: async () => (goalPortfolioReadPromise ? await goalPortfolioReadPromise : null),
                },
              });
              return projectAgentTurnStartObligationBrief(read.agenda);
            } catch {
              return null;
            }
          })()
        : undefined;
    // WI-2140700: the holder's own every-wake owner-report obligation — computed
    // from the same three rails the goal-owner-report watchdog measures and folded
    // into `modes.ownerReport`, which the GOAL contract tells the holder to read
    // FIRST each wake. A cold wake has no memory of having reported; this is it.
    // Fail-open: null on any read error; undefined for a non-GOAL caller.
    const goalOwnerReportPromise =
      goalSubject && ownerId
        ? (async () => {
            try {
              const [{ readGoalOwnerReportObligation }, { getOrgPg }] = await Promise.all([
                import('../../../system-health/goal-owner-report-watchdog'),
                import('@papercusp/db-org'),
              ]);
              return await readGoalOwnerReportObligation(getOrgPg().sql, {
                workspaceId: orientWorkspaceId,
                ownerId,
                goalId: goalSubject,
              });
            } catch {
              return null;
            }
          })()
        : undefined;
    // WI-4533 (P-006): START the pipeline-health read HERE — before composeOrient's sequential
    // legs — and hand composeOrient a closure over the in-flight promise. Its latency therefore
    // overlaps reads that were happening anyway (orient p50 1.75s; this leg is cached and usually
    // ~ms), instead of being added to them. `.catch(() => null)` is belt-and-braces: the fetch is
    // already fail-soft, but an unhandled rejection on a promise created early and awaited late
    // must be impossible.
    const pipelinePromise = (async () => {
      const { fetchOrientPipeline } = await import('../pipeline-health');
      return fetchOrientPipeline(args.harness ?? (ctx as { harnessSlug?: string | null }).harnessSlug ?? undefined);
    })().catch(() => null);
    // WI-42290: executable check rows are replayed on the same mandatory orient
    // bootstrap every loop wake already performs. Start the bounded read/dispatch
    // fold early so its latency overlaps the existing orientation legs; fail-soft
    // means neither a bad persisted row nor an unavailable read can eat orient.
    const continuityProbesPromise =
      ownerId && ctx.dispatchTool
        ? (async () => {
            try {
              const { runContinuityProbesForOwner } = await import('../../../continuity-probes');
              const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
              const batch = await runContinuityProbesForOwner(ownerId, ws, ctx);
              return batch.total > 0 ? batch : undefined;
            } catch {
              return undefined;
            }
          })()
        : undefined;
    const orientInnerCall = inProcessCall(ctx, { telemetrySurface: 'orient', ignoreSessionPayloadTier: true });
    const fleetSummariesFold = readLedFleets
      ? async (homeFleetSlug: string, homeBrief: unknown | null | undefined) => {
          const led = await readLedFleets();
          if (!led) return null;
          const summaryOf = (brief: unknown): Record<string, unknown> | null => {
            if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return null;
            const summary = (brief as Record<string, unknown>).summary;
            return summary && typeof summary === 'object' && !Array.isArray(summary)
              ? { ...(summary as Record<string, unknown>) }
              : null;
          };
          return await Promise.all(
            led.map(async ({ fleetSlug }) => {
              if (fleetSlug === homeFleetSlug) {
                const summary = summaryOf(homeBrief);
                return summary
                  ? { fleet: fleetSlug, summary }
                  : { fleet: fleetSlug, summary: null, unavailable: true as const, reason: 'home-brief-unavailable' };
              }
              try {
                const brief = await orientInnerCall('fleet:leader-brief', {
                  fleet: fleetSlug,
                  ...(args.harness ? { harness: args.harness } : {}),
                });
                const summary = summaryOf(brief);
                return summary
                  ? { fleet: fleetSlug, summary }
                  : { fleet: fleetSlug, summary: null, unavailable: true as const, reason: 'summary-unavailable' };
              } catch {
                return {
                  fleet: fleetSlug,
                  summary: null,
                  unavailable: true as const,
                  reason: 'leader-brief-read-failed',
                };
              }
            }),
          );
        }
      : undefined;
    const result = await composeOrient(
      args,
      // P-001 (orient-recall-quality-2026-07-12): the folded memory:search records
      // its recall telemetry under surface 'orient' (not generic 'search') so
      // orient's recall quality is measurable per-entry-point. Telemetry only.
      //
      // WI-37843: `ignoreSessionPayloadTier` is the SUB-READ half of orient's
      // uncapping, and without it the tool declaration above is a half-fix.
      // orient serving 'full' only governs orient's OWN payload; each folded
      // sub-read re-resolves the tier from the inherited ctx, so under a trimmed
      // agent session every fold still arrived shaped — including
      // fleet:assignments projecting per-agent `claims[]` down to a NUMBER, the
      // type change behind the planNow failure (EI-20108229813877389).
      orientInnerCall,
      ownerId,
      driveMode,
      ownerPresent,
      fleetCursor,
      planEventsCursor,
      fleetCatchUpCursor,
      fleetMembership,
      roleFolds,
      () => pipelinePromise,
      presenceDriftCheck,
      fleetLeadershipCheck,
      // P-008 (b): the identity the standing-facts fold re-checks declared cell
      // dependencies under. Best-effort — an unattributable caller (no ownerId)
      // gets no re-check rather than a read made under a guessed identity.
      (() => {
        try {
          if (!ownerId) return undefined;
          return cellReaderFromCtx({ ownerId }, ctx as CellReaderCtxLike);
        } catch {
          return undefined;
        }
      })(),
      // P-006 (consult-revival-and-honest-min-2026-08-18): the peers-know archive
      // lookup. Heavy seams (embedder graph + PG) imported per-call inside the
      // closure — never at registration (the same constraint get-feedback.ts
      // documents) — and injected so composeOrient stays IO-free. Best-effort:
      // any failure resolves null, and the module itself never throws.
      async (intent: string) => {
        try {
          const [{ peersKnowLookup }, { buildQueryEmbedderResolved }, { resolveProseProfileSelection }, { getOrgPg }] = await Promise.all([
            import('../../../consult/peers-know'),
            import('../../search/embedder'),
            import('../../../search/prose-vector-dims'),
            import('@papercusp/db-org'),
          ]);
          const ws = (ctx as { workspaceId?: string | null }).workspaceId ?? activeWorkspaceId();
          if (!ws) return null;
          const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: 1_500 });
          const profile = resolved
            ? resolveProseProfileSelection(resolved.mode, resolved.profile)
            : null;
          return await peersKnowLookup(
            getOrgPg().sql,
            resolved && profile ? { embed: resolved.embed, profile } : null,
            { workspaceId: ws, intent },
          );
        } catch {
          return null;
        }
      },
      fleetSummariesFold,
      recoveredFleetScopePromise ? () => recoveredFleetScopePromise : undefined,
      (snapshot) => snapshotOrientAggregate(aggregateFallback, snapshot),
      goalPortfolioPromise ? () => goalPortfolioPromise : undefined,
      goalObligationsPromise ? () => goalObligationsPromise : undefined,
    );
    // Await the already-running recovery only after composeOrient completes;
    // this preserves the existing fold output while keeping the two budgets
    // overlapped rather than serial.
    const recovery = compactionRecoveryPromise ? await compactionRecoveryPromise : undefined;
    const continuityProbes = continuityProbesPromise ? await continuityProbesPromise : undefined;
    // capless-adaptive-resource-governor P-011: bounded, best-effort shared state.
    // Read after composition so governor availability cannot delay the core orient legs.
    try {
      const { readGovernorStateSnapshot, buildGovernorOrientSummary } = await import('../../../resource-governor/state-snapshot');
      const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
      const governor = await readGovernorStateSnapshot(ws);
      result.governor = governor ? buildGovernorOrientSummary(governor.payload) : null;
    } catch {
      result.governor = null;
    }
    // EI-21589715378243224: refresh the aggregate fallback after the handler-owned
    // enrichment folds have settled. The compose progress callback above preserves
    // the useful core snapshot, but recovery/continuity are assembled here and the
    // governor is attached here; a later handler fold (for example disclosure
    // recording) may still exceed the aggregate deadline. Keep those enriched
    // values in the stable partial response instead of returning a pre-handler
    // snapshot that falsely reads as if recovery never ran.
    snapshotOrientAggregate(aggregateFallback, {
      ...result,
      ...(recovery !== undefined ? { recovery } : {}),
      ...(continuityProbes !== undefined ? { continuityProbes } : {}),
    } as OrientResult);
    // popup-agent-state-coverage-2026-08-18 P-005 (D-008): RECORD the six
    // disclosure markers this payload carried, so the HUD sessions popup can
    // show a human what THIS agent was actually told about what its reads left
    // out. Deliberately here, in the handler, and not inside composeOrient —
    // that function is contractually IO-free so it stays unit-testable, and its
    // every ctx-dependent value is injected.
    //
    // Recorded rather than re-derived at view time because four of the six are
    // artifacts of the ARGUMENTS of this very call (mode, claimableLimit,
    // recipesLimit/intent, the caller's drive-mode classification). A popup
    // recomputing them would measure the VIEWER's bounds and render the answer
    // as the agent's — coming back clean nearly always, which reads as "nothing
    // was withheld". See agent-orient-disclosures.ts for the full argument.
    //
    // Awaited, not fire-and-forget: it is one bounded upsert that no-ops when
    // the markers are unchanged, and its own catch turns any failure into "no
    // recording" — which renders as nothing, never as a false clean.
    if (ownerId) {
      const ws = (ctx as { workspaceId?: string | null }).workspaceId ?? 'default';
      await recordOrientDisclosures(ownerId, ws, collectOrientDisclosures(result));
    }
    // Fold in the caller's own identity so the orientation states YOUR ownerId
    // explicitly (the roster/assignments it composes are about peers; `self` is
    // the "and this is you" anchor). Best-effort — omitted for an unattributable
    // caller. See self-marker.ts for why this is a response-layer overlay.
    const self = resolveSelfRef(ctx);
    // modes-and-intake-ux-2026-07-05 P-008: re-inject the caller's ACTIVE mode
    // contracts each orient — the always-present prompt carries only the one-line
    // mode index; orient (the mandated bootstrap read, run every wake) is the
    // activation-scoped carry surface, same pattern as checkpoint re-injection.
    // A peer-set mode thus takes effect at the target's next turn boundary.
    // Best-effort: a mode-read failure never breaks orientation.
    let modes:
      | {
          active: Array<Record<string, unknown>>;
          contracts: string;
          definitionRevisions?: Record<string, { sourceRevision: string; definitionRevision: string }>;
          definitionUnavailable?: string;
          /** WI-2140700: GOAL holders only — the every-wake owner-report verdict
           *  (null = read failed / no active goal-mode row; absent = not a GOAL caller). */
          ownerReport?: GoalOwnerReportObligation | null;
        }
      | undefined;
    let runtimeModeIds: string[] | null = null;
    if (runtimeModeRows) {
      runtimeModeIds = runtimeModeRows.map((row) => row.mode);
      if (runtimeModeRows.length) {
        modes = await composeSelectedOrientModes(runtimeModeRows);
        if (goalOwnerReportPromise) modes.ownerReport = await goalOwnerReportPromise;
      }
    }
    // P-022: the structured counterpart of the prose mode contracts. Resolve
    // the effective mission from canonical runtime mode + live fleet role +
    // durable session scope, and explicitly suppress generic rules that do not
    // apply now. A failed mode read omits the trace rather than falsely falling
    // back to confirm-first. The watermark is content-addressed; any mismatch
    // requires a full coord:orient replacement, never a partial merge.
    let instructionPrecedence: unknown;
    if (ownerId && runtimeModeIds) {
      try {
        const [{ buildInstructionPrecedenceTrace }, { getSessionBrief }] = await Promise.all([
          import('../../../instruction-lint'),
          import('../../../session-brief'),
        ]);
        const brief = await getSessionBrief({ ownerId });
        const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
        instructionPrecedence = buildInstructionPrecedenceTrace({
          source: 'coord:orient',
          ownerId,
          modes: runtimeModeIds,
          route: fleetMembership?.fleetSlug
            ? {
                kind: 'fleet',
                fleet: fleetMembership.fleetSlug,
                role: fleetMembership.fleetRole,
              }
            : { kind: 'self' },
          scope: {
            workspace: ws,
            harness: args.harness ?? brief?.harnessSlug ?? null,
            plan: args.planSlug ?? brief?.currentPlanSlug ?? null,
            items: args.planItems ?? [],
          },
        });
      } catch {
        /* fail-soft */
      }
    }
    // su-ideate-learning-substrate-2026-07-10 P-011: when the caller's active
    // modes include 'ideate', fold ONE line telling them whether they are OVERDUE
    // to run an ideate pass — keyed on OBSERVATION COUNT, never elapsed days
    // (D-015). Gated to ideate-active callers, fail-soft, a few indexed reads.
    // Same handler-side best-effort IO pattern as the modes fold above.
    let ideate: import('./orient-ideate-hint').IdeateHint | undefined;
    if (ownerId && modes?.active?.some((m) => m.mode === 'ideate')) {
      try {
        const { computeIdeateOverdue } = await import('./orient-ideate-hint');
        const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
        ideate = await computeIdeateOverdue({ ownerId, workspaceId: ws });
      } catch {
        /* fail-soft */
      }
    }
    // su-ideate-learning-substrate-2026-07-10 P-022(a): the capture-MISS advisory
    // (D-017). A high-signal turn — an error-retry cluster / EI-* reference /
    // durable-discovery language in the caller's boundary artifacts — that filed
    // ZERO lane:observation rows gets ONE advisory line. A NUDGE, never a quota
    // (D-017 rejects volume quotas). Fail-soft; the resolver short-circuits the
    // cost for anyone who already filed, and this is ATTACHED only when it fires
    // (a healthy session sees nothing).
    let captureMiss: import('./orient-capture-miss-hint').CaptureMissHint | undefined;
    if (ownerId) {
      try {
        const { resolveCaptureMissHint } = await import('./orient-capture-miss-hint');
        captureMiss = await resolveCaptureMissHint({ ownerId, harness: args.harness });
      } catch {
        /* fail-soft */
      }
    }
    // WI-4562: a Claude Code config save (/model, /effort, theme) REWRITES the session's
    // settings.json from its own in-memory keys and drops every psu key — silently
    // de-enrolling the edit-LOCK hook, the coord inbox, turn-start recall, and the
    // SessionStart epoch bump, plus the papercusp-su MCP entry. The existing self-heals
    // cannot catch it: they live INSIDE the SessionStart hook whose registration the wipe
    // deletes. orient is the right detector precisely because it is operator-side and
    // needs no hooks — and because the repair takes effect in the RUNNING session
    // (hooks are re-read from the file), orient AUTO-REPAIRS rather than only warning:
    // the moment a de-enrolled session next orients, its capabilities are restored.
    // Reported ONLY when something was actually broken — a healthy session pays a couple
    // of file reads and adds no key.
    let configIntegrity: unknown;
    if (ownerId) {
      try {
        const { loadSessionConfigState, checkSessionConfigIntegrityForClient, repairSessionConfigOnDisk } =
          await import('../../../session-config-integrity');
        const advRow = await (await import('../../../adv-sessions')).latestAdvSessionByCoordOwner(ownerId);
        const recordedClient = advRow?.agent;
        // WI-38349: WHERE this session's config dir is is an OBSERVATION, not the
        // `session-claude/<ownerId>` formula — several launch paths key it by spawn
        // id instead, and reading the formula's path found nothing for ~80% of
        // active sessions, which the checker then reported as de-enrollment. The
        // live process is the ground truth; coord_presence.pid is the anchor that
        // finds it (it records the psu-launcher, whose child is the claude CLI).
        const pidHint = await readSessionPidHint(ownerId);
        const locator = { pidHint, sessionId: advRow?.sessionId ?? null };
        const state = loadSessionConfigState(ownerId, undefined, locator);
        const verdict = checkSessionConfigIntegrityForClient(state, recordedClient);
        if (verdict?.unknown) {
          // Deliberately NOT a de-enrollment claim: nothing was checked. Reported so
          // the gap is visible rather than silently swallowed — and worded so it can
          // never be mistaken for the alarm below.
          configIntegrity = {
            status: 'unknown',
            checked: false,
            reason: verdict.unknownReason,
            resolutionTried: state.configDirUnresolvedReason,
            warning:
              "CONFIG INTEGRITY NOT CHECKED (WI-38349): this session's real CLAUDE_CONFIG_DIR could not be located, so the WI-4562 de-enrollment check did not run. This says NOTHING about your hooks, edit-locks, inbox or MCP — do not read it as damage. If you want certainty, check that your live process's CLAUDE_CONFIG_DIR holds a settings.json carrying the global hook block.",
          };
        } else if (verdict && !verdict.ok) {
          const repair = repairSessionConfigOnDisk(ownerId, undefined, recordedClient, locator);
          const repairedCleanly = repair.repaired && repair.stillBroken.length === 0;
          configIntegrity = {
            ...verdict,
            configDir: state.configDir,
            configDirSource: state.configDirSource,
            repaired: repair.repaired,
            fixed: repair.fixed,
            wrote: repair.wrote,
            stillBroken: repair.stillBroken,
            skipped: repair.skipped,
            residualCaveats: repair.residualCaveats,
            warning: repairedCleanly
              ? 'YOUR SESSION WAS DE-ENROLLED (WI-4562) and has just been AUTO-REPAIRED. Claude Code had rewritten this session config and dropped psu-owned keys; orient restored them on disk. Hook registrations are re-read from the file, so delivery (edit-locks, coord inbox, turn-start recall) resumes WITHOUT a relaunch — verified live on su-5d6764f9, where the coord inbox delivered a 40+ message backlog immediately after repair. See residualCaveats for the two things a disk write cannot undo.'
              : // WI-38349: never point at `stillBroken` when it is EMPTY — the old
                // wording told the reader to "see stillBroken" and handed them an
                // empty list. When the repair did not RUN, `skipped` says why.
                repair.skipped
                ? `YOUR SESSION IS RUNNING DE-ENROLLED (WI-4562) and auto-repair did NOT run: ${repair.skipped}. The capabilities listed in consequences remain OFF. Relaunch the session, or repair its real config dir (${state.configDir ?? 'unresolved'}) by hand.`
                : 'YOUR SESSION IS RUNNING DE-ENROLLED (WI-4562) and auto-repair did NOT fully succeed — see stillBroken. Claude Code rewrote this session config and dropped psu-owned keys, so some capabilities above remain OFF. Repair manually via session-config-integrity.repairSessionConfigOnDisk, or relaunch.',
          };
        }
      } catch {
        /* fail-soft — never break orientation over a config read/repair */
      }
    }
    // EI-11408 / P-004: Codex's lock policy is a RUNTIME verdict, not a
    // static client assumption. Hooks merely present on disk remain manual
    // until this exact owner produces a successful owner-scoped hook decision;
    // a newer owner-scoped error flips it back to manual. This fold is the
    // after-launch authority and carries one effective instruction only.
    let codexLocks: unknown;
    if (ownerId) {
      try {
        const session = await (await import('../../../adv-sessions')).latestAdvSessionByCoordOwner(ownerId);
        if (session?.agent === 'codex') {
          const [{ readCodexHomeDiagnostics }, { readCodexLockRuntimeVerdict }] = await Promise.all([
            import('../../../role-codex-home'),
            import('../../../codex-lock-runtime'),
          ]);
          const home = readCodexHomeDiagnostics(session.id);
          const hooksConfigured =
            home.hooksExists &&
            home.diagnostics?.lockEnforcement === 'hooks-configured' &&
            (!home.diagnostics.lockOwnerSid || home.diagnostics.lockOwnerSid === ownerId);
          codexLocks = readCodexLockRuntimeVerdict({ ownerId, hooksConfigured });
        }
      } catch {
        /* fail-soft: prompt snapshot remains conservative/manual */
      }
    }
    // P-006 / EI-11409: derive the small tool set this task actually needs
    // from the active modes + declared scope + surfaced recipe context, then
    // grow the EXISTING per-session MCP surface. list_changed-capable clients
    // (Codex/OMP) re-fetch the real full schemas; the compact schema pack in
    // the response makes the same task resumable after compaction with no
    // tools:find/tools:invoke rediscovery tax. Every orient recomputes it, so a
    // mode/scope transition yields a new watermark and a post-compaction orient
    // reconstructs the same pack. Fail-soft: orientation remains usable if the
    // registry or client activation seam is unavailable during a rolling deploy.
    let taskToolSchemaPack: OrientResult['taskToolSchemaPack'];
    try {
      const { buildTaskToolSchemaPack } = await import('./orient-task-schema-pack');
      const pack = buildTaskToolSchemaPack({
        intent: args.intent ?? args.memoryQuery,
        modes: runtimeModeIds ?? [],
        harness: args.harness ?? (ctx as { harnessSlug?: string | null }).harnessSlug ?? null,
        plan: args.planSlug ?? null,
        planItems: args.planItems ?? [],
        recipeTitles: Array.isArray(result.recipes)
          ? result.recipes.flatMap((recipe) => (typeof recipe.title === 'string' ? [recipe.title] : []))
          : args.intent
            ? []
            : undefined,
      });
      const activationRequested = shouldActivateOrientToolSurface(
        (ctx as { callerAgent?: string | null }).callerAgent,
      );
      let surfaceChanged: boolean | null = null;
      if (activationRequested) {
        try {
          surfaceChanged = ctx.activateTools?.(pack.toolNames) ?? null;
        } catch {
          surfaceChanged = null;
        }
      }
      taskToolSchemaPack = {
        ...pack,
        activation: { requested: activationRequested, surfaceChanged },
      };
    } catch {
      /* fail-soft */
    }
    // EI-11484: OPEN OWNER DIRECTIVES fold — every orient (full AND monitor;
    // orient is the mandated bootstrap, so this is how a SUCCESSOR session in
    // the workspace inherits an order whose recording session died). Rendered
    // by the shared budgeted renderer; fail-soft, absent when none are open.
    let ownerDirectives: string | undefined;
    try {
      const { renderOpenOwnerDirectivesBlock } = await import('../../../owner-directives');
      const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
      // Rendered FOR the orienting session (P-008 / D-008): rows it cleared off
      // its own agenda drop out here and stay open for every other session.
      ownerDirectives = (await renderOpenOwnerDirectivesBlock(ws, { viewerOwnerId: ownerId })) ?? undefined;
    } catch {
      /* fail-soft */
    }
    const out = assembleOrientOutput({
      self,
      recovery,
      continuityProbes,
      presenceDrift: result.presenceDrift,
      ownerDirectives,
      modes,
      instructionPrecedence,
      ideate,
      captureMiss,
      configIntegrity,
      codexLocks,
      taskToolSchemaPack,
      result: result as object,
    });
    // EI-22549932772057219: the post-compaction control anchor is prepared/read
    // before this handler starts composing the response, but it must not be
    // acknowledged until the complete orient payload has assembled successfully.
    // Otherwise a render failure (or a later handler fold that prevents the
    // response from being delivered) advances the watermark and makes the next
    // loop wake inject the same stale generation as if it were new. Keep the
    // acknowledgement fail-soft: if its write fails, the pending generation is
    // intentionally retried on the next turn.
    if (
      args.afterCompaction === true &&
      ownerId &&
      recovery?.control &&
      Number.isSafeInteger(recovery.control.generation)
    ) {
      try {
        const { acknowledgeControlTransition } = await import('../control-anchor');
        await acknowledgeControlTransition(ownerId, orientWorkspaceId, recovery.control.generation);
      } catch {
        /* preserve the assembled orient; the generation remains pending */
      }
    }
    // EI-9130: stamp the generic delta-served breadcrumb when at least one of orient's
    // bespoke cursor-delta legs actually narrowed/unchanged its response — see
    // orientServedDelta's doc comment + dispatch-stack.ts's recordTelemetry. Never
    // stamped `false`: absence already reads as "no delta mechanism engaged" (flag off,
    // no cursor, or a baseline/first read), same convention as the formal protocol.
    await bindOrientOutputResult(out, {
      ownerId: ownerId ?? null, workspaceId: orientWorkspaceId, harness: args.harness ?? null,
    }, orientServedDelta(result), ctx.metadata, undefined, runtimeModeRows);
    // `{ data }` envelope (tool-data-shape ratchet P-003) so payload-tier
    // shaping + format-aware serialization apply. On the MCP transport this is
    // behavior-equivalent to the prior raw-JSON text (the re-encode path
    // already routed orient through the same serializer when TOON shrank it).
    return { data: out };
      },
      {
        ...aggregateFallback,
      },
    );
    return aggregate;
  },
});
