/**
 * eviction-agent.ts — ONE peer of a ≥3-peer shared hive as a real OS process, for the
 * cross-machine LOCK-AUTHORITY φ+SWIM EVICTION proof (P-016 of
 * shared-hive-hardening-2026-06-13, D-010).
 *
 * The eviction analog of `claim-agent.ts`: the SAME process runs locally (N children on
 * loopback — the $0 parity path) and on a real Hetzner bench frame over SSH (the paid
 * cross-machine run), driven over the same ndjson stdin/stdout line protocol. It exercises
 * the REAL eviction machinery end to end:
 *
 *   - the per-harness lock-authority ELECTION (`lockAuthorityFor`, argmin device_pubkey over
 *     the presence roster) consulting the REAL {@link AuthorityEvictionMonitor};
 *   - the φ-accrual + SWIM relay probe: when a peer's presence goes silent (high φ), the
 *     monitor probes k witnesses via the REAL `peer.probe` authority op over the REAL
 *     {@link HttpPeerRpcTransport}, and excludes a relay-confirmed-dead peer from candidacy
 *     BEFORE the 90s staleness floor;
 *   - file-lock acquire ROUTING through the elected (post-eviction, LIVE) authority
 *     (`routeToAuthority` → `lock.acquire`), proving a live authority is promoted rather than
 *     the acquire failing open to the dead one.
 *
 * # The ONLY non-production leg: the presence SOURCE
 *
 * A bench frame is PG-less, so — exactly as claim-agent swaps the SQL claim store for an
 * in-memory one through a documented seam — this agent swaps the `shared_presence` PG source
 * for a lightweight in-memory cross-frame HEARTBEAT view: every peer serves `GET /alive`, and
 * every peer polls every other peer's `/alive` each `heartbeatMs`, recording `lastSeenMs`. A
 * REAL process kill freezes the dead peer's `lastSeenMs` from the survivors' vantage (a real
 * cross-machine staleness signal), which drives both the φ detector (fed via
 * `fetchPresenceRows`) and the witness's `peer.probe` answer (injected `isPeerLive`). The
 * REAL eviction monitor, REAL `peer.probe` op + dispatch, and REAL HTTP transport are
 * unchanged — only WHERE liveness comes from is swapped. The substrate's actual cross-machine
 * presence FEDERATION over the public DHT is proven separately (hive-cross-machine P-011); this
 * proof isolates the eviction DECISION chain over real machines + a real crash.
 *
 * Launch: `node --import tsx <this file>` with the JSON config in EVICTION_AGENT env
 * (spawned by eviction-launcher.ts — never run by hand).
 *
 * Wire protocol (ndjson, child stdout → parent):
 *   {evt:'ready', devicePubkey, httpPort}            — server + authority ops + loops up
 *   {evt:'state', nonce, authorityPubkey, isSelf,    — snapshot answer to a `state <nonce>` query
 *     liveCount, evicted:[...], presenceAgeMs:{...}, heldPaths:[...]}
 *   {evt:'acquired', nonce, path, ok, via,           — answer to an `acquire <nonce> <path>` query
 *     authorityPubkey}
 *   {evt:'error', message}                           — fatal; exits 1
 * Parent stdin → child:
 *   `state <nonce>`           — emit a {state} snapshot tagged with the nonce
 *   `acquire <nonce> <path>`  — route a lock.acquire through the authority; emit {acquired}
 *   `stop`                    — shut the HTTP server + exit
 */

import { createServer, get as httpGet, type Server } from 'node:http';
import {
  registerFileLockAuthorityOps,
  FILE_LOCK_OP_KINDS,
  type FileLockCoordinator,
  type FileLockAcquireParams,
  type FileLockAcquireResult,
} from '../../authority/file-lock-authority-ops';
import {
  handleAuthorityRpc,
  type AuthorityRpcEnvelope,
} from '../../authority/authority-op-registry';
import {
  lockAuthorityFor,
  routeToAuthority,
  type LockAuthorityDeps,
  type PeerRef,
} from '../../authority/lock-authority';
import { setPeerRpcTransport } from '../../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../../authority/http-peer-rpc-transport';
import { AuthorityEvictionMonitor, setAuthorityEvictionMonitor } from '../../authority/peer-eviction';
import { registerPeerProbeOp } from '../../authority/peer-probe-op';

/** One peer in the roster — its election identity + where to reach its HTTP endpoint. */
export interface EvictionRosterEntry {
  devicePubkey: string;
  githubUserId: number;
  machineLabel: string;
  /** Base URL of this peer's HTTP server (authority RPC POST + `GET /alive`). */
  baseUrl: string;
}

export interface EvictionAgentConfig {
  peerIndex: number;
  devicePubkey: string;
  githubUserId: number;
  owner: string;
  machineLabel: string;
  /** The authority scope (harness slug) every peer resolves the authority for. */
  scope: string;
  /** Coordination domain (repo realpath) threaded on lock payloads. */
  coordinationDomain: string;
  /** Every peer (including self) — the injected presence roster + the RPC address book. */
  roster: EvictionRosterEntry[];
  /** This agent's HTTP server. Bind 0.0.0.0 on a frame, 127.0.0.1 locally. */
  httpPort: number;
  httpHost?: string;
  /**
   * Install the eviction monitor (true) or not (false → the pre-P-016 staleness-only
   * control: a killed authority stays "elected" until the 90s floor, acquires fail open).
   * Default true.
   */
  evictionEnabled?: boolean;
  /** Presence poll + authority-resolve cadence (ms). Default 500. */
  heartbeatMs?: number;
  /** Witness liveness window (ms): `peer.probe` answers DEAD when a peer's last `/alive`
   *  is older than this. Scaled down from the production 90s so the test evicts in seconds;
   *  >a few poll intervals so transient jitter never false-evicts. Default 2500. */
  evictionStaleMs?: number;
  /** The authority-selection staleness FLOOR (ms). Default 90_000 (the production value) —
   *  eviction must beat it. */
  authorityStaleMs?: number;
  /** Monitor background relay-probe throttle (ms). Default 500. */
  refreshThrottleMs?: number;
  /** Per-peer `/alive` poll timeout (ms) — short so a dead peer's poll fails fast. Default 1000. */
  pollTimeoutMs?: number;
  /** Authority RPC per-call timeout (ms). Default 3000. */
  rpcTimeoutMs?: number;
  /** Lock lease TTL (s). Default 300. */
  ttlSec?: number;
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * A trivial in-memory file-lock coordinator (mirrors the two-instance rig's): each agent's
 * own lock store, behind the REAL `lock.acquire`/`release`/`queue` authority handlers. The
 * authority's store is the serialization point.
 */
function inMemoryCoordinator(): FileLockCoordinator & { heldPaths(): string[] } {
  const held = new Map<string, { owner: string; lockId: string }>();
  let seq = 0;
  return {
    heldPaths: () => [...held.keys()],
    async acquire(p: FileLockAcquireParams): Promise<FileLockAcquireResult> {
      const busy: Array<{ path: string; owner: string }> = [];
      for (const path of p.paths) {
        const cur = held.get(path);
        if (cur && cur.owner !== p.owner) busy.push({ path, owner: cur.owner });
      }
      if (busy.length) return { ok: false, busy };
      const lockId = `lk-${seq++}`;
      const expiresTs = new Date(Date.now() + p.ttlSec * 1000).toISOString();
      for (const path of p.paths) held.set(path, { owner: p.owner, lockId });
      return { ok: true, lockId, expiresTs };
    },
    async release(p): Promise<{ ok: boolean; released?: string[] }> {
      const released: string[] = [];
      for (const [path, lock] of [...held.entries()]) {
        const match = lock.owner === p.owner && (p.allMine || p.lockId === lock.lockId || p.paths?.includes(path));
        if (match) {
          held.delete(path);
          released.push(path);
        }
      }
      return { ok: true, released };
    },
    async queue() {
      return { active_locks: [...held.entries()].map(([path, l]) => ({ path, owner: l.owner })) };
    },
  };
}

/** GET `${baseUrl}/alive` with a hard timeout; resolve true on a 2xx, false on anything else. */
function probeAlive(baseUrl: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      const req = httpGet(`${baseUrl}/alive`, (res) => {
        const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
        res.resume(); // drain so the socket frees
        res.on('end', () => finish(ok));
        res.on('error', () => finish(false));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(false);
      });
      req.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = JSON.parse(process.env.EVICTION_AGENT ?? '{}') as EvictionAgentConfig;
  if (!cfg.devicePubkey || !Array.isArray(cfg.roster) || !cfg.scope) {
    throw new Error('eviction-agent: EVICTION_AGENT config missing devicePubkey/roster/scope');
  }
  const evictionEnabled = cfg.evictionEnabled !== false;
  const heartbeatMs = cfg.heartbeatMs ?? 500;
  const evictionStaleMs = cfg.evictionStaleMs ?? 2_500;
  const authorityStaleMs = cfg.authorityStaleMs ?? 90_000;
  const refreshThrottleMs = cfg.refreshThrottleMs ?? 500;
  const pollTimeoutMs = cfg.pollTimeoutMs ?? 1_000;
  const rpcTimeoutMs = cfg.rpcTimeoutMs ?? 3_000;
  const ttlSec = cfg.ttlSec ?? 300;

  const self = cfg.roster.find((r) => r.devicePubkey === cfg.devicePubkey);
  if (!self) throw new Error('eviction-agent: self not in roster');
  const others = cfg.roster.filter((r) => r.devicePubkey !== cfg.devicePubkey);

  // ── In-memory cross-frame presence view (the swapped source). Seed every peer fresh so
  //    the φ detectors have a baseline cadence to learn before any kill. ──
  const now0 = Date.now();
  const lastSeenMs = new Map<string, number>(cfg.roster.map((r) => [r.devicePubkey, now0]));

  // ── The REAL lock store + authority op handlers (so ops routed HERE when we are the
  //    elected authority run against OUR store). Registered globally; handleAuthorityRpc
  //    dispatches from the global registry. ──
  const coordinator = inMemoryCoordinator();
  // emit:no-op — this proof isolates eviction; the P-015 lock-event capture is proven elsewhere
  // and the default sink would be a needless no-op on a PG-less frame anyway.
  registerFileLockAuthorityOps(coordinator, { emit: () => {} });

  // ── The REAL relay-side `peer.probe` op, answering from THIS peer's polled view (the
  //    injected isPeerLive — the documented test seam). Authority-EXEMPT (any peer answers). ──
  registerPeerProbeOp({
    isPeerLive: (targetPubkey: string) => {
      const last = lastSeenMs.get(targetPubkey);
      return last != null && Date.now() - last < evictionStaleMs;
    },
  });

  // ── The REAL HTTP authority transport, addressing peers by pubkey via the roster. ──
  const addrByPubkey = new Map(cfg.roster.map((r) => [r.devicePubkey, r.baseUrl]));
  setPeerRpcTransport(
    new HttpPeerRpcTransport({
      resolveAddress: (peer: PeerRef) => addrByPubkey.get(peer.devicePubkey) ?? null,
      timeoutMs: rpcTimeoutMs,
    }),
  );

  // ── The REAL eviction monitor (default relayProbe = transportRelayProbe over the HTTP
  //    transport). null when disabled → the pre-P-016 staleness-only control. ──
  const monitor = evictionEnabled ? new AuthorityEvictionMonitor({ refreshThrottleMs }) : null;
  setAuthorityEvictionMonitor(monitor);

  // ── Authority deps: presence rows + self identity + the floor + the monitor. ──
  const deps: LockAuthorityDeps = {
    now: Date.now,
    staleMs: authorityStaleMs,
    resolveSelf: async () => ({ githubUserId: cfg.githubUserId, devicePubkey: cfg.devicePubkey }),
    fetchPresenceRows: async () =>
      cfg.roster.map((r) => ({
        device_pubkey: r.devicePubkey,
        github_user_id: r.githubUserId,
        machine_label: r.machineLabel,
        last_seen_ms: lastSeenMs.get(r.devicePubkey) ?? 0,
      })),
    evictionMonitor: monitor,
    // Sibling of the WI-5203 fix (claim-agent.ts) — same real-OS-process pattern,
    // same HRW_RENDEZVOUS_AUTHORITY-graduated-default-ON exposure. Pin OFF so this
    // agent's election stays the deterministic argmin the eviction-monitor scenarios
    // are built against, independent of the live flag.
    useHrwRendezvous: false,
  };

  // ── The HTTP server: GET /alive (the heartbeat) + POST (authority RPC). ──
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ alive: true, devicePubkey: cfg.devicePubkey }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const env = JSON.parse(raw) as AuthorityRpcEnvelope;
        const result = await handleAuthorityRpc(env, {
          verifyIsAuthority: async (slug) => (await lockAuthorityFor(slug, deps)).isSelf,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'handler_error', message: String(err) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(cfg.httpPort, cfg.httpHost ?? '0.0.0.0', resolve);
  });

  // ── Presence poll loop: refresh self every tick; poll every other peer's /alive (a
  //    dead peer's poll fails → its lastSeen freezes → φ rises + the witness votes dead). ──
  let stopped = false;
  const pollLoop = (async () => {
    while (!stopped) {
      lastSeenMs.set(cfg.devicePubkey, Date.now());
      await Promise.allSettled(
        others.map(async (peer) => {
          if (await probeAlive(peer.baseUrl, pollTimeoutMs)) lastSeenMs.set(peer.devicePubkey, Date.now());
        }),
      );
      await sleep(heartbeatMs);
    }
  })();

  // ── Authority-resolve loop: keep resolving the authority so the monitor is fed
  //    (beforeSelect → φ + throttled background relay probes), and cache the resolution. ──
  let lastResolution = await lockAuthorityFor(cfg.scope, deps);
  const resolveLoop = (async () => {
    while (!stopped) {
      lastResolution = await lockAuthorityFor(cfg.scope, deps);
      await sleep(heartbeatMs);
    }
  })();

  out({ evt: 'ready', devicePubkey: cfg.devicePubkey, httpPort: cfg.httpPort });

  /** Snapshot the agent's current view for a `state` query. Re-resolves the authority FRESH
   *  (rather than reading the resolve-loop's cached value) so the reported authority is
   *  consistent with the live evicted set — they update on different cadences, and a one-tick
   *  lag would otherwise show the just-evicted authority for a beat. */
  async function snapshot(nonce: string): Promise<void> {
    const res = await lockAuthorityFor(cfg.scope, deps);
    lastResolution = res;
    const nowMs = Date.now();
    const evicted = monitor ? [...monitor.excludedPubkeys(cfg.scope)] : [];
    const presenceAgeMs: Record<string, number> = {};
    for (const r of cfg.roster) presenceAgeMs[r.devicePubkey] = nowMs - (lastSeenMs.get(r.devicePubkey) ?? 0);
    out({
      evt: 'state',
      nonce,
      authorityPubkey: res.isSelf ? cfg.devicePubkey : (res.peer?.devicePubkey ?? null),
      isSelf: res.isSelf,
      liveCount: res.liveCount,
      evicted,
      presenceAgeMs,
      heldPaths: coordinator.heldPaths(),
    });
  }

  /** Route a lock.acquire through the (eviction-aware) authority and report the route taken. */
  async function acquire(nonce: string, path: string): Promise<void> {
    const params: FileLockAcquireParams = {
      owner: cfg.owner,
      ownerLabel: cfg.machineLabel,
      paths: [path],
      intent: `eviction-proof ${cfg.machineLabel}`,
      ttlSec,
      coordinationDomain: cfg.coordinationDomain,
    };
    const route = await routeToAuthority<FileLockAcquireResult>(
      cfg.scope,
      {
        local: () => coordinator.acquire(params),
        remote: {
          kind: FILE_LOCK_OP_KINDS.acquire,
          payload: params,
          decode: (rawResult): FileLockAcquireResult => rawResult as FileLockAcquireResult,
        },
      },
      deps,
    );
    // Re-resolve FRESH for the reported authority (consistent with the route just taken).
    const res = await lockAuthorityFor(cfg.scope, deps);
    out({
      evt: 'acquired',
      nonce,
      path,
      ok: route.value.ok,
      via: route.via,
      authorityPubkey: res.isSelf ? cfg.devicePubkey : (res.peer?.devicePubkey ?? null),
    });
  }

  // ── Command loop over stdin. ──
  const lines = createLineReader();
  for (;;) {
    const line = await lines.next();
    if (line === null || line === 'stop') break;
    const [cmd, nonce, ...rest] = line.split(/\s+/);
    if (cmd === 'state' && nonce) await snapshot(nonce);
    else if (cmd === 'acquire' && nonce && rest[0]) await acquire(nonce, rest[0]);
  }

  stopped = true;
  await Promise.allSettled([pollLoop, resolveLoop]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

/** Minimal async line reader over stdin (mirrors claim-agent.ts). */
function createLineReader(): { next(): Promise<string | null> } {
  let buf = '';
  const queue: string[] = [];
  let resolveWait: ((v: string | null) => void) | null = null;
  let eof = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (resolveWait) {
        resolveWait(line);
        resolveWait = null;
      } else {
        queue.push(line);
      }
    }
  });
  process.stdin.on('end', () => {
    eof = true;
    if (resolveWait) {
      resolveWait(null);
      resolveWait = null;
    }
  });
  return {
    next(): Promise<string | null> {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (eof) return Promise.resolve(null);
      return new Promise((r) => {
        resolveWait = r;
      });
    },
  };
}

void main().catch((e) => {
  out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
