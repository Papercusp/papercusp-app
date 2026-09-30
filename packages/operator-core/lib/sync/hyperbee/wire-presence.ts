/**
 * wire-presence — start THIS machine's presence-announce loop for a booted
 * harness (shared-hive-federation-2026-06-08 P-008 presence PUBLISHER). Mirrors
 * wire-outbox.ts: a thin per-harness wiring called from boot-all.ts AFTER
 * bootHarnessSubstrate returns the handle.
 *
 * Presence federates via the ANNOUNCE LOOP (not a capture trigger — presence is
 * ephemeral / high-frequency, and D-007's state-change-with-TTL cadence prevents a
 * firehose). Each tick appends a presence op to the own peer-log when the cadence
 * fires; peers project it into shared_presence, so a Hive's Swarms see each other —
 * which is exactly what the per-Hive lock authority (lockAuthorityForHive, P-009)
 * elects over (the lowest live device_pubkey across the Hive roster).
 *
 * GATED: only a SHARED harness (swarmBinding present + a joined swarm) announces —
 * a private/local harness has no peers. Best-effort: a wiring/tick failure never
 * blocks boot (mirrors wire-outbox). The harness's home Hive slug is resolved ONCE
 * (WI-559: `canonicalHiveHomeSlug` — the OWNER-authored slug, which on a joiner may
 * differ from the local view slug) and stamped on every announce so the federated row
 * carries hive_slug for the authority's `WHERE hive_slug` (mig 187).
 */
import type { LocalWriteOp } from './boot';
import {
  startPresenceAnnounceLoop,
  buildPresenceTombstoneOp,
  buildPresenceAnnounceRow,
  type PresenceAnnounceLoopHandle,
  type PresenceIdentity,
  type PresenceState,
} from './presence-announce';
import {
  resolveLocalAnnounceIdentity,
  resolveLocalAnnounceIdentityFromHiveMembers,
  type LocalAnnounceIdentity,
} from './local-announce-identity';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import { machineFingerprint } from '../../identity/device-keychain-id';
import { canonicalHiveHomeSlug } from '../../hive-federation';
import { nodeActiveRoutines, nodeRunsCadenceLoops } from '../../cadence-runner-capability';
import type { SharedPresenceRow } from './projections/presence';
import {
  registerPresenceGossipTopic,
  broadcastPresencePut,
  broadcastPresenceDel,
  type PresenceGossipWriter,
} from './presence-gossip-wiring';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval } from '@papercusp/scheduled-registry';

/** The booted-handle surface wire-presence needs — a structural subset of
 *  BootedHarnessHandle, so a test can pass a minimal mock. */
export interface PresenceWireHandle {
  workspaceId: string;
  harnessSlug: string;
  ownLog: { keyHex: string };
  append: (op: LocalWriteOp) => Promise<void>;
  /** Null when this boot didn't join a swarm (private harness). */
  swarm: unknown | null;
  registerCloseHook: (hook: () => void | Promise<void>) => () => void;
}

export interface WirePresenceOpts {
  /** Tick interval ms. Default 5000; <= 0 disables (the loop never starts). */
  intervalMs?: number;
  // ── test / wiring seams ──
  resolveIdentity?: () => Promise<PresenceIdentity | null>;
  resolvePotSlug?: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
  /** EI-18761517980514694 test seam — override the runner-capability resolver
   *  stamped onto each announce (default: nodeRunsCadenceLoops for this harness). */
  resolveRunsRoutines?: () => Promise<boolean | null>;
  /** EI-19330771435294981 test seam — override the published ACTIVE routine-name
   *  SET stamped onto each announce (default: nodeActiveRoutines for this
   *  harness). Each election derives its OWN capability predicate from it. */
  resolveActiveRoutines?: () => Promise<readonly string[] | null>;
  getState?: () => PresenceState;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  now?: () => number;
  onError?: (err: unknown) => void;
  /** WI-3684 send-side twin: threaded to `startPresenceAnnounceLoop`'s
   *  `onSessionClosed` (see presence-announce.ts) — fires once the announce
   *  loop self-stops on a permanently closed own-log session, so
   *  `ensureSendSideWired` (boot-all.ts) can un-mark this harness as wired and
   *  re-wire on the next boot pass. */
  onSessionClosed?: () => void;
  /** Flag seam (the lock-authority `useHrwRendezvous` idiom): short-circuits the
   *  PRESENCE_GOSSIP read at wire time. Tests MUST pin the path they assert —
   *  `false` = the log-append ROLLBACK path, `true` = the gossip writer —
   *  instead of riding the live default, which flipped ON at the 2026-07-17
   *  cutover (a default-riding log-path assertion reds the moment the flag
   *  graduates). Production callers omit it. */
  presenceGossip?: boolean;
}

const DEFAULT_PRESENCE_INTERVAL_MS = 5_000;

/** EI-18767449529288937: rate limit for the "presence not reaching peers" warning.
 *  A permanently-unbound gossip writer re-attempts every ~30s (shouldAnnounce's
 *  refresh window) forever, so the warning is throttled to one per 5 min after the
 *  first — visible immediately, then steady evidence without flooding the log. */
const BROADCAST_WARN_INTERVAL_MS = 300_000;

export interface BroadcastFailureReporterOpts {
  /** `<workspaceId>::<harnessSlug>` — names the node in the log line. */
  label: string;
  now: () => number;
  /** Override the throttle window (tests). */
  warnIntervalMs?: number;
  /** Log seams (tests). Default console. */
  warn?: (msg: string) => void;
  info?: (msg: string) => void;
}

/**
 * EI-18767449529288937 — the pure, testable core of the broadcast-failure signal.
 *
 * Before this, a failed presence gossip broadcast was COMPLETELY silent:
 * `broadcastPresencePut` returns false both for an unbound writer and for a
 * swallowed throw, and the sole call site discarded that boolean. A node could
 * therefore be invisible to every peer with clean logs — and because the gossip
 * path never materializes our OWN `shared_presence` row either (we return before
 * `handle.append`), "read your own presence row" was not a self-check. Observed
 * live on the 2-machine rig (WI-559): fed-a published to nobody, zero error lines.
 *
 * Returns a `note(delivered, topicHex)` sink: warns on the FIRST failure (a fault
 * is visible at once), then at most once per `warnIntervalMs`, and reports a
 * one-line RECOVERY when a beat lands after a failing streak — so the log carries
 * both edges, not just the onset.
 *
 * Purely observational by design: it never throws and never influences the
 * announce cadence, so a missed beat stays the TTL-absorbed miss the protocol
 * already models.
 */
export function createBroadcastFailureReporter(
  opts: BroadcastFailureReporterOpts,
): (delivered: boolean, topicHex: string) => void {
  const warnIntervalMs = opts.warnIntervalMs ?? BROADCAST_WARN_INTERVAL_MS;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const info = opts.info ?? ((m: string) => console.info(m));
  let failStreak = 0;
  let lastWarnMs = 0;
  return (delivered: boolean, topicHex: string): void => {
    if (delivered) {
      if (failStreak > 0) {
        info(
          `[wire-presence] presence broadcast RECOVERED for ${opts.label} after ` +
            `${failStreak} consecutive failed beat(s)`,
        );
      }
      failStreak = 0;
      return;
    }
    failStreak += 1;
    const nowMs = opts.now();
    if (failStreak === 1 || nowMs - lastWarnMs >= warnIntervalMs) {
      lastWarnMs = nowMs;
      warn(
        `[wire-presence] presence NOT reaching peers for ${opts.label} — ${failStreak} consecutive ` +
          `failed gossip broadcast(s) on topic ${topicHex.slice(0, 12)}… (no bound writer for the ` +
          `topic, or a swallowed send/sign error). This node is INVISIBLE to peers' presence, ` +
          `lock-authority election and runner election.`,
      );
    }
  };
}

/**
 * Wire + start the presence-announce loop for `handle`. Returns the loop handle
 * (its `stop` is also registered as a close-hook so teardown is automatic), or
 * null when not started (private harness / no swarm / disabled).
 */
export async function wirePresenceAnnounceForHarness(
  handle: PresenceWireHandle,
  opts: WirePresenceOpts = {},
): Promise<PresenceAnnounceLoopHandle | null> {
  // Only a harness that JOINED a swarm has peers to announce to (handle.swarm is
  // non-null exactly when a shared harness's swarm-join succeeded). A private /
  // local-only / gh-unauthenticated harness has no swarm → nothing to announce.
  // Logged because this skip is INVISIBLE otherwise: when the boot-time join
  // failed transiently, presence stays dead until the WI-752 join-retry recovery
  // re-wires (boot-all onSwarmJoinRecovered) — the 2026-07-17 tower bg-host ran
  // a whole process lifetime presence-less with zero log evidence.
  if (!handle.swarm) {
    console.info(
      `[wire-presence] skip ${handle.workspaceId}::${handle.harnessSlug} — no swarm ` +
        `(private/local-only, or join pending; a join-retry recovery re-wires)`,
    );
    return null;
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_PRESENCE_INTERVAL_MS;
  if (intervalMs <= 0) return null;

  // Resolve the harness's home Hive ONCE (stable for the boot session). Best-effort:
  // a failure → announce harness-scoped (hive_slug null), never blocks the loop.
  // WI-559: the CANONICAL (owner-authored) home slug, not the local view slug. This
  // value becomes the topic binding's `potHomeSlug` below, which is the presence
  // ADMISSION gate's read scope (presence-gossip-wiring listHiveMembers /
  // loadRevokedHivePubkeys) AND the `hive_slug` stamped on every announce. It must match
  // the projection WRITE scope (boot.ts resolveHiveHomeProjectionSlug → joinerPotHomeSlug,
  // also canonicalized) or the joiner writes pot_members under one slug and admits under
  // another — see canonicalHiveHomeSlug. Unchanged for an owned hive.
  const resolveHive = opts.resolvePotSlug ?? canonicalHiveHomeSlug;
  let potSlug: string | null = null;
  try {
    potSlug = await resolveHive(handle.workspaceId, handle.harnessSlug);
  } catch {
    potSlug = null;
  }

  // WI-38328: the LAST swallowed identity-resolution cause, so `onIdentityUnresolved`
  // can name it. Without this the warning could only guess, and a permanent GitHub
  // refusal read as a transient auth gap for the whole life of the process.
  let lastIdentityError: unknown = null;
  const resolveIdentity =
    opts.resolveIdentity ??
    (() =>
      defaultResolvePresenceIdentity(handle, potSlug, (err) => {
        lastIdentityError = err;
      }));

  // EI-18761517980514694: the RUNNER-election capability bit stamped on every
  // announce. Re-resolved per announce (behind a 60s cache in the resolver) rather
  // than fixed at wire time like `potSlug` — a node that DISARMS its cadence routine
  // must stop advertising itself as a runner, or it keeps winning the argmin and the
  // pot's cadence loop goes dark again.
  const resolveRunsRoutines =
    opts.resolveRunsRoutines ??
    (async () => nodeRunsCadenceLoops(handle.workspaceId, handle.harnessSlug));

  // EI-19330771435294981: the published routine SET, stamped on the same announces
  // and re-resolved on the same 60s cache for the same disarm-self-heal reason.
  // Each election derives its own predicate from it (cadence-runner intersects
  // CADENCE_RUNNER_ROUTINES; the git-sync integrator tests for 'git-sync'), which
  // is what lets the integrator stop borrowing a bit about an unrelated loop.
  const resolveActiveRoutines =
    opts.resolveActiveRoutines ??
    (async () => nodeActiveRoutines(handle.workspaceId, handle.harnessSlug));

  const getState =
    opts.getState ??
    ((): PresenceState => ({ intent: null, currentView: null, harnessSlug: handle.harnessSlug }));

  // ── P-004 (cross-machine-coord-parity D-002/D-008): presence off the log. ──
  // READER-FIRST: register this hive topic with the gossip reader UNCONDITIONALLY
  // (idles at zero cost with no gossip writers) so every updated peer can read
  // gossip presence before any writer flips. The WRITER cutover is flag-gated
  // (PRESENCE_GOSSIP, dark until the 2-machine verify): when ON, announce beats
  // BROADCAST signed frames instead of appending immortal ops to the peer-log.
  // Flag is read once at wire time (a cutover flag — flip applies on reboot).
  const topicHex = (handle.swarm as { topicHex?: unknown } | null)?.topicHex;
  const gossipTopicHex = typeof topicHex === 'string' && topicHex ? topicHex : null;
  let gossipWriterOn = false;
  if (gossipTopicHex && potSlug) {
    gossipWriterOn =
      opts.presenceGossip ?? (await getFlag(FLAGS.PRESENCE_GOSSIP, 'system').catch(() => false));
    let writer: PresenceGossipWriter | undefined;
    if (gossipWriterOn) {
      writer = await buildGossipWriter(
        handle,
        getState,
        potSlug,
        opts,
        resolveRunsRoutines,
        resolveActiveRoutines,
      );
      if (!writer) gossipWriterOn = false; // gh-unauthed → stay on the log path gate (no-op anyway)
    }
    await registerPresenceGossipTopic({
      topicHex: gossipTopicHex,
      workspaceId: handle.workspaceId,
      potHomeSlug: potSlug,
      ...(writer ? { writer } : {}),
    });
  }
  console.info(
    `[wire-presence] wired ${handle.workspaceId}::${handle.harnessSlug} — ` +
      `gossipWriter=${gossipWriterOn ? 'on' : 'off'} topic=${gossipTopicHex ? gossipTopicHex.slice(0, 12) : 'none'} pot=${potSlug ?? 'none'}`,
  );

  // EI-18767449529288937: a failed gossip broadcast used to be COMPLETELY silent —
  // broadcastPresencePut returns false for an unbound writer (and swallows every
  // throw into the same false), the call site discarded that boolean, and nothing
  // counted or logged it. A node could therefore be invisible to every peer while
  // its logs stayed clean, which is undiagnosable: the gossip path also never
  // materializes our OWN shared_presence row (we return before handle.append), so
  // "read your own presence row" is not a self-check either. Observed live on the
  // 2-machine rig (WI-559) — fed-a published to nobody, with zero error lines.
  //
  // Deliberately OBSERVABILITY-ONLY: we do NOT change `prev` advancement. A failed
  // beat still counts as announced, so the retry stays on the designed ~30s
  // refresh cadence (shouldAnnounce's refreshMs) rather than every intervalMs —
  // the TTL absorbs a missed beat by design, and turning one absorbable miss into
  // a 6x-faster retry is a behavior change this bug does not justify.
  const noteBroadcastResult = createBroadcastFailureReporter({
    label: `${handle.workspaceId}::${handle.harnessSlug}`,
    now: opts.now ?? Date.now,
  });

  const loop = startPresenceAnnounceLoop({
    resolveIdentity,
    getState,
    // EI-18768167802573425: "no identity → announce nothing" used to be an
    // entirely silent state, and (before that fix) a permanent one. Surface both
    // edges. Fired per ATTEMPT, so already throttled by identityRetryMs.
    onIdentityUnresolved: (attempt) => {
      // WI-38328: report the actual cause. A GitHub-side REFUSAL (e.g. gist
      // creation 422 on an account with no verified email) is permanent, not a
      // transient auth gap, and no number of retries will clear it — saying so is
      // the difference between a fixable line and a misleading one.
      const cause =
        lastIdentityError instanceof Error
          ? lastIdentityError.message
          : lastIdentityError != null
            ? String(lastIdentityError)
            : null;
      console.warn(
        `[wire-presence] no swarm identity for ${handle.workspaceId}::${handle.harnessSlug} ` +
          `(attempt ${attempt}) — announcing NOTHING; this node is invisible to peers. ` +
          `Neither the durable local Hive binding nor live GitHub identity resolution succeeded` +
          (cause ? ` — cause: ${cause}` : '') +
          `. Expected on a gh-unauthenticated box; otherwise the device identity/keychain failed to resolve. ` +
          `Retrying periodically.`,
      );
    },
    onIdentityRecovered: (afterAttempts) => {
      console.info(
        `[wire-presence] swarm identity RESOLVED for ${handle.workspaceId}::${handle.harnessSlug} ` +
          `after ${afterAttempts} attempt(s) — presence announce is live`,
      );
    },
    // Writer cutover: gossip beats when ON (a put op's row broadcasts as a signed
    // frame; a skipped/failed broadcast is a missed beat the TTL absorbs) — the
    // log path stays byte-identical when OFF.
    append:
      gossipWriterOn && gossipTopicHex
        ? async (op) => {
            const row = (op as { value?: SharedPresenceRow }).value;
            if (op.type === 'put' && row) {
              noteBroadcastResult(await broadcastPresencePut(gossipTopicHex, row), gossipTopicHex);
              return;
            }
            await handle.append(op); // non-put presence ops keep the log path
          }
        : (op) => handle.append(op),
    potSlug,
    resolveRunsRoutines,
    resolveActiveRoutines,
    intervalMs,
    now: opts.now,
    setIntervalFn: opts.setIntervalFn,
    clearIntervalFn: opts.clearIntervalFn,
    onError:
      opts.onError ??
      ((err) =>
        console.warn(
          `[wire-presence] announce tick error for ${handle.workspaceId}::${handle.harnessSlug}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )),
    onSessionClosed: opts.onSessionClosed,
  });
  // WI-10002534: wiring is idempotent per handle. A re-wire of the SAME handle
  // (boot-all's rewireSoon / onSwarmJoinRecovered) stops the prior announce loop
  // before this one takes over, instead of leaving both beating.
  announcerState.loopsByHandle.get(handle)?.stop();
  announcerState.loopsByHandle.set(handle, loop);
  handle.registerCloseHook(() => {
    loop.stop();
    if (announcerState.loopsByHandle.get(handle) === loop) announcerState.loopsByHandle.delete(handle);
  });

  // ── P-005: the SESSION-GRAIN announcer (gossip-only). Every tick reads this
  // machine's LOCAL live-session roster and broadcasts it as one signed
  // 'sessions' frame (full-set semantics — receivers replace our previous set).
  // A change-hash short-circuits identical sets so a quiet machine costs one
  // frame per SESSION_ANNOUNCE_REFRESH_MS keep-alive, not one per tick.
  // Gossip-writer-gated: no flag, no frames (log-path behavior byte-identical).
  //
  // WI-10002534: the roster is WORKSPACE-wide, so the announcer is shared by
  // every handle on the same (workspace, topic) — refcounted, never one per
  // handle. The tower wired 39 harnesses onto one topic, sent ~39 duplicate
  // full-set frames per change, and the receiver rewrote every row per frame.
  if (gossipWriterOn && gossipTopicHex) {
    acquireSessionAnnouncer(handle, gossipTopicHex, opts);
  }

  return loop;
}

interface SessionAnnouncer {
  /** Live handles sharing this announcer (object identity, so a re-wire of the
   *  same handle is a no-op and two handles of one harness count separately). */
  members: Set<PresenceWireHandle>;
  stop: () => void;
}

/** Process-wide announcer registry, pinned so a split module record cannot run
 *  a second copy of the same topic's announcer. */
const announcerState = pinModuleState('@papercusp/operator-core.wire-presence.announcers', () => ({
  sessionsByTopic: new Map<string, SessionAnnouncer>(),
  loopsByHandle: new WeakMap<PresenceWireHandle, PresenceAnnounceLoopHandle>(),
}));

/** Test-only: stop and forget every session announcer (module state outlives a test). */
export function __resetSessionAnnouncersForTests(): void {
  for (const a of announcerState.sessionsByTopic.values()) a.stop();
  announcerState.sessionsByTopic.clear();
}

function acquireSessionAnnouncer(
  handle: PresenceWireHandle,
  gossipTopicHex: string,
  opts: WirePresenceOpts,
): void {
  const key = `${handle.workspaceId}::${gossipTopicHex}`;
  let announcer = announcerState.sessionsByTopic.get(key);
  if (!announcer) {
    const members = new Set<PresenceWireHandle>();
    announcer = { members, stop: startSessionAnnouncer(handle.workspaceId, gossipTopicHex, members, opts) };
    announcerState.sessionsByTopic.set(key, announcer);
  }
  const shared = announcer;
  if (shared.members.has(handle)) return; // same handle re-wired — its close hook is already registered
  shared.members.add(handle);
  handle.registerCloseHook(() => {
    shared.members.delete(handle);
    if (shared.members.size === 0 && announcerState.sessionsByTopic.get(key) === shared) {
      shared.stop();
      announcerState.sessionsByTopic.delete(key);
    }
  });
}

/** Arm one sessions announcer for (workspace, topic); returns its stop. */
function startSessionAnnouncer(
  workspaceId: string,
  gossipTopicHex: string,
  members: ReadonlySet<PresenceWireHandle>,
  opts: WirePresenceOpts,
): () => void {
  {
    let lastHash = '';
    let lastSentMs = 0;
    const tickSessions = async (): Promise<void> => {
      try {
        // harness_slug is a sender-declared label only (the receiver keys on
        // workspace+owner+machine); take it from a live member so it stays stable.
        const labelHandle = members.values().next().value as PresenceWireHandle | undefined;
        if (!labelHandle) return;
        // Dynamic import (the EI-279 layering idiom): the local roster lives in
        // agent-tools/coordination; sync/hyperbee must not import it statically.
        const { listPresence } = await import('../../agent-tools/coordination/presence');
        const records = await listPresence({ workspaceId });
        const nowMs = (opts.now ?? Date.now)();
        const sessions = (records ?? [])
          .filter((r) => typeof r?.ownerId === 'string' && r.ownerId.length > 0)
          .slice(0, 128)
          .map((r) => ({
            owner_id: r.ownerId,
            kind: r.ownerId.startsWith('su-') ? 'su' : r.ownerId.startsWith('s-') ? 'cup' : 'agent',
            intent: r.intent ?? null,
            plan_slug: (r as { currentPlanSlug?: string | null }).currentPlanSlug ?? null,
            harness_slug: labelHandle.harnessSlug,
            last_active_ms: nowMs,
            fleet_slug: null as string | null,
            fleet_role: null as string | null,
          }));
        // P-301: stamp each announced session's named-fleet membership so a fleet
        // spanning machines resolves `@fleet:<slug>` to its cross-machine members +
        // leader. ONE batch read keyed by the announced ownerIds (constant, not N) —
        // best-effort: a lookup error just leaves membership null (wire unchanged).
        try {
          const { fetchPresenceFleet } = await import(
            '../../agent-tools/coordination/presence-fleet'
          );
          const fleetOf = await fetchPresenceFleet(sessions.map((s) => s.owner_id));
          for (const s of sessions) {
            const m = fleetOf.get(s.owner_id);
            if (m?.fleetSlug) {
              s.fleet_slug = m.fleetSlug;
              s.fleet_role = m.fleetRole ?? null;
            }
          }
        } catch {
          /* membership enrichment is best-effort — never fails an announce */
        }
        const hash = JSON.stringify(
          sessions.map((s) => [s.owner_id, s.intent, s.plan_slug, s.fleet_slug, s.fleet_role]),
        );
        if (hash === lastHash && nowMs - lastSentMs < SESSION_ANNOUNCE_REFRESH_MS) return;
        const { broadcastSessions } = await import('./presence-gossip-wiring');
        if (await broadcastSessions(gossipTopicHex, sessions)) {
          lastHash = hash;
          lastSentMs = nowMs;
        }
      } catch (err) {
        opts.onError?.(err);
      }
    };
    // Injected seam (tests) or a NAMED managed interval, so schedule:inventory
    // shows how many announcers are live — the count this bug hid.
    if (opts.setIntervalFn) {
      const clearIv = opts.clearIntervalFn ?? clearInterval;
      const sessTimer = opts.setIntervalFn(() => void tickSessions(), SESSION_ANNOUNCE_TICK_MS);
      return () => clearIv(sessTimer);
    }
    const managed = managedSetInterval(
      'presence-sessions-announcer',
      SESSION_ANNOUNCE_TICK_MS,
      () => void tickSessions(),
      // D-004: no event source announces a local session roster change, so the
      // announcer hash-compares each tick to detect one — must-sample, not a reaper.
      { category: 'lifecycle', instanced: true, classification: 'must-sample' },
    );
    return () => managed.stop();
  }
}

/** Session-announcer cadence: tick (change-detect) + keep-alive refresh. The
 *  refresh must stay well under the roster's staleness window so a live remote
 *  session never ages out while its machine is up. */
const SESSION_ANNOUNCE_TICK_MS = Number(process.env.PAPERCUSP_SESSION_ANNOUNCE_TICK_MS) || 10_000;
const SESSION_ANNOUNCE_REFRESH_MS =
  Number(process.env.PAPERCUSP_SESSION_ANNOUNCE_REFRESH_MS) || 30_000;

/** Build the gossip WRITER half for this booted handle (P-004): the device
 *  signer + this machine's current-row provider (the hello snapshot + each
 *  broadcast beat). Undefined when NEITHER the durable local Hive binding nor
 *  live GitHub identity resolution succeeds — then there is nothing to announce
 *  on either plane. */
async function buildGossipWriter(
  handle: PresenceWireHandle,
  getState: () => PresenceState,
  potSlug: string,
  opts: WirePresenceOpts,
  resolveRunsRoutines: () => Promise<boolean | null>,
  resolveActiveRoutines: () => Promise<readonly string[] | null>,
): Promise<PresenceGossipWriter | undefined> {
  try {
    // WI-38328: durable-first, exactly like the announce loop — the writer needs
    // only the keychain id (to sign), the pubkey and the gh user id, never a gist.
    const id = await resolvePresenceAnnounceIdentity(handle, potSlug);
    const now = opts.now ?? Date.now;
    const machineLabel = machineFingerprint();
    return {
      devicePubkey: id.devicePubkeyBase64,
      sign: (bytes) => signWithDeviceKey(id.keychainId, bytes),
      githubUserId: id.githubUserId,
      machineLabel,
      potSlug,
      getOwnRow: async () => {
        // EI-18761517980514694: the GOSSIP plane is the live presence path since the
        // 2026-07-17 PRESENCE_GOSSIP cutover, so the runner-capability bit must be
        // stamped here too — a row published without it reads as "not a runner" to
        // peers. Best-effort, exactly like the log path: never fail an announce.
        let runsRoutines: boolean | null = null;
        try {
          runsRoutines = await resolveRunsRoutines();
        } catch {
          runsRoutines = null;
        }
        // EI-19330771435294981: same reasoning one field on — the gossip plane is
        // the LIVE presence path, so a row published without the routine set reads
        // as "no advertised capability" to peers and the git-sync integrator
        // election never sees a candidate. Best-effort: never fail an announce.
        let activeRoutines: readonly string[] | null = null;
        try {
          activeRoutines = await resolveActiveRoutines();
        } catch {
          activeRoutines = null;
        }
        return buildPresenceAnnounceRow(
          {
            githubUserId: id.githubUserId,
            devicePubkey: id.devicePubkeyBase64,
            machineLabel,
          },
          getState(),
          now(),
          potSlug,
          runsRoutines,
          activeRoutines,
        );
      },
    };
  } catch {
    return undefined; // gh unauthed → no writer (no-op on either plane)
  }
}

/**
 * WI-38328 — resolve the identity the presence planes announce under, preferring
 * the DURABLE local binding over a live GitHub round-trip.
 *
 * Both presence planes need only `{ githubUserId, devicePubkeyBase64, keychainId }`.
 * Neither carries `attestationGistId` — `PresenceIdentity` has no such field, and
 * every consumer of it lives in boot.ts's swarm-JOIN announce frame. But
 * `resolveLocalAnnounceIdentity` resolves the attestation gist MANDATORILY, via a
 * live `ensureAttestationGist` WRITE, and throws when GitHub refuses. So presence
 * used to hard-depend on the success of a call whose result it discards.
 *
 * That is not hypothetical: a GitHub account with no VERIFIED EMAIL cannot create
 * gists at all (422 `{"resource":"Gist","field":"user","message":"user must have a
 * verified email"}`), which is an account-level condition, so every retry fails
 * identically and the node stays invisible to peers FOREVER — observed on the
 * local-matrix rig, 8/8 retries across both topics, blocking WI-5481's soak from
 * running a single cycle. Gist-restricted org/EMU accounts and a plain GitHub gist
 * outage land in the same place.
 *
 * `resolveLocalAnnounceIdentityFromHiveMembers` already resolves exactly this from
 * the local `hive_members` projection + OS keychain, and boot.ts:4355 already
 * PREFERS it on the swarm-JOIN path for the same reason ("lets known Hive members
 * rejoin the swarm during a GitHub outage without weakening admission"). Presence
 * simply never called it. Admission is unweakened here too: the fallback resolves
 * only when a durable membership row already names THIS device's existing pubkey
 * (it never generates a key), and peers still verify the announce signature.
 */
async function resolveKnownHiveMemberPresenceIdentity(
  handle: Pick<PresenceWireHandle, 'workspaceId'>,
  potSlug: string | null,
): Promise<LocalAnnounceIdentity | null> {
  if (!potSlug) return null; // non-Hive harness → no durable roster to resolve against
  try {
    const { listHiveMembersForLocalPot } = await import('../../federated-pot-scope');
    const members = await listHiveMembersForLocalPot(handle.workspaceId, potSlug);
    return await resolveLocalAnnounceIdentityFromHiveMembers({ members });
  } catch {
    return null; // projection unreadable → fall through to the live resolver
  }
}

/** Durable-first presence identity: the local Hive binding, else the live
 *  GitHub-backed resolver (first-time / non-Hive announces). Throws only when
 *  NEITHER path resolves, so the caller can report the real reason. */
async function resolvePresenceAnnounceIdentity(
  handle: Pick<PresenceWireHandle, 'workspaceId' | 'ownLog'>,
  potSlug: string | null,
): Promise<LocalAnnounceIdentity> {
  const known = await resolveKnownHiveMemberPresenceIdentity(handle, potSlug);
  if (known) return known;
  return resolveLocalAnnounceIdentity({ logCoreKeyHex: handle.ownLog.keyHex });
}

/** The default presence-identity resolver for a booted handle: this machine's
 *  github user + device pubkey + machine fingerprint, or null when neither the
 *  durable local binding nor gh can resolve one (then we never announce/tombstone
 *  — no-op). Shared by the announce loop and the leave tombstone.
 *
 *  `noteError` receives the swallowed cause so the caller can name it instead of
 *  guessing — this catch is why a permanent GitHub-side refusal was reported for
 *  months as an unqualified "gh-unauthenticated box". */
async function defaultResolvePresenceIdentity(
  handle: Pick<PresenceWireHandle, 'workspaceId' | 'ownLog'>,
  potSlug: string | null = null,
  noteError?: (err: unknown) => void,
): Promise<PresenceIdentity | null> {
  try {
    const id = await resolvePresenceAnnounceIdentity(handle, potSlug);
    return {
      githubUserId: id.githubUserId,
      devicePubkey: id.devicePubkeyBase64,
      machineLabel: machineFingerprint(),
    };
  } catch (err) {
    noteError?.(err);
    return null; // no durable binding and gh unauthenticated → nothing to announce/retract
  }
}

export interface PublishPresenceTombstoneOpts {
  /** Resolve this machine's swarm identity (test seam; default the shared resolver). */
  resolveIdentity?: () => Promise<PresenceIdentity | null>;
  now?: () => number;
}

/**
 * Publish a presence TOMBSTONE (a `del` on this device's presence key) to a
 * booted harness's own log so peers drop the leaver's `shared_presence` row at
 * once rather than aging it out by TTL (shared-hive-hardening EI-469). The
 * caller (pot:leave) MUST invoke this BEFORE closing the harness handle — the
 * swarm must still be live for the del op to replicate.
 *
 * Best-effort + gated, mirroring the announce wiring: a private/local harness
 * (no swarm) or a gh-unauthenticated box (no identity) is a no-op (returns
 * false). Returns true when the tombstone was appended.
 *
 * ⚠ Cross-machine delivery is NOT guaranteed here: appending then immediately
 * closing the swarm can out-race live replication, so a peer that hasn't
 * replicated the block falls back to the TTL (today's behavior — safe). A
 * flush/await-replication-before-close is the real-hardware-gated refinement
 * (plan D-003) — the deterministic single-box piece (the publisher + the
 * before-close ordering) is what this builds.
 */
export async function publishPresenceTombstoneForHarness(
  handle: PresenceWireHandle,
  opts: PublishPresenceTombstoneOpts = {},
): Promise<boolean> {
  if (!handle.swarm) return false; // private/local → no peers to tell
  // WI-38328: resolve the home Hive slug so the tombstone can use the same
  // durable-first identity path as the announce loop. A node that could not
  // ANNOUNCE without GitHub could not RETRACT without it either, which left a
  // departed peer's presence row to age out by TTL instead of dropping promptly.
  let tombstonePotSlug: string | null = null;
  try {
    tombstonePotSlug = await canonicalHiveHomeSlug(handle.workspaceId, handle.harnessSlug);
  } catch {
    tombstonePotSlug = null;
  }
  const resolveIdentity =
    opts.resolveIdentity ?? (() => defaultResolvePresenceIdentity(handle, tombstonePotSlug));
  let identity: PresenceIdentity | null;
  try {
    identity = await resolveIdentity();
  } catch {
    identity = null;
  }
  if (!identity) return false; // gh unauthed → nothing to retract
  const now = (opts.now ?? Date.now)();
  await handle.append(buildPresenceTombstoneOp(identity, now));
  // P-004: DUAL-publish the tombstone on the gossip plane when the writer flag
  // is on — a one-shot leave event (not a beat), so dual-write is cheap and
  // keeps log-readers AND gossip-readers dropping the row promptly during the
  // cutover window. Best-effort: a miss falls back to the TTL (safe).
  try {
    const topicHex = (handle.swarm as { topicHex?: unknown } | null)?.topicHex;
    if (typeof topicHex === 'string' && topicHex) {
      const on = await getFlag(FLAGS.PRESENCE_GOSSIP, 'system').catch(() => false);
      if (on) {
        await broadcastPresenceDel(topicHex, {
          github_user_id: identity.githubUserId,
          machine_label: identity.machineLabel,
          harness_slug: handle.harnessSlug,
        });
      }
    }
  } catch {
    /* best-effort — the log tombstone above already published */
  }
  return true;
}
