/**
 * presence-snapshot.ts — the shared hive-scoped roster SNAPSHOT builder
 * (presence-v2-2026-06-14). One place assembles the byte-stable read-once
 * snapshot so the coord:presence tool AND the coord:inbox re-bootstrap
 * (P-010 / D-007) read the SAME roster, scoped the SAME way — never a
 * divergent second implementation.
 *
 *   resolvePresenceScope  — ctx (+ optional args) → the effective read scope
 *                           (hive default via the caller's harness→home hive;
 *                           SU/unmapped → workspace fallback | workspace | all).
 *   assemblePresenceSnapshot — run the scope: list local + federated presence,
 *                           GC long-dead rows, Tier-1 enrich the active locals,
 *                           and project each row through the P-009 byte-stable
 *                           `toStableRosterRow`.
 *   renderPresenceRebootstrapBlock — a terse text block for the [coord+N]
 *                           injection that re-establishes a compacted agent's
 *                           roster baseline (P-010).
 */

import { activeWorkspaceId } from '../../workspace-registry';
import { listEndedAdvSessionsByOwners, listRecordedLiveSessions, recordedLiveOwnerIds } from '../../adv-sessions';
import { listPresence, sweepStalePresence } from './presence';
import { listFederatedPresence } from './federated-presence';
import { reconcileRosterSources, synthesizeEndedRosterRows } from './recorded-sessions';
import {
  listRunningNurseryAliasRows,
  synthesizeNurseryAliasRosterRows,
  type NurseryAliasRow,
} from './nursery-alias-liveness';
import { fetchPresenceTier1, mergeTier1, type PresenceTier1Joins } from './presence-tier1';
import { deriveFleetControlVisibility, fetchPresenceFleet, type FleetMembership } from './presence-fleet';
import { createHash } from 'node:crypto';
import { toStableRosterRow, deltaEligibleProjection, type RosterRow } from './presence-payload';
import {
  fetchWakeability,
  overrideIntentStaleForSessionState,
  type WakeabilitySignals,
} from './presence-wakeability';
import { deriveVerdict } from './liveness-oracle';
// EI-22805550006169069: the SAME derivation the wake path uses to tell "dormant
// between loop fires" from "dead" (`recipient_dormant_scheduled`). Imported, never
// re-derived: re-implementing the rule here is how the two surfaces would drift
// back apart, and its `stalled` guard is what stops a loop parked-and-wedged for
// hours from being reported as a promise that it will fire again.
import { deriveDormantSchedule, fetchSelfWake, type SelfWakeSignals } from './presence-selfwake';
import { getLoopStatuses, type LoopStatus } from '../../harness/routines/loop';
import { findLiveHost } from '../../events/await/psu-pty-discovery';
import { deriveContextPressure, deriveContextPressureAgeSec } from './context-pressure';
import { writeWatermark } from './watermarks';
import {
  getTxPool,
  readPathInterestsByOwner,
  type PathInterestRow,
} from '../locks/su-lock-store';
import { gatherOnDesktopSessions } from '../../desktop-window-liveness';
import { gatherViewerAttachedOwners } from '../../pty-viewer-heartbeat';
import type { Watermark } from '@papercusp/coordination/core';

/** Hard GC threshold: rows whose heartbeat is older than this are dead beyond
 *  any doubt and are swept on read so the roster stays bounded. */
const PRESENCE_GC_MS = 24 * 60 * 60 * 1000;

/** EI-9029: below this size, the re-bootstrap block still inlines a full
 *  per-agent roster (small enough to be cheap AND genuinely readable at a
 *  glance — a fleet/hive roster is small by design, D-002). At or above it
 *  (a workspace-fallback read on a large workspace), inlining every row is
 *  expensive context most sessions never read — deltas ([coord+N]) are
 *  already the steady-state mechanism and carry everything that changes
 *  from here, so the block collapses to a one-line summary + an explicit
 *  on-demand pointer at coord:presence instead of a 40-line dump. */
const REBOOTSTRAP_INLINE_MAX_ROWS = 15;

export interface PresenceScopeArgs {
  scope?: 'hive' | 'workspace' | 'all';
  hive?: string;
  workspace?: string;
  /** EI-18653888556683414: this scope resolution is feeding a TARGETED { owner }
   *  point-lookup (find ONE specific known agent id/label), not a browse-roster
   *  read — see resolvePresenceScope for why that changes the default. */
  targetedOwner?: boolean;
}

export interface ResolvedPresenceScope {
  scope: 'hive' | 'workspace' | 'all';
  wsId: string | null;
  potId: string | null;
  scopeNote?: string;
}

export interface PresenceSnapshot {
  as_of: string;
  scope: string;
  hive?: string;
  scope_note?: string;
  /** `wakeable` (P-001) is the count a coordinator should read INSTEAD of
   *  `active` — agents an events:emit / coord:dispatch will actually reach.
   *  `byState` breaks the roster down live | parked | draining | suspect | ended. */
  summary: {
    active: number;
    stale: number;
    federated: number;
    wakeable: number;
    /** Agents CURRENTLY on the desktop (a live OS window) — the "assign these to
     *  the agent on the desktop" count, and the reaper's hard-exempt cohort. */
    onDesktop: number;
    /** Agents a human is CURRENTLY viewing in the operator web/Tauri PTY panel
     *  (no OS window) — the reaper's other hard-exempt cohort (pty-viewer-heartbeat.ts). */
    viewerAttached: number;
    byState: {
      live: number;
      parked: number;
      draining?: number;
      suspect?: number;
      ended: number;
      recorded: number;
    };
    /** P-007: agents whose context-pressure bucket is 'high' or 'critical' right
     *  now — the fleet-health headline (silent by design: 'ok'/unknown agents are
     *  the common case and aren't counted, mirroring the ambient gauge's own
     *  quiet-below-LOUD philosophy). */
    byContextPressure: { high: number; critical: number };
    /** EI-21488009366204518 — targeted `{ owner }` reads ONLY: how the needle
     *  resolved. `matched` is the returned row count; `fromSessionLog` true means
     *  the answer was synthesized from adv_sessions death evidence because the
     *  coord_presence row was reaped. matched:0 + fromSessionLog:false is an
     *  EXPLICIT not-found, distinct from the synthesized-ended case. Absent on
     *  default (browse) reads. */
    ownerLookup?: { needle: string; matched: number; fromSessionLog: boolean };
  };
  /** The ACTIONABLE roster: live + parked + recorded rows (everything a
   *  coordinator can dispatch to / wake) — `ended` rows are NEVER included here
   *  (that full-stale dump was the payload footgun this replaced). A targeted
   *  `owner` read returns the matched row(s) here EVEN IF `ended` (the "inspect /
   *  wake one dead agent" path). Counts for the excluded `ended` rows still live
   *  in `summary.byState.ended`. */
  active: Record<string, unknown>[];
  /** Content ETag over the DELTA-ELIGIBLE projection (identity+state) of the
   *  returned roster — the byte-stable half (D-006), EXCLUDING liveness churn
   *  (heartbeat / lastActiveSecAgo / live↔parked) and `as_of`. Stable across reads
   *  of an unchanged roster. A caller passes it back as `since:` to get a ~100B
   *  `{ unchanged: true }` short-circuit when nothing actionable has changed —
   *  the structural defense against re-polling a 20KB snapshot every turn. */
  etag: string;
}

/**
 * Pure: the content ETag for a roster's DELTA-ELIGIBLE projection (P-006 /
 * presence-tool-hardening). Hashes the identity+state of each row (via
 * `deltaEligibleProjection` — the SAME projection the [coord+N] delta channel
 * diffs, so liveness churn is excluded by construction) plus the scope + hive, so
 * two reads of an unchanged roster produce the SAME etag while ANY identity/state
 * change (intent, plan, claimed lane, await, a row added/removed, a re-host)
 * produces a different one. Rows are already ownerId-sorted by `selectRosterRows`;
 * we sort defensively so the etag is order-independent regardless of caller.
 */
export function computeRosterEtag(
  rows: RosterRow[],
  scope: string,
  potId: string | null,
): string {
  const projected = rows
    .map((r) => deltaEligibleProjection(r))
    .sort((a, b) => String(a.ownerId).localeCompare(String(b.ownerId)));
  const h = createHash('sha1');
  h.update(scope);
  h.update('\0');
  h.update(potId ?? '');
  h.update('\0');
  h.update(JSON.stringify(projected));
  return h.digest('hex').slice(0, 16);
}

/**
 * Resolve the effective read scope (P-004 / D-002). Default = the caller's
 * Hive: explicit `hive` arg wins; else the caller's harness → home Hive. A
 * caller with no Hive (SU/operator, harness '*'/none/unmapped) falls back to
 * workspace scope (recorded in `scopeNote`). ctx is read defensively so an
 * anonymous caller never throws.
 */
export async function resolvePresenceScope(
  ctx: { workspaceId?: string | null; harnessSlug?: string | null } | undefined,
  args: PresenceScopeArgs = {},
): Promise<ResolvedPresenceScope> {
  const c = ctx ?? {};
  const callerWs = args.workspace ?? c.workspaceId ?? null;
  // EI-18653888556683414: a TARGETED { owner } point-lookup ("find this ONE
  // specific agent id I already know") must NOT be silently narrowed to the
  // caller's own Hive by the generic browse-roster default — the caller isn't
  // browsing, they already know exactly who they want. Hive-scoping it made a
  // genuinely LIVE peer registered under a different Hive (or no Hive) come
  // back as an empty roster, indistinguishable from "no such agent exists",
  // which nearly caused a live work-item claim to be force-released as
  // orphaned. Only the DEFAULT changes here: an explicit `scope` or `hive`
  // argument from the caller is still honored exactly as before.
  const defaultScope = args.targetedOwner ? 'workspace' : 'hive';
  const scope = args.hive ? 'hive' : (args.scope ?? defaultScope);
  let hiveFilter: string | null = null;
  let scopeNote: string | undefined;
  if (scope === 'hive') {
    hiveFilter = args.hive ?? null;
    if (!hiveFilter) {
      const harness = c.harnessSlug && c.harnessSlug !== '*' ? c.harnessSlug : null;
      if (harness) {
        try {
          const { potHomeSlugForHarness } = await import('../../hive-federation');
          hiveFilter = await potHomeSlugForHarness(callerWs ?? 'default', harness);
        } catch {
          hiveFilter = null; // best-effort — presence must list even if hive lookup fails
        }
      }
    }
    if (!hiveFilter) scopeNote = 'caller has no Hive (SU/operator or unmapped harness) — fell back to workspace scope';
  } else if (scope === 'workspace' && args.targetedOwner && args.scope == null && args.hive == null) {
    scopeNote =
      'targeted owner lookup — searched workspace-wide (not narrowed to your Hive) so a live peer registered under a different Hive is still found; pass scope:"hive" to narrow';
  }
  // all → no filters; hive+resolved → workspace+hive; hive-without-a-hive / workspace → workspace only.
  // F-M2 (workspace-data-isolation-leaks): a non-'all' scope with no caller workspace
  // used to fall through to wsId=null (= ALL workspaces' roster). Default to the active
  // workspace instead, so only an EXPLICIT scope:'all' is cross-workspace.
  const wsId = scope === 'all' ? null : (callerWs ?? activeWorkspaceId());
  const potId = scope === 'hive' ? hiveFilter : null;
  return { scope, wsId, potId, scopeNote };
}

/**
 * Match a roster row against a targeted `owner` needle for the `owner` lookup —
 * exact ownerId or label, else a substring either-way (the same fuzz
 * coord:dispatch's findPresenceRow + coord:send resolve), so a handle / id prefix
 * still finds the agent. Pure + exported for unit coverage.
 */
export function matchesOwner(r: RosterRow, needle: string): boolean {
  if (!needle) return false;
  const id = String(r.ownerId ?? '');
  const label = String((r as { ownerLabel?: unknown }).ownerLabel ?? '');
  return id === needle || label === needle || (!!id && (id.includes(needle) || needle.includes(id)));
}

/**
 * PURE selection of the RETURNED roster from the full enriched set (extracted so
 * the DEFECT-1 contract unit-tests without PG):
 *   - `owner` set → the matched row(s), INCLUDING an `ended` one (the targeted
 *     "inspect / wake one dead agent" lookup that replaced `include_stale`).
 *   - `owner` absent → every ACTIONABLE row (live | parked | recorded | a
 *     federated/unknown peer), NEVER an `ended` row (the payload-ballooning dead
 *     pile). Sorted by ownerId so the emitted list is byte-stable (D-006).
 */
export function selectRosterRows(
  rows: RosterRow[],
  owner?: string | readonly string[],
): RosterRow[] {
  const owners = typeof owner === 'string' ? [owner] : owner;
  const picked = owners?.length
    ? rows.filter((r) => owners.some((candidate) => matchesOwner(r, candidate)))
    : rows.filter((r) => r.sessionState !== 'ended');
  return picked.sort((a, b) => String(a.ownerId).localeCompare(String(b.ownerId)));
}

/** The emitted-row lens for a cheap liveness read (WI-6658). `full` is the
 *  default and is byte-identical to the historical payload. */
export type RosterProjection = 'ids' | 'liveness' | 'full';

/** Fields kept by the `liveness` lens — the oracle's verdict and nothing else. */
const LIVENESS_PROJECTION_FIELDS = ['ownerId', 'sessionState', 'confirmLiveness'] as const;

/**
 * PURE projection of the EMITTED roster rows down to the fields a liveness
 * question actually needs (WI-6658). This runs on the OUTPUT of
 * `assemblePresenceSnapshot`, deliberately: `sessionState` is assembled by
 * `deriveVerdict` from six legs (two of which — a `kill(pid,0)` probe and the
 * box-local psu-pty registry — are not in Postgres at all), so a cheap path that
 * recomputed a subset would reintroduce exactly the per-surface divergence
 * `presence-derivation-unification-2026-07-17` closed. We project the SAME
 * verdict; we just emit fewer fields. Assembly is ~300ms and is not the cost
 * being addressed — the payload is (a full workspace read measured 135KB /
 * ~34k tokens across 132 rows, at ~1KB and 37 keys per row).
 */
export function projectRosterRows(
  rows: Record<string, unknown>[],
  projection: RosterProjection,
): Record<string, unknown>[] | string[] {
  if (projection === 'full') return rows;
  if (projection === 'ids') return rows.map((r) => String(r.ownerId));
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of LIVENESS_PROJECTION_FIELDS) {
      // confirmLiveness is a nudge, not a state — emit it only when it is set,
      // so the common row stays two fields wide.
      if (k === 'confirmLiveness' && !r[k]) continue;
      out[k] = r[k];
    }
    return out;
  });
}

/**
 * PURE: the RE-POLL etag for one coord:roster READ — a hash of the
 * REPRESENTATION ACTUALLY EMITTED, not of the underlying roster (WI-6665).
 *
 * This is deliberately NOT `computeRosterEtag`, and the difference is the whole
 * point. That one hashes the roster's identity+state and EXCLUDES liveness churn
 * (D-006) — the right trade for `coord:presence`, which has no caller lens and
 * one payload per session. Porting it here verbatim would be wrong twice over:
 *
 *   1. `coord:roster` applies `filterRosterRowsByState` + `projectRosterRows`
 *      AFTER the snapshot, so ONE roster etag maps to many different payloads
 *      (`full` vs `liveness` vs `ids`, crossed with any `states[]` subset). A
 *      caller that read with `project:'full'` and re-read with
 *      `project:'liveness', since:<that etag>` would be told `unchanged:true`
 *      — "you already have this" — when it demonstrably does not.
 *
 *   2. The excluded lane, liveness, is EXACTLY what this tool's cheapest lens is
 *      for. `{ project:'liveness', states:['live'] }` asks "who is live?"; an
 *      etag that ignores live↔parked would report `unchanged` while the answer
 *      churned underneath the caller — a confident wrong answer on the single
 *      most-polled read, which is the failure mode this surface keeps closing.
 *
 * Hashing the emitted representation fixes both by construction: `unchanged:true`
 * means "the bytes you would get back are identical to the ones you hold", on
 * EVERY lens, with no per-lens special-casing to get wrong.
 *
 * The honest trade-off, stated rather than hidden: on the DEFAULT `full` read the
 * rows carry `lastActiveSecAgo`, which moves on nearly every read, so the etag
 * churns and the guard degrades to a no-op — the caller pays full price, exactly
 * as it does today. That is a guard that is USELESS on the expensive read, never
 * one that LIES on the cheap one. Callers who want the cheap re-poll ask for a
 * cheap lens, which is the behaviour we want to reward anyway.
 *
 * A foreign or stale token simply misses and yields a full read — the safe
 * direction, and the reason this guard cannot cause a wrong answer even when a
 * caller mixes tokens up.
 *
 * ⚠ The `coord:roster/v1` salt is a VERSION NAMESPACE, not a collision defence —
 * do not justify it as the latter. Mutation-testing showed removing it leaves the
 * whole suite green, because the lens fields hashed above ALREADY make a
 * coord:presence token unable to collide with one from here. What the salt buys
 * is forward safety: if the hash composition below ever changes, bump it to /v2
 * so outstanding tokens miss by construction instead of a stale token
 * accidentally matching a new-format read. That is a real property, but it is a
 * property of the NEXT change, which is why no test today can pin it.
 */
export function computeRosterViewEtag(
  emitted: readonly Record<string, unknown>[] | readonly string[],
  lens: {
    view: string;
    scope: string;
    potId: string | null;
    project: RosterProjection;
    states?: readonly string[] | undefined;
    includeDetail?: boolean | undefined;
    includeStale?: boolean | undefined;
    owner?: string | undefined;
  },
): string {
  const h = createHash('sha1');
  h.update('coord:roster/v1');
  h.update('\0');
  h.update(lens.view);
  h.update('\0');
  h.update(lens.scope);
  h.update('\0');
  h.update(lens.potId ?? '');
  h.update('\0');
  h.update(lens.project);
  h.update('\0');
  // Sorted so ['live','parked'] and ['parked','live'] are the same lens — they
  // select the same rows, so they must not produce different etags.
  h.update([...(lens.states ?? [])].sort().join(','));
  h.update('\0');
  h.update(lens.includeDetail ? '1' : '0');
  h.update(lens.includeStale ? '1' : '0');
  h.update('\0');
  h.update(lens.owner ?? '');
  h.update('\0');
  h.update(JSON.stringify(emitted));
  return h.digest('hex').slice(0, 16);
}

/**
 * PURE `sessionState` filter over the emitted rows (WI-6658).
 *
 * ⚠ A row whose `sessionState` is null — a federated/unknown peer, which has no
 * LOCAL wakeability entry to derive a verdict from — matches NO state and is
 * therefore excluded by any filter. That is the honest reading (it is not
 * known-live), but silently dropping it would be the same failure mode as
 * steering a liveness question onto a keepalive column: a confident wrong
 * answer. The caller is told how many rows this removed, so an empty result is
 * never confusable with "no live peers".
 */
export function filterRosterRowsByState(
  rows: Record<string, unknown>[],
  states: readonly string[] | undefined,
): { rows: Record<string, unknown>[]; unknownStateExcluded: number } {
  if (!states || states.length === 0) return { rows, unknownStateExcluded: 0 };
  const want = new Set(states);
  let unknownStateExcluded = 0;
  const kept = rows.filter((r) => {
    const s = r.sessionState;
    if (typeof s !== 'string') {
      unknownStateExcluded += 1;
      return false;
    }
    return want.has(s);
  });
  return { rows: kept, unknownStateExcluded };
}

/**
 * Assemble the roster snapshot for a resolved scope. The federated roster
 * (cross-machine peers) is merged in (best-effort — [] on a single box). The
 * GC sweep runs concurrently so it adds no latency and never breaks the read.
 * Active local rows get the Tier-1 enrichment; every row is projected through
 * the P-009 byte-stable `toStableRosterRow` (raw timestamps dropped).
 */
export async function assemblePresenceSnapshot(
  resolved: ResolvedPresenceScope,
  opts: {
    owner?: string;
    owners?: readonly string[];
    nowMs?: number;
    detail?: { coordinationDomain: string };
  } = {},
): Promise<PresenceSnapshot> {
  const { wsId, potId, scope, scopeNote } = resolved;
  // EI-9454: a `{ owner }` read is a TARGETED point-lookup — source queries and
  // downstream enrichment must receive only the bounded owner selectors, and it
  // must not pay the whole-roster assembly (see the early filter + sweep skip below).
  const ownerSelectors = opts.owners?.length ? opts.owners : opts.owner ? [opts.owner] : [];
  const targeted = ownerSelectors.length > 0;
  const targetedOwnerIds = targeted ? [...ownerSelectors] : undefined;
  const [records, federated, recordedLive, , nurseryAliasRows] = await Promise.all([
    listPresence({
      workspaceId: wsId,
      potSlug: potId,
      ...(targetedOwnerIds ? { ownerIds: targetedOwnerIds } : {}),
    }),
    listFederatedPresence({
      workspaceId: wsId,
      potSlug: potId,
      ...(targetedOwnerIds ? { ownerIds: targetedOwnerIds } : {}),
    }),
    // The AUTHORITATIVE-session-log leg (P-001): live recorded sessions of ANY
    // CLI not yet self-registered in coord_presence — so a recorded session is
    // visible the instant it launches, never gated on a self-heartbeat. Skipped
    // for an explicit hive scope (adv_sessions carries no hive attribution yet →
    // including it could leak cross-hive agents; P-002 adds hive_slug). Runs for
    // the workspace/all views — the su/operator/admin roster where the gap lives.
    // listRecordedLiveSessions is itself best-effort ([] on DB error).
    potId == null
      ? listRecordedLiveSessions({
          workspaceId: wsId,
          ...(targetedOwnerIds ? { ownerIds: targetedOwnerIds } : {}),
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof listRecordedLiveSessions>>),
    // Blunt 24h GC of long-dead rows (the pre-existing backstop, still here as a
    // final safety net). NOTE: the READ side additionally excludes `ended` rows from
    // the default payload (`selectRosterRows`) WITHOUT deleting them — that's a
    // display filter, not retention. Actual short-TTL retention is now a SEPARATE
    // scheduled reaper (presence-coord-unification-2026-07-01 P-004, WI-1347 —
    // coordPresenceReaperTick / reapEndedPresenceRows in presence-reaper.ts, hourly),
    // which is wakeability-aware (never reaps a `parked` row, only a genuinely
    // `ended` one past its TTL) and was cleared to ship once the append-only
    // fleet_membership_events ledger (P-002 / WI-1345 / migration 430) landed —
    // fleet-membership history now survives a coord_presence row's deletion.
    // EI-9454: the sweep (a maintenance DELETE) runs on the FULL-roster read only —
    // a targeted { owner } lookup is the hot "is this agent alive?" point-read and
    // must not queue a write behind a starved pool. The hourly presence-reaper and
    // every default read keep the sweep cadence, so retention is unaffected.
    targeted ? Promise.resolve(0) : sweepStalePresence(PRESENCE_GC_MS).catch(() => 0),
    // EI-16639: the alias-aware nursery-liveness leg (nursery-alias-liveness.ts)
    // — closes the same identity-alias gap migration 225/EI-311 already closed
    // for fleet_assignment. Gated the SAME way as the recordedLive leg above
    // (potId == null): harness_shared.spawned_agents carries no hive attribution
    // either, so including it in an explicit hive-scoped read could leak a
    // cross-hive bee. A targeted read scopes the query to just the requested
    // owner (EI-9454 point-lookup-cost discipline); a full-roster read takes the
    // bounded (500-row) default. Best-effort ([] on any DB error).
    potId == null
      ? listRunningNurseryAliasRows({
          workspaceId: wsId,
          ...(targeted ? { ownerIds: [...ownerSelectors] } : {}),
        }).catch(() => [] as NurseryAliasRow[])
      : Promise.resolve([] as NurseryAliasRow[]),
  ]);
  // Reconcile the two liveness sources: a fresh presence row wins; a live
  // session-log record supersedes a STALE presence row (so a resumed-but-idle
  // session whose old heartbeat went stale is still surfaced, not shadowed); an
  // owner with only a live record gets a synthesized 'recorded' row. CLI-agnostic.
  // P-006 (cross-machine-coord-parity): LOCAL WINS on ownerId collision — a
  // session homed HERE must never be shadowed (or duplicated) by its own
  // federated echo, and a remote peer claiming a local ownerId is dropped.
  const localOwnerIds = new Set(records.map((r) => r.ownerId));
  const fedDeduped = federated.filter((f) => !localOwnerIds.has(f.ownerId));
  const reconciled: RosterRow[] = reconcileRosterSources([...records, ...fedDeduped], recordedLive);
  // EI-16639: a THIRD leg — a running nursery bee addressable ONLY by an alias
  // (spawn_id/session_owner/run_id) that never wrote its own coord_presence row
  // (or an adv_sessions record). Synthesize a row for any alias not already
  // covered by the reconciled roster above, mirroring `synthesizeRecordedRosterRows`
  // (recorded-sessions.ts) — so a targeted `coord:presence { owner: '<alias>' }`
  // lookup returns the bee instead of an empty roster, closing the exact gap that
  // let `fleet:assignments` (alias-aware since migration 225/EI-311) and
  // `coord:presence` (alias-BLIND until now) disagree on the same holder's liveness.
  const reconciledOwnerIds = new Set(reconciled.map((r) => r.ownerId));
  const nurserySynth = synthesizeNurseryAliasRosterRows(nurseryAliasRows, reconciledOwnerIds);
  let all: RosterRow[] = nurserySynth.length ? [...reconciled, ...nurserySynth] : reconciled;
  // EI-21488009366204518: a FOURTH synthesis leg, TARGETED-ONLY. An owner whose
  // coord_presence row was REAPED but whose adv_sessions still records the death
  // (ended_at) must answer a `{ owner }` point-lookup with an explicit `ended`
  // row — never with an empty roster that reads as "never existed". Runs only
  // when the needle matched nothing above (one bounded query on a miss), so the
  // EI-9454 point-lookup cost discipline holds and full-roster reads are
  // unaffected (the dead-row pile stays out of the default payload).
  let endedFromSessionLog = false;
  if (targeted) {
    const needle = opts.owner as string;
    if (!all.some((r) => matchesOwner(r, needle))) {
      const endedRows = await listEndedAdvSessionsByOwners([needle]).catch(() => []);
      const endedSynth = synthesizeEndedRosterRows(endedRows, new Set(all.map((r) => r.ownerId)));
      if (endedSynth.length > 0) {
        all = [...all, ...endedSynth];
        endedFromSessionLog = true;
      }
    }
  }
  // EI-9454 (targeted-lookup cost): when `owner` is set, filter EARLY — the base
  // rows already carry ownerId+ownerLabel (all matchesOwner needs), so the matched
  // row(s) are known BEFORE the enrichment fan-out. Everything downstream (the 5
  // batch joins, the per-row projection, the opt-in detail lock join) then runs
  // for the 1-2 matched ids instead of the whole roster — the documented
  // "targeted lookup" stops paying the O(roster) assembly that made it time out
  // under fleet load (~67 sessions → 55s/300s aborts). selectRosterRows applies
  // the SAME predicate at the end (idempotent), so the selected rows are
  // byte-identical to the late-filter result; summary counts on a targeted read
  // now describe the matched subset (the rows actually returned), not the whole
  // roster.
  const scoped = targeted
    ? all.filter((r) => ownerSelectors.some((owner) => matchesOwner(r, owner)))
    : all;
  const active = scoped.filter((r) => !r.stale);
  const stale = scoped.filter((r) => r.stale);
  const now = opts.nowMs ?? Date.now();
  const isFederated = (r: RosterRow) => r.federated === true;
  // Tier-1 enrichment stays ACTIVE-only (cost, P-003); wakeability is fetched for
  // BOTH active AND stale locals — a stale (heartbeat>10min) row with a live await
  // is `parked`, not gone, and that is exactly the dispatch target P-001 surfaces.
  const localActiveIds = active.filter((r) => !isFederated(r)).map((r) => r.ownerId);
  // EI-9454: derive from `scoped` (not `all`) so the wakeability + fleet joins
  // also collapse to the matched id(s) on a targeted read.
  const localAllIds = scoped.filter((r) => !isFederated(r)).map((r) => r.ownerId);
  let joins = new Map<string, PresenceTier1Joins>();
  let wakeability = new Map<string, WakeabilitySignals>();
  let recordedLiveOwners = new Set<string>();
  let onDesktopOwners = new Set<string>();
  let viewerAttachedOwners = new Set<string>();
  // Named-fleet membership (P-005): the SOFT coord_presence label, joined in per-owner
  // (it does NOT ride the base PresenceRecord like hive_slug). Fetched for the WHOLE
  // local roster (active + stale) so a parked fleet member still shows its fleet.
  let fleet = new Map<string, FleetMembership>();
  // EI-22805550006169069: the forward-looking self-wake schedule. Fetched for the
  // WHOLE local roster (active + stale) on purpose — the row this exists to repair
  // is a STALE one (heartbeat gone, session ended) that is nevertheless coming back
  // at a known time, which is precisely the row an active-only join would miss.
  let loops = new Map<string, LoopStatus>();
  // Whether that read actually happened. An empty `loops` is ambiguous on its own —
  // "no owner has a loop" and "the query failed" are the same map — and collapsing
  // the second into `dormantScheduled:false` would assert the exact false-negative
  // ("nothing will wake this agent") that this field exists to prevent.
  let loopsRead = false;
  // EI-19407725333778711: this is a separate forward-looking axis from the
  // scheduled-fire projection. A failed/empty enrichment remains unknown; the
  // oracle omits the fields and the wire projection emits null rather than
  // fabricating `selfWake:'none'`.
  let selfWakeSignals = new Map<string, SelfWakeSignals>();
  await Promise.all([
    // each best-effort + independent — presence must list even if any join fails.
    fetchPresenceTier1(localActiveIds)
      .then((m) => {
        joins = m;
      })
      .catch(() => {}),
    fetchWakeability(localAllIds)
      .then((m) => {
        wakeability = m;
      })
      .catch(() => {}),
    // Session-log authority leg (unification P-002): owners whose recorded
    // adv_session is live rescue a not-wakeable row to `recorded` instead of
    // `ended` — the SAME leg fleet:assignments has applied since EI-6374, now
    // uniform here via the oracle's deriveVerdict. Best-effort like every join.
    recordedLiveOwnerIds(localAllIds)
      .then((s) => {
        // EI-16639: fold the alive nursery-alias ids in too, so deriveVerdict's
        // `recordedLiveOnly` (liveness-oracle.ts) classifies an alias-only bee as
        // `recorded` the SAME way it does a live adv_sessions record — one oracle,
        // no special-casing of the new leg's source marker.
        recordedLiveOwners =
          nurseryAliasRows.length === 0
            ? s
            : new Set([...s, ...nurseryAliasRows.map((r) => r.alias)]);
      })
      .catch(() => {}),
    // On-desktop (live OS window) owners — best-effort, box-local (empty on a
    // headless box). Independent of the other joins so a wmctrl hiccup never
    // affects wakeability/tier-1, and vice-versa.
    gatherOnDesktopSessions()
      .then((s) => {
        onDesktopOwners = s.owners;
      })
      .catch(() => {}),
    // PTY-panel viewer-attach owners (pty-viewer-heartbeat.ts) — the no-OS-window
    // sibling of on-desktop. Best-effort + independent so a DB hiccup never affects
    // the other joins.
    gatherViewerAttachedOwners()
      .then((s) => {
        viewerAttachedOwners = s;
      })
      .catch(() => {}),
    // Named-fleet membership (P-005) — best-effort + independent of the other joins.
    fetchPresenceFleet(localAllIds)
      .then((m) => {
        fleet = m;
      })
      .catch(() => {}),
    // EI-22805550006169069: engine-loop schedules, batched for the whole local
    // roster like every join here. Best-effort + independent by the same contract:
    // a failed read leaves `loops` empty, which surfaces as `dormantScheduled:null`
    // (NOT MEASURED) on every row — never as `false`, which would assert that
    // nothing will wake an agent when we simply failed to look.
    getLoopStatuses(localAllIds)
      .then((m) => {
        loops = m;
        loopsRead = true;
      })
      .catch(() => {}),
    fetchSelfWake(localAllIds)
      .then((m) => {
        selfWakeSignals = m;
      })
      .catch(() => {}),
  ]);

  // EI-22072194984361823: the fleet's CONTROL state (active|winding-down),
  // batched for exactly the distinct slugs this roster touched above. Must
  // run AFTER the Promise.all (it depends on `fleet`'s resolved slugs), and is
  // skipped for a cross-workspace scope (wsId null) — agent_fleets is
  // workspace-scoped and there is no single cheap query across all of them.
  // Fail-soft like every other join here: a read error just leaves every row
  // without the field, never blocks or corrupts the roster.
  let fleetControl = new Map<string, { controlState: 'active' | 'winding-down'; controlReason: string | null }>();
  if (wsId && fleet.size > 0) {
    try {
      const { getFleetControlStates } = await import('../../agent-fleets-store');
      const slugs = [...new Set([...fleet.values()].map((m) => m.fleetSlug).filter((s): s is string => !!s))];
      fleetControl = await getFleetControlStates(wsId, slugs);
    } catch {
      /* fail-soft — see comment above */
    }
  }

  /** Attach the P-001 wakeability signals via the shared liveness oracle
   *  (presence-derivation-unification-2026-07-17 P-002): deriveVerdict is the
   *  ONE place all input legs (stale + wakeable + liveTurn + hardStale + pid
   *  probe + recorded + claimsHeld) meet deriveSessionState, so this surface
   *  can never drift from fleet:status / fleet:assignments / the send-miss
   *  path. A federated/unknown row has no local wakeability entry →
   *  sessionState/wakeable stay absent (emitted as null by toStableRosterRow). */
  const nowMs = Date.now();
  const withWakeability = (r: RosterRow): RosterRow => {
    const w = wakeability.get(r.ownerId);
    if (!w) return r;
    // Tier-1 adds this join only for state derivation; it is deliberately not
    // part of the emitted RosterRow payload.
    const claimsHeld =
      (r.claimedItems?.length ?? 0) > 0 ||
      (((r as RosterRow & { workItemClaims?: string[] }).workItemClaims?.length ?? 0) > 0);
    const v = deriveVerdict(
      {
        ownerId: r.ownerId,
        heartbeatAt: r.heartbeatAt,
        stale: !!r.stale,
        host: r.host,
        pid: r.pid,
        source: r.source,
        agentRole: r.agentRole,
        claimsHeld,
      },
      w,
      recordedLiveOwners,
      nowMs,
      undefined,
      { enabled: true, negative: false, positive: true, findHostFn: findLiveHost },
      selfWakeSignals.get(r.ownerId),
    );
    return {
      ...r,
      wakeable: v.wakeable,
      sessionState: v.sessionState,
      // WI-4400: a draining/suspect row is not safe to classify from one stale
      // read. Expose the confirmation nudge on the shared snapshot so
      // coord:presence and coord:inbox re-bootstrap agree.
      confirmLiveness: v.confirmLiveness,
      // EI-19407725333778711: carry the independently derived forward-looking
      // axis onto the row. Preserve absence when the enrichment degraded so
      // toStableRosterRow emits UNKNOWN (null), never a fabricated `none`.
      ...(v.selfWake !== undefined ? { loopArmed: v.loopArmed, selfWake: v.selfWake } : {}),
      // EI-9262: sessionState (wakeability + activity end-marker) converges to
      // parked/ended far faster than the 30-minute intentStale activity clock —
      // the instant it does, the declared intent must read as unreliable too, so
      // a reader never sees a fresh-looking "still working on X" for an agent
      // that has already stopped taking turns.
      intentStale: overrideIntentStaleForSessionState(r.intentStale ?? null, v.sessionState),
    };
  };

  /** Attach the on-desktop flag for LOCAL rows (a federated row's windows live on
   *  its home box → leave it null/unknown, like sessionState). */
  const withOnDesktop = (r: RosterRow): RosterRow =>
    isFederated(r) ? r : { ...r, onDesktop: onDesktopOwners.has(r.ownerId) };

  /** Attach the PTY-panel viewer flag for LOCAL rows (a federated row's viewers live
   *  on its home box → leave it null/unknown, like onDesktop). */
  const withViewerAttached = (r: RosterRow): RosterRow =>
    isFederated(r) ? r : { ...r, viewerAttached: viewerAttachedOwners.has(r.ownerId) };

  /** EI-22805550006169069: attach the FORWARD-LOOKING half of liveness — is a
   *  self-wake already scheduled for this owner?
   *
   *  `sessionState`/`wakeable` answer only backward-looking questions ("is a turn
   *  running", "is an inbox-wake await armed"), and for an agent DORMANT BETWEEN
   *  LOOP FIRES every one of them is accurately negative while the agent is not
   *  gone at all. Without this field such a row is byte-identical to a dead one,
   *  so the only way a reader could tell them apart was to send a wake and read
   *  `recipient_dormant_scheduled` — i.e. the disconfirming datum existed, just
   *  not on the surface people actually read before reclaiming work.
   *
   *  A federated row's loop lives on its home box (like onDesktop/viewerAttached),
   *  and a degraded read is NOT MEASURED — both stay `null`, never `false`. */
  const withDormantSchedule = (r: RosterRow): RosterRow => ({
    ...r,
    ...deriveDormantSchedule(
      { federated: isFederated(r), measured: loopsRead, loop: loops.get(r.ownerId) ?? null },
      nowMs,
    ),
  });

  /** P-007: attach the coarse context-pressure bucket, derived live from the row's
   *  own (contextTokens, compactionLimit, contextEstimatedAt) — no extra query,
   *  these already ride PresenceRecord (watchdog-cached). The estimate's own age
   *  degrades a badly-stale reading to null (EI-18729596985129261) rather than
   *  asserting a bucket the watchdog cached up to a sweep-delay ago. A federated
   *  row carries no local estimate → leave it null/unknown, like
   *  onDesktop/viewerAttached. */
  const withContextPressure = (r: RosterRow): RosterRow =>
    isFederated(r)
      ? r
      : {
          ...r,
          contextPressure: deriveContextPressure(r.contextTokens, r.compactionLimit, r.contextEstimatedAt, nowMs),
          contextPressureAgeSec: deriveContextPressureAgeSec(r.contextEstimatedAt, nowMs),
        };

  /** Attach the P-005 named-fleet membership. An agent in no fleet (or a federated
   *  row with no local coord_presence) has no entry → fleetSlug/fleetRole stay absent
   *  (toStableRosterRow emits them only when present, so no null spam for non-members). */
  const withFleet = (r: RosterRow): RosterRow => {
    const f = fleet.get(r.ownerId);
    if (!f) return r;
    // EI-22072194984361823: fail-open on an unresolved slug, and the gate is
    // MEMBER-only — both policies live in deriveFleetControlVisibility, which
    // documents why and is unit-tested against them directly.
    return {
      ...r,
      fleetSlug: f.fleetSlug,
      fleetRole: f.fleetRole,
      ...deriveFleetControlVisibility(f, fleetControl),
    };
  };

  const activeEnriched = mergeTier1(active, joins, now)
    .map(withWakeability)
    .map(withOnDesktop)
    .map(withViewerAttached)
    .map(withDormantSchedule)
    .map(withContextPressure)
    .map(withFleet);
  // EI-22805550006169069: the STALE chain gets withDormantSchedule too, and that is
  // the leg that actually matters — a dormant-between-fires agent is stale BY
  // CONSTRUCTION (no heartbeat between fires), so omitting it here would leave the
  // originating bug unfixed on the exact population it was reported against.
  const staleEnriched = stale.map((r) =>
    withFleet(
      withContextPressure(withDormantSchedule(withViewerAttached(withOnDesktop(withWakeability(r as RosterRow))))),
    ),
  );

  // The FULL enriched roster (fresh-heartbeat + stale), each carrying its derived
  // sessionState. What we RETURN is a filtered view of it:
  //   - a targeted `owner` read → the matched row(s), INCLUDING an `ended` one — the
  //     "inspect / wake ONE dead agent" path that replaced the include_stale full dump.
  //   - a default read → every ACTIONABLE row (live | parked | recorded | a
  //     federated/unknown peer), but NEVER an `ended` row (the dead-row pile that
  //     ballooned the payload; its count still surfaces in summary.byState.ended).
  // Ordered by ownerId so the emitted list stays byte-stable (D-006).
  const fullEnriched = [...activeEnriched, ...staleEnriched];
  const selected = selectRosterRows(fullEnriched, ownerSelectors);
  // P-006: the delta-eligible ETag (identity+state) for the `since:` short-circuit,
  // computed from the SELECTED rows so it matches EXACTLY what this read returns.
  const etag = computeRosterEtag(selected, scope, potId);
  let activeRows = selected.map(toStableRosterRow);

  // P-011 include_detail: the heavy Tier-2/3 field — held files — lives in the
  // SEPARATE papercusp_su lock DB, so it is fetched ONLY when asked (opt-in,
  // fail-soft) and merged onto the lean rows; never on the default read path
  // (the lean default stays the org-PG-only Tier-1, P-003). Await/handoff/
  // escalation detail keeps its dedicated tools (events:* / coord:inbox) rather
  // than being duplicated into this org-PG read.
  if (opts.detail) {
    const held = await fetchPresenceHeldLocks(localActiveIds, opts.detail.coordinationDomain);
    activeRows = activeRows.map((r) => {
      const locks = held.get(r.ownerId as string);
      if (!locks || locks.length === 0) return r;
      return {
        ...r,
        // Keep the original P-011 path-only field stable for existing readers.
        heldFiles: locks.map((lock) => lock.path),
        // Reconciliation detail: the exact release handles and their live
        // namespace/expiry evidence come from the same authoritative rows as
        // locks:queue. A holder that lost local lock context can now identify
        // and release the row that still blocks a peer.
        heldLocks: locks,
        heldLockIds: [...new Set(locks.map((lock) => lock.lockId))],
      };
    });
  }

  // P-001 summary: count wakeable agents + the live/parked/ended breakdown across
  // the WHOLE roster (active + stale) — `wakeable` is the headline a coordinator
  // reads instead of `active`, and `byState` separates the dispatchable (parked)
  // from the busy (live) and the dead (ended).
  const byState = { live: 0, parked: 0, draining: 0, suspect: 0, ended: 0, recorded: 0 };
  const byContextPressure = { high: 0, critical: 0 };
  let wakeable = 0;
  let onDesktop = 0;
  let viewerAttached = 0;
  for (const r of [...activeEnriched, ...staleEnriched]) {
    if (r.wakeable === true) wakeable += 1;
    if (r.onDesktop === true) onDesktop += 1;
    if (r.viewerAttached === true) viewerAttached += 1;
    if (r.contextPressure === 'high') byContextPressure.high += 1;
    else if (r.contextPressure === 'critical') byContextPressure.critical += 1;
    const state = r.sessionState;
    if (state === 'live' || state === 'parked' || state === 'draining' || state === 'suspect' || state === 'ended' || state === 'recorded') {
      byState[state] += 1;
    }
  }

  const summary: PresenceSnapshot['summary'] = {
    active: active.length,
    stale: stale.length,
    // EI-9454: on a targeted read the count matches the returned subset (like
    // active/stale above); the default read keeps the whole-roster count.
    federated: targeted ? scoped.filter((r) => r.federated === true).length : federated.length,
    wakeable,
    onDesktop,
    viewerAttached,
    byState,
    byContextPressure,
  };
  // EI-21488009366204518: on a targeted read, say HOW the needle resolved —
  // matched rows, and whether the answer came from session-log death evidence
  // (a reaped presence row) rather than a live presence row. An unknown id reads
  // as matched:0/fromSessionLog:false — an explicit not-found, distinct from the
  // synthesized-ended case.
  if (targeted) {
    // `targeted` being true means opts.owner is a non-empty string (EI-9454);
    // the alias re-asserts that narrowing once for every targeted-only use below.
    const needle = opts.owner as string;
    summary.ownerLookup = {
      needle,
      matched: scoped.length,
      // True only when a session-log-synthesized row actually SURVIVED the
      // owner filter — never merely because the leg ran.
      fromSessionLog: endedFromSessionLog && scoped.length > 0,
    };
  }

  return {
    as_of: new Date(now).toISOString(),
    scope,
    ...(potId ? { hive: potId } : {}),
    ...(scopeNote ? { scope_note: scopeNote } : {}),
    summary,
    active: activeRows,
    etag,
  };
}

/**
 * Pure: group granular (file) lock holders into per-owner held-file lists,
 * restricted to the roster's ownerIds. Root-node ('') holds are skipped (they
 * are tree-wide intents, not a file), and each list is sorted for byte-stability.
 */
export function groupHeldFilesByOwner(
  holders: Array<{ owner: string; node: string }>,
  ownerIds: Set<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of holders) {
    if (!ownerIds.has(h.owner) || !h.node) continue;
    const arr = out.get(h.owner) ?? [];
    arr.push(h.node);
    out.set(h.owner, arr);
  }
  for (const [k, v] of out) out.set(k, v.sort());
  return out;
}

/** A stable, model-facing description of one live file-lock row. */
export interface PresenceHeldLock {
  /** Exact handle accepted by locks:release. */
  lockId: string;
  /** Repository-relative path covered by the lock set. */
  path: string;
  /** Lock namespace needed to distinguish same-path rows across trees. */
  coordinationDomain: string;
  /** Lease expiry read from the authoritative lock row. */
  expiresAt: string;
}

function isHeldLockRow(holder: PathInterestRow): holder is PathInterestRow & {
  lock_id: string;
  coordination_domain: string;
  expires_ts: Date;
} {
  return (
    typeof holder.lock_id === 'string' &&
    holder.lock_id.length > 0 &&
    typeof holder.coordination_domain === 'string' &&
    holder.coordination_domain.length > 0 &&
    holder.expires_ts instanceof Date &&
    Number.isFinite(holder.expires_ts.getTime())
  );
}

/**
 * Pure: group active lock rows by roster owner while retaining the release
 * handle and the evidence needed to reconcile it with locks:queue. The same
 * lock id legitimately appears once per covered path; `heldLockIds` is derived
 * at the emission site when callers need one release handle per lock set.
 */
export function groupHeldLocksByOwner(
  holders: PathInterestRow[],
  ownerIds: Set<string>,
): Map<string, PresenceHeldLock[]> {
  const out = new Map<string, PresenceHeldLock[]>();
  for (const holder of holders) {
    if (!ownerIds.has(holder.owner) || !holder.node || !isHeldLockRow(holder)) continue;
    const arr = out.get(holder.owner) ?? [];
    arr.push({
      lockId: holder.lock_id,
      path: holder.node,
      coordinationDomain: holder.coordination_domain,
      expiresAt: holder.expires_ts.toISOString(),
    });
    out.set(holder.owner, arr);
  }
  for (const [owner, locks] of out) {
    locks.sort((a, b) =>
      a.path.localeCompare(b.path) ||
      a.lockId.localeCompare(b.lockId) ||
      a.coordinationDomain.localeCompare(b.coordinationDomain) ||
      a.expiresAt.localeCompare(b.expiresAt),
    );
  }
  return out;
}

/**
 * IO seam (P-011 / include_detail): read the live file-lock HOLDS from the SU
 * lock store (the SEPARATE papercusp_su DB) and group them per owner. Fail-soft
 * → empty map: presence must render even if that store is unreachable, and this
 * cross-DB query is OPT-IN (only under include_detail), never on the lean path.
 *
 * ⚠ READS `agent_file_locks`, NOT `agent_granular_locks`. The granular table was
 * abandoned by production on 2026-07-02 and has had ZERO live rows since, so this
 * lane silently returned an empty map on every call (EI-20199756190949760).
 * `coordinationDomain` is now OPTIONAL and defaults to every domain: agents write
 * locks under the proxying operator's checkout while a reader resolves its own
 * tree, so passing the reader's domain returns zero rows by construction. The
 * `ownerIds` bound is the real restriction and is applied either way.
 */
export async function fetchPresenceHeldFiles(
  ownerIds: string[],
  coordinationDomain?: string | null,
): Promise<Map<string, string[]>> {
  const held = await fetchPresenceHeldLocks(ownerIds, coordinationDomain);
  return new Map([...held].map(([owner, locks]) => [owner, locks.map((lock) => lock.path)]));
}

/**
 * IO seam for the include_detail reconciliation lane. It deliberately shares
 * the existing path-interest query with the coupling reader, but consumes its
 * holds-only metadata columns so the presence row exposes the authoritative
 * lock id instead of only the covered path. Fail-soft like the legacy
 * `fetchPresenceHeldFiles` wrapper.
 */
export async function fetchPresenceHeldLocks(
  ownerIds: string[],
  coordinationDomain?: string | null,
): Promise<Map<string, PresenceHeldLock[]>> {
  if (ownerIds.length === 0) return new Map();
  try {
    const holders = await readPathInterestsByOwner(getTxPool(), ownerIds, {
      coordinationDomain: coordinationDomain ?? null,
      includeIntents: false,
    });
    return groupHeldLocksByOwner(holders, new Set(ownerIds));
  } catch {
    return new Map();
  }
}

/**
 * IO seam for the `holds-a-lock-on` COUPLING derivation — held locks UNION
 * in-flight waiter tickets, per owner, across coordination domains.
 *
 * ⚠ NOT the same question as {@link fetchPresenceHeldFiles}, and the difference is
 * the whole fix. The derivation emits an edge when two agents are interested in the
 * SAME path, and `agent_file_locks_pkey` is `PRIMARY KEY (coordination_domain, path)`
 * — at most ONE owner per path — so a holds-only source can NEVER satisfy that
 * predicate. It is a mutual-exclusion table: it records who WON contention, never
 * that contention happened. The contention lives in `agent_lock_waiters`, whose
 * `paths text[]` can hold two owners against one path.
 *
 * Fail-soft → empty map, like the holds lane: a coupling read must never degrade
 * the roster.
 */
export async function fetchPresencePathInterests(
  ownerIds: string[],
  coordinationDomain?: string | null,
): Promise<Map<string, string[]>> {
  if (ownerIds.length === 0) return new Map();
  try {
    const rows = await readPathInterestsByOwner(getTxPool(), ownerIds, {
      coordinationDomain: coordinationDomain ?? null,
    });
    return groupHeldFilesByOwner(rows, new Set(ownerIds));
  } catch {
    return new Map();
  }
}

/**
 * Render a terse re-bootstrap block for the [coord+N] injection (P-010): one
 * line per active agent — `<label> [<role>] <intent> (<plan>)` — under a header
 * that tells the agent its lost roster baseline is restored and to resume
 * tailing deltas. Pure (snapshot in → string out) so it is unit-testable.
 *
 * EI-9029: at/above REBOOTSTRAP_INLINE_MAX_ROWS active agents, per-row detail
 * is dropped in favor of a compact byState summary + an explicit on-demand
 * pointer — a 40+-line roster dump was being re-paid on every compaction in
 * a long session regardless of whether that turn ever consulted it; deltas
 * ([coord+N]) already carry what changes from here.
 */
export function renderPresenceRebootstrapBlock(snap: PresenceSnapshot): string {
  const total = snap.summary.active;
  const header =
    `[presence ⟲ ${total}] roster re-read after context compaction — ` +
    `baseline restored, tail [coord+N] deltas from here (as_of ${snap.as_of})`;

  if (total >= REBOOTSTRAP_INLINE_MAX_ROWS) {
    const { live, parked, draining, suspect, ended, recorded } = snap.summary.byState;
    const stateBits = [
      live ? `${live} live` : null,
      parked ? `${parked} parked` : null,
      draining ? `${draining} draining` : null,
      suspect ? `${suspect} suspect` : null,
      ended ? `${ended} ended` : null,
      recorded ? `${recorded} recorded` : null,
    ].filter((b): b is string => b !== null);
    const stateNote = stateBits.length ? ` (${stateBits.join(', ')})` : '';
    return (
      `${header}\n` +
      `${total} agents active${stateNote} — not inlined (>=${REBOOTSTRAP_INLINE_MAX_ROWS}); ` +
      `fetch the full roster on demand via coord:presence if you need it.`
    );
  }

  const lines = snap.active.map((r) => {
    const label = String(r.ownerLabel ?? r.ownerId ?? '?');
    const role = r.agentRole ? `[${String(r.agentRole)}]` : '[—]';
    const intent = r.intent ? String(r.intent) : '';
    const plan = r.currentPlanSlug ? ` (${String(r.currentPlanSlug)})` : '';
    return `${label} ${role} ${intent}${plan}`.trimEnd();
  });
  return [header, ...lines].join('\n');
}

/**
 * P-010 re-bootstrap-on-compaction (D-007). If the agent's cursor carries a
 * pending re-bootstrap (its cached roster baseline was lost to a context
 * compaction / fresh resume while this durable cursor kept advancing), build the
 * snapshot block + clear the flag ONCE, so the agent re-establishes its baseline
 * before trusting deltas and is never re-injected on later turns. Returns the
 * block, or null when no re-bootstrap is pending. `build` runs BEFORE the clear,
 * so a transient build failure leaves the flag set to retry next turn.
 *
 * The caller passes the already-read watermark (it reads it concurrently with
 * the inbox), so this adds no extra read on the common (no-flag) path.
 */
export async function consumePresenceRebootstrap(
  ownerId: string,
  wm: Pick<Watermark, 'snapshot_rebootstrap_pending'>,
  build: () => Promise<string>,
): Promise<string | null> {
  if (!wm.snapshot_rebootstrap_pending) return null;
  const block = await build();
  await writeWatermark(ownerId, { snapshot_rebootstrap_pending: false });
  return block;
}
