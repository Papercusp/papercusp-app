/**
 * claim-agent.ts — ONE Swarm of a shared Hive as a real OS process, for the ≥3-Swarm
 * decentralized work-item-claim E2E (decentralized-dispatch-scaling-2026-06-08 P-013).
 *
 * The work-item-claim analog of `sync/hyperbee/perf/peer-child.ts`: the SAME process
 * runs locally (N children on loopback — the $0 parity path) and on a real Hetzner bench
 * frame over SSH (the paid cross-machine run), driven over the same ndjson stdin/stdout
 * line protocol. It exercises the REAL decentralized-claim machinery end to end:
 *
 *   - the per-Hive lock authority ELECTION (`lockAuthorityForHive`, argmin device_pubkey
 *     over the Hive's Swarms — injected presence roster, like the two-instance test);
 *   - the authority RPC over the REAL `HttpPeerRpcTransport` → POST /api/authority/rpc →
 *     `handleAuthorityRpc` (this agent serves that endpoint for ops routed to it when it
 *     is the elected authority);
 *   - FAIL-OPEN when the authority is unreachable (it was killed mid-run) → a local
 *     advisory lease (D-007 hybrid);
 *   - the deterministic RECONCILE (`reconcileAll`, computed by the orchestrator over every
 *     agent's reported claims) that resolves the tolerated double-claims to one winner.
 *
 * The ONLY non-production leg is the claim STORE: a bench frame is PG-less, so the store
 * is `InMemoryWorkItemClaimStore` bound through the documented `WorkItemClaimCoordinator`
 * seam. Its lease semantics are proven identical to the SQL store by
 * `work-item-claim-mem-store.integration.test.ts`, and the SQL store's authority-fronted
 * serialization is proven on real PG by `work-item-claims-two-instance.integration.test.ts`
 * — so swapping the persistence leg loses no coverage while letting the agent run anywhere
 * with zero per-frame PG provisioning.
 *
 * Launch: `node --import tsx <this file>` with the JSON config in CLAIM_AGENT env
 * (spawned by run-claim-dispatch.ts — never run by hand).
 *
 * Wire protocol (ndjson, child stdout → parent):
 *   {evt:'ready', devicePubkey, httpPort}          — store + authority op + HTTP server up
 *   {evt:'progress', completed, sweeps}            — 1Hz claim-loop progress
 *   {evt:'result', completions, stats}             — loop finished; KEEPS serving authority RPC
 *   {evt:'error', message}                         — fatal; exits 1
 * Parent stdin → child: `go` (start the claim loop) and `stop` (shut the HTTP server + exit).
 */

import { createServer, type Server } from 'node:http';
import { InMemoryWorkItemClaimStore } from '../../work-item-claim-mem-store';
import {
  WORK_ITEM_CLAIM_OP_KINDS,
  type AcquireOpts,
  type AcquireResult,
} from '../../work-item-claims';
import { registerWorkItemClaimAuthorityOps } from '../../work-item-claim-authority-ops';
import {
  handleAuthorityRpc,
  type AuthorityRpcEnvelope,
} from '../../authority/authority-op-registry';
import {
  routeToAuthorityForHive,
  lockAuthorityForHive,
  type LockAuthorityDeps,
  type PeerRef,
} from '../../authority/lock-authority';
import { setPeerRpcTransport } from '../../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../../authority/http-peer-rpc-transport';

/** One Swarm in the roster — its election identity + where to reach its authority endpoint. */
export interface ClaimRosterEntry {
  devicePubkey: string;
  githubUserId: number;
  machineLabel: string;
  /** Base URL of this Swarm's HTTP authority endpoint (e.g. http://1.2.3.4:4790). */
  baseUrl: string;
}

export interface ClaimAgentConfig {
  swarmIndex: number;
  devicePubkey: string;
  githubUserId: number;
  owner: string;
  machineLabel: string;
  workspaceId: string;
  harnessSlug: string;
  potSlug: string;
  /** The shared backlog: work-item ids every Swarm contends to claim+complete. */
  backlog: string[];
  /** Every Swarm (including self) — the injected Hive presence + the RPC address book. */
  roster: ClaimRosterEntry[];
  /** This agent's authority HTTP server. Bind 0.0.0.0 on a frame, 127.0.0.1 locally. */
  httpPort: number;
  httpHost?: string;
  /** Claim lease TTL — long enough that a completed item stays held for the whole run
   *  (so authority-alive runs are exactly-once; lapse is not the contention source here). */
  ttlSec?: number;
  /** Simulated per-item work (ms). */
  workMinMs?: number;
  workMaxMs?: number;
  /** Delay between backlog sweeps (ms). */
  sweepDelayMs?: number;
  /** Hard caps so the loop always terminates. */
  maxSweeps?: number;
  deadlineMs?: number;
  /** Authority RPC per-call timeout (ms) — short so a killed authority fails open fast. */
  rpcTimeoutMs?: number;
  /** Presence staleness window (ms). Default large so the injected roster stays live. */
  staleMs?: number;
}

/** One completed item — carries every field an AdvisoryClaim needs, plus the route taken. */
export interface ClaimCompletion {
  workItemId: string;
  claimId: string;
  holderPubkey: string;
  owner: string;
  acquiredTs: string;
  /** How the grant was obtained — proves whether the authority served it or we failed open. */
  via: 'local-authority' | 'remote-authority' | 'fail-open';
  completedAtMs: number;
}

export interface ClaimAgentResult {
  evt: 'result';
  swarmIndex: number;
  devicePubkey: string;
  owner: string;
  completions: ClaimCompletion[];
  stats: {
    sweeps: number;
    localAuthority: number;
    remoteAuthority: number;
    failOpen: number;
    conflicts: number;
  };
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deterministic-ish per-item work duration from a string seed (no Math.random — stable). */
function workMs(cfg: ClaimAgentConfig, item: string): number {
  const lo = cfg.workMinMs ?? 20;
  const hi = cfg.workMaxMs ?? 80;
  if (hi <= lo) return lo;
  let n = 0;
  for (let i = 0; i < item.length; i++) n = (n * 31 + item.charCodeAt(i)) >>> 0;
  return lo + (n % (hi - lo));
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.env.CLAIM_AGENT ?? '{}') as ClaimAgentConfig;
  if (!cfg.devicePubkey || !Array.isArray(cfg.backlog)) {
    throw new Error('claim-agent: CLAIM_AGENT config missing devicePubkey/backlog');
  }
  const ttlSec = cfg.ttlSec ?? 300; // outlasts the run → a completed item stays held
  const staleMs = cfg.staleMs ?? 10 * 60_000;
  const maxSweeps = cfg.maxSweeps ?? 30;
  const sweepDelayMs = cfg.sweepDelayMs ?? 50;
  const deadlineMs = cfg.deadlineMs ?? 120_000;
  const rpcTimeoutMs = cfg.rpcTimeoutMs ?? 3000;

  // 1. This Swarm's own claim store + the authority op handlers bound to it (so ops
  //    routed HERE when we are the elected authority run against OUR store).
  const store = new InMemoryWorkItemClaimStore();
  registerWorkItemClaimAuthorityOps(store.asCoordinator());

  // 2. The real HTTP authority transport, addressing peers by pubkey via the roster.
  const addrByPubkey = new Map(cfg.roster.map((r) => [r.devicePubkey, r.baseUrl]));
  setPeerRpcTransport(
    new HttpPeerRpcTransport({
      resolveAddress: (peer: PeerRef) => addrByPubkey.get(peer.devicePubkey) ?? null,
      timeoutMs: rpcTimeoutMs,
    }),
  );

  // 3. The injected Hive presence roster + self identity (authority = argmin pubkey).
  //    Presence is INJECTED exactly like work-item-claims-two-instance.integration.test.ts:
  //    this proves the claim/kill/reconcile dynamics; the live presence-federation publisher
  //    is proven separately. A killed Swarm stays in the roster → survivors keep electing it
  //    → its RPC is unreachable → fail-open (the designed kill→fail-open path, not failover).
  const deps: LockAuthorityDeps = {
    now: Date.now,
    staleMs,
    resolveSelf: async () => ({ githubUserId: cfg.githubUserId, devicePubkey: cfg.devicePubkey }),
    fetchHivePresenceRows: async () =>
      cfg.roster.map((r) => ({
        device_pubkey: r.devicePubkey,
        github_user_id: r.githubUserId,
        machine_label: r.machineLabel,
        last_seen_ms: Date.now(),
      })),
    // WI-5203 (same class as WI-5190/WI-5192): HRW_RENDEZVOUS_AUTHORITY graduated
    // to default-ON 2026-07-17. This agent runs as a REAL separate OS process (not
    // an in-process mock), so left unpinned it reads the LIVE flag and silently
    // swaps the deterministic argmin election this whole harness is documented and
    // built around ("authority = argmin pubkey", line 171) for the hash-based
    // selectAuthorityRendezvous — breaking the "survivors keep electing the killed
    // Swarm → fail-open" invariant the KILL-AUTHORITY scenario depends on. Pin OFF
    // so this proves the argmin/RPC/fail-open/reconcile mechanics the docstring
    // describes; the hash algorithm itself has its own dedicated test suite.
    useHrwRendezvous: false,
  };

  // 4. The authority HTTP endpoint (the production /api/authority/rpc, served minimally).
  //    verifyIsAuthority re-checks we are the elected authority before serializing an op,
  //    exactly as the security note in authority-op-registry.ts requires.
  const server: Server = createServer((req, res) => {
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
          verifyIsAuthority: async (slug) => (await lockAuthorityForHive(slug, deps)).isSelf,
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

  out({ evt: 'ready', devicePubkey: cfg.devicePubkey, httpPort: cfg.httpPort });

  const completions = new Map<string, ClaimCompletion>();
  const stats = { sweeps: 0, localAuthority: 0, remoteAuthority: 0, failOpen: 0, conflicts: 0 };

  /** Attempt to claim ONE item through the Hive authority; on a grant, "work" it + record. */
  async function claimOne(item: string): Promise<'mine' | 'held'> {
    const opts: AcquireOpts = {
      workspaceId: cfg.workspaceId,
      harnessSlug: cfg.harnessSlug,
      workItemId: item,
      potSlug: cfg.potSlug,
      owner: cfg.owner,
      ownerLabel: cfg.machineLabel,
      holderPubkey: cfg.devicePubkey,
      ttlSec,
      intent: `claim-dispatch ${cfg.machineLabel}`,
    };
    const route = await routeToAuthorityForHive<AcquireResult>(
      cfg.potSlug,
      {
        local: () => store.acquire(opts),
        remote: {
          kind: WORK_ITEM_CLAIM_OP_KINDS.acquire,
          payload: opts,
          decode: (rawResult): AcquireResult => rawResult as AcquireResult,
        },
      },
      deps,
    );
    if (route.via === 'local-authority') stats.localAuthority++;
    else if (route.via === 'remote-authority') stats.remoteAuthority++;
    else stats.failOpen++;

    if (!route.value.ok) {
      stats.conflicts++;
      return 'held';
    }
    // Granted — simulate the work turn, then record the completion (hold the lease;
    // the long TTL keeps a completed item held for the rest of the run).
    await sleep(workMs(cfg, item));
    const claim = route.value.claim;
    completions.set(item, {
      workItemId: item,
      claimId: claim.claimId,
      holderPubkey: claim.holderPubkey ?? cfg.devicePubkey,
      owner: cfg.owner,
      acquiredTs: claim.acquiredTs,
      via: route.via,
      completedAtMs: Date.now(),
    });
    // Emit progress on every completion so the orchestrator can trigger the authority-kill
    // the instant work distribution is established (robust vs a fixed wall-clock delay).
    out({ evt: 'progress', completed: completions.size, sweeps: stats.sweeps });
    return 'mine';
  }

  async function runClaimLoop(): Promise<void> {
    const t0 = Date.now();
    let quiet = 0;
    const progressTimer = setInterval(
      () => out({ evt: 'progress', completed: completions.size, sweeps: stats.sweeps }),
      1000,
    );
    progressTimer.unref();
    try {
      for (;;) {
        if (Date.now() - t0 >= deadlineMs) break;
        if (stats.sweeps >= maxSweeps) break;
        stats.sweeps++;
        let progressed = false;
        let pending = false;
        for (const item of cfg.backlog) {
          if (completions.has(item)) continue;
          const r = await claimOne(item);
          if (r === 'mine') progressed = true;
          else pending = true; // held by a (still-live) peer — retry next sweep
        }
        // Done when we have completed every backlog item ourselves.
        if (completions.size >= cfg.backlog.length) break;
        // Stable: remaining items are held by LIVE peers and no progress is being made
        // (the authority is alive and serializing — the exactly-once steady state).
        if (!progressed) {
          quiet++;
          if (quiet >= 2 && pending) break;
        } else {
          quiet = 0;
        }
        await sleep(sweepDelayMs);
      }
    } finally {
      clearInterval(progressTimer);
    }
  }

  // Command loop over stdin: `go` runs the claim loop then emits `result` (but KEEPS the
  // HTTP server up so it can still serve authority RPCs for peers still working); `stop`
  // shuts down + exits.
  const lines = createLineReader();
  for (;;) {
    const line = await lines.next();
    if (line === null || line === 'stop') break;
    if (line === 'go') {
      await runClaimLoop();
      const result: ClaimAgentResult = {
        evt: 'result',
        swarmIndex: cfg.swarmIndex,
        devicePubkey: cfg.devicePubkey,
        owner: cfg.owner,
        completions: [...completions.values()],
        stats,
      };
      out(result);
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

/** Minimal async line reader over stdin (mirrors peer-child.ts). */
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
