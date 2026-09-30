/**
 * hive-directory-boot.ts — the substrate boot-join that makes the hive directory
 * FUNCTION live (p2p-hive-directory-2026-06-06 P-003).
 *
 * Composes the pieces shipped in P-001..P-005 into the live feed: on substrate
 * boot it creates ONE directory-gossip instance (createDirectoryGossip — one
 * connection handler, one Protomux channel per topic), joins the global
 * directory topic + each owned invite hive's invite-scoped topic, pipes inbound
 * announces to the directory service's verified-only ingest, wires the gossip
 * broadcast as the directory's transport, registers + announces this peer's
 * owned public/invite hives, and starts the re-announce timer. Returns a stop
 * handle.
 *
 * Called once per workspace boot from boot-all.ts (additive, best-effort — a
 * directory failure must NEVER break harness boot). The `dir` is injectable so
 * the composition unit-tests with a fake-deps directory + a fake swarm; the
 * LIVE proof (real Hyperswarm on a testnet) is
 * sync/hyperbee/__tests__/hive-directory-live-two-peer.test.ts.
 */

import { deriveDirectoryTopic, deriveInviteTopic, hiveTopicAsHex } from './sync/hyperbee/derive-hive-topic';
import {
  createDirectoryGossip,
  type DirectoryGossipHandle,
} from './sync/hyperbee/directory-swarm';
import type { HyperswarmLike } from './sync/hyperbee/swarm';
import type { SignedHiveAnnounce } from './sync/hyperbee/hive-announce';
import { getHiveDirectory, setHiveDirectoryTransport } from './hive-directory-deps';
import { isHiveUnlistFrame } from './hive-directory';
import { publishHiveToDirectory, type HiveDirectoryMeta, type HiveOwnerIdentity } from './hive-publish';
import type { HiveDirectory } from './hive-directory';
import { bakedCanonicalHiveInvite } from './harness/papercusp-hive-join';
import { requestOnlyHost } from './background-workers';
import { trackDetached } from './detached-imports';

/** Default re-announce cadence (5 min) — keeps a hive fresh under the TTL. */
export const DEFAULT_REANNOUNCE_MS = 5 * 60 * 1000;

export interface WireHiveDirectoryOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** Device keychain id — signs our hive announces (signWithDeviceKey). */
  keychainId: string;
  /** This peer's GitHub + device identity (owner of the hives we announce). */
  owner: HiveOwnerIdentity;
  /** The hives this workspace owns + wants to publish (public/invite/private). */
  ownedHives?: HiveDirectoryMeta[];
  /** Re-announce cadence (ms). Default DEFAULT_REANNOUNCE_MS. */
  reannounceMs?: number;
  /** Per-topic discovery-refresh cadence (ms) — see createDirectoryGossip. */
  refreshMs?: number;
  /** The directory service (default: the process singleton). Injected for tests. */
  dir?: HiveDirectory;
}

/**
 * G-002 honest-join: the bounded-confirmation result. `found` is the truth the
 * UI/route reports — did a hive ACTUALLY materialize on the invite topic within
 * the wait, or did we merely subscribe to a topic nobody is announcing on (a
 * withdrawn / wrong / offline-owner invite)?
 */
export interface InviteAnnounceConfirm {
  /** A verified invite hive announced on this secret's topic within the wait. */
  found: boolean;
  /** The discovered hive, when found (for an honest "Found 'X' — joining" copy).
   *  Carries the joiner-side memberLinks + hivePubkey so the caller can JOIN straight
   *  off the confirm, instead of a second listDiscovered lookup + pubkey re-match
   *  (which fails when the owner's actual pubkey differs from the baked one) — P-004. */
  hive?: {
    potId: string;
    title: string;
    visibility: string;
    memberLinks?: string[];
    hivePubkey?: string;
    /** Verified owner device binding carried by the signed directory announce. */
    ownerDevicePubkey?: string;
  };
  /** Swarm peers currently paired on the invite topic (0 = nobody is home — the
   *  announce can never arrive). Informational; `found` is the decision. */
  peersOnTopic: number;
}

export interface HiveDirectoryWiring {
  /** The directory gossip (all topics — global + invite-scoped). */
  gossip: DirectoryGossipHandle;
  /** Join an invite-scoped directory topic from a received invite secret (the
   *  invitee side). Idempotent. */
  joinInviteTopic(inviteSecret: string): Promise<void>;
  /**
   * G-002 honest-join: after joining the invite topic, BOUNDED-WAIT for the
   * invite hive to actually announce on it — instead of the route claiming
   * `joined:true` on a bare topic subscribe (which is a lie for a withdrawn /
   * wrong / offline-owner invite, where nothing ever appears). Reuses the
   * already-landed per-topic reach signal (`openChannelCount(topicHex)`, the
   * G-001 mechanism) as the "is anyone home" gate and the discovered set as the
   * "it materialized" confirmation. Resolves as soon as the hive appears, or
   * after `timeoutMs`. Best-effort: any failure resolves `found:false`.
   */
  confirmInviteAnnounce(
    inviteSecret: string,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<InviteAnnounceConfirm>;
  /**
   * The topic-routing broadcast — the same closure handed to
   * setHiveDirectoryTransport. Exposed so an injected (non-singleton) directory
   * can route its `broadcast` dep through this wiring (tests, multi-instance).
   */
  transport(topicHex: string, frame: SignedHiveAnnounce): Promise<void>;
  stop(): Promise<void>;
}

// ── WI-1585 VM-half defect B: retry the canonical auto-join on ingest ─────────
// The canonical `papercusp` auto-join used to fire ONLY at boot and from the
// setup wizard. An announce that arrives AFTER those (owner came online late;
// joiner booted while the owner was quiet — the Avis-iMac LIVE-1 strand) was
// passively cached by this module's ingest and NOTHING ever re-fired the join:
// the joiner sat "discovered but never joined" until the next app restart. So:
// whenever an announce whose pubkey matches the BAKED canonical invite is
// ACCEPTED and this box has no hives row for it yet (the P-005 fire-once latch
// misses ⇒ unjoined), re-fire the single-flight bootstrap. Debounced; every
// failure is a silent no-op — the 5-min re-announce cadence retries.
const CANONICAL_JOIN_RETRIGGER_MIN_MS = 60_000;
let _canonicalJoinLastTriggerMs = 0;

/** Test seam — reset the ingest-retrigger debounce between cases. */
export function __resetCanonicalJoinIngestTrigger(): void {
  _canonicalJoinLastTriggerMs = 0;
}

/** Injectable seams for maybeTriggerCanonicalJoinOnIngest (unit tests). */
export interface CanonicalJoinIngestDeps {
  baked?: () => { pubkeyBase64: string; inviteSecret: string } | null;
  /** The P-005 latch read: a hives row keyed by the baked pubkey ⇒ already joined. */
  getHiveByPubkey?: (workspaceId: string, pubkeyBase64: string) => Promise<unknown>;
  /** Fire the (single-flight) bootstrap. Default: startBootstrapPapercuspHive. */
  trigger?: () => void;
  nowMs?: () => number;
}

export async function maybeTriggerCanonicalJoinOnIngest(
  frame: { hive_pubkey?: string },
  deps: CanonicalJoinIngestDeps = {},
): Promise<void> {
  const baked = (deps.baked ?? bakedCanonicalHiveInvite)();
  if (!baked || frame.hive_pubkey !== baked.pubkeyBase64) return;
  const now = (deps.nowMs ?? Date.now)();
  if (now - _canonicalJoinLastTriggerMs < CANONICAL_JOIN_RETRIGGER_MIN_MS) return;
  _canonicalJoinLastTriggerMs = now;
  const getHive =
    deps.getHiveByPubkey ??
    (async (ws: string, pk: string) => (await import('./hive-store')).getHiveByPubkey(ws, pk));
  const { PAPERCUSP_WORKSPACE_ID } = await import('./harness/papercusp-workspace');
  const existing = await getHive(PAPERCUSP_WORKSPACE_ID, baked.pubkeyBase64).catch(() => null);
  if (existing) return; // already joined — the latch holds
  const trigger =
    deps.trigger ??
    (() => {
      // WI-1423: this ingest-fired retrigger is the ONE trigger path that used to
      // bypass the DOGFOOD_PAPERCUSP_POT flag gate the other two callers (the boot
      // path in host-bootstrap.ts and the wizard's /api/desktop/bootstrap-pot/start)
      // already apply — a box merely overhearing the canonical announce on the
      // unconditionally-wired global directory topic (boot-all.ts) could silently
      // auto-join production even with the feature flag off. Mirror the sibling
      // gate here too; bootstrapPapercuspHive's own dogfoodHiveDisabled() env
      // kill-switch is the hard backstop for test-frame isolation regardless of
      // flag state.
      void Promise.all([
        import('@papercusp/flags/server').then((m) => m.getFlag),
        import('@papercusp/flags').then((m) => m.FLAGS),
      ])
        .then(async ([getFlag, FLAGS]) => {
          const on = await getFlag(FLAGS.DOGFOOD_PAPERCUSP_POT, 'system').catch(() => false);
          if (!on) return;
          const { startBootstrapPapercuspHive } = await import('./harness/bootstrap-papercusp-hive');
          await startBootstrapPapercuspHive().done.catch(() => {});
        })
        .catch(() => {});
    });
  trigger();
}

export async function wireHiveDirectoryAtBoot(opts: WireHiveDirectoryOpts): Promise<HiveDirectoryWiring> {
  const dir = opts.dir ?? getHiveDirectory();

  // Canonical-hive host (WI-867 cause (a)): the box that OWNS the canonical `papercusp`
  // hive must advertise it on the BAKED invite secret — the exact discovery topic fresh
  // installs listen on — overriding any drifted/missing meta secret. The old share path
  // minted a RANDOM per-device secret, so the host announced on a topic nobody was
  // joined to and every clean-install join timed out. We match the canonical hive by its
  // real Ed25519 pubkey (enriched onto each owned meta), so a JOINER box (which does not
  // OWN the canonical hive) is never affected.
  const baked = bakedCanonicalHiveInvite();
  const ownedHives: HiveDirectoryMeta[] = (opts.ownedHives ?? []).map((h) =>
    baked && h.hivePubkey === baked.pubkeyBase64
      ? { ...h, visibility: 'invite', inviteSecret: baked.inviteSecret }
      : h,
  );

  // 0. Hydrate the discovered set from the PG offline cache FIRST, so the
  //    browse list answers "what did I last see" before the swarm reconnects
  //    (the cache is a cache, never the transport — live announces LWW over it).
  await dir.hydrateFromCache().catch(() => 0);

  // ONE gossip instance for every directory topic. `getOwnAnnounces` is SCOPED
  // per topic so a global-topic pair only ever receives PUBLIC hives and an
  // invite-topic pair only that invite's hive(s) — an invite hive never leaks
  // onto the global topic.
  const gossip = createDirectoryGossip({
    swarm: opts.swarm,
    // P-005: the shared gossip channel carries announces AND withdrawal
    // tombstones — route by frame kind (the test fakes deliver inline); old peers
    // shape-reject unlist frames harmlessly.
    // P-009 (data-sync-push-completion): the verify→add-to-set / withdraw-
    // tombstone ingest is the PRIMARY mutation point for the discovered set —
    // push the directory browse + federation-status panels on every ACCEPTED
    // change so the desktop converges off its old 30s/10s polls. Lazy fire-and-
    // forget so this boot module never statically depends on the SSE layer (a
    // missing bus is a no-op); only an ACCEPTED ingest is a real change worth a
    // push (a rejected/superseded/muted frame leaves the set untouched).
    onAnnounce: async (frame) => {
      const unlist = isHiveUnlistFrame(frame);
      const res = unlist ? await dir.ingestUnlist(frame) : await dir.ingestAnnounce(frame);
      if (res.accepted) {
        // EI-8696: this push is fire-and-forget (never awaited by design — see
        // above) so it can OUTLIVE the caller's own await. Under vitest, none of
        // hive-directory's plain unit tests wire a real `./sync-sse` (no PG, no
        // SSE subscribers), so this chain's real `notifySyncInvalidate` throws
        // and its bus.onError logs a bare `console.error('[sync-sse] ... failed')`
        // — swallowed by the OUTER .catch here, but only AFTER it already fired
        // vitest-fail-on-console. Because the promise is untracked, that log can
        // land after the delivering test's `it()` has returned — inside a LATER
        // test's (or even a later FILE's, same worker) console-spy window, which
        // is exactly the "a different single test reds each hour" cross-test
        // contamination the green-checkpoint flake tracked. The push is a pure
        // UI-freshness nicety with no test ever asserting on it, so skip it
        // hermetically in test env — unchanged in every real deployment.
        if (!process.env.VITEST) {
          void trackDetached(import('./sync-sse'))
            .then((m) => {
              void m.notifySyncInvalidate('network.hiveDirectory').catch(() => {});
              void m.notifySyncInvalidate('network.federationStatus').catch(() => {});
            })
            .catch(() => {});
        }
        // WI-1585 defect B: a late canonical announce re-fires the auto-join
        // (no-op when already joined / non-canonical / debounced — see above).
        if (!unlist) void maybeTriggerCanonicalJoinOnIngest(frame as SignedHiveAnnounce).catch(() => {});
      } else if (res.reason !== 'superseded' && res.reason !== 'muted' && !process.env.VITEST) {
        // WI-953 diagnosability: a rejected announce previously left ZERO
        // trace anywhere — from the outside "peer connected, no discovery
        // row" was indistinguishable between "announce never arrived" and
        // "announce arrived but silently rejected" (unattested / bad-sig /
        // tombstoned). 'superseded'/'muted' are routine under normal gossip
        // re-broadcast and excluded to avoid log noise; the rest indicate a
        // real admission problem worth a trace on the next live/gate run.
        // Gated to non-test env (same reasoning as the sync-sse push above):
        // unit tests deliberately exercise every rejection path and would
        // otherwise trip vitest-fail-on-console on an unasserted warn.
        console.warn(
          `[hive-directory] rejected inbound ${unlist ? 'unlist' : 'announce'} for ${frame.hive_id}: ${res.reason}`,
        );
      }
      return res;
    },
    getOwnAnnounces: (topicHex) => dir.buildOwnedAnnounces({ topicHex }),
    refreshMs: opts.refreshMs,
  });

  // 1. The global directory topic (public hives).
  gossip.joinTopic(deriveDirectoryTopic());

  // 1b. Each owned INVITE hive's invite topic, so its announce has a transport
  //     AND we hear other announces on that invite topic.
  for (const hive of ownedHives) {
    if (hive.visibility === 'invite' && hive.inviteSecret) {
      try {
        gossip.joinTopic(deriveInviteTopic(hive.inviteSecret));
      } catch (e) {
         
        console.warn(`[hive-directory] failed to join invite topic for ${hive.potId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 2. Transport routes a frame to ITS topic's channels. An unknown topic (an
  //    invite hive added after boot) is lazily joined first — the hex is the
  //    32-byte topic, so it round-trips to a Buffer. Never silently dropped.
  const transport = async (topicHex: string, frame: SignedHiveAnnounce): Promise<void> => {
    try {
      gossip.joinTopic(Buffer.from(topicHex, 'hex')); // idempotent
    } catch {
      /* malformed hex / closed — fall through; broadcast is a no-op then */
    }
    gossip.broadcast(topicHex, frame);
  };
  // Deceptive-publish fix: hand the directory the live reach signal so a publish
  // can honestly report whether the announce reached anyone, instead of claiming
  // success on a void broadcast. G-001: pass the announce's topic through so the
  // count is THAT topic's paired channels — `openChannelCount(topicHex)` — not
  // every joined topic's (which over-reports an invite publish's reach). With no
  // topic it returns the all-topics total (back-compat).
  setHiveDirectoryTransport(transport, opts.keychainId, (topicHex) => gossip.openChannelCount(topicHex));

  // 3. Register + announce owned hives (transport is set, so public + invite go out).
  for (const hive of ownedHives) {
    try {
      await publishHiveToDirectory(dir, hive, opts.owner);
    } catch (e) {
       
      console.warn(`[hive-directory] failed to publish hive ${hive.potId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 4. Re-announce on a timer so our hives stay fresh under peers' TTLs.
  const stopTimer = dir.startReannounce(opts.reannounceMs ?? DEFAULT_REANNOUNCE_MS);

  return {
    gossip,
    /** Join an invite-scoped directory topic from a received invite secret (the
     *  invitee side — a "follow invite link" action calls this so the invite
     *  hive's announce is ingested + listed). Idempotent. */
    async joinInviteTopic(inviteSecret: string): Promise<void> {
      gossip.joinTopic(deriveInviteTopic(inviteSecret));
    },
    // G-002 honest-join: bounded-wait for the invite hive to ACTUALLY appear on
    // the topic we just joined, instead of reporting success on a bare subscribe.
    async confirmInviteAnnounce(inviteSecret, opts = {}) {
      const timeoutMs = Math.max(0, opts.timeoutMs ?? 6000);
      const pollMs = Math.max(50, opts.pollMs ?? 400);
      let topicHex: string;
      try {
        topicHex = hiveTopicAsHex(deriveInviteTopic(inviteSecret));
      } catch {
        return { found: false, peersOnTopic: 0 };
      }
      const peersOnTopic = (): number => {
        try {
          return gossip.openChannelCount(topicHex);
        } catch {
          return 0;
        }
      };
      // Snapshot the invite hives already known. We just joined EXACTLY this one
      // invite topic, so any invite hive that newly appears is this invite
      // materializing — the honest "it actually showed up" signal (vs a bare
      // topic subscribe, which always "succeeds" even for a dead secret).
      const seen = new Set(
        dir
          .listDiscoveredHives({ includeExpired: true })
          .filter((h) => h.visibility === 'invite')
          .map((h) => h.potId),
      );
      const findFresh = (): InviteAnnounceConfirm['hive'] | null => {
        const h = dir
          .listDiscoveredHives()
          .find((d) => d.visibility === 'invite' && !seen.has(d.potId));
        return h
          ? {
              potId: h.potId,
              title: h.title,
              visibility: h.visibility,
              // Surface the join targets so the caller skips the listDiscovered re-match.
              ...(h.memberLinks ? { memberLinks: h.memberLinks } : {}),
              ...(h.hivePubkey ? { hivePubkey: h.hivePubkey } : {}),
              ...(h.ownerDevicePubkey ? { ownerDevicePubkey: h.ownerDevicePubkey } : {}),
            }
          : null;
      };
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const fresh = findFresh();
        if (fresh) return { found: true, hive: fresh, peersOnTopic: peersOnTopic() };
        if (Date.now() >= deadline) return { found: false, peersOnTopic: peersOnTopic() };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
    transport,
    async stop() {
      stopTimer();
      dir.stopReannounce();
      await gossip.close();
    },
  };
}

// ── Process-global boot entry (called from boot-all, best-effort) ──────────────

let _wiring: HiveDirectoryWiring | null = null;
let _lastWireAttemptMs = 0;
/** P-539: the wire attempt still in progress, shared with every concurrent caller. */
let _wiringInFlight: Promise<HiveDirectoryWiring | null> | null = null;

/**
 * LAZY wire — for surfaces that need the directory live but may run before (or
 * instead of) the boot-all join: `discovery:set_pot` (announcing needs the
 * transport) and the discovery list reads. The boot join is once-only and
 * skips on a gh-unauthenticated box; without this, a box that authenticates
 * AFTER boot has a dead directory until restart. Returns the existing wiring
 * instantly when already joined; otherwise re-attempts at most once per minute
 * (identity resolution is the expensive/failing part). Best-effort → null.
 *
 * P-539: a caller that arrives while a wire is STILL IN PROGRESS gets that same
 * attempt, not null. The canonical first join bounds this call at 30 s and, on a
 * slow DHT bootstrap (~55 s measured on the Mac VM rig), retries it; answering
 * that retry with null inside the 60 s throttle reported "not wired" for a wire
 * that was about to succeed.
 */
export async function ensureHiveDirectoryWired(
  workspaceId: string,
  opts: { force?: boolean } = {},
): Promise<HiveDirectoryWiring | null> {
  if (_wiring) return _wiring;
  if (_wiringInFlight) return _wiringInFlight;
  const now = Date.now();
  if (!opts.force && now - _lastWireAttemptMs < 60_000) return null;
  _lastWireAttemptMs = now;
  const attempt = wireHiveDirectoryForWorkspace(workspaceId).finally(() => {
    if (_wiringInFlight === attempt) _wiringInFlight = null;
  });
  _wiringInFlight = attempt;
  return attempt;
}

/**
 * Boot the hive directory for a workspace (idempotent across the process). The
 * FIRST call joins the global topic + sets the transport + starts re-announce
 * (using this device's identity); a later call for another workspace just
 * publishes THAT workspace's owned hives onto the already-joined directory (the
 * directory is per-DEVICE — D-016 — so the topic join is shared).
 *
 * Fully best-effort: a gh-unauthenticated box (no announce identity) or any
 * failure SKIPS the directory and returns null — it must NEVER break harness
 * boot. Called from boot-all.bootAllHarnessesForActiveWorkspace.
 */
export async function wireHiveDirectoryForWorkspace(
  workspaceId: string,
  opts: {
    swarm?: HyperswarmLike;
    reannounceMs?: number;
    /** Hardening P-003 test seam — the full-publish-set reconcile for public
     *  hives. Default: hive-publish-from-repo's republishHiveAfterMemberAdd. */
    republish?: (o: { workspaceId: string; potSlug: string }) => Promise<unknown>;
    /** EI-9534 test seam — force the request-only decision. Default: requestOnlyHost(). */
    requestOnly?: boolean;
  } = {},
): Promise<HiveDirectoryWiring | null> {
  // [EI-9534] A request-only SECONDARY host (PAPERCUSP_BACKGROUND_WORKERS=0 / the
  // :3170 staging operator) must NOT join the directory swarm / gossip / announce:
  // the single-writer bg-host owns the shared federation machinery (EI-126). The
  // boot-all substrate path is already gated on backgroundWorkersEnabled(), but
  // THIS lazy wire — fired by discovery/federation-status reads, publish, join
  // (ensureHiveDirectoryWired) — was NOT, so a secondary host joined the global
  // directory topic anyway, grew to ~74 swarm connections + ~3.2 GB RSS, and
  // self-OOM-recycled (memory-watchdog exit 75). Skip the swarm join entirely.
  // A caller that injects its OWN swarm (tests / multi-instance) opts in
  // deliberately and bypasses the gate. requestOnlyHost() is a pure env predicate
  // (no vitest short-circuit) so this bites in every process, tests included.
  const requestOnly = opts.requestOnly ?? requestOnlyHost();
  if (!opts.swarm && requestOnly) {
    // EI-13590/WI-953 diagnosability: this early-return used to be completely
    // silent — a process with PAPERCUSP_BACKGROUND_WORKERS=0 (explicit, or
    // inherited ambiently from a calling shell that never overrode it — the
    // from-repo two-instance smoke's own launcher was doing exactly that) or
    // PAPERCUSP_HONO_PORT=3170 would NEVER wire setHiveDirectoryTransport, so
    // every later announce threw an opaque "device keychain not wired"
    // (hive-directory-deps.ts) with zero trace back to the actual cause. Loud
    // on purpose (not gated behind !VITEST like the neighboring catch-warn) —
    // a request-only host correctly skipping this is a real, useful fact to
    // see once per process, not spam.

    console.warn(
      `[hive-directory] boot-join SKIPPED for workspace ${workspaceId}: requestOnlyHost()===true ` +
        `(PAPERCUSP_BACKGROUND_WORKERS=${process.env.PAPERCUSP_BACKGROUND_WORKERS ?? '<unset>'}, ` +
        `PAPERCUSP_HONO_PORT=${process.env.PAPERCUSP_HONO_PORT ?? '<unset>'}) — this process will never ` +
        `announce/discover hives; every publish's sign() will throw "device keychain not wired" until a ` +
        `caller passes an explicit swarm or the env is corrected.`,
    );
    return null;
  }
  try {
    const { resolveLocalAnnounceIdentity } = await import('./sync/hyperbee/local-announce-identity');
    const { listOwnedHiveMeta } = await import('./hive-directory-meta');
    // The hive announce carries no log_core_key; resolveLocalAnnounceIdentity
    // only needs logCoreKeyHex non-empty (for a peer-announce body we don't use).
    const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: '0'.repeat(64) });
    const owner: HiveOwnerIdentity = {
      githubLogin: id.githubLogin,
      githubUserId: id.githubUserId,
      devicePubkey: id.devicePubkeyBase64,
      attestationGistId: id.attestationGistId,
    };
    const ownedHivesRaw = await listOwnedHiveMeta(workspaceId);
    // Enrich each owned hive with its Ed25519 IDENTITY pubkey (the cross-Hive dial
    // address, P-006) sourced from the keychain/hives table — only the owning Swarm
    // holds it, and publish only runs for owned hives. Not persisted in the registry
    // meta (it lives in hives.public_key); attached fresh at publish time.
    // WI-3496 / D-032 R-3+R-3b: this read decides whether the announce carries the
    // cross-Hive dial address, and it used to be `loadHivePubkey(...).catch(() => null)`
    // — which flattens FOUR distinct outcomes into one silent `null`: not_found,
    // io_error, decryption_failed, and a throw. Holding the key does NOT prevent the
    // omission, because the omit is keyed on THE READ, not on presence. The result is
    // replayed forever: the pubkey is resolved once here, and dir.startReannounce()
    // re-announces whatever was published, so ONE transient keychain error at wire time
    // poisons every later announce until the process restarts. Reporting merely "null"
    // reproduces the exact conflation that made this defect invisible, so this reports
    // WHICH outcome fired, per hive, with the keychainId actually used.
    const { loadHiveKeyStatus, hiveKeychainId } = await import('./identity/hive-keypair');
    const { deriveHiveMemberRepoRefs } = await import('./hive-member-repos');
    const ownedHives = await Promise.all(
      ownedHivesRaw.map(async (h) => {
        let pk: string | null = null;
        let pkOutcome: string;
        try {
          const st = await loadHiveKeyStatus(workspaceId, h.potId);
          if (st.kind === 'ok') {
            pk = st.pubkeyBase64;
            pkOutcome = 'ok';
          } else if (st.kind === 'not_found') {
            pkOutcome = 'not_found';
          } else {
            pkOutcome = `error:${st.reason}`;
          }
        } catch (e) {
          pkOutcome = `threw:${e instanceof Error ? e.message : String(e)}`;
        }
        if (pkOutcome !== 'ok') {
          console.warn(
            `[hive-directory] hivePubkey OMITTED from announce for hive ${h.potId} ` +
              `(workspace ${workspaceId}): ${pkOutcome} — keychainId=${hiveKeychainId(workspaceId, h.potId)}. ` +
              `This announce carries NO cross-Hive dial address, and the omission is replayed by ` +
              `every reannounce until this process restarts.`,
          );
        }
        // member_repos: the repo→Hive binding signal (P-003) — derived fresh at
        // publish time like the pubkey, never persisted in the registry meta.
        const memberRepos = await deriveHiveMemberRepoRefs(workspaceId, h.potId).catch(
          () => [] as string[],
        );
        return {
          ...h,
          workspaceId, // P-004: announce-build enrichment key
          ...(pk ? { hivePubkey: pk } : {}),
          ...(memberRepos.length ? { memberRepos } : {}),
        };
      }),
    );

    if (!_wiring) {
      const { getSharedSwarm } = await import('./sync/hyperbee/swarm');
      const swarm = opts.swarm ?? (await getSharedSwarm());
      _wiring = await wireHiveDirectoryAtBoot({
        swarm,
        keychainId: id.keychainId,
        owner,
        ownedHives,
        reannounceMs: opts.reannounceMs,
      });
    } else {
      // Already joined — just publish this workspace's owned hives.
      const dir = getHiveDirectory();
      for (const hive of ownedHives) {
        try {
          await publishHiveToDirectory(dir, hive, owner);
        } catch {
          /* best-effort per hive */
        }
      }
    }

    // Hardening P-003 (D-003): boot-time Cupboard reconcile for public hives.
    await reconcilePublicHiveListings(ownedHives, workspaceId, opts.republish);
    return _wiring;
  } catch (e) {
     
    console.warn(
      `[hive-directory] boot-join skipped for workspace ${workspaceId}: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

/**
 * Hardening P-003 (D-003): the boot tick is the designed Cupboard reconcile
 * point — re-run the FULL publish set (announce + Cupboard rows + local
 * bindings; rowsExisted-tolerant) for owned PUBLIC hives, so a create that
 * happened while the Cupboard was unreachable self-heals on the next boot.
 * Invite/private stay directory-only (no Cupboard, D-003 of the parent plan).
 * Best-effort throughout: a reconcile failure never breaks the wire, and the
 * extra announce it emits is harmless (newer-ts LWW).
 */
export async function reconcilePublicHiveListings(
  ownedHives: readonly Pick<HiveDirectoryMeta, 'potId' | 'visibility'>[],
  workspaceId: string,
  republish?: (o: { workspaceId: string; potSlug: string }) => Promise<unknown>,
): Promise<number> {
  let reconciled = 0;
  try {
    const run =
      republish ??
      (async (o: { workspaceId: string; potSlug: string }) =>
        (await import('./hive-publish-from-repo')).republishHiveAfterMemberAdd(o));
    for (const h of ownedHives) {
      if (h.visibility !== 'public') continue;
      const ok = await run({ workspaceId, potSlug: h.potId }).then(
        () => true,
        () => false,
      );
      if (ok) reconciled += 1;
    }
  } catch {
    /* best-effort */
  }
  return reconciled;
}

/** Test seam: drop the process wiring so the next call re-joins. */
export function __resetHiveDirectoryWiring(): void {
  _wiring = null;
  _lastWireAttemptMs = 0;
  _wiringInFlight = null;
}
