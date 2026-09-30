/**
 * pot-git/ref-announce.ts — G-3 ref announcements (Phase 7,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-027; D-010).
 *
 * The announcement rail: how a peer LEARNS a device's namespace advanced,
 * without polling. After a device publishes new heads and rebuilds its sigrefs
 * (G-4, sigrefs.ts), it signs a tiny `{device, sigrefsOid, version}` envelope
 * and fires it hive-wide as a P-009 federated event
 * (`events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive', payload }`).
 * Every member awaits the same key; on wake it runs the receiver pipeline here:
 *
 *   accept (sig + membership + monotonic version + budget)
 *     → compare announced sigrefsOid vs the local mirror  → noop when current
 *     → fetchPeerNamespace (G-2)                          → mirror the heads
 *     → acceptFetchedSigrefs + reconcileFetchedHeads (G-4/G-4b) → trust verdict
 *
 * WHY an envelope at all (and not just "something changed, go fetch"): the
 * `sigrefs_oid` lets a receiver skip the fetch entirely when it already mirrors
 * that exact snapshot (dedup across relays/replays), and the mirrored `version`
 * fences stale/replayed announcements BEFORE any transport work — the same
 * no-side-table watermark idiom as G-4b (the watermark IS the version of the
 * sigrefs currently stored in the local mirror for that device).
 *
 * BUDGET CAP (the P-003 idiom, applied to fetch storms): a per-device
 * fixed-window budget bounds how many announcement-driven fetches one device
 * can trigger. Over-budget announcements are DEFERRED, not errors — the
 * periodic anti-entropy sweep (integrator cadence) reconverges; the cap only
 * bounds the burst. The budget is charged ONLY for otherwise-acceptable fresh
 * announcements, so replays/stale ones can never starve a device's budget.
 *
 * The signed payload + pure acceptance follow staging-advance.ts exactly
 * (fixed field order, domain-separated signing bytes). Pure over ed25519.ts +
 * storage.ts's RunGit seam + a caller-provided `openStream` (the Protomux
 * sub-stream to the announcing peer) — unit-tests without git, integration-
 * tests against real bare repos over a socketpair.
 */

import type { Duplex } from 'node:stream';
import { verifyEd25519 } from '../../identity/ed25519';
import { type RunGit, defaultRunGit, readNamespaceRef } from './storage';
import { fetchPeerNamespace } from './fetch-transport';
import { fetchCoalescerKey, withFetchCoalescing } from './fetch-coalescer';
import {
  SIGREFS_REF,
  type SignedSigrefs,
  acceptFetchedSigrefs,
  readSigrefs,
  reconcileFetchedHeads,
} from './sigrefs';
import {
  SIGNED_PROTOCOL_SCHEMA_VERSION,
  isSignedProtocolContext,
  signedProtocolContextMatches,
  compareGenerationVersion,
  type ExpectedSignedProtocolContext,
  type SignedSnapshotFloor,
  type SignedProtocolContext,
} from './signed-context';

/** Wire schema version for the ref-announcement envelope. */
export const REF_ANNOUNCE_SCHEMA_VERSION = 1;
/** Context-bound envelope version. V1 remains readable only during migration. */
export const REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT = SIGNED_PROTOCOL_SCHEMA_VERSION;

/** Domain-separation tag (the staging-advance idiom) — a ref-announce signature
 *  can never be replayed as a sigrefs blob / staging advance / handoff token. */
export const REF_ANNOUNCE_SIG_DOMAIN = 'papercusp-pot-git-ref-announce-v1';

/** The hive-wide rendezvous key (P-009 rail): senders
 *  `events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive', payload: SignedRefAnnouncement }`,
 *  every member holds an events:await on the same key. */
export const REF_ANNOUNCE_EVENT_KEY = 'pot-git:ref-announce';

/** The signed announcement payload (fixed field order = the signing order). */
export interface RefAnnouncePayload {
  /** Wire schema version. */
  v: number;
  /** The announcing device's raw-32 Ed25519 pubkey (base64) — bound into the sig. */
  device_pubkey: string;
  /** The blob sha its `refs/rad/sigrefs` points at — the snapshot being advertised. */
  sigrefs_oid: string;
  /** The sigrefs monotonic version (G-4b counter) — pre-transport fencing. */
  version: number;
  /** Announce time (epoch ms) — audit/freshness only, NOT part of the ordering. */
  ts: number;
  /** V2 stable signed identity tuple. Absent on legacy v1 envelopes. */
  hive_id?: string;
  repo_key?: string;
  store_generation?: string;
}

export interface SignedRefAnnouncement extends RefAnnouncePayload {
  /** base64 Ed25519 signature over refAnnounceSigningBytes(payload). */
  sig: string;
}

const OID_RE = /^[0-9a-f]{40,64}$/;

function isRefAnnouncePayload(x: unknown): x is RefAnnouncePayload {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  const baseOk = (
    typeof s.v === 'number' &&
    typeof s.device_pubkey === 'string' &&
    typeof s.sigrefs_oid === 'string' &&
    OID_RE.test(s.sigrefs_oid) &&
    typeof s.version === 'number' &&
    Number.isSafeInteger(s.version) &&
    s.version >= 0 &&
    typeof s.ts === 'number' &&
    (s.v === REF_ANNOUNCE_SCHEMA_VERSION || s.v === REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT)
  );
  if (!baseOk) return false;
  return s.v !== REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT || isSignedProtocolContext(s);
}

export function isSignedRefAnnouncement(x: unknown): x is SignedRefAnnouncement {
  return isRefAnnouncePayload(x) && typeof (x as unknown as Record<string, unknown>).sig === 'string';
}

/** Canonical signing bytes: domain tag + fixed field order, `sig` excluded. */
export function refAnnounceSigningBytes(payload: RefAnnouncePayload): Buffer {
  const ordered: Record<string, unknown> = {
    v: payload.v,
    device_pubkey: payload.device_pubkey,
    sigrefs_oid: payload.sigrefs_oid,
    version: payload.version,
    ts: payload.ts,
  };
  if (payload.v === REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT) {
    ordered.hive_id = payload.hive_id;
    ordered.repo_key = payload.repo_key;
    ordered.store_generation = payload.store_generation;
  }
  return Buffer.from(`${REF_ANNOUNCE_SIG_DOMAIN}\n${JSON.stringify(ordered)}`, 'utf8');
}

/**
 * Build + sign THIS device's announcement from its currently-stored sigrefs in
 * `repoPath` (blob oid + version). Call AFTER buildSigrefs — throws when the
 * device has no sigrefs yet (an announcement without a snapshot is meaningless).
 * `sign` is the device signer seam (prod: `bytes => signWithDeviceKey(...)`).
 */
export async function buildRefAnnouncement(
  repoPath: string,
  devicePubkeyBase64: string,
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts: { nowMs: number; runGit?: RunGit; context?: SignedProtocolContext },
): Promise<SignedRefAnnouncement> {
  const runGit = opts.runGit ?? defaultRunGit;
  const sigrefsOid = await readNamespaceRef(repoPath, devicePubkeyBase64, SIGREFS_REF, runGit);
  const stored = await readSigrefs(repoPath, devicePubkeyBase64, runGit);
  if (!sigrefsOid || !stored) {
    throw new Error('pot-git: buildRefAnnouncement requires a stored sigrefs (run buildSigrefs first)');
  }
  if (opts.context && !signedProtocolContextMatches(stored, opts.context)) {
    throw new Error('pot-git: announcement context differs from the stored signed snapshot');
  }
  if (!opts.context && isSignedProtocolContext(stored)) {
    throw new Error('pot-git: refusing to downgrade a scoped snapshot announcement');
  }
  const payload: RefAnnouncePayload = {
    v: opts.context ? REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT : REF_ANNOUNCE_SCHEMA_VERSION,
    device_pubkey: devicePubkeyBase64,
    sigrefs_oid: sigrefsOid,
    version: stored.version,
    ts: opts.nowMs,
    ...(opts.context ?? {}),
  };
  const sig = (await sign(refAnnounceSigningBytes(payload))).toString('base64');
  return { ...payload, sig };
}

/**
 * Verify a signed announcement. When `expectedDevicePubkeyBase64` is given the
 * embedded device must equal it; otherwise the signature is verified against
 * the EMBEDDED key and the caller MUST separately gate that device (hive
 * membership). Never throws.
 */
export function verifyRefAnnouncement(
  signed: SignedRefAnnouncement,
  expectedDevicePubkeyBase64?: string,
): boolean {
  if (!isSignedRefAnnouncement(signed)) return false;
  if (expectedDevicePubkeyBase64 !== undefined && signed.device_pubkey !== expectedDevicePubkeyBase64) {
    return false;
  }
  try {
    return verifyEd25519(
      refAnnounceSigningBytes(signed),
      signed.device_pubkey,
      Buffer.from(signed.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

// ── Budget cap ────────────────────────────────────────────────────────────────

export interface AnnounceBudgetConfig {
  /** Fixed-window length. */
  windowMs: number;
  /** Max announcement-driven fetches per device per window. */
  maxPerWindow: number;
}

/** Default: at most 12 announcement-driven fetches per device per minute — a
 *  busy autocommit cadence fits; a flood defers to the anti-entropy sweep. */
export const DEFAULT_ANNOUNCE_BUDGET: AnnounceBudgetConfig = { windowMs: 60_000, maxPerWindow: 12 };

/** Per-device budget window state (caller keeps a Map<device, state>). */
export interface AnnounceBudgetState {
  windowStartMs: number;
  count: number;
}

/**
 * PURE fixed-window take: returns whether a token was available and the next
 * state (unchanged when denied). `state` null ⇒ first sighting of the device.
 */
export function takeAnnounceBudget(
  state: AnnounceBudgetState | null,
  nowMs: number,
  cfg: AnnounceBudgetConfig = DEFAULT_ANNOUNCE_BUDGET,
): { ok: boolean; state: AnnounceBudgetState } {
  if (!state || nowMs - state.windowStartMs >= cfg.windowMs) {
    return { ok: true, state: { windowStartMs: nowMs, count: 1 } };
  }
  if (state.count >= cfg.maxPerWindow) return { ok: false, state };
  return { ok: true, state: { windowStartMs: state.windowStartMs, count: state.count + 1 } };
}

// ── Acceptance ────────────────────────────────────────────────────────────────

export type RefAnnounceBaseRejectReason =
  | 'malformed'
  | 'self'
  | 'wrong-device'
  | 'bad-signature'
  | 'stale-version'
  | 'over-budget';
// Context/version failures are intentionally separate from bad signatures so
// operators can distinguish mixed-version peers from tampering.
export type RefAnnounceContextRejectReason = 'legacy-version' | 'context-mismatch' | 'stale-generation';
export type RefAnnounceRejectReason = RefAnnounceBaseRejectReason | RefAnnounceContextRejectReason;

export type RefAnnounceAcceptance =
  | { ok: true; budgetState: AnnounceBudgetState | null }
  | { ok: false; reason: RefAnnounceRejectReason; budgetState: AnnounceBudgetState | null };

export interface AcceptRefAnnouncementOpts {
  /** Our own device — its announcements are ignored ('self'). */
  selfDevice?: string;
  /** Devices allowed to announce (current hive members). Omitted ⇒ signature
   *  self-consistency only — the caller MUST gate the device itself. */
  allowedDevices?: readonly string[];
  /**
   * The G-4b watermark: the `version` of the sigrefs currently stored in OUR
   * mirror for the announcing device (null when we hold none). An announcement
   * whose version is ≤ this is stale — we already mirror that state or newer.
   */
  priorVersion: number | null;
  /** Expected v2 context. V1 is accepted only when allowLegacy is true. */
  expectedContext?: ExpectedSignedProtocolContext;
  allowLegacy?: boolean;
  replayFloor?: SignedSnapshotFloor | null;
  /** Budget leg (omit to skip capping — e.g. the anti-entropy sweep path). */
  budget?: {
    state: AnnounceBudgetState | null;
    nowMs: number;
    config?: AnnounceBudgetConfig;
  };
}

/**
 * PURE acceptance for an inbound announcement: shape → self-filter → membership
 * gate → signature → version fencing → budget. The budget is charged LAST, so
 * only announcements that would otherwise trigger a fetch consume it. The
 * caller persists `budgetState` back into its per-device map either way.
 */
export function acceptRefAnnouncement(
  incoming: SignedRefAnnouncement,
  opts: AcceptRefAnnouncementOpts,
): RefAnnounceAcceptance {
  const currentBudget = opts.budget?.state ?? null;
  if (!isSignedRefAnnouncement(incoming)) return { ok: false, reason: 'malformed', budgetState: currentBudget };
  if (incoming.v === REF_ANNOUNCE_SCHEMA_VERSION && (opts.allowLegacy !== true || opts.replayFloor)) {
    return { ok: false, reason: 'legacy-version', budgetState: currentBudget };
  }
  if (incoming.v === REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT &&
      (!opts.expectedContext || !signedProtocolContextMatches(incoming, opts.expectedContext))) {
    return { ok: false, reason: 'context-mismatch', budgetState: currentBudget };
  }
  if (opts.selfDevice !== undefined && incoming.device_pubkey === opts.selfDevice) {
    return { ok: false, reason: 'self', budgetState: currentBudget };
  }
  if (opts.allowedDevices !== undefined && !opts.allowedDevices.includes(incoming.device_pubkey)) {
    return { ok: false, reason: 'wrong-device', budgetState: currentBudget };
  }
  if (!verifyRefAnnouncement(incoming)) return { ok: false, reason: 'bad-signature', budgetState: currentBudget };
  if (opts.replayFloor) {
    const order = compareGenerationVersion(incoming, opts.replayFloor);
    if (order !== 1) return { ok: false, reason: incoming.store_generation === opts.replayFloor.store_generation ? 'stale-version' : 'stale-generation', budgetState: currentBudget };
  } else if (opts.priorVersion !== null && incoming.version <= opts.priorVersion) {
    return { ok: false, reason: 'stale-version', budgetState: currentBudget };
  }
  if (opts.budget) {
    const take = takeAnnounceBudget(opts.budget.state, opts.budget.nowMs, opts.budget.config);
    if (!take.ok) return { ok: false, reason: 'over-budget', budgetState: take.state };
    return { ok: true, budgetState: take.state };
  }
  return { ok: true, budgetState: currentBudget };
}

/** PURE fetch decision: skip transport when we already mirror the advertised
 *  snapshot (`localSigrefsOid` = the blob our mirror's sigrefs ref points at,
 *  null when we hold none for that device). */
export function shouldFetchOnAnnouncement(
  incoming: SignedRefAnnouncement,
  localSigrefsOid: string | null,
): boolean {
  return incoming.sigrefs_oid !== localSigrefsOid;
}

// ── Receiver driver ───────────────────────────────────────────────────────────

export type RefAnnounceHandleResult =
  | { action: 'rejected'; reason: RefAnnounceRejectReason; budgetState: AnnounceBudgetState | null }
  | { action: 'noop'; budgetState: AnnounceBudgetState | null }
  /**
   * WI-6418: a fetch for this (repo, device) was ALREADY RUNNING, so this drive
   * was collapsed into it and opened no session of its own.
   *
   * This is deliberately NOT `fetch-failed`, and the distinction is the entire
   * point of the fix. On this fleet ~12+ staggered `git-sync` routines drive a
   * fetch for the same repo roughly every ~15s in aggregate, while a multi-GB
   * cold join needs ~175s. Every one of those drives used to open its own
   * session, and the serve side then destroyed (pre-WI-6412) or refused
   * (post-WI-6412) the transfer already in progress — so the repo could never
   * converge at ANY throughput, because the ceiling is a PERIOD, not a RATE.
   *
   * Reporting this as a failure would re-arm exactly that storm: the driver
   * would log a phantom transport error and treat a perfectly healthy
   * in-progress transfer as a broken one.
   *
   * The caller SHOULD still hold its fed-event cursor on this outcome, exactly
   * as it does for `fetch-failed` — the announcement genuinely has not been
   * mirrored yet, and advancing past it would re-create the silent, permanent
   * namespace gap EI-15335 fixed. Holding is correct and always was; it was the
   * RE-DIAL that holding triggered, not the hold itself, that caused the harm.
   */
  | { action: 'already-in-flight'; budgetState: AnnounceBudgetState | null }
  /**
   * WI-6277: `stderr` ALONE cannot describe this failure, and the gap is not
   * cosmetic — it stranded a live replication stall on the P-302 rig with an
   * operator line that ended in a bare colon.
   *
   * The transport already distinguishes the cases (`TransportResult.timedOut`
   * is set immediately before `child.kill('SIGKILL')` on the ceiling path), but
   * a SIGKILLed git writes NOTHING to stderr — so the one failure mode we can
   * positively identify was the one that rendered as an empty string, and a
   * ceiling timeout, a transient dial miss, and a genuine git error all printed
   * identically. Carry the discriminators so the log site can say which.
   *
   * `code: -1` means NO git process ran at all (the stream never opened), which
   * is why it cannot be conflated with a real exit status.
   */
  | {
      action: 'fetch-failed';
      stderr: string;
      timedOut: boolean;
      code: number;
      budgetState: AnnounceBudgetState | null;
    }
  | {
      action: 'fetched';
      /** G-4/G-4b verdict on the fetched snapshot. When NOT accepted the caller
       *  (integrator) must treat the whole namespace as untrusted — the mirror
       *  refs are present but unverified. */
      sigrefs:
        | { accepted: true; snapshot: SignedSigrefs }
        | {
            accepted: false;
            reason:
              | 'bad-signature'
              | 'wrong-device'
              | 'rollback'
              | 'malformed'
              | 'missing'
              | 'origin-claim-outside-scope'
              | 'legacy-version'
              | 'context-mismatch'
              | 'stale-generation'
              | 'snapshot-mismatch';
          };
      /** Heads whose fetched sha diverges from the signed snapshot (empty ⇒
       *  every head is exactly what the device signed). */
      mismatches: { ref: string; expected: string; actual: string | null }[];
      /** The blob the mirror's sigrefs ref points at AFTER the fetch. It can be
       *  NEWER than `incoming.sigrefs_oid` (the peer advanced before we dialed —
       *  see `fetchedSnapshotHonoursAnnouncement`), so a replay floor recorded
       *  from an accepted fetch must use this, never the announcement's oid. */
      sigrefsOid?: string | null;
      budgetState: AnnounceBudgetState | null;
    };

export interface HandleRefAnnouncementOpts {
  selfDevice?: string;
  allowedDevices?: readonly string[];
  /** Per-device budget window (pass the device's current state; persist the
   *  returned one). Omit to skip capping. */
  budget?: { state: AnnounceBudgetState | null; config?: AnnounceBudgetConfig };
  nowMs: number;
  /** Open the transport sub-stream to the ANNOUNCING peer (Protomux channel on
   *  the live hive-swarm connection; a socketpair in tests). Only called when a
   *  fetch is actually needed. */
  openStream: () => Promise<Duplex> | Duplex;
  timeoutMs?: number;
  runGit?: RunGit;
  expectedContext?: ExpectedSignedProtocolContext;
  allowLegacy?: boolean;
  replayFloor?: SignedSnapshotFloor | null;
}

/** Ceiling applied to the `openStream` seam when the caller passes no
 *  `timeoutMs`. Matches `fetchOverDuplex`'s own default posture: generous
 *  enough that a healthy-but-slow dial is never cut off, finite enough that a
 *  wedged one cannot pin the tick. */
const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 30_000;

/**
 * EI-18752434722211671 — call the caller-supplied `openStream` seam under a
 * CEILING, resolving null if it never produces a duplex in time.
 *
 * `opts.timeoutMs` used to bound only `fetchPeerNamespace`; the
 * `await opts.openStream()` immediately before it was UNBOUNDED. `openStream`
 * is arbitrary caller code that dials a live peer — on the P-302 rig its
 * implementation reached a protomux channel that neither opened nor closed, so
 * this await never settled, the receive tick never returned, and (because the
 * tick runs as a DBOS step) the git-sync routine's dedup pin was never
 * released, rejecting every subsequent enqueue on that device for hours.
 *
 * The root cause was fixed in `serve-wiring.ts` (`waitOpened` is now bounded),
 * but this seam is the injection point for ANY openStream implementation —
 * including ones that do their own I/O before dialing (git-sync-action's reads
 * `resolveHiveGitTopicHex` from Postgres first). Bounding it here makes the
 * receive path structurally incapable of hanging, whatever a caller supplies,
 * which is what stops this CLASS of wedge from returning.
 *
 * A late duplex is DESTROYED rather than leaked — if the seam resolves after we
 * gave up, that duplex owns a live channel session nobody will ever read.
 */
async function openStreamWithinCeiling(
  openStream: () => Promise<Duplex> | Duplex,
  timeoutMs: number | undefined,
): Promise<Duplex | null> {
  const ms = timeoutMs ?? DEFAULT_STREAM_OPEN_TIMEOUT_MS;
  let timedOut = false;
  const pending = (async () => openStream())();
  const winner = await new Promise<Duplex | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, ms);
    timer.unref?.();
    void pending.then(
      (d) => {
        clearTimeout(timer);
        resolve(d);
      },
      () => {
        // A THROWN openStream is a failed dial, not a hang — resolve null and
        // let the caller report `fetch-failed` (the tick's own catch would also
        // handle it, but reporting here keeps one result per announcement).
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
  if (timedOut) {
    void pending.then(
      (late) => {
        try {
          late.destroy();
        } catch {
          /* best-effort */
        }
      },
      () => {
        /* already failed — nothing to clean up */
      },
    );
  }
  return winner;
}

/**
 * Full receiver pipeline for one inbound announcement against the local mirror
 * `repoPath`: pure acceptance (watermark read from the mirror), sigrefs-oid
 * dedup, G-2 namespace fetch from the announcing peer, then the G-4/G-4b
 * verdict + head reconciliation on what arrived. Never throws on transport or
 * verification failures — every leg reports through the result union.
 *
 * NOTE the watermark is captured BEFORE the fetch: the forced namespace
 * refspec overwrites the mirrored sigrefs ref, so post-fetch the mirror holds
 * the INCOMING snapshot — `acceptFetchedSigrefs` fences it against the
 * pre-fetch version. A rejected snapshot leaves the namespace mirrored but
 * UNTRUSTED; the integrator only merges heads that reconcile against an
 * accepted sigrefs (G-5 contract), so an unaccepted fetch cannot advance
 * staging.
 */
export async function handleRefAnnouncement(
  repoPath: string,
  incoming: SignedRefAnnouncement,
  opts: HandleRefAnnouncementOpts,
): Promise<RefAnnounceHandleResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  const device = incoming.device_pubkey;
  const prior = isSignedRefAnnouncement(incoming) ? await readSigrefs(repoPath, device, runGit) : null;
  // Explicit null is a durable first-contact floor, never a mirror-derived one.
  const priorVersion = opts.replayFloor !== undefined ? opts.replayFloor?.version ?? null : prior?.version ?? null;
  const localOid = isSignedRefAnnouncement(incoming)
    ? await readNamespaceRef(repoPath, device, SIGREFS_REF, runGit)
    : null;
  const exactAcceptedSnapshot = opts.replayFloor && incoming.version === opts.replayFloor.version &&
    incoming.sigrefs_oid === opts.replayFloor.sigrefs_oid && signedProtocolContextMatches(incoming, opts.replayFloor);
  // A receiver may lose its Git mirror while retaining its PG floor. Rebuild
  // exactly that accepted snapshot without lowering or discarding the floor.
  const rematerialize = !!exactAcceptedSnapshot && (localOid !== incoming.sigrefs_oid || !prior ||
    (await reconcileFetchedHeads(repoPath, device, prior, runGit)).length !== 0);

  const acceptance = acceptRefAnnouncement(incoming, {
    selfDevice: opts.selfDevice,
    allowedDevices: opts.allowedDevices,
    priorVersion: rematerialize ? null : priorVersion,
    expectedContext: opts.expectedContext,
    allowLegacy: opts.allowLegacy,
    replayFloor: rematerialize ? null : opts.replayFloor,
    budget: opts.budget ? { state: opts.budget.state, nowMs: opts.nowMs, config: opts.budget.config } : undefined,
  });
  if (!acceptance.ok) return { action: 'rejected', reason: acceptance.reason, budgetState: acceptance.budgetState };
  const needsFetch = rematerialize || shouldFetchOnAnnouncement(incoming, localOid);
  if (!needsFetch && incoming.v === REF_ANNOUNCE_SCHEMA_VERSION) {
    return { action: 'noop', budgetState: acceptance.budgetState };
  }

  // WI-6418 — coalesce concurrent drives for this (repo, device) into ONE
  // fetch. The guard wraps BOTH the openStream and the transfer, because it is
  // opening the second SESSION that does the damage: the serve side sees a
  // second request for a repo it is already streaming and destroys/refuses the
  // transfer in progress. Keyed on (repoPath, device) so genuinely different
  // peers still sync in parallel — only same-peer, same-repo duplicates collapse.
  const coalesced = await withFetchCoalescing(fetchCoalescerKey(repoPath, device), async () => {
    if (!needsFetch) return { code: 0, stdout: '', stderr: '', timedOut: false };
    const duplex = await openStreamWithinCeiling(opts.openStream, opts.timeoutMs);
    if (!duplex) {
      return {
        action: 'fetch-failed' as const,
        stderr:
          `openStream did not resolve within ${opts.timeoutMs ?? DEFAULT_STREAM_OPEN_TIMEOUT_MS}ms ` +
          `(no duplex was ever produced — see EI-18752434722211671)`,
        timedOut: true,
        // No git process ever ran on this branch, so there is no exit status to
        // report — -1 marks that explicitly rather than implying a clean exit 0.
        code: -1,
      };
    }
    return fetchPeerNamespace(repoPath, duplex, device, { timeoutMs: opts.timeoutMs });
  });

  if (!coalesced.ran) {
    // A fetch for this repo+device is already streaming. Not an error — see the
    // `already-in-flight` doc on RefAnnounceHandleResult.
    return { action: 'already-in-flight', budgetState: acceptance.budgetState };
  }
  const res = coalesced.result;
  if ('action' in res && res.action === 'fetch-failed') {
    return { action: 'fetch-failed', stderr: res.stderr, timedOut: res.timedOut, code: res.code, budgetState: acceptance.budgetState };
  }
  if (res.code !== 0) {
    return {
      action: 'fetch-failed',
      stderr: res.stderr,
      timedOut: res.timedOut,
      code: res.code,
      budgetState: acceptance.budgetState,
    };
  }

  const fetched = await readSigrefs(repoPath, device, runGit);
  if (!fetched) {
    return {
      action: 'fetched',
      sigrefs: { accepted: false, reason: 'missing' },
      mismatches: [],
      budgetState: acceptance.budgetState,
    };
  }
  const verdict = acceptFetchedSigrefs(fetched, device, rematerialize ? null : priorVersion, {
    expectedContext: opts.expectedContext,
    allowLegacy: opts.allowLegacy,
    replayFloor: rematerialize ? null : opts.replayFloor,
  });
  const fetchedOid = await readNamespaceRef(repoPath, device, SIGREFS_REF, runGit);
  if (incoming.v === REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT && !fetchedSnapshotHonoursAnnouncement(fetched, fetchedOid, incoming)) {
    return { action: 'fetched', sigrefs: { accepted: false, reason: 'snapshot-mismatch' }, mismatches: [], sigrefsOid: fetchedOid, budgetState: acceptance.budgetState };
  }
  const mismatches = await reconcileFetchedHeads(repoPath, device, fetched, runGit);
  return {
    action: 'fetched',
    sigrefs: verdict.ok ? { accepted: true, snapshot: fetched } : { accepted: false, reason: verdict.reason },
    mismatches,
    sigrefsOid: fetchedOid,
    budgetState: acceptance.budgetState,
  };
}

/**
 * WI-2142873 / P-203 Leg A — does a v2 fetch honour the announcement that drove it?
 *
 * A fetch mirrors the peer's namespace AS IT IS WHEN WE DIAL, not as it was when
 * it announced. Requiring the fetched snapshot to be EXACTLY the announced one
 * (the rule this replaces) therefore made every fetch driven by a queued
 * announcement fail as `snapshot-mismatch` whenever the peer had announced
 * again since. The receiver drains its backlog oldest-first, so after any stall
 * that is every fetch. Measured on the Mac VM 2026-09-27T16:52Z: the batch held
 * XPAsvso1 announcements v2..v2683, the fetch brought v2921, nothing was
 * accepted, the replay floor stayed null, and with no floor every later row
 * re-dialed into serve-wiring's `busy-streaming` refusal while the worktree
 * bridge held forever on `unknown-generation`.
 *
 * A NEWER snapshot is legitimate: it is device-signed, and `acceptFetchedSigrefs`
 * has already checked its signature, device, context and replay floor. The
 * announcement only has to stop the relay from serving something OLDER than the
 * device announced. That is the rollback this guard exists for. So:
 *   - same signed context (hive, repo, store generation) — always required;
 *   - newer version than announced — accepted (the peer advanced);
 *   - same version — must be byte-identical (a different oid is equivocation);
 *   - older version — refused (relay rollback).
 */
export function fetchedSnapshotHonoursAnnouncement(
  fetched: SignedSigrefs,
  fetchedOid: string | null,
  incoming: SignedRefAnnouncement,
): boolean {
  if (!signedProtocolContextMatches(fetched, incoming as SignedProtocolContext)) return false;
  if (fetched.version > incoming.version) return fetchedOid !== null;
  return fetched.version === incoming.version && fetchedOid === incoming.sigrefs_oid;
}
