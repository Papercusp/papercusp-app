/**
 * swarm-guard — process-global DoS guard for the shared Hyperswarm
 * (hyperswarm-dos-hardening Phases 2-3: P-003 firewall ban-gate, P-004 ban-on-
 * abuse, P-005 per-peer connection rate-limit).
 *
 *   - `firewall(remotePublicKey)` — a SYNC predicate handed to
 *     `new Hyperswarm({ firewall })`; rejects banned keys pre-handshake (cheap).
 *     Hyperswarm only exposes the remote Noise key here, so the firewall is
 *     key-only.
 *   - `recordConnection(keyHex, ip)` — per-connection accounting run by the
 *     connection handler: a tight per-KEY connection-rate limit plus a much
 *     wider per-IP ceiling (the shared `@papercusp/rate-limit` soft bucket over
 *     an IN-MEMORY store — D-004: conn gating is high-frequency + ephemeral,
 *     must cause zero PG writes). A per-key trip bans that KEY only; the IP is
 *     banned only when the wide per-IP ceiling is itself breached. The two are
 *     separate on purpose — one shared bucket keyed by IP let co-located peers
 *     spend each other's budget and ban each other (EI-20578573707248054).
 *   - Enforcement: the firewall blocks future *key* connects pre-handshake; the
 *     handler's sync `isBanned*` drops an in-flight connection and one from a
 *     banned IP (the key-only firewall can't see IPs). Hyperswarm's own `ban()`
 *     does NOT close an existing connection (D-003), so the handler destroys it.
 *
 * Process-global (like the shared swarm) so a ban fed by any harness's handler
 * is seen by the one firewall. The ban-list TTL uses an injected clock for
 * deterministic tests; the rate-limiter uses its own `Date.now` (burst tests
 * don't advance time). Firewall semantics: `true` = DENY.
 */
import {
  createRateLimiter,
  type BucketStore,
  type BucketPayload,
  type StoredBucket,
} from '@papercusp/rate-limit';

/**
 * In-memory BucketStore for the connection-rate limiter (D-004 — NOT the
 * PG-backed store `auth-rate-limit` uses; per-connection checks must not touch PG).
 */
export function createInMemoryBucketStore(): BucketStore {
  const m = new Map<string, { payload: BucketPayload; touched: number }>();
  return {
    async read(key): Promise<StoredBucket> {
      return (m.get(key)?.payload ?? null) as StoredBucket;
    },
    async write(key, payload): Promise<void> {
      m.set(key, { payload, touched: Date.now() });
    },
    async delete(key): Promise<void> {
      m.delete(key);
    },
    async gcStale(olderThanMs): Promise<void> {
      for (const [k, v] of m) if (v.touched < olderThanMs) m.delete(k);
    },
    async clearPrefix(prefix): Promise<void> {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
    },
  };
}

/** Default ban cooldown (auto-unban after this; a forgotten ban self-heals). */
export const DEFAULT_BAN_TTL_MS = 10 * 60_000;
/**
 * Connection-rate ceiling PER PEER KEY: one peer reconnecting more than this in
 * the window is a clear reconnect storm (legitimate reconnects are rare).
 *
 * ⚠ PER KEY, NOT PER IP — that distinction is the whole point (EI-20578573707248054).
 * This bucket was keyed `ip ?? keyHex`, so every peer behind one egress IP shared
 * a single 30-per-10s budget and a trip banned the IP, kicking every innocent
 * neighbour off for ten minutes. Forming a flat N-peer mesh produces ~N-1 inbound
 * connections by construction, so the guard was spent by the mesh itself: fine at
 * 16 peers, marginal at 32, collapsed at 64 — which is exactly the knee D-008
 * measured, with a p95 of 601s against this file's 600s ban TTL. Co-located peers
 * are the NORMAL case, not an attack: every Tier-1/Tier-2 perf peer is on
 * loopback, and in production an office NAT, a k8s cluster egress or a cloud NAT
 * gateway all put many legitimate peers on one address.
 */
export const CONN_RATE = { windowMs: 10_000, capacity: 30 };
/**
 * The number of peers a single flat mesh is supported at
 * (harden-shared-hive-to-256-peers). The per-IP ceiling below is sized from it:
 * a capacity beneath this silently caps mesh size no matter what the sync
 * substrate can do.
 */
export const SUPPORTED_MESH_PEERS = 256;
/**
 * Secondary, much wider ceiling PER IP — still stops a genuine flood from one
 * address, but sized so a legitimate mesh formation burst from co-located peers
 * (~SUPPORTED_MESH_PEERS connections, plus headroom for retries and churn)
 * cannot trip it. Only a trip of THIS bucket bans the IP.
 */
export const CONN_RATE_IP = { windowMs: 10_000, capacity: SUPPORTED_MESH_PEERS * 4 };

export interface SwarmGuard {
  /** SYNC predicate for `new Hyperswarm({ firewall })`. `true` = reject. */
  firewall(remotePublicKey: Buffer | Uint8Array | null | undefined): boolean;
  isBannedKey(keyHex: string): boolean;
  isBannedIp(ip: string): boolean;
  banKey(keyHex: string, ttlMs?: number): void;
  banIp(ip: string, ttlMs?: number): void;
  /** Per-connection accounting. Resolves `{ allow:false }` when the peer is
   *  already banned (`reason:'banned'`) or just tripped the connection-rate
   *  limit (`reason:'rate_limited'`, which also bans it) — the caller drops the
   *  socket and can record the reason for observability (P-007). */
  recordConnection(
    keyHex?: string,
    ip?: string,
  ): Promise<{ allow: boolean; reason?: 'banned' | 'rate_limited' }>;
}

export interface SwarmGuardOpts {
  now?: () => number;
  store?: BucketStore;
}

export function createSwarmGuard(opts: SwarmGuardOpts = {}): SwarmGuard {
  const now = opts.now ?? Date.now;
  const bannedKeys = new Map<string, number>(); // → expiry ms
  const bannedIps = new Map<string, number>();
  const store = opts.store ?? createInMemoryBucketStore();
  // Two buckets, deliberately separate (EI-20578573707248054): a tight per-KEY
  // limit that catches a single peer's reconnect storm, and a wide per-IP
  // ceiling that only a genuine flood from one address can reach. Sharing one
  // bucket keyed by IP is what let co-located peers ban each other.
  const keyLimiter = createRateLimiter({ store, soft: CONN_RATE });
  const ipLimiter = createRateLimiter({ store, soft: CONN_RATE_IP });

  const banned = (m: Map<string, number>, k: string): boolean => {
    const exp = m.get(k);
    if (exp === undefined) return false;
    if (now() >= exp) {
      m.delete(k); // lazy expiry → auto-unban
      return false;
    }
    return true;
  };
  const isBannedKey = (keyHex: string) => banned(bannedKeys, keyHex);
  const isBannedIp = (ip: string) => banned(bannedIps, ip);
  const banKey = (keyHex: string, ttlMs = DEFAULT_BAN_TTL_MS) =>
    void bannedKeys.set(keyHex, now() + ttlMs);
  const banIp = (ip: string, ttlMs = DEFAULT_BAN_TTL_MS) =>
    void bannedIps.set(ip, now() + ttlMs);

  return {
    isBannedKey,
    isBannedIp,
    banKey,
    banIp,
    firewall(remotePublicKey) {
      const keyHex = toHex(remotePublicKey);
      if (!keyHex) return false; // unidentifiable → allow (never break a legit peer)
      return isBannedKey(keyHex);
    },
    async recordConnection(keyHex, ip) {
      if ((keyHex && isBannedKey(keyHex)) || (ip && isBannedIp(ip))) {
        return { allow: false, reason: 'banned' };
      }
      // Charge the PEER first. The penalty lands on whoever actually burst, so
      // a noisy peer can never cost its co-located neighbours their connection
      // (or get them banned for ten minutes).
      if (keyHex) {
        const perKey = await keyLimiter.checkSoft(`conn:key:${keyHex}`);
        if (!perKey.ok) {
          banKey(keyHex);
          return { allow: false, reason: 'rate_limited' };
        }
      }
      // Then the much wider per-IP ceiling — a genuine flood from one address,
      // well above any legitimate mesh-formation burst. Only THIS bans the IP.
      // An unidentifiable peer (no key) is charged here alone, which is why the
      // IP bucket must still exist.
      if (ip) {
        const perIp = await ipLimiter.checkSoft(`conn:ip:${ip}`);
        if (!perIp.ok) {
          if (keyHex) banKey(keyHex);
          banIp(ip);
          return { allow: false, reason: 'rate_limited' };
        }
      }
      // A peer with NEITHER key nor IP is still accounted — against a shared
      // 'unknown' bucket, banning nothing (there is nothing to ban). Without
      // this branch an unidentifiable peer would be charged nowhere at all and
      // could connect without limit.
      if (!keyHex && !ip) {
        const perUnknown = await keyLimiter.checkSoft('conn:unknown');
        if (!perUnknown.ok) return { allow: false, reason: 'rate_limited' };
      }
      return { allow: true };
    },
  };
}

function toHex(rk: Buffer | Uint8Array | null | undefined): string | undefined {
  if (!rk) return undefined;
  try {
    return Buffer.isBuffer(rk) ? rk.toString('hex') : Buffer.from(rk).toString('hex');
  } catch {
    return undefined;
  }
}

// ── process-global singleton + test seam ──
let _guard: SwarmGuard | null = null;
export function getSwarmGuard(): SwarmGuard {
  if (!_guard) _guard = createSwarmGuard();
  return _guard;
}
export function _setSwarmGuardForTests(g: SwarmGuard | null): void {
  _guard = g;
}
