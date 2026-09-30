/**
 * presence-gossip — ephemeral presence over the hive topic, OFF the append-only
 * peer-log (cross-machine-coord-parity-and-trust-2026-07-01 P-004, D-002/D-008).
 *
 * WHY: presence is a beat — state-change + keep-alive every ~30s per device.
 * On the peer-log every beat is an IMMORTAL append that every peer stores and
 * folds forever (at 256 machines × 10 agents ≈ half the hive's entire write
 * budget spent immortalizing heartbeats). Gossip frames cost nothing after
 * they're applied: the TTL-windowed `shared_presence` projection in PG is the
 * only persistent trace, exactly like the hive DIRECTORY (the pattern this
 * rides — createTopicGossip, extracted from directory-swarm.ts).
 *
 * WIRE: protocol `papercusp/hive-presence`, topic = the SAME hive federation
 * topic the substrate already joined (a different protocol id gets its own
 * Protomux channel on the shared socket — no new DHT join needed when the
 * caller passes the substrate's topic). Frames are DEVICE-SIGNED (the
 * hive-announce idiom: raw-32 Ed25519 pubkey, fixed-field-order JSON signing
 * bytes, freshness window) — a gossip frame does not ride a signed log, so it
 * must carry its own authenticity. Admission mirrors the log path's WI-259
 * membership gate: the caller injects `isMemberDevice` (device_pubkey ∈ the
 * hive's current `hive_members`) and non-members' frames are dropped.
 *
 * SEMANTICS:
 *   - `put` — upsert the device's SharedPresenceRow (TTL/staleness stays the
 *     reader's concern, e.g. PRESENCE_STALE_MS / the lock authority's window).
 *   - `del` — the leave TOMBSTONE (pot:leave semantics preserved from
 *     presence-announce.buildPresenceTombstoneOp): peers drop the leaver's row
 *     at once instead of waiting out the TTL. Going offline is still transient
 *     (no del on shutdown) — the TTL models that.
 *   - HELLO/snapshot: a freshly-paired peer receives our current row(s)
 *     (getHelloFrames) — replacing the log-replay catch-up a late joiner used
 *     to get. Frames re-sign per broadcast so the freshness window holds.
 *
 * Apply is INJECTED (applyPut/applyDel) so the module unit-tests without PG;
 * the boot wiring binds them to the shared_presence projection's writeToPg /
 * deleteFromPg (same LWW/ts guards as the log path — one writer shape, two
 * transports). Everything is best-effort: a bad frame is dropped, never thrown.
 */

import { verify as nodeVerify, createPublicKey } from 'node:crypto';
import type { HyperswarmLike } from './swarm';
import type { SharedPresenceRow } from './projections/presence';
import { createTopicGossip, type TopicGossipHandle } from './topic-gossip';

/** Protomux protocol id for the hive-presence gossip exchange. */
export const HIVE_PRESENCE_PROTOCOL = 'papercusp/hive-presence';

/** Presence gossip frame schema version. */
export const PRESENCE_FRAME_VERSION = 1;

/** Same replay-hardening freshness window as hive announces (D-007). */
export const DEFAULT_PRESENCE_FRAME_WINDOW_MS = 5 * 60 * 1000;

/** Fixed 12-byte Ed25519 SPKI DER prefix (matches announce.ts / hive-announce.ts). */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A device's presence-del key (mirrors the presence projection composeKey
 *  `<github_user_id>/<machine_label>`). */
export interface PresenceDelKey {
  github_user_id: number;
  machine_label: string;
  harness_slug: string;
  /** H2 (audit D-013): the SIGNING device. A del may only remove rows THIS device
   *  owns — stamped by buildPresenceDelFrame (= the signer) and pinned in verify
   *  (=== frame.device_pubkey), and carried into the delete WHERE, so an admitted
   *  member cannot evict another member's presence row (the de-presence DoS that
   *  breaks lock-authority election). */
  device_pubkey: string;
}

/** One live session on the announcing device (P-005 session-grain presence —
 *  the row the unified roster surfaces as a first-class remote agent). */
export interface SessionPresenceEntry {
  /** The session's REAL ownerId (su-<uuid> / s-<ts>-<hash> / queen id). */
  owner_id: string;
  /** 'su' | 'bee' | 'queen' | … — the sender's advisory classification. */
  kind: string;
  intent: string | null;
  plan_slug: string | null;
  /** The session's harness scope (within-hive demux, D-006). */
  harness_slug: string;
  /** The session's own liveness beat (epoch ms, sender-declared). */
  last_active_ms: number;
  /** The named-fleet MEMBERSHIP label this session carries WHILE ALIVE (mig 417/479,
   *  P-301) — so `@fleet:<slug>` resolves cross-machine members. Optional +
   *  advisory: absent/null for a session in no named fleet (and on frames from
   *  pre-mig-479 senders). Stamped by the announcer from coord_presence. */
  fleet_slug?: string | null;
  /** 'leader' | 'member' (advisory, free text — mirrors coord_presence.fleet_role);
   *  a cross-machine leader is derived from a member advertising 'leader'. */
  fleet_role?: string | null;
}

/** Defensive bound on one device's announced session set (10 agents/machine is
 *  the design point; 128 absorbs bursts without letting a peer flood rows). */
export const MAX_SESSIONS_PER_FRAME = 128;

export interface PresenceFrameBody {
  v: number;
  kind: 'put' | 'del' | 'sessions';
  /** The signing device (raw-32 Ed25519, base64) — must equal row.device_pubkey
   *  on a put (a device may only announce ITSELF; enforced in verify). */
  device_pubkey: string;
  /** Frame time (epoch ms) — freshness-windowed on receive. */
  ts: number;
  /** put: the full presence row. */
  row?: SharedPresenceRow;
  /** del: the tombstone key. */
  del?: PresenceDelKey;
  /** sessions (P-005): this device's FULL current session set — the receiver
   *  replaces the device's previous set (full-set semantics, self-healing).
   *  Frame-level identity legs give each entry its device/user/machine/hive. */
  sessions?: SessionPresenceEntry[];
  github_user_id?: number;
  machine_label?: string;
  hive_slug?: string | null;
}

export interface SignedPresenceFrame extends PresenceFrameBody {
  sig: string; // base64 Ed25519 over presenceFrameSigningBytes(body)
}

/**
 * Canonical signing bytes: fixed-field-order JSON of the body EXCLUDING `sig`
 * (the hive-announce idiom — fixed order equals JCS for this schema; optional
 * sections included only when present).
 */
export function presenceFrameSigningBytes(body: PresenceFrameBody): Buffer {
  const ordered: Record<string, unknown> = {
    v: body.v,
    kind: body.kind,
    device_pubkey: body.device_pubkey,
    ts: body.ts,
  };
  if (body.row) {
    const r = body.row;
    const row: Record<string, unknown> = {
      harness_slug: r.harness_slug,
      github_user_id: r.github_user_id,
      machine_label: r.machine_label,
      device_pubkey: r.device_pubkey,
      intent: r.intent,
      current_view: r.current_view,
      last_seen_at: r.last_seen_at,
      schema_version: r.schema_version,
      hive_slug: r.hive_slug ?? null,
    };
    // EI-18761517980514694: the runner-capability bit rides the SIGNED bytes —
    // the per-Hive runner election trusts it to decide candidacy, so leaving it
    // unsigned would let a tamperer mark any peer a runner and starve the pot's
    // cadence loop. Included ONLY when present, the same P-301 idiom the fleet
    // labels below use: the publisher emits it solely when TRUE, so a node that
    // is NOT a runner produces byte-identical frames to the pre-mig-682 wire form
    // and verification stays stable across a mixed-version deploy window.
    if (r.runs_routines != null) row.runs_routines = r.runs_routines;
    // EI-19330771435294981 (mig 724): the published routine SET rides the SIGNED
    // bytes for exactly the reason the bit above does — the git-sync INTEGRATOR
    // election decides candidacy from it, so leaving it unsigned would let a
    // tamperer claim 'git-sync' on any peer and capture the integrator lease
    // (the failure WI-6996 was opened for). Appended LAST and emitted ONLY when
    // present, so a publisher that does not send it produces byte-identical
    // frames to the pre-mig-724 wire form and verification stays stable across a
    // mixed-version deploy window. The publisher normalizes (dedupe + sort) so an
    // unchanged set never re-orders these bytes.
    if (r.active_routines != null) row.active_routines = r.active_routines;
    ordered.row = row;
  }
  if (body.del) {
    ordered.del = {
      github_user_id: body.del.github_user_id,
      machine_label: body.del.machine_label,
      harness_slug: body.del.harness_slug,
      device_pubkey: body.del.device_pubkey,
    };
  }
  if (body.sessions) {
    ordered.github_user_id = body.github_user_id;
    ordered.machine_label = body.machine_label;
    ordered.hive_slug = body.hive_slug ?? null;
    ordered.sessions = body.sessions.map((s) => {
      const entry: Record<string, unknown> = {
        owner_id: s.owner_id,
        kind: s.kind,
        intent: s.intent,
        plan_slug: s.plan_slug,
        harness_slug: s.harness_slug,
        last_active_ms: s.last_active_ms,
      };
      // P-301: the fleet-membership label rides the signed frame, but is included
      // in the signing bytes ONLY when present — so a session in NO named fleet
      // produces a byte-identical frame to the pre-mig-479 wire form, keeping frame
      // verification stable across a mixed-version deploy window (an upgraded sender
      // only changes the bytes for sessions that ARE fleet-attributed — the new path).
      if (s.fleet_slug != null) entry.fleet_slug = s.fleet_slug;
      if (s.fleet_role != null) entry.fleet_role = s.fleet_role;
      return entry;
    });
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/** Build a signed presence PUT frame. Signer injected (production:
 *  `bytes => signWithDeviceKey(keychainId, bytes)`; tests: a generated keypair). */
export async function buildPresencePutFrame(
  row: SharedPresenceRow,
  nowMs: number,
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<SignedPresenceFrame> {
  const body: PresenceFrameBody = {
    v: PRESENCE_FRAME_VERSION,
    kind: 'put',
    device_pubkey: row.device_pubkey,
    ts: nowMs,
    row,
  };
  const sig = await sign(presenceFrameSigningBytes(body));
  return { ...body, sig: sig.toString('base64') };
}

/** Build a signed SESSIONS frame — this device's full current session set
 *  (P-005). Receivers replace the device's previous set (full-set semantics). */
export async function buildSessionsFrame(
  identity: {
    devicePubkey: string;
    githubUserId: number;
    machineLabel: string;
    potSlug: string | null;
  },
  sessions: SessionPresenceEntry[],
  nowMs: number,
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<SignedPresenceFrame> {
  const body: PresenceFrameBody = {
    v: PRESENCE_FRAME_VERSION,
    kind: 'sessions',
    device_pubkey: identity.devicePubkey,
    ts: nowMs,
    github_user_id: identity.githubUserId,
    machine_label: identity.machineLabel,
    hive_slug: identity.potSlug,
    sessions: sessions.slice(0, MAX_SESSIONS_PER_FRAME),
  };
  const sig = await sign(presenceFrameSigningBytes(body));
  return { ...body, sig: sig.toString('base64') };
}

/** Build a signed presence DEL (leave-tombstone) frame. The del key's
 *  `device_pubkey` is STAMPED from the signer (H2) — a device may only tombstone
 *  its own rows — so callers pass just the (user, machine, harness) target. */
export async function buildPresenceDelFrame(
  devicePubkey: string,
  del: Omit<PresenceDelKey, 'device_pubkey'>,
  nowMs: number,
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<SignedPresenceFrame> {
  const body: PresenceFrameBody = {
    v: PRESENCE_FRAME_VERSION,
    kind: 'del',
    device_pubkey: devicePubkey,
    ts: nowMs,
    del: { ...del, device_pubkey: devicePubkey },
  };
  const sig = await sign(presenceFrameSigningBytes(body));
  return { ...body, sig: sig.toString('base64') };
}

/**
 * Verify a presence frame: shape, self-announce-only (put.row.device_pubkey ===
 * device_pubkey), freshness window, and the Ed25519 signature against the
 * frame's own device_pubkey. Signature + freshness ONLY — membership admission
 * (device ∈ hive_members) is the gossip's separate injected gate, mirroring the
 * directory's channel-1 / channel-2 split. Never throws.
 */
export function verifyPresenceFrame(
  frame: SignedPresenceFrame,
  opts?: { nowMs?: number; windowMs?: number },
): boolean {
  try {
    if (!frame || typeof frame !== 'object') return false;
    if (frame.v !== PRESENCE_FRAME_VERSION) return false;
    if (frame.kind !== 'put' && frame.kind !== 'del' && frame.kind !== 'sessions') return false;
    if (typeof frame.device_pubkey !== 'string' || typeof frame.sig !== 'string') return false;
    if (typeof frame.ts !== 'number' || !Number.isFinite(frame.ts)) return false;

    if (frame.kind === 'sessions') {
      // P-005: frame-level identity legs + a bounded, well-shaped session set.
      if (
        typeof frame.github_user_id !== 'number' ||
        typeof frame.machine_label !== 'string' ||
        frame.machine_label.length === 0 ||
        !Array.isArray(frame.sessions) ||
        frame.sessions.length > MAX_SESSIONS_PER_FRAME
      ) {
        return false;
      }
      for (const s of frame.sessions) {
        if (!s || typeof s !== 'object') return false;
        if (typeof s.owner_id !== 'string' || s.owner_id.length === 0) return false;
        if (typeof s.kind !== 'string') return false;
        if (s.intent !== null && typeof s.intent !== 'string') return false;
        if (s.plan_slug !== null && typeof s.plan_slug !== 'string') return false;
        if (typeof s.harness_slug !== 'string' || s.harness_slug.length === 0) return false;
        if (typeof s.last_active_ms !== 'number' || !Number.isFinite(s.last_active_ms)) return false;
      }
    } else if (frame.kind === 'put') {
      const r = frame.row;
      if (!r || typeof r !== 'object') return false;
      if (
        typeof r.harness_slug !== 'string' ||
        typeof r.github_user_id !== 'number' ||
        typeof r.machine_label !== 'string' ||
        typeof r.device_pubkey !== 'string' ||
        typeof r.last_seen_at !== 'number'
      ) {
        return false;
      }
      // A device may only announce ITSELF — the signature covers row.device_pubkey,
      // so requiring equality pins the row to the signing device.
      if (r.device_pubkey !== frame.device_pubkey) return false;
    } else {
      const d = frame.del;
      if (!d || typeof d !== 'object') return false;
      if (
        typeof d.github_user_id !== 'number' ||
        typeof d.machine_label !== 'string' ||
        typeof d.harness_slug !== 'string' ||
        typeof d.device_pubkey !== 'string'
      ) {
        return false;
      }
      // H2 (audit D-013): a del may only remove the SIGNER's own rows — pin the
      // del's device to the signing device (the dual of the put self-announce pin
      // at the `put` branch above), so an admitted member can't evict another
      // member's presence row.
      if (d.device_pubkey !== frame.device_pubkey) return false;
    }

    const nowMs = opts?.nowMs ?? Date.now();
    const windowMs = opts?.windowMs ?? DEFAULT_PRESENCE_FRAME_WINDOW_MS;
    if (Math.abs(nowMs - frame.ts) > windowMs) return false;

    const rawPubkey = Buffer.from(frame.device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return false;
    const spkiDer = Buffer.concat([SPKI_PREFIX, rawPubkey]);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const { sig: _sig, ...body } = frame;
    const bytes = presenceFrameSigningBytes(body);
    const sig = Buffer.from(frame.sig, 'base64');
    return nodeVerify(null, bytes, publicKey, sig);
  } catch {
    return false;
  }
}

export interface CreatePresenceGossipOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** Membership admission + ATTESTED-IDENTITY resolution (the WI-259 gate's
   *  gossip twin, hardened for multi-owner — audit D-013 root fix for H1/H3):
   *  resolve the github_user_id ATTESTED to this signing device in the hive whose
   *  TOPIC the frame arrived on. A non-null id ⇒ a current member (admitted); null
   *  ⇒ not a member / revoked / read error ⇒ the frame is dropped. Production binds
   *  hive_members (device_pubkey → githubUserId, minus the revoked union) keyed by
   *  the topic's registered hive. The returned id is the TRUST ANCHOR every
   *  sender-declared identity field (row/del github_user_id, sessions frame user)
   *  is validated against — never the spoofable body fields. */
  resolveMemberIdentity: (
    devicePubkey: string,
    topicHex: string,
  ) => (number | null) | Promise<number | null>;
  /** Apply an admitted put (bind to the shared_presence projection's writeToPg —
   *  same LWW/ts guards as the log path). `topicHex` = the carrying topic (the
   *  receiver's workspace/hive binding key). */
  applyPut: (row: SharedPresenceRow, frameTs: number, topicHex: string) => void | Promise<unknown>;
  /** Apply an admitted del (bind to the projection's deleteFromPg). */
  applyDel: (del: PresenceDelKey, frameTs: number, topicHex: string) => void | Promise<unknown>;
  /** Apply an admitted SESSIONS set (P-005): replace the device's whole
   *  session-presence set (bind to the shared_session_presence writer).
   *  Optional so put/del-only deployments (and older tests) stay valid. */
  applySessions?: (
    input: {
      devicePubkey: string;
      githubUserId: number;
      machineLabel: string;
      potSlug: string | null;
      sessions: SessionPresenceEntry[];
    },
    frameTs: number,
    topicHex: string,
  ) => void | Promise<unknown>;
  /** Our current presence frame(s) for the late-joiner HELLO — re-signed at call
   *  time so the freshness window holds. Empty when gh-unauthed / nothing to say. */
  getHelloFrames: (topicHex: string) => SignedPresenceFrame[] | Promise<SignedPresenceFrame[]>;
  /** Freshness window override (tests). */
  frameWindowMs?: number;
  now?: () => number;
  /** Discovery-refresh knobs — forwarded to the chassis. When the caller rides
   *  an already-joined substrate topic, the substrate's own discovery drives
   *  connections and 0 disables this instance's refresh loop entirely. */
  refreshMs?: number;
  fastWindowMs?: number;
  slowRefreshMs?: number;
}

export type PresenceGossipHandle = TopicGossipHandle<SignedPresenceFrame>;

/** The inbound pipeline's disposition — surfaced for tests/diagnostics.
 *  'identity-mismatch' (audit D-013 H1/H3): the frame verified + the signer is an
 *  admitted member, but a sender-declared identity field (row/del github_user_id,
 *  sessions frame user) did NOT match the signer's ATTESTED github_user_id — the
 *  spoof is dropped. */
export type PresenceFrameDisposition =
  | 'applied'
  | 'bad-frame'
  | 'not-member'
  | 'identity-mismatch'
  | 'apply-failed';

/**
 * The inbound presence pipeline (pure over injected gates/appliers): verify
 * (sig + freshness + self-announce pin) → membership gate → applyPut/applyDel.
 * Never throws — a bad/failed frame is dropped; gossip is best-effort by
 * contract. Exported so the gating order is unit-tested without a swarm (the
 * chassis behavior itself is pinned by directory-swarm.test.ts).
 */
export async function handleInboundPresenceFrame(
  frame: SignedPresenceFrame,
  topicHex: string,
  opts: Pick<
    CreatePresenceGossipOpts,
    'resolveMemberIdentity' | 'applyPut' | 'applyDel' | 'applySessions' | 'frameWindowMs' | 'now'
  >,
): Promise<PresenceFrameDisposition> {
  try {
    if (
      !verifyPresenceFrame(frame, {
        nowMs: (opts.now ?? Date.now)(),
        ...(opts.frameWindowMs !== undefined ? { windowMs: opts.frameWindowMs } : {}),
      })
    ) {
      return 'bad-frame';
    }
    // Root fix (audit D-013): resolve the signer's ATTESTED github_user_id from
    // membership (null ⇒ not a member ⇒ drop). Every sender-declared identity
    // field below is validated against THIS attested id, never the body fields.
    const attestedUserId = await Promise.resolve(
      opts.resolveMemberIdentity(frame.device_pubkey, topicHex),
    ).catch(() => null);
    if (attestedUserId == null) return 'not-member';
    if (frame.kind === 'put' && frame.row) {
      // H3 (audit D-013): the row's github_user_id must be the SIGNER's attested
      // id — else an admitted device forges another (user, machine)'s presence.
      // (verify already pinned row.device_pubkey === the signer.)
      if (frame.row.github_user_id !== attestedUserId) return 'identity-mismatch';
      await Promise.resolve(opts.applyPut(frame.row, frame.ts, topicHex));
    } else if (frame.kind === 'del' && frame.del) {
      // H2 (audit D-013): the del's declared user must be the signer's attested id
      // (verify already pinned del.device_pubkey === the signer, so a device can
      // only tombstone its own rows — this rejects a signer whose OWN attested id
      // doesn't even match the del it signed).
      if (frame.del.github_user_id !== attestedUserId) return 'identity-mismatch';
      await Promise.resolve(opts.applyDel(frame.del, frame.ts, topicHex));
    } else if (frame.kind === 'sessions' && frame.sessions && opts.applySessions) {
      // H1 (audit D-013): a device may only announce sessions under its OWN user —
      // the frame's github_user_id must be the signer's attested id, so it cannot
      // announce a victim's / the queen's user. (A remote session additionally can
      // NEVER shadow a LOCAL owner_id — the local agent is authoritative for its own
      // id — enforced receiver-side in recipient-resolve.readKnownOwnerIds.)
      if (frame.github_user_id !== attestedUserId) return 'identity-mismatch';
      await Promise.resolve(
        opts.applySessions(
          {
            devicePubkey: frame.device_pubkey,
            githubUserId: frame.github_user_id!,
            machineLabel: frame.machine_label!,
            potSlug: frame.hive_slug ?? null,
            sessions: frame.sessions,
          },
          frame.ts,
          topicHex,
        ),
      );
    }
    return 'applied';
  } catch {
    return 'apply-failed';
  }
}

/**
 * Create the presence gossip family. One instance per process; join each shared
 * hive's federation topic through the handle. Inbound: verify (sig + freshness
 * + self-announce pin) → membership gate → applyPut/applyDel. All best-effort.
 */
export function createPresenceGossip(opts: CreatePresenceGossipOpts): PresenceGossipHandle {
  return createTopicGossip<SignedPresenceFrame>({
    swarm: opts.swarm,
    protocol: HIVE_PRESENCE_PROTOCOL,
    name: 'createPresenceGossip',
    refreshLabel: 'presence-gossip-refresh',
    refreshMs: opts.refreshMs,
    fastWindowMs: opts.fastWindowMs,
    slowRefreshMs: opts.slowRefreshMs,
    getHelloFrames: opts.getHelloFrames,
    onFrame: (frame, topicHex) => void handleInboundPresenceFrame(frame, topicHex, opts),
  });
}
