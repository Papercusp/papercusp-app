/**
 * substrate-booted-handles-pg.ts — the cross-SERVICE leg of the booted-handles
 * status broadcast (EI-19327550671915579, part 2 of EI-18735338283879820).
 *
 * `cluster-booted-handles-sync.ts` (EI-8816) pushes the substrate owner's
 * `listBootedHandles()` snapshot over `node:cluster` IPC — a mechanism confined
 * to ONE process tree (a primary + its own forked workers). Under the
 * dedicated-bg-host topology the true substrate owner is a SEPARATE systemd
 * service (`papercup-bg-host.service`); :3070/:3270 are each their own
 * unforked host, so they can never receive that broadcast — `node:cluster`
 * IPC only exists between a parent and a process it directly forked, and
 * bg-host never forked them. `resolveEffectiveBootedHandles` then honestly
 * (and, per EI-18735338283879820, correctly) reports `reachedSubstrateOwner:
 * false` forever, turning the substrate's own diagnostic into a permanent
 * blind spot rather than the transient one it was designed to be.
 *
 * This module closes that gap with the cross-service transport
 * EI-18735338283879820 deferred ("reuse-first, no new mechanism"): the
 * existing single-row-per-workspace `operator_state` PG pattern
 * (operator-state-pg.ts). Whichever process actually OWNS the substrate
 * (`isSubstrateOwnerProcess()`, evaluated per-beat — the SAME predicate that
 * gates the cluster broadcaster, so a non-owner can never poison this row
 * either, mirroring EI-18735338283879820's "never let a non-owner broadcast"
 * fix) periodically upserts its snapshot; any process — same host or not —
 * can read it back and apply the identical staleness gate
 * `resolveEffectiveBootedHandles` already uses for the cluster-IPC leg.
 *
 * Deliberately NOT wired into `resolveEffectiveBootedHandles` itself: that
 * function is documented (cluster-booted-handles-sync.ts's own file comment)
 * to stay a pure SYNCHRONOUS read so its two callers don't need an
 * async/shape change. A PG round-trip is inherently async, so callers that
 * want the cross-service fallback call `getPgBootedHandlesSnapshotFallback`
 * THEMSELVES, only when the fast sync path already reported
 * `reachedSubstrateOwner: false` — see dogfood-substrate-status.ts /
 * dogfood-substrate-health.ts / dev/dogfood_substrate_status.ts.
 */

import { managedSetInterval } from '@papercusp/scheduled-registry';
import { randomUUID } from 'node:crypto';
import { isSubstrateOwnerProcess } from '../../background-workers';
import { listBootedHandles, listRelocatedBootedHandles, listGitServingCapabilities, type BootedHandleSummary, type GitServingAdvertisement } from './boot-all';
import { gitServingUnavailable, validateGitServingState, type GitServingRequest, type GitServingState } from '../pot-git/serving-capability';
import type { BootedAnnounceIdentity } from './boot';
import { readOperatorState, updateOperatorState } from '../../operator-state-pg';
import {
  collectSubstrateHealthInputs,
  isCompleteHealthInputs,
  type RemoteBootedHandlesSnapshot,
  type SubstrateHealthInputsBundle,
} from './cluster-booted-handles-sync';
import { resolveSubstrateSocketPath } from './substrate-socket-path';
import { isAbsolute } from 'node:path';

interface PgRelocatedSidecarAdvertisement {
  /** Absolute, machine-local JSON-RPC socket owned by the substrate process. */
  socketPath: string;
  /** Exact handles that are relocated behind this socket. */
  handles: BootedHandleSummary[];
}

interface PgLastKnownHarnessAnnounceDeviceRecord {
  workspaceId: string;
  harnessSlug: string;
  devicePubkeyBase64: string;
  advertisedAt: number;
}

interface PgBootedHandlesPayload {
  handles: BootedHandleSummary[];
  sentAt: number;
  /** Stable for one live publisher process. A replacement owner gets a new id
   * and therefore invalidates every predecessor capability immediately. */
  publisherId?: string;
  publicationId?: string;
  /** Owner-issued per-repository leases. Omission is an old/unknown owner. */
  gitServing?: GitServingAdvertisement[];
  /**
   * WI-2142873 / D-013: last serving identity observed for each pot, retained
   * across a fresh snapshot that temporarily omits the pot during owner boot.
   * Refusal-only evidence: readers must never use one of these records to sign.
   * Optional so a new reader can bootstrap the history from a legacy row's
   * current `handles` before the publisher replaces it.
   */
  lastKnownAnnounceDevices?: PgLastKnownHarnessAnnounceDeviceRecord[];
  /**
   * EI-20575137548097507: the owner's health-input registries, published
   * ALONGSIDE the handle list so a non-owner reader can actually ASSESS the
   * harnesses this row tells it about.
   *
   * Before this, every leg of the fallback chain (local map → cluster IPC → this
   * PG row) carried only the handle LIST, while the liveness/fork detectors
   * stayed module-scope state in the owner process. A non-owner therefore
   * reported ever more harnesses it was no better able to assess, and the
   * unmeasured verdict rendered as `healthy` / "no issues detected" — five
   * filed instances of one defect. Publishing it here rather than adding a
   * second registry follows the same reasoning as the `sidecar` field above,
   * and covers BOTH non-owner topologies (cluster worker and cross-service
   * request-only host) with one mechanism.
   *
   * Optional for backward compatibility with rows written by an older owner: a
   * reader that finds it absent must treat health as UNOBSERVED, never healthy.
   * The same applies to a row written by the FIRST pass of this fix, which
   * carried a bare `replicationLiveness` and no fork/log-stat state — that row
   * is deliberately not upgraded in place, because a reader cannot honestly
   * claim to have observed inputs the row never carried.
   */
  healthInputs?: SubstrateHealthInputsBundle;
  /**
   * Optional for backward compatibility with pre-EI-20438405483051865 rows and
   * absent for an in-process substrate owner.  This extends the existing
   * cross-service owner advertisement instead of inventing a second registry.
   */
  sidecar?: PgRelocatedSidecarAdvertisement;
}

export interface PgRelocatedHarnessEndpoint {
  socketPath: string;
  advertisedAt: number;
}

/**
 * What the substrate owner says about ONE pot's swarm identity, for a reader in
 * another process (WI-2142873).
 *
 * The three states are deliberately distinct, because collapsing any two of
 * them is what caused the defect this exists to fix:
 *
 * - `null` (no result)  — UNKNOWN. No fresh advertisement; we learned nothing.
 * - `{ booted: false }` — the owner holds NO handle for this pot. Nothing
 *   serves it, so a gh-login fallback is the honest best effort.
 * - `{ booted: true, identity }` — a handle exists. `identity` is the device
 *   peers file our socket under; a `null` identity means the owner is running
 *   pre-WI-2142873 code and could not tell us, which is NOT permission to sign
 *   as some other device.
 */
export interface PgBootedHarnessIdentity {
  booted: boolean;
  identity: BootedAnnounceIdentity | null;
  advertisedAt: number;
}

/**
 * The last device the substrate owner advertised for one pot, IGNORING
 * freshness — see `getPgLastKnownHarnessAnnounceDevice` for why the stale case
 * has to stay distinguishable from the never-advertised one.
 *
 * `stale` is reported rather than acted on: it is the caller's business whether
 * an aged claim about WHICH device serves a pot is still good enough to refuse
 * on. It is not good enough to SIGN on, which is why no identity is returned.
 */
export interface PgLastKnownHarnessAnnounceDevice {
  devicePubkeyBase64: string;
  advertisedAt: number;
  stale: boolean;
}

export interface BootedHandlesPgPublisherHandle {
  stop(): void;
}

// The snapshot row is a liveness surface, not an append-only history. Bound the
// refusal-only identity ledger so deleted/renamed harnesses cannot grow it
// forever; current handles are stamped newest and therefore survive eviction.
const LAST_KNOWN_ANNOUNCE_DEVICE_LIMIT = 2_048;

function isLastKnownAnnounceDeviceRecord(value: unknown): value is PgLastKnownHarnessAnnounceDeviceRecord {
  const record = value as Partial<PgLastKnownHarnessAnnounceDeviceRecord> | null;
  return Boolean(
    record &&
    typeof record.workspaceId === 'string' &&
    record.workspaceId &&
    typeof record.harnessSlug === 'string' &&
    record.harnessSlug &&
    typeof record.devicePubkeyBase64 === 'string' &&
    record.devicePubkeyBase64 &&
    typeof record.advertisedAt === 'number' &&
    Number.isFinite(record.advertisedAt),
  );
}

function lastKnownAnnounceDeviceKey(record: { workspaceId: string; harnessSlug: string }): string {
  return `${record.workspaceId}\u0000${record.harnessSlug}`;
}

function announceDeviceRecordFromHandle(
  handle: BootedHandleSummary,
  advertisedAt: number,
): PgLastKnownHarnessAnnounceDeviceRecord | null {
  const devicePubkeyBase64 = handle.announceIdentity?.devicePubkeyBase64;
  if (
    typeof handle.workspaceId !== 'string' ||
    !handle.workspaceId ||
    typeof handle.harnessSlug !== 'string' ||
    !handle.harnessSlug ||
    typeof devicePubkeyBase64 !== 'string' ||
    !devicePubkeyBase64
  ) {
    return null;
  }
  return {
    workspaceId: handle.workspaceId,
    harnessSlug: handle.harnessSlug,
    devicePubkeyBase64,
    advertisedAt,
  };
}

/**
 * Carry forward identity history while replacing the liveness snapshot.
 *
 * The legacy `current.handles` pass is load-bearing: on the first publisher
 * beat after this field ships, it captures the old process's last live
 * identities BEFORE the fresh (possibly empty) handle list replaces them.
 */
function mergeLastKnownAnnounceDevices(
  current: Partial<PgBootedHandlesPayload> | null | undefined,
  nextHandles: BootedHandleSummary[],
  nextAdvertisedAt: number,
): PgLastKnownHarnessAnnounceDeviceRecord[] {
  const byHarness = new Map<string, PgLastKnownHarnessAnnounceDeviceRecord>();
  const priorRecords = Array.isArray(current?.lastKnownAnnounceDevices) ? current.lastKnownAnnounceDevices : [];
  for (const value of priorRecords) {
    if (!isLastKnownAnnounceDeviceRecord(value)) continue;
    const key = lastKnownAnnounceDeviceKey(value);
    const prior = byHarness.get(key);
    if (!prior || value.advertisedAt >= prior.advertisedAt) byHarness.set(key, value);
  }

  const currentAdvertisedAt =
    typeof current?.sentAt === 'number' && Number.isFinite(current.sentAt) ? current.sentAt : 0;
  for (const handle of Array.isArray(current?.handles) ? current.handles : []) {
    const record = announceDeviceRecordFromHandle(handle, currentAdvertisedAt);
    if (record) byHarness.set(lastKnownAnnounceDeviceKey(record), record);
  }
  for (const handle of nextHandles) {
    const record = announceDeviceRecordFromHandle(handle, nextAdvertisedAt);
    if (record) byHarness.set(lastKnownAnnounceDeviceKey(record), record);
  }

  return [...byHarness.values()]
    .sort(
      (a, b) =>
        b.advertisedAt - a.advertisedAt || lastKnownAnnounceDeviceKey(a).localeCompare(lastKnownAnnounceDeviceKey(b)),
    )
    .slice(0, LAST_KNOWN_ANNOUNCE_DEVICE_LIMIT);
}

/**
 * SUBSTRATE-OWNER side: periodically upsert `listBootedHandles()` to the
 * cross-service PG row. Self-gates on real ownership EVERY beat (never once
 * at start) — mirrors `startBootedHandlesBroadcaster`'s `ownsSubstrate` gate
 * exactly, for the same reason: a punctual empty snapshot from a non-owner is
 * indistinguishable from the real owner reporting a genuinely-empty
 * substrate, and would manufacture a confident false zero instead of leaving
 * the honest blind spot (EI-18735338283879820).
 *
 * Safe to call unconditionally at boot on every host — a request-only host
 * simply never passes the per-beat gate, so it writes nothing.
 */
export function startBootedHandlesPgPublisher(opts: {
  intervalMs?: number;
  now?: () => number;
  /** Test seam / explicit override for "does this process own the substrate?". */
  ownsSubstrate?: boolean;
  collectGitServing?: () => Promise<GitServingAdvertisement[]>;
}): BootedHandlesPgPublisherHandle {
  const intervalMs = opts.intervalMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const publisherId = randomUUID();
  let publishing: Promise<void> | null = null;
  let stopped = false;
  const beat = (): void | Promise<void> => {
    if (stopped || !(opts.ownsSubstrate ?? isSubstrateOwnerProcess())) return;
    const handles = listBootedHandles();
    const relocated = listRelocatedBootedHandles();
    const sentAt = now();
    const payload: PgBootedHandlesPayload = {
      handles,
      sentAt,
      publisherId,
      publicationId: randomUUID(),
      // EI-20575137548097507: publish what a reader needs to ASSESS these
      // handles, not just enumerate them.
      healthInputs: collectSubstrateHealthInputs(),
      ...(relocated.length > 0
        ? {
            sidecar: {
              socketPath: resolveSubstrateSocketPath(),
              handles: relocated,
            },
          }
        : {}),
    };
    // D-013: merge the refusal-only identity ledger under the SAME row lock as
    // the snapshot replacement. A read-then-write pair can lose history when
    // two publisher starts overlap; updateOperatorState is the existing
    // single-round-trip, FOR UPDATE primitive for exactly this class.
    //
    // Return the Promise to managedSetInterval. Swallowing it here made the
    // timer look healthy (`lastError:null`) while every PG write failed — the
    // observability gap that prolonged EI-20952729544817284. The managed timer
    // records/logs a rejection and still retries next interval.
    if (publishing) return publishing;
    // Publish liveness/omission immediately, invalidating a PRECEDING owner
    // before any slow Git/PG work. A refresh by this SAME live publisher keeps
    // its prior capabilities available while replacements are collected. Their
    // issuedAt/expiresAt remain byte-identical, so this never renews authority:
    // getPgGitServingCapability still rejects each one at its original 30s
    // expiry. Without this distinction, every 10s heartbeat erased discovery
    // for the whole (currently ~20s) collection pass, making protected Git
    // publication fail more often than it could succeed.
    publishing = updateOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', payload, (current) => ({
      ...payload,
      ...(current.publisherId === publisherId && Array.isArray(current.gitServing)
        ? { gitServing: current.gitServing }
        : {}),
      lastKnownAnnounceDevices: mergeLastKnownAnnounceDevices(current, handles, sentAt),
    })).then(async () => {
      const gitServing = await (opts.collectGitServing ?? listGitServingCapabilities)();
      if (stopped || !(opts.ownsSubstrate ?? isSubstrateOwnerProcess())) return;
      await updateOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', payload, (current) => {
        // A newer owner/beat won during issuance: never overwrite its verdict.
        if (current.publisherId !== publisherId || current.publicationId !== payload.publicationId) return current;
        return { ...current, gitServing };
      });
    }).finally(() => { publishing = null; });
    return publishing;
  };
  // Preserve the publisher's existing synchronous first-attempt semantics:
  // updateOperatorState is invoked before this function returns. This attempt
  // is outside the managed interval, so contain + name its failure explicitly;
  // subsequent failures are visible through the timer's lastError field.
  const initialBeat = beat();
  if (initialBeat) {
    void initialBeat.catch((error: unknown) => {
      console.warn(
        `[booted-handles-pg] initial publish failed; next interval retries: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  // D-004: 'must-sample' — the PRODUCER half of a liveness probe. Publishing only on
  // change is unsound here because ROW AGE is the signal: readers treat a row older than
  // DEFAULT_PG_SNAPSHOT_MAX_AGE_MS (3x this cadence) as "owner not reached", so an
  // unchanged-but-alive owner must keep re-stamping or it reads as dead. There is no
  // change event that carries "still alive, nothing changed".
  const timer = managedSetInterval('booted-handles-pg-publish', intervalMs, beat, {
    category: 'watchdog',
    classification: 'must-sample',
  });
  return {
    stop() {
      stopped = true;
      timer.stop();
    },
  };
}

/** How stale the cross-service PG row may be before a reader stops trusting
 *  it — matches DEFAULT_REMOTE_BOOTED_HANDLES_MAX_AGE_MS's 3x-interval
 *  generosity (3x this module's own 10s publish cadence: one missed beat is
 *  tolerated, a genuinely dead/wedged owner is not). */
const DEFAULT_PG_SNAPSHOT_MAX_AGE_MS = 30_000;

async function readFreshPgBootedHandlesPayload(opts?: {
  maxAgeMs?: number;
  now?: () => number;
}): Promise<PgBootedHandlesPayload | null> {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PG_SNAPSHOT_MAX_AGE_MS;
  const now = opts?.now ?? (() => Date.now());
  let row: PgBootedHandlesPayload | null;
  try {
    row = await readOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', undefined, {
      fresh: true,
    });
  } catch {
    return null;
  }
  if (!row || !Array.isArray(row.handles) || !Number.isFinite(row.sentAt)) return null;
  if (now() - row.sentAt > maxAgeMs || row.sentAt > now()) return null;
  return row;
}

/** Missing/omitted/expired discovery remains retryable and never authorizes a
 * substitute signer. Each capability has its own lease in addition to row age. */
export async function getPgGitServingCapability(request: GitServingRequest,
  opts?: { maxAgeMs?: number; now?: () => number },
): Promise<GitServingState> {
  const row = await readFreshPgBootedHandlesPayload(opts);
  if (!row || !Array.isArray(row.gitServing)) return gitServingUnavailable('unknown', 'no current serving discovery');
  if (!row.handles.some(h => h.workspaceId === request.workspaceId &&
      (h.harnessSlug === request.installSlug || h.harnessSlug === request.potHomeSlug))) {
    return gitServingUnavailable('absent', 'serving handle omitted from owner snapshot');
  }
  const match = row.gitServing.find(a => a.request?.workspaceId === request.workspaceId &&
    a.request.installSlug === request.installSlug && a.request.potHomeSlug === request.potHomeSlug &&
    a.request.scope?.repo_key === request.scope.repo_key && a.request.scope.hive_id === request.scope.hive_id);
  if (!match) return gitServingUnavailable('absent', 'repository omitted from owner serving snapshot');
  return validateGitServingState(match.state, request, (opts?.now ?? Date.now)());
}

/**
 * READER side (any process, any host): read back the cross-service snapshot,
 * or `null` if there is none / it is stale. Shaped identically to
 * `RemoteBootedHandlesSnapshot` (cluster-booted-handles-sync.ts) so a caller
 * can feed it through the exact same staleness/trust logic as the in-process
 * cluster-IPC leg.
 *
 * Always a FRESH PG read (`{ fresh: true }`) — this is already the fallback
 * path (called only once the fast sync leg reported no answer), so serving a
 * cached value here would defeat the point.
 */
export async function getPgBootedHandlesSnapshotFallback(opts?: {
  maxAgeMs?: number;
  now?: () => number;
}): Promise<RemoteBootedHandlesSnapshot | null> {
  const row = await readFreshPgBootedHandlesPayload(opts);
  if (!row) return null;
  return {
    handles: row.handles,
    receivedAt: row.sentAt,
    // EI-20575137548097507: absent on rows written by a pre-fix owner — passed
    // through as `undefined` so the reader reports health UNOBSERVED rather
    // than manufacturing a healthy verdict from a missing field. A partial
    // bundle is rejected for the same reason (isCompleteHealthInputs).
    ...(isCompleteHealthInputs(row.healthInputs) ? { healthInputs: row.healthInputs } : {}),
  };
}

/**
 * Resolve the true substrate owner's machine-local sidecar socket for one
 * exact relocated harness.
 *
 * This is deliberately stricter than the diagnostic snapshot reader: the row
 * must be fresh, the path must be absolute, and the requested `(workspace,
 * harness)` must appear in the sidecar-specific handle list.  The caller still
 * performs an existing-only `substrate:bootHarness` RPC before dialing, which
 * is the final fail-closed guard against a stale or misdirected advertisement.
 */
export async function getPgRelocatedHarnessEndpoint(
  workspaceId: string,
  harnessSlug: string,
  opts?: { maxAgeMs?: number; now?: () => number },
): Promise<PgRelocatedHarnessEndpoint | null> {
  const row = await readFreshPgBootedHandlesPayload(opts);
  const sidecar = row?.sidecar;
  if (
    !row ||
    !sidecar ||
    typeof sidecar.socketPath !== 'string' ||
    !isAbsolute(sidecar.socketPath) ||
    !Array.isArray(sidecar.handles)
  ) {
    return null;
  }
  const exact = sidecar.handles.some(
    (handle) => handle?.workspaceId === workspaceId && handle?.harnessSlug === harnessSlug,
  );
  if (!exact) return null;
  return { socketPath: sidecar.socketPath, advertisedAt: row.sentAt };
}

/**
 * Resolve the swarm announce identity the substrate owner holds for one exact
 * pot — the WI-2142873 reader.
 *
 * Reads the FULL handle list, not just the sidecar-relocated one: a harness
 * booted IN-PROCESS in the owner is equally invisible to a git-sync routine
 * running elsewhere, and it fails exactly the same way. Scoping this to
 * relocated handles would have fixed one of the two process splits and left
 * the other signing announcements no peer can dial.
 *
 * Returns `null` for UNKNOWN (no fresh row) so a caller can tell "the owner
 * says nothing serves this pot" from "we could not ask" — see
 * `PgBootedHarnessIdentity`.
 */
export async function getPgBootedHarnessAnnounceIdentity(
  workspaceId: string,
  harnessSlug: string,
  opts?: { maxAgeMs?: number; now?: () => number },
): Promise<PgBootedHarnessIdentity | null> {
  const row = await readFreshPgBootedHandlesPayload(opts);
  if (!row) return null;
  const match = row.handles.find(
    (handle) => handle?.workspaceId === workspaceId && handle?.harnessSlug === harnessSlug,
  );
  if (!match) return { booted: false, identity: null, advertisedAt: row.sentAt };
  const identity = match.announceIdentity;
  // A half-identity is not an identity: signing needs BOTH the device peers
  // filed us under and the keychain that can sign as it.
  const usable =
    identity && typeof identity.devicePubkeyBase64 === 'string' && identity.devicePubkeyBase64 ? identity : null;
  return { booted: true, identity: usable, advertisedAt: row.sentAt };
}

/**
 * The device the substrate owner LAST advertised as serving one pot, read
 * WITHOUT the freshness bound.
 *
 * WHY THIS EXISTS (WI-2142873 follow-on, measured 2026-09-04): the freshness
 * bound collapses two different facts into one `null`, and the difference
 * between them is the whole answer.
 *
 *   - There has never been an advertisement (no row, or no entry for this pot).
 *     Nothing is known to serve it; a gh-login fallback is the honest best
 *     effort, and that is the single-account box this module must not silence.
 *   - There IS an advertisement naming a device, it has simply gone stale.
 *     Staleness means "that device may no longer be up". It does NOT mean the
 *     gh-login device took over, so it is not permission to sign as one we have
 *     positive evidence is the wrong device.
 *
 * `getPgBootedHarnessAnnounceIdentity` returns `null` for both, so the caller
 * cannot tell them apart and takes the fallback in both. On this box the two
 * collide on every restart of the process that is BOTH substrate owner and
 * git-sync host: the previous owner's row ages past
 * DEFAULT_PG_SNAPSHOT_MAX_AGE_MS (30s) while the new one has not yet booted the
 * harness, so a leg firing in that window signed as the gh-login device and
 * minted one announcement no peer can dial — re-arming every peer's convergence
 * bar once per restart, faster than the announcement window can age it out.
 *
 * Returns `null` when nothing was ever advertised for this pot; otherwise the
 * device plus how old that claim is, so a caller can refuse instead of
 * mis-signing. Never throws: an unreadable row is reported as `null`, which
 * preserves the historical fallback rather than converting a PG hiccup into a
 * refusal.
 */
export async function getPgLastKnownHarnessAnnounceDevice(
  workspaceId: string,
  harnessSlug: string,
  opts?: { maxAgeMs?: number; now?: () => number },
): Promise<PgLastKnownHarnessAnnounceDevice | null> {
  let row: PgBootedHandlesPayload | null;
  try {
    row = await readOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', undefined, {
      fresh: true,
    });
  } catch {
    return null;
  }
  if (!row || !Array.isArray(row.handles) || typeof row.sentAt !== 'number') return null;
  const match = row.handles.find(
    (handle) => handle?.workspaceId === workspaceId && handle?.harnessSlug === harnessSlug,
  );
  const currentDevicePubkeyBase64 = match?.announceIdentity?.devicePubkeyBase64;
  const historical = Array.isArray(row.lastKnownAnnounceDevices)
    ? row.lastKnownAnnounceDevices.find(
        (record) =>
          isLastKnownAnnounceDeviceRecord(record) &&
          record.workspaceId === workspaceId &&
          record.harnessSlug === harnessSlug,
      )
    : undefined;
  const devicePubkeyBase64 =
    typeof currentDevicePubkeyBase64 === 'string' && currentDevicePubkeyBase64
      ? currentDevicePubkeyBase64
      : historical?.devicePubkeyBase64;
  if (!devicePubkeyBase64) return null;
  const advertisedAt =
    typeof currentDevicePubkeyBase64 === 'string' && currentDevicePubkeyBase64 ? row.sentAt : historical?.advertisedAt;
  if (typeof advertisedAt !== 'number' || !Number.isFinite(advertisedAt)) return null;
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PG_SNAPSHOT_MAX_AGE_MS;
  const now = opts?.now ?? (() => Date.now());
  return {
    devicePubkeyBase64,
    advertisedAt,
    stale: now() - advertisedAt > maxAgeMs,
  };
}
