/**
 * loop-agent.ts — ONE Swarm of a shared Hive running the FULL autonomous loop
 * (steer → contend → execute → converge) as a real OS process, for the
 * real-metal full-loop E2E (shared-hive-loop-e2e-testing-2026-06-10 P-008/P-009/P-011,
 * brief-12 runbook §1+§2).
 *
 * It is the composition of the two proven child binaries:
 *
 *   claim-agent.ts  — the per-Hive authority ELECTION + REAL HTTP authority RPC +
 *                     fail-open + in-memory claim store (the dispatch leg);
 *   peer-child.ts   — the REAL hyperbee substrate over Hyperswarm (public DHT on
 *                     metal, testnet locally), re-keyed onto the Hive federation
 *                     topic via `hivePubkey` (the convergence leg).
 *
 * On top of those it adds the loop pieces the hermetic composition rig
 * (`shared-hive-loop/composition-rig.ts`) proved on one box:
 *
 *   steering    — a SCRIPTED Queen turn (stdin `queen {...}`): appends `wi-steer`
 *                 ops to the own log; every Swarm's claim order follows its LOCAL
 *                 projection of the federated steering (the P-001 axis);
 *   execution   — a FAKE pipeline (zero LLM): work-sleep → side-effect marker →
 *                 the D-007 rule-5 heartbeat seam (renewed:false = abort signal)
 *                 → a federated `wi-done` completion record;
 *   chaos knobs — `partition on|off` (injected transport fault → authority RPC
 *                 fail-open; the REAL network cut on metal is nftables, layered
 *                 on top by the test), a configured mid-pipeline STALL (lease
 *                 lapses → peer steals → zombie completes anyway → D-007
 *                 adoption adjudicates), and `revoke <pubkey>` (arms the EI-284
 *                 caller-standing gate on THIS agent's authority ops — a revoked
 *                 swarm's acquire/heartbeat is refused with `caller_revoked`).
 *
 * Launch: `node --import tsx <this file>` with the JSON config in LOOP_AGENT env
 * (spawned by run-full-loop.ts — never run by hand).
 *
 * Wire protocol (ndjson, child stdout → parent):
 *   {evt:'ready', devicePubkey, httpPort, logKey}   — store + authority + substrate up
 *   {evt:'admitted', size}                          — substrate mesh formed (size ≥ meshSize)
 *   {evt:'steer-seen', epoch}                       — steering epoch fully visible locally
 *   {evt:'progress', completed, sweeps}             — claim-loop progress
 *   {evt:'refused', workItemId, reason}             — authority refused on caller standing (EI-284)
 *   {evt:'abort-signal', workItemId, claimId}       — heartbeat returned renewed:false (D-007 rule 5)
 *   {evt:'queen-result', epoch, sawDone, steered}   — scripted Queen turn ran
 *   {evt:'revoked-ack', pubkey, tAuthority}         — revoke armed on this agent's gate
 *   {evt:'state', ...}                              — `dump` response (claims + projection digest)
 *   {evt:'result', ...}                             — claim loop finished; KEEPS serving
 *   {evt:'error', message}                          — fatal; exits 1
 * Parent stdin → child: `go`, `queen <json>`, `revoke <pubkey>`, `partition on|off`,
 * `dump`, `stop`.
 */

import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../../sync/hyperbee/boot';
import { closeHarnessStore } from '../../sync/hyperbee/corestore';
import type { OpEnvelope } from '../../sync/hyperbee/op-envelope-types';
import type { SwarmBinding } from '../../sync/hyperbee/derive-swarm-topic';
import type { HyperswarmLike } from '../../sync/hyperbee/swarm';
import { makePeerIdentity } from '../../sync/hyperbee/perf/fixture';
import { InMemoryWorkItemClaimStore } from '../../work-item-claim-mem-store';
import {
  WORK_ITEM_CLAIM_OP_KINDS,
  type AcquireOpts,
  type AcquireResult,
  type HeartbeatClaimParams,
  type HeartbeatResult,
  type WorkItemClaim,
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
import {
  setPeerRpcTransport,
  PeerUnreachableError,
  type AuthorityRpcRequest,
} from '../../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../../authority/http-peer-rpc-transport';
import type { ClaimRosterEntry } from './claim-agent';

export interface LoopAgentConfig {
  swarmIndex: number;
  /** ELECTION identity (argmin over the roster = the authority). Distinct from the
   *  substrate announce identity, which is a real ed25519 keypair per process. */
  devicePubkey: string;
  githubUserId: number;
  owner: string;
  machineLabel: string;
  workspaceId: string;
  harnessSlug: string;
  potSlug: string;
  /** Raw-32-byte base64 Hive pubkey — the federation TOPIC every Swarm of this run
   *  shares (`deriveHiveFederationTopic`). Fresh per scenario: no DHT crosstalk. */
  hivePubkey: string;
  /** Corestore root for this peer's substrate state (fresh per scenario). */
  root: string;
  /** Local-testnet DHT bootstrap. ABSENT/empty → the PUBLIC DHT (the metal posture). */
  bootstrap?: Array<{ host: string; port: number }>;
  /** The shared backlog in SEED order (the pre-steering fallback priority). */
  backlog: string[];
  roster: ClaimRosterEntry[];
  httpPort: number;
  httpHost?: string;
  /** Substrate mesh gate: emit `admitted` once this many logs are admitted (incl. own).
   *  Default roster.length (full mesh). */
  meshSize?: number;
  ttlSec?: number;
  workMinMs?: number;
  workMaxMs?: number;
  sweepDelayMs?: number;
  maxSweeps?: number;
  deadlineMs?: number;
  rpcTimeoutMs?: number;
  staleMs?: number;
  mergePollMs?: number;
  /** End the loop after this many consecutive no-progress sweeps with items still
   *  pending on live peers. Default 2 (claim-agent parity); the lease-steal scenario
   *  raises it so the stealer keeps retrying until the stalled lease lapses. */
  quietBreakSweeps?: number;
  /** Lease-steal chaos: stall mid-pipeline (after the side-effect marker, before
   *  completion) on the FIRST item granted to this agent, for `ms` — long enough for
   *  the lease to lapse and a peer to steal. The zombie then observes the D-007
   *  rule-5 abort signal at its heartbeat… and completes anyway (deliberately:
   *  the run probes ADOPTION, not well-behaved zombies). */
  stall?: { ms: number };
}

/** One completed item (the claim-agent shape + the loop's steering evidence). */
export interface LoopCompletion {
  workItemId: string;
  claimId: string;
  holderPubkey: string;
  owner: string;
  acquiredTs: string;
  via: 'local-authority' | 'remote-authority' | 'fail-open';
  completedAtMs: number;
  /** Position of this item in the agent's steered claim order at grant time. */
  steerOrderIndex: number;
  /** Steering epoch the agent was claiming under at grant time. */
  steerEpoch: number;
}

export interface LoopAgentResult {
  evt: 'result';
  swarmIndex: number;
  devicePubkey: string;
  owner: string;
  completions: LoopCompletion[];
  stats: {
    sweeps: number;
    localAuthority: number;
    remoteAuthority: number;
    failOpen: number;
    conflicts: number;
    refusedRevoked: number;
  };
  /** External side-effect ledger (the stand-in for git commits/spawns — NOT federated). */
  sideEffects: Array<{ workItemId: string; claimId: string; atMs: number }>;
  refusals: Array<{ workItemId: string; atMs: number; reason: string }>;
  abortSignals: Array<{ workItemId: string; claimId: string }>;
  stalledItem: string | null;
  /** Convergence-lag samples over REMOTE `wi-done` ops (applied-at − sentAt, ms). */
  lag: { count: number; maxMs: number; p95Ms: number };
  /** Distinct items visible as done in the local projection at result time. */
  doneItemsVisible: number;
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deterministic per-item work duration from a string seed (claim-agent parity). */
function workMs(cfg: LoopAgentConfig, item: string): number {
  const lo = cfg.workMinMs ?? 20;
  const hi = cfg.workMaxMs ?? 80;
  if (hi <= lo) return lo;
  let n = 0;
  for (let i = 0; i < item.length; i++) n = (n * 31 + item.charCodeAt(i)) >>> 0;
  return lo + (n % (hi - lo));
}

function p95(samples: number[]): number {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.env.LOOP_AGENT ?? '{}') as LoopAgentConfig;
  if (!cfg.devicePubkey || !Array.isArray(cfg.backlog) || !cfg.hivePubkey) {
    throw new Error('loop-agent: LOOP_AGENT config missing devicePubkey/backlog/hivePubkey');
  }
  const ttlSec = cfg.ttlSec ?? 300;
  const staleMs = cfg.staleMs ?? 10 * 60_000;
  const maxSweeps = cfg.maxSweeps ?? 60;
  const sweepDelayMs = cfg.sweepDelayMs ?? 50;
  const deadlineMs = cfg.deadlineMs ?? 120_000;
  const rpcTimeoutMs = cfg.rpcTimeoutMs ?? 3000;
  const quietBreakSweeps = cfg.quietBreakSweeps ?? 2;
  const meshSize = cfg.meshSize ?? cfg.roster.length;

  // ── 1. Claim store + authority ops, with the EI-284 caller-standing gate armed ──
  // `revoked` is THIS agent's authority-side revoked set, mutated by the `revoke`
  // stdin command. Holder pubkeys here live in the ELECTION domain (the roster
  // pubkeys), the same domain the agents self-report on every claim op — so the
  // gate judges exactly what the wire carries, like the rig's domain bridge.
  const revoked = new Set<string>();
  const store = new InMemoryWorkItemClaimStore();
  registerWorkItemClaimAuthorityOps(store.asCoordinator(), {
    isCallerRevoked: async (holderPubkey) => revoked.has(holderPubkey),
  });

  // ── 2. Authority RPC transport, with the injectable partition fault ──
  // `partition on` makes every REMOTE authority call unreachable (PeerUnreachableError
  // → routeToAuthorityForHive fails open, D-007 hybrid). On metal the test ADDITIONALLY
  // cuts the wire with nftables; this knob is the transport-portable layer.
  let partitioned = false;
  const addrByPubkey = new Map(cfg.roster.map((r) => [r.devicePubkey, r.baseUrl]));
  const httpTransport = new HttpPeerRpcTransport({
    resolveAddress: (peer: PeerRef) => addrByPubkey.get(peer.devicePubkey) ?? null,
    timeoutMs: rpcTimeoutMs,
  });
  setPeerRpcTransport({
    async rpc(peer: PeerRef, req: AuthorityRpcRequest): Promise<unknown> {
      if (partitioned) throw new PeerUnreachableError('partitioned (injected fault)', peer);
      return httpTransport.rpc(peer, req);
    },
  });

  // ── 3. Election deps: injected Hive presence roster (claim-agent parity) ──
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
    // Sibling of the WI-5203 fix (claim-agent.ts, "claim-agent parity" per the
    // comment above) — pin OFF so this agent's election stays the deterministic
    // argmin the loop-agent scenarios are built against, independent of the
    // now-default-ON HRW_RENDEZVOUS_AUTHORITY flag.
    useHrwRendezvous: false,
  };

  // ── 4. The authority HTTP endpoint (claim-agent parity) ──
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

  // ── 5. The substrate: REAL hyperbee over Hyperswarm on the Hive topic ──
  // Projection state (the PG-less stand-in for the rig's real PG projections):
  //   steer: item → {order, epoch} (LWW by epoch, then ts)
  //   done:  item → claimId → completion record
  const steer = new Map<string, { order: number; epoch: number; ts: number }>();
  const done = new Map<string, Map<string, { owner: string; holderPubkey: string }>>();
  const lagSamples: number[] = [];
  let appliedOps = 0;
  const emittedSteerEpochs = new Set<number>();

  const maybeEmitSteerSeen = (): void => {
    // The Queen steers EVERY backlog item per epoch, so epoch e is "fully seen"
    // when every item's steer entry has epoch ≥ e.
    let minEpoch = Infinity;
    for (const item of cfg.backlog) {
      const s = steer.get(item);
      if (!s) return;
      if (s.epoch < minEpoch) minEpoch = s.epoch;
    }
    if (!Number.isFinite(minEpoch)) return;
    for (let e = 1; e <= minEpoch; e++) {
      if (!emittedSteerEpochs.has(e)) {
        emittedSteerEpochs.add(e);
        out({ evt: 'steer-seen', epoch: e });
      }
    }
  };

  // Structural op view: applies to both read-merged OpEnvelopes and own LocalWriteOps.
  type LoopOpView = { type: string; table?: string; hbKey?: string; value?: unknown };
  const projectOp = (op: LoopOpView, remote: boolean): void => {
    if (op.type !== 'put' || !op.hbKey) return;
    if (op.table === 'wi-steer') {
      const v = op.value as { item: string; order: number; epoch: number; ts: number };
      const cur = steer.get(v.item);
      if (!cur || v.epoch > cur.epoch || (v.epoch === cur.epoch && v.ts >= cur.ts)) {
        steer.set(v.item, { order: v.order, epoch: v.epoch, ts: v.ts });
      }
      maybeEmitSteerSeen();
    } else if (op.table === 'wi-done') {
      const v = op.value as {
        item: string;
        claimId: string;
        owner: string;
        holderPubkey: string;
        sentAt: number;
      };
      let byClaim = done.get(v.item);
      if (!byClaim) done.set(v.item, (byClaim = new Map()));
      if (!byClaim.has(v.claimId)) {
        byClaim.set(v.claimId, { owner: v.owner, holderPubkey: v.holderPubkey });
        if (remote && typeof v.sentAt === 'number') lagSamples.push(Date.now() - v.sentAt);
      }
    }
  };

  const identity = makePeerIdentity(`loop-${cfg.swarmIndex}`, 1000 + cfg.swarmIndex);
  const swarm = new Hyperswarm(
    cfg.bootstrap && cfg.bootstrap.length ? { bootstrap: cfg.bootstrap } : {},
  ) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
    keyPair: { publicKey: Buffer };
    joinPeer(publicKey: Buffer): void;
  };

  const binding: SwarmBinding = { kind: 'hive', hive_pubkey: cfg.hivePubkey };
  let handle: BootedHarnessHandle | null = null;
  try {
    handle = await bootHarnessSubstrate({
      workspaceRoot: cfg.root,
      workspaceId: cfg.workspaceId,
      harnessSlug: cfg.harnessSlug,
      swarmBinding: binding,
      swarmOverride: swarm,
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op: OpEnvelope) => {
        appliedOps++;
        projectOp(op, true);
        return true;
      },
      mergePollMs: cfg.mergePollMs ?? 500,
      pendingRetryMs: 1000,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: identity.override,
    });

    /** Append a loop op to the own log AND project it locally (own ops are not
     *  read-merged back — same shape as the rig's local PG write + capture). */
    const appendOp = async (table: 'wi-steer' | 'wi-done', hbKey: string, value: unknown) => {
      const op = {
        type: 'put' as const,
        table,
        hbKey,
        value,
        ts: Date.now(),
        schema_version: 1,
        writerPubkey: identity.devicePubkey,
      };
      await handle!.append(op);
      projectOp(op, false);
    };

    // `swarmKey` = this peer's hyperswarm noise pubkey. Announces ride PER-CONNECTION
    // channels (no gossip), so full-mesh admission needs a DIRECT connection per pair —
    // concurrent topic joins race the DHT announce and can miss each other. The parent
    // collects every swarmKey and sends `peers <hex,…>`; each agent then joinPeer()s
    // the others explicitly (deterministic mesh, identical on testnet + public DHT).
    out({
      evt: 'ready',
      devicePubkey: cfg.devicePubkey,
      httpPort: cfg.httpPort,
      logKey: handle.ownLog.keyHex,
      swarmKey: swarm.keyPair.publicKey.toString('hex'),
    });

    let admittedReported = false;
    const reportAdmitted = () => {
      if (!admittedReported && handle!.admitted.size >= meshSize) {
        admittedReported = true;
        out({ evt: 'admitted', size: handle!.admitted.size });
      }
    };
    const offAdmitted = handle.onAdmitted(reportAdmitted);
    reportAdmitted();

    // ── 6. The loop state ──
    const completions = new Map<string, LoopCompletion>();
    const sideEffects: LoopAgentResult['sideEffects'] = [];
    const refusals: LoopAgentResult['refusals'] = [];
    const abortSignals: LoopAgentResult['abortSignals'] = [];
    let stalledItem: string | null = null;
    const stats = { sweeps: 0, localAuthority: 0, remoteAuthority: 0, failOpen: 0, conflicts: 0, refusedRevoked: 0 };

    /** The steered claim order: federated steering first (order asc), seed order fallback. */
    const orderedBacklog = (): string[] => {
      const seedIndex = new Map(cfg.backlog.map((b, i) => [b, i]));
      return [...cfg.backlog].sort((a, b) => {
        const oa = steer.get(a)?.order ?? 10_000 + seedIndex.get(a)!;
        const ob = steer.get(b)?.order ?? 10_000 + seedIndex.get(b)!;
        return oa - ob;
      });
    };
    const currentSteerEpoch = (): number => {
      let e = 0;
      for (const s of steer.values()) if (s.epoch > e) e = s.epoch;
      return e;
    };

    async function routeAcquire(item: string): Promise<{ via: LoopCompletion['via']; value: AcquireResult }> {
      const opts: AcquireOpts = {
        workspaceId: cfg.workspaceId,
        harnessSlug: cfg.harnessSlug,
        workItemId: item,
        potSlug: cfg.potSlug,
        owner: cfg.owner,
        ownerLabel: cfg.machineLabel,
        holderPubkey: cfg.devicePubkey,
        ttlSec,
        intent: `full-loop ${cfg.machineLabel}`,
      };
      return routeToAuthorityForHive<AcquireResult>(
        cfg.potSlug,
        {
          local: () => store.acquire(opts),
          remote: {
            kind: WORK_ITEM_CLAIM_OP_KINDS.acquire,
            payload: opts,
            decode: (raw): AcquireResult => raw as AcquireResult,
          },
        },
        deps,
      );
    }

    async function routeHeartbeat(item: string, claim: WorkItemClaim): Promise<HeartbeatResult> {
      const p: HeartbeatClaimParams = {
        workspaceId: cfg.workspaceId,
        harnessSlug: cfg.harnessSlug,
        workItemId: item,
        potSlug: cfg.potSlug,
        claimId: claim.claimId,
        owner: cfg.owner,
        holderPubkey: cfg.devicePubkey,
      };
      const route = await routeToAuthorityForHive<HeartbeatResult>(
        cfg.potSlug,
        {
          local: () => store.heartbeat(p),
          remote: {
            kind: WORK_ITEM_CLAIM_OP_KINDS.heartbeat,
            payload: p,
            decode: (raw): HeartbeatResult => raw as HeartbeatResult,
          },
        },
        deps,
      );
      return route.value;
    }

    /** The fake pipeline run for one granted item (work → side effect → D-007
     *  heartbeat seam → federated completion record). */
    async function executeGranted(item: string, via: LoopCompletion['via'], claim: WorkItemClaim): Promise<void> {
      // External side effect FIRST (the stand-in for branch/commits — what a steal
      // duplicates and adoption later marks superseded, D-007 rule 4).
      sideEffects.push({ workItemId: item, claimId: claim.claimId, atMs: Date.now() });

      if (cfg.stall && stalledItem === null) {
        // The zombie leg: stall past the lease TTL mid-pipeline.
        stalledItem = item;
        out({ evt: 'progress', completed: completions.size, sweeps: stats.sweeps, stalledOn: item });
        await sleep(cfg.stall.ms);
        // D-007 rule 5: the heartbeat between side-effecting steps IS the abort
        // signal. This zombie observes it — and completes anyway, deliberately,
        // so the run exercises adoption (rule 2) rather than zombie politeness.
        const hb = await routeHeartbeat(item, claim);
        if (!hb.renewed) {
          abortSignals.push({ workItemId: item, claimId: claim.claimId });
          out({ evt: 'abort-signal', workItemId: item, claimId: claim.claimId });
        }
      } else {
        await sleep(workMs(cfg, item));
      }

      const completedAtMs = Date.now();
      const completion: LoopCompletion = {
        workItemId: item,
        claimId: claim.claimId,
        holderPubkey: claim.holderPubkey ?? cfg.devicePubkey,
        owner: cfg.owner,
        acquiredTs: claim.acquiredTs,
        via,
        completedAtMs,
        steerOrderIndex: orderedBacklog().indexOf(item),
        steerEpoch: currentSteerEpoch(),
      };
      completions.set(item, completion);
      await appendOp('wi-done', `${item}:${claim.claimId}`, {
        item,
        claimId: claim.claimId,
        owner: cfg.owner,
        holderPubkey: claim.holderPubkey ?? cfg.devicePubkey,
        acquiredTs: claim.acquiredTs,
        sentAt: completedAtMs,
      });
      out({ evt: 'progress', completed: completions.size, sweeps: stats.sweeps });
    }

    async function claimOne(item: string): Promise<'mine' | 'held' | 'refused'> {
      const steerOrderIndex = orderedBacklog().indexOf(item);
      const route = await routeAcquire(item);
      if (route.via === 'local-authority') stats.localAuthority++;
      else if (route.via === 'remote-authority') stats.remoteAuthority++;
      else stats.failOpen++;

      if (!route.value.ok) {
        if (route.value.refused === 'caller_revoked') {
          stats.refusedRevoked++;
          refusals.push({ workItemId: item, atMs: Date.now(), reason: route.value.refused });
          out({ evt: 'refused', workItemId: item, reason: route.value.refused });
          return 'refused';
        }
        stats.conflicts++;
        return 'held';
      }
      void steerOrderIndex; // captured fresh inside executeGranted at completion time
      await executeGranted(item, route.via, route.value.claim);
      return 'mine';
    }

    async function runLoop(): Promise<void> {
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
          for (const item of orderedBacklog()) {
            if (completions.has(item)) continue;
            if (done.has(item)) continue; // visible-done via federation — converged away
            const r = await claimOne(item);
            if (r === 'mine') progressed = true;
            else pending = true;
          }
          const allDoneVisible = cfg.backlog.every((i) => completions.has(i) || done.has(i));
          if (allDoneVisible) break;
          if (!progressed) {
            quiet++;
            if (quiet >= quietBreakSweeps && pending) break;
          } else {
            quiet = 0;
          }
          await sleep(sweepDelayMs);
        }
      } finally {
        clearInterval(progressTimer);
      }
    }

    const doneDigest = (): string => {
      const keys: string[] = [];
      for (const [item, byClaim] of done) {
        for (const [claimId, rec] of byClaim) keys.push(`${item}::${claimId}::${rec.owner}`);
      }
      keys.sort();
      return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
    };

    // ── 7. Command loop ──
    // `go` runs the claim loop CONCURRENTLY with this loop: chaos commands
    // (partition / revoke / dump) must take effect MID-RUN, not queue behind it.
    let loopRun: Promise<void> | null = null;
    const lines = createLineReader();
    for (;;) {
      const line = await lines.next();
      if (line === null || line === 'stop') break;

      if (line === 'go') {
        loopRun = (async () => {
          await runLoop();
          const result: LoopAgentResult = {
            evt: 'result',
            swarmIndex: cfg.swarmIndex,
            devicePubkey: cfg.devicePubkey,
            owner: cfg.owner,
            completions: [...completions.values()],
            stats,
            sideEffects,
            refusals,
            abortSignals,
            stalledItem,
            lag: { count: lagSamples.length, maxMs: Math.max(0, ...lagSamples), p95Ms: p95(lagSamples) },
            doneItemsVisible: done.size,
          };
          out(result);
        })().catch((e) => {
          out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
        });
        continue;
      }

      if (line.startsWith('queen ')) {
        // Scripted Queen turn: read the LOCAL projection (what this swarm's Queen
        // actually sees — the steering-monotonicity oracle's input), then steer.
        const turn = JSON.parse(line.slice('queen '.length)) as { epoch: number; order: string[] };
        const sawDone: Record<string, string[]> = {};
        for (const [item, byClaim] of done) {
          sawDone[item] = [...new Set([...byClaim.values()].map((r) => r.owner))].sort();
        }
        for (let i = 0; i < turn.order.length; i++) {
          const item = turn.order[i];
          await appendOp('wi-steer', `${turn.epoch}:${item}`, {
            item,
            order: i,
            epoch: turn.epoch,
            ts: Date.now(),
          });
        }
        out({ evt: 'queen-result', epoch: turn.epoch, sawDone, steered: turn.order.length });
        continue;
      }

      if (line.startsWith('revoke ')) {
        const pk = line.slice('revoke '.length).trim();
        revoked.add(pk);
        out({ evt: 'revoked-ack', pubkey: pk, tAuthority: Date.now() });
        continue;
      }

      if (line.startsWith('peers ')) {
        const ownKey = swarm.keyPair.publicKey.toString('hex');
        for (const hex of line.slice('peers '.length).split(',')) {
          const k = hex.trim();
          if (k && k !== ownKey) {
            try {
              swarm.joinPeer(Buffer.from(k, 'hex'));
            } catch {
              /* a bad key can't block the mesh; topic discovery is the fallback */
            }
          }
        }
        out({ evt: 'peers-ack' });
        continue;
      }

      if (line.startsWith('partition ')) {
        partitioned = line.endsWith('on');
        out({ evt: 'partition-ack', partitioned });
        continue;
      }

      if (line === 'dump' || line.startsWith('dump ')) {
        // `dump <seq>` — the seq is echoed so a POLLING parent can match THIS
        // response (waitFor scans event history; an unsequenced poll would
        // always re-match the first state event).
        const seq = line.startsWith('dump ') ? Number(line.slice('dump '.length)) : 0;
        out({
          evt: 'state',
          seq,
          claims: store.allClaims(),
          doneDigest: doneDigest(),
          doneItems: done.size,
          appliedOps,
          lagCount: lagSamples.length,
        });
        continue;
      }
    }

    // A `stop` while the loop is mid-run: let it finish its current await, then close.
    if (loopRun) await Promise.race([loopRun, sleep(2_000)]);
    offAdmitted();
  } catch (e) {
    out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  } finally {
    try {
      await handle?.close();
      await closeHarnessStore({ workspaceRoot: cfg.root, harnessSlug: cfg.harnessSlug });
    } catch {
      /* ignore */
    }
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      /* ignore */
    }
  }
  process.exit(process.exitCode ?? 0);
}

/** Minimal async line reader over stdin (claim-agent / peer-child parity). */
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
