/**
 * presence-announce — the WRITE side of Phase 0.3
 * (distributed-coordination-shared-harness-2026-06-04): publishing THIS machine's
 * presence into the harness swarm so peers see it (the read side,
 * federated-presence.ts, surfaces peers; this makes us a peer).
 *
 * Two pure pieces (the testable core) + a thin append integration (the gated
 * wire):
 *
 *  1. shouldAnnounce — the D-007 cadence rule: federate presence as a
 *     STATE-CHANGE-with-TTL, NOT every heartbeat. A per-heartbeat presence write
 *     would flood the peer-log (the plan's "presence firehose" risk). So announce
 *     only when (a) the declared state changed (intent / current_view / harness),
 *     or (b) the last announce is older than the refresh interval (a keep-alive
 *     before the staleness window expires).
 *  2. buildPresenceAnnounceOp — the op the local Hypercore log carries; its value
 *     is exactly the SharedPresenceRow the presence projection materializes on
 *     every peer (and on us, so we see ourselves).
 *
 * The integration — calling `handle.append(op)` on the booted per-harness
 * substrate handle on a timer — is environment-gated (needs a booted swarm + a gh
 * device identity, neither present on a single gh-unauthenticated dev box). It is
 * a thin wire over these pure pieces: resolve the device identity
 * (resolveUsageActor), build the op, and append it whenever shouldAnnounce is
 * true. {@link announceLocalPresence} packages that with an injected `append` so
 * the decision + op are tested without a live swarm.
 */

import type { SharedPresenceRow } from './projections/presence';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import type { LocalWriteOp } from './boot';
import { isSessionClosedError } from './own-log-fork-guard';

/** The presence schema version (presence rows carry schema_version). */
const PRESENCE_SCHEMA_VERSION = 1;

/** The mutable presence state a machine declares. */
export interface PresenceState {
  intent: string | null;
  currentView: string | null;
  harnessSlug: string;
}

/** What was last announced (for the state-change decision). */
export interface LastAnnounce {
  state: PresenceState;
  /** epoch ms of the last announce. */
  atMs: number;
}

export interface AnnounceCadenceOpts {
  /** Re-announce (keep-alive) once the last announce is older than this, even
   *  with no state change. Default: 1/3 of the staleness window so a peer never
   *  ages out a still-present machine. */
  refreshMs?: number;
}

const DEFAULT_REFRESH_MS = 30_000;

/** EI-18768167802573425 — how long to wait before re-attempting an identity
 *  resolution that returned null. Long enough that a genuinely unauthenticated
 *  box is not re-probing its keychain every tick, short enough that a transient
 *  boot-race failure self-heals in about a minute instead of never. */
const DEFAULT_IDENTITY_RETRY_MS = 60_000;

function stateChanged(a: PresenceState, b: PresenceState): boolean {
  return a.intent !== b.intent || a.currentView !== b.currentView || a.harnessSlug !== b.harnessSlug;
}

/**
 * The D-007 cadence rule: announce iff the state changed OR the last announce is
 * stale (keep-alive). `prev === null` (never announced) → always announce.
 */
export function shouldAnnounce(
  prev: LastAnnounce | null,
  next: PresenceState,
  nowMs: number,
  opts: AnnounceCadenceOpts = {},
): boolean {
  if (!prev) return true;
  if (stateChanged(prev.state, next)) return true;
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  return nowMs - prev.atMs >= refreshMs;
}

/** This machine's swarm identity for a presence announce. */
export interface PresenceIdentity {
  githubUserId: number;
  machineLabel: string;
  devicePubkey: string;
}

/**
 * Build the SharedPresenceRow value for an announce.
 *
 * `potSlug` (shared-hive-federation P-008/P-009) is the harness's home Hive slug
 * — the publisher resolves it once via potHomeSlugForHarness and threads it here
 * so each federated presence row carries it for the per-Hive lock authority.
 * Defaults null (a non-Hive harness, or a caller that hasn't wired Hive scope yet)
 * — additive + back-compat.
 *
 * `runsRoutines` (EI-18761517980514694) is the same shape one layer on: the
 * capability bit the per-Hive RUNNER election filters peers by ("this node's
 * routine host is live AND a cadence-runner routine is armed here for this
 * harness" — lib/cadence-runner-capability.ts). Defaults null = "not a runner",
 * the conservative direction: peers skip us, but every selector adds SELF
 * unconditionally, so we still run our own loop.
 */
export function buildPresenceAnnounceRow(
  identity: PresenceIdentity,
  state: PresenceState,
  nowMs: number,
  potSlug: string | null = null,
  runsRoutines: boolean | null = null,
  activeRoutines: readonly string[] | null = null,
): SharedPresenceRow {
  return {
    harness_slug: state.harnessSlug,
    github_user_id: identity.githubUserId,
    machine_label: identity.machineLabel,
    device_pubkey: identity.devicePubkey,
    intent: state.intent,
    current_view: state.currentView,
    last_seen_at: nowMs,
    schema_version: PRESENCE_SCHEMA_VERSION,
    hive_slug: potSlug,
    // Emitted only when TRUE — `false` and "unknown" are the same verdict to every
    // consumer (not a runner candidate), so collapsing them to null keeps a
    // non-runner's signed gossip frame byte-identical to the pre-mig-682 wire form
    // (see presenceFrameSigningBytes) instead of breaking verification on peers
    // that have not upgraded yet.
    runs_routines: runsRoutines === true ? true : null,
    // EI-19330771435294981 (mig 724): same emit-only-when-informative rule, for the
    // same wire reason. An EMPTY set and "unknown" are the identical verdict to
    // every consumer (not a candidate for any election), so collapsing both to null
    // keeps a routine-less node's signed frame byte-identical to the pre-mig-724
    // form rather than breaking verification on peers that have not upgraded.
    active_routines: activeRoutines && activeRoutines.length > 0 ? activeRoutines : null,
  };
}

/** Build the local-log op the substrate appends (federates to peers, and the
 *  local projection materializes back so we see ourselves). The Hyperbee key
 *  mirrors the presence projection's composeKey: `<github_user_id>/<machine>`. */
export function buildPresenceAnnounceOp(
  identity: PresenceIdentity,
  state: PresenceState,
  nowMs: number,
  potSlug: string | null = null,
  runsRoutines: boolean | null = null,
  activeRoutines: readonly string[] | null = null,
): LocalWriteOp {
  const value = buildPresenceAnnounceRow(
    identity,
    state,
    nowMs,
    potSlug,
    runsRoutines,
    activeRoutines,
  );
  return {
    type: 'put',
    table: 'presence',
    hbKey: `${identity.githubUserId}/${identity.machineLabel}`,
    value,
    ts: nowMs,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
}

/**
 * Build the presence TOMBSTONE op — a `del` on this device's presence key
 * (shared-hive-hardening-2026-06-13 EI-469). Published when a peer LEAVES a hive
 * (pot:leave) so OTHER peers delete the leaver's `shared_presence` row at once
 * (the projection's ts-guarded deleteFromPg) instead of waiting out the ~90s
 * staleness TTL — which also drops one stale vote from the per-Hive lock-authority
 * election.
 *
 * Deliberately NOT published on graceful shutdown: going offline is TRANSIENT
 * (you'll reappear on next boot, and a quick restart should not blink out of
 * peers' rosters) — the TTL models that correctly. A tombstone means "I LEFT",
 * not "I'm briefly offline". Key mirrors buildPresenceAnnounceOp /
 * the projection composeKey: `<github_user_id>/<machine_label>`.
 */
export function buildPresenceTombstoneOp(
  identity: Pick<PresenceIdentity, 'githubUserId' | 'machineLabel'>,
  nowMs: number,
): LocalWriteOp {
  return {
    type: 'del',
    table: 'presence',
    hbKey: `${identity.githubUserId}/${identity.machineLabel}`,
    ts: nowMs,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
}

export interface AnnounceLocalPresenceDeps {
  /** Append the op to this machine's Hypercore log (the booted substrate handle).
   *  Injected so the decision + op are tested without a live swarm. */
  append: (op: LocalWriteOp) => Promise<void>;
  /** The last announce (for the cadence decision); null = never announced. */
  prev: LastAnnounce | null;
  now?: () => number;
  cadence?: AnnounceCadenceOpts;
  /** The harness's home Hive slug (shared-hive-federation P-008/P-009), stamped on
   *  each announce so the FEDERATED presence row carries it — the per-Hive lock
   *  authority scopes by it (lockAuthorityForHive's `WHERE hive_slug`). Null = a
   *  non-Hive harness. Additive: omitted → null (back-compat). */
  potSlug?: string | null;
  /**
   * EI-18761517980514694 — resolve the RUNNER-election capability bit
   * (`shared_presence.runs_routines`). Called LAZILY, only on a tick that actually
   * announces (never on a suppressed one), so the cost is one cached lookup per
   * announce rather than one per poll.
   *
   * A resolver rather than a value ON PURPOSE: resolving once at wire time (the way
   * `potSlug` is) would let a node that later DISARMS its cadence routine keep a
   * stale `true` marker, keep winning the argmin and re-create the very starvation
   * this fixes. Re-resolving per announce self-heals inside one staleness window.
   * A throw resolves to null ("not a runner") — the conservative direction.
   */
  resolveRunsRoutines?: () => Promise<boolean | null>;
  /**
   * EI-19330771435294981 — resolve the ACTIVE routine-name SET
   * (`shared_presence.active_routines`, mig 724). Same lazy-resolver contract as
   * `resolveRunsRoutines` above, and a resolver rather than a value for the same
   * disarm-must-self-heal reason. A throw resolves to null ("no advertised
   * capability") — the conservative direction for every election reading it.
   */
  resolveActiveRoutines?: () => Promise<readonly string[] | null>;
}

export interface AnnounceResult {
  announced: boolean;
  /** The new LastAnnounce when announced (feed back as `prev` next tick). */
  last?: LastAnnounce;
}

/**
 * Announce this machine's presence IFF the cadence rule fires. Returns whether it
 * announced + the new LastAnnounce to thread into the next tick. Pure but for the
 * injected `append`.
 */
export async function announceLocalPresence(
  identity: PresenceIdentity,
  state: PresenceState,
  deps: AnnounceLocalPresenceDeps,
): Promise<AnnounceResult> {
  const now = (deps.now ?? Date.now)();
  if (!shouldAnnounce(deps.prev, state, now, deps.cadence)) {
    return { announced: false };
  }
  // EI-18761517980514694: resolved HERE (post-cadence-decision) so a suppressed tick
  // costs nothing. Never fails the announce — an unresolvable capability publishes
  // null ("not a runner"), which peers skip while we stay our own candidate.
  let runsRoutines: boolean | null = null;
  if (deps.resolveRunsRoutines) {
    try {
      runsRoutines = await deps.resolveRunsRoutines();
    } catch {
      runsRoutines = null;
    }
  }
  let activeRoutines: readonly string[] | null = null;
  if (deps.resolveActiveRoutines) {
    try {
      activeRoutines = await deps.resolveActiveRoutines();
    } catch {
      activeRoutines = null;
    }
  }
  await deps.append(
    buildPresenceAnnounceOp(
      identity,
      state,
      now,
      deps.potSlug ?? null,
      runsRoutines,
      activeRoutines,
    ),
  );
  return { announced: true, last: { state: { ...state }, atMs: now } };
}

export interface PresenceAnnounceLoopDeps {
  /** Resolve this machine's swarm identity, or null when it cannot be resolved
   *  (then the loop ticks but never announces). A SUCCESS is cached for the
   *  process lifetime; a null is RETRIED every {@link identityRetryMs} — see
   *  EI-18768167802573425 in startPresenceAnnounceLoop for why the null must
   *  not be latched. */
  resolveIdentity: () => Promise<PresenceIdentity | null>;
  /** EI-18768167802573425 — how long to wait before re-attempting an identity
   *  resolution that came back null. Default 60s. A genuinely gh-unauthenticated
   *  box just re-checks once a minute (cheap); a TRANSIENT boot failure recovers
   *  within one window instead of staying mute until the process restarts. */
  identityRetryMs?: number;
  /** EI-18768167802573425 — fired when a resolution attempt yields no identity,
   *  with the running attempt count, so the caller can surface the fact that this
   *  node is announcing NOTHING (previously an entirely silent state). Fired per
   *  ATTEMPT, not per tick, so it is already throttled by identityRetryMs. */
  onIdentityUnresolved?: (attempt: number) => void;
  /** EI-18768167802573425 — fired once when an identity resolves after one or
   *  more failed attempts (never on a first-attempt success), so a recovery is
   *  visible too. */
  onIdentityRecovered?: (afterAttempts: number) => void;
  /** The current declared presence state at tick time. */
  getState: () => PresenceState;
  /** Append the announce op to the booted substrate handle's own log. */
  append: (op: LocalWriteOp) => Promise<void>;
  /** The harness's home Hive slug (P-008/P-009) — resolved ONCE by the publisher
   *  (potHomeSlugForHarness) and stamped on every announce. Null = non-Hive. */
  potSlug?: string | null;
  /** EI-18761517980514694 — forwarded to {@link announceLocalPresence}; see its
   *  doc for why this is a per-announce RESOLVER and not a wire-time value. */
  resolveRunsRoutines?: () => Promise<boolean | null>;
  /** EI-19330771435294981 — forwarded to {@link announceLocalPresence}; same
   *  per-announce resolver contract as `resolveRunsRoutines`. */
  resolveActiveRoutines?: () => Promise<readonly string[] | null>;
  /** Tick rate (the decision cadence is shouldAnnounce's; the loop just polls). */
  intervalMs: number;
  cadence?: AnnounceCadenceOpts;
  now?: () => number;
  /** Injected timer (tests use fake timers; default global setInterval). */
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  /** Surface a tick error (a failed announce must NOT kill the loop). */
  onError?: (err: unknown) => void;
  /**
   * WI-3684 send-side twin (outbox-drain.ts's `onSessionClosed` sibling):
   * fired instead of `onError` when a tick's `append` fails with a Hypercore
   * `SESSION_CLOSED` error — the own-log session is permanently dead, so this
   * loop self-stops (clears its interval) rather than blind-retrying every
   * `intervalMs` forever. The caller (wire-presence.ts → boot-all.ts's
   * `ensureSendSideWired`) uses this to re-wire a fresh loop on the next boot
   * pass, mirroring the receive side's repair-on-detect posture.
   */
  onSessionClosed?: () => void;
}

export interface PresenceAnnounceLoopHandle {
  stop: () => void;
  /** Run one tick now (also the unit of work the interval calls). */
  tickOnce: () => Promise<void>;
}

/**
 * Start the periodic presence-announce loop (Phase 0.3 write-side driver). Each
 * tick resolves the identity (lazily, cached), reads the current state, and calls
 * announceLocalPresence — which only actually appends on a state-change or TTL
 * refresh (D-007, no firehose). Identity-null (gh unauthed) ticks are no-ops. A
 * tick error is reported via onError and swallowed so one failure can't kill the
 * loop. The handle.append integration is the only gated bit — everything else
 * (cadence, identity gating, error resilience, threading prev) is exercised here
 * with injected timer/append.
 */
export function startPresenceAnnounceLoop(deps: PresenceAnnounceLoopDeps): PresenceAnnounceLoopHandle {
  const setIv = deps.setIntervalFn ?? setInterval;
  const clearIv = deps.clearIntervalFn ?? clearInterval;
  let identity: PresenceIdentity | null = null;
  // EI-18768167802573425: identity resolution is retried while it yields null.
  // This used to be `PresenceIdentity | null | undefined` memoized behind an
  // `identity === undefined` guard, which cached the NULL as permanently as a
  // success — so ONE transient failure on the first tick (gh token not yet
  // readable, device keychain not yet decryptable, a registry blip racing
  // substrate boot) disabled this node's presence for the entire process
  // lifetime, silently. The default resolver collapses every throw into null
  // (wire-presence's defaultResolvePresenceIdentity), so "transient error" and
  // "genuinely unauthenticated" were indistinguishable AND both were latched.
  // Caching the SUCCESS is still correct and still happens; only the failure
  // retries, at identityRetryMs (not every tick — a truly unauthed box must not
  // re-probe the keychain every 5s).
  let identityAttempts = 0;
  let lastIdentityAttemptMs = 0;
  const identityRetryMs = deps.identityRetryMs ?? DEFAULT_IDENTITY_RETRY_MS;
  let prev: LastAnnounce | null = null;
  let stopped = false;
  // Assigned right after creation, below — `tickOnce`'s SESSION_CLOSED
  // self-stop path needs to clear the SAME interval `stop()` clears.
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  async function tickOnce(): Promise<void> {
    if (stopped) return;
    try {
      if (!identity) {
        // EI-18768167802573425: attempt on the first tick, then at most once per
        // identityRetryMs while still unresolved — never latch the null.
        const nowMs = (deps.now ?? Date.now)();
        if (identityAttempts === 0 || nowMs - lastIdentityAttemptMs >= identityRetryMs) {
          lastIdentityAttemptMs = nowMs;
          identityAttempts += 1;
          identity = await deps.resolveIdentity();
          if (identity) {
            if (identityAttempts > 1) deps.onIdentityRecovered?.(identityAttempts);
          } else {
            deps.onIdentityUnresolved?.(identityAttempts);
          }
        }
      }
      if (!identity) return; // no swarm identity → nothing to announce
      const result = await announceLocalPresence(identity, deps.getState(), {
        append: deps.append,
        prev,
        now: deps.now,
        cadence: deps.cadence,
        potSlug: deps.potSlug,
        resolveRunsRoutines: deps.resolveRunsRoutines,
        resolveActiveRoutines: deps.resolveActiveRoutines,
      });
      if (result.last) prev = result.last;
    } catch (err) {
      if (isSessionClosedError(err)) {
        // WI-3684 send-side twin: the own-log session is permanently closed —
        // every future tick's append would throw the same error, so stop
        // ticking (rather than blind-retrying every `intervalMs` forever) and
        // signal the caller to re-wire once a live handle is available again.
        stopped = true;
        if (intervalHandle !== undefined) clearIv(intervalHandle);
        try {
          deps.onSessionClosed?.();
        } catch {
          // best-effort — a throwing callback must never surface from here
        }
        return;
      }
      deps.onError?.(err);
    }
  }

  intervalHandle = setIv(() => void tickOnce(), deps.intervalMs);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (intervalHandle !== undefined) clearIv(intervalHandle);
    },
    tickOnce,
  };
}
