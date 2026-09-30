/**
 * run-full-loop.ts — the full-autonomous-loop E2E orchestrator
 * (shared-pot-loop-e2e-testing-2026-06-10 P-008/P-009/P-011, brief-12 §1+§2),
 * the loop analog of run-claim-dispatch.ts.
 *
 * Transport-agnostic over a `LoopLauncher` (local children + testnet DHT, or real
 * Hetzner frames + the PUBLIC DHT), so the SAME scenarios run $0 on loopback and
 * paid across machines. One run = one full loop cycle plus an optional chaos
 * injection:
 *
 *   1. launch every Swarm; gate on substrate full-mesh (every log admitted everywhere);
 *   2. SCRIPTED Queen turn 1 on the queen Swarm (steering ops federate over the
 *      substrate); gate on every Swarm seeing epoch 1 (steering rides the wire);
 *   3. `go` — every Swarm claims off the shared backlog IN ITS LOCAL STEERED ORDER
 *      through the per-Hive authority, runs the fake pipeline, federates `wi-done`;
 *   4. chaos (per scenario): partition a bee from the authority / kill the authority
 *      Swarm / let a configured mid-pipeline stall lapse the lease (steal + D-007
 *      adoption) / revoke a bee at the authority (the EI-284 caller-standing gate);
 *   5. wait for CONVERGENCE: every live Swarm's `wi-done` projection digest equal +
 *      whole backlog visible-done everywhere; measure arrival lag;
 *   6. Queen turn 2: the queen's LOCAL projection must show the remote Swarms'
 *      completions (steering monotonicity);
 *   7. reconcile + adoption + the structured verdict. No assertions here — the
 *      test asserts on the verdict (run-claim-dispatch parity).
 */

import { randomBytes } from 'node:crypto';
import {
  reconcileAll,
  type AdvisoryClaim,
  type ClaimResolution,
} from '../../work-item-claim-reconcile';
import {
  adoptAll,
  type AdoptionVerdict,
  type CompletionRecord,
} from '../../shared-pot-loop/lease-steal-semantics';
import type { WorkItemClaim } from '../../work-item-claims';
import type { ClaimRosterEntry } from './claim-agent';
import type { LoopAgentConfig, LoopAgentResult, LoopCompletion } from './loop-agent';
import type { ClaimAgentEvent } from './claim-launcher';
import type { LoopLauncher } from './loop-launcher';

export type LoopScenario =
  | { kind: 'happy' }
  | {
      kind: 'partition';
      /** The bee to cut off from the authority mid-run. */
      targetIndex: number;
      /** Heal this long after the cut engages. */
      healAfterMs: number;
      /** Override the cut/heal mechanics (metal: a REAL nftables drop). Default:
       *  the agent's injected transport fault via stdin `partition on|off`. */
      engage?: () => Promise<void>;
      heal?: () => Promise<void>;
    }
  | { kind: 'kill-authority'; killSettleMs?: number }
  | {
      kind: 'lease-steal';
      /** The Swarm configured to stall mid-pipeline on its first granted item. */
      stallIndex: number;
      stallMs: number;
      ttlSec: number;
    }
  | { kind: 'revoke'; revokeIndex: number };

export interface RunFullLoopOpts {
  launcher: LoopLauncher;
  scenario: LoopScenario;
  potSlug?: string;
  workspaceId?: string;
  harnessSlug?: string;
  backlogSize?: number;
  /** Which Swarm hosts the scripted Queen. Default 1 — NOT the authority (slot 0),
   *  so killing the authority never kills the Queen (the P-003 metal shape). */
  queenIndex?: number;
  /** Local-testnet DHT bootstrap for every agent. Absent → the PUBLIC DHT. */
  bootstrap?: Array<{ host: string; port: number }>;
  ttlSec?: number;
  workMinMs?: number;
  workMaxMs?: number;
  sweepDelayMs?: number;
  maxSweeps?: number;
  agentDeadlineMs?: number;
  rpcTimeoutMs?: number;
  mergePollMs?: number;
  readyTimeoutMs?: number;
  meshTimeoutMs?: number;
  steerTimeoutMs?: number;
  resultTimeoutMs?: number;
  convergenceTimeoutMs?: number;
  log?: (line: string) => void;
}

/** Snapshot of one agent's `dump` response. */
interface AgentDump {
  claims: WorkItemClaim[];
  doneDigest: string;
  doneItems: number;
  appliedOps: number;
}

export interface FullLoopVerdict {
  scenario: LoopScenario['kind'];
  swarmCount: number;
  backlog: string[];
  killedAuthority: { swarmIndex: number; devicePubkey: string } | null;
  results: LoopAgentResult[];
  reconciliations: ClaimResolution[];
  completedItems: string[];
  starvedItems: string[];
  rawDoubleClaimed: string[];
  doubleCompletedAfterReconcile: string[];
  determinismHolds: boolean;
  failOpenObserved: boolean;
  exactlyOnceObserved: boolean;
  routeStats: {
    localAuthority: number;
    remoteAuthority: number;
    failOpen: number;
    conflicts: number;
    refusedRevoked: number;
  };
  steering: {
    /** Every Swarm saw the Queen's epoch-1 steering before dispatch started. */
    epoch1SeenByAll: boolean;
    /** Per-Swarm: its grant sequence was monotone in the steered order (asserted
     *  in the happy path only — chaos legs legitimately backfill). */
    claimsFollowedSteering: boolean[];
    /** Queen turn 2 saw every completion by a NON-queen Swarm (the monotonicity
     *  oracle: A's next Queen turn reflects B's work). */
    queenSawAllRemoteCompletions: boolean;
    queenMissedItems: string[];
  };
  convergence: {
    digestsEqual: boolean;
    doneVisibleEverywhere: boolean;
    fixpointAfterMs: number;
    lagMaxMs: number;
    lagP95Ms: number;
    lagCount: number;
  };
  /** Lease-steal scenario (D-007): the adjudication over the stalled item. */
  adoption: {
    stalledItem: string | null;
    verdicts: AdoptionVerdict[];
    stalledItemRule: AdoptionVerdict['rule'] | null;
    adoptedOwner: string | null;
    zombieOwner: string | null;
    zombieAbortSignaled: boolean;
    sideEffectsDuplicated: boolean;
  } | null;
  /** Revoke scenario (EI-284): the caller-standing gate over real RPC. */
  revoke: {
    revokedPubkey: string;
    /** Authority-clock ms at which the gate armed. */
    tAuthorityMs: number;
    refusedCount: number;
    /** Claims in the authority's final store granted to the revoked pubkey AFTER
     *  the gate armed — MUST be empty (no post-revocation grants). */
    postRevocationGrants: string[];
    /** Completions by the revoked Swarm acquired after the gate armed — MUST be empty. */
    postRevocationCompletions: string[];
  } | null;
}

/** Deterministic election pubkey: slot 0 sorts lowest → slot 0 is the authority. */
function pubkeyFor(index: number): string {
  return `${String(index).padStart(4, '0')}-swarm-full-loop-device-pubkey`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runFullLoop(opts: RunFullLoopOpts): Promise<FullLoopVerdict> {
  const log = opts.log ?? (() => {});
  const slots = opts.launcher.slots;
  const swarmCount = slots.length;
  if (swarmCount < 3) throw new Error(`runFullLoop: need ≥3 Swarms, have ${swarmCount}`);
  const queenIndex = opts.queenIndex ?? 1;
  const scenario = opts.scenario;

  const potSlug = opts.potSlug ?? 'full-loop-hive';
  // Synthetic ≥3-Swarm full-loop E2E test-rig scope (siblings 'full-loop-hive' /
  // 'full-loop-h1') — a self-contained steer→contend→execute→converge scenario over loopback
  // / ephemeral Hetzner frames that never reads or writes real workspace data, a local default.
  // allow-scope-default: E2E test-rig local scope, never real workspace data (D-003).
  const workspaceId = opts.workspaceId ?? 'default';
  const harnessSlug = opts.harnessSlug ?? 'full-loop-h1';
  const backlogSize = opts.backlogSize ?? 12;
  const backlog = Array.from({ length: backlogSize }, (_, i) => `F-${String(i + 1).padStart(3, '0')}`);
  // Fresh Hive pubkey per run = fresh federation topic — zero DHT crosstalk between
  // scenarios (or with anything else on the public DHT).
  const hivePubkey = randomBytes(32).toString('base64');

  // WI-5185: 5 chaos scenarios in this file each cold-spawn 3 fresh `tsx`
  // processes sequentially — under real shared-fleet CPU contention, one of
  // those ~15 per-file spawns occasionally needed noticeably longer than 60s
  // to reach 'ready' (confirmed via 2 reproductions: a DIFFERENT scenario/
  // Swarm index missed the deadline each time, never the same one — a boot-
  // time-variance signature, not a stuck/deterministic failure; every
  // scenario that DID become ready in time then passed its assertions
  // cleanly, ruling out a logic regression). 60s was tight relative to this
  // file's own sibling budgets (meshTimeoutMs 90s, convergenceTimeoutMs 90s)
  // for a step with zero application work yet (spawn + DHT bootstrap only) —
  // widen to match them rather than tolerate a bound that's already tighter
  // than its neighbors for no documented reason.
  const readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
  const meshTimeoutMs = opts.meshTimeoutMs ?? 90_000;
  const steerTimeoutMs = opts.steerTimeoutMs ?? 60_000;
  const resultTimeoutMs = opts.resultTimeoutMs ?? 180_000;
  const convergenceTimeoutMs = opts.convergenceTimeoutMs ?? 90_000;

  const roster: ClaimRosterEntry[] = slots.map((s, i) => ({
    devicePubkey: pubkeyFor(i),
    githubUserId: i + 1,
    machineLabel: s.label,
    baseUrl: `http://${s.host}:${s.httpPort}`,
  }));

  const ttlSec = scenario.kind === 'lease-steal' ? scenario.ttlSec : opts.ttlSec ?? 300;
  const quietBreakSweeps = scenario.kind === 'lease-steal' || scenario.kind === 'kill-authority' ? 1000 : 2;

  // 1. Launch every agent.
  const handles = slots.map((slot, i) => {
    const cfg: LoopAgentConfig = {
      swarmIndex: i,
      devicePubkey: roster[i].devicePubkey,
      githubUserId: roster[i].githubUserId,
      owner: `swarm-${i}-${slot.label}`,
      machineLabel: slot.label,
      workspaceId,
      harnessSlug,
      potSlug,
      hivePubkey,
      root: slot.root,
      ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
      backlog,
      roster,
      httpPort: slot.httpPort,
      httpHost: slot.bindHost,
      meshSize: swarmCount,
      ttlSec,
      quietBreakSweeps,
      ...(opts.workMinMs != null ? { workMinMs: opts.workMinMs } : {}),
      ...(opts.workMaxMs != null ? { workMaxMs: opts.workMaxMs } : {}),
      ...(opts.sweepDelayMs != null ? { sweepDelayMs: opts.sweepDelayMs } : {}),
      ...(opts.maxSweeps != null ? { maxSweeps: opts.maxSweeps } : {}),
      ...(opts.agentDeadlineMs != null ? { deadlineMs: opts.agentDeadlineMs } : {}),
      ...(opts.rpcTimeoutMs != null ? { rpcTimeoutMs: opts.rpcTimeoutMs } : {}),
      ...(opts.mergePollMs != null ? { mergePollMs: opts.mergePollMs } : {}),
      ...(scenario.kind === 'lease-steal' && scenario.stallIndex === i
        ? { stall: { ms: scenario.stallMs } }
        : {}),
    };
    return slot.launch(cfg);
  });

  // 2. Ready + full substrate mesh.
  const readys = await Promise.all(handles.map((h) => h.waitFor('ready', readyTimeoutMs)));
  const notReady = readys.map((r, i) => (r ? null : i)).filter((i): i is number => i !== null);
  if (notReady.length) {
    // WI-5185: waitFor resolves null on EITHER a genuine timeout OR the child
    // process closing early (e.g. an uncaught bind/bootstrap failure — main()'s
    // top-level catch in loop-agent.ts emits a structured {evt:'error',message}
    // line before process.exit(1)). Surface that line when present so a future
    // "never became ready" failure carries its real cause instead of forcing
    // another blind re-run/instrumentation pass to find out why.
    const detail = notReady
      .map((i) => {
        const errEvt = handles[i].events.find((e) => e.evt === 'error') as { message?: string } | undefined;
        return `${i}${errEvt?.message ? ` (${errEvt.message})` : ' (no error event — likely a genuine timeout)'}`;
      })
      .join(', ');
    throw new Error(`runFullLoop: Swarm(s) ${detail} never became ready`);
  }
  log(`all ${swarmCount} Swarms ready; hive topic ${hivePubkey.slice(0, 12)}…`);

  // Deterministic mesh: announces are PER-CONNECTION (no gossip), so distribute every
  // peer's swarm key and have each agent joinPeer() the others explicitly — concurrent
  // topic joins otherwise race the DHT announce and stall the pairwise mesh.
  const swarmKeys = readys.map((r) => String((r as { swarmKey?: unknown }).swarmKey ?? ''));
  const peersLine = `peers ${swarmKeys.filter(Boolean).join(',')}`;
  for (const h of handles) h.send(peersLine);

  const admits = await Promise.all(handles.map((h) => h.waitFor('admitted', meshTimeoutMs)));
  const notMeshed = admits.map((r, i) => (r ? null : i)).filter((i): i is number => i !== null);
  if (notMeshed.length) throw new Error(`runFullLoop: Swarm(s) ${notMeshed.join(',')} never reached full mesh`);
  log(`substrate full mesh formed (${swarmCount} logs admitted everywhere)`);

  // 3. Queen turn 1: reprioritize = REVERSE the seed order (deterministic, observable).
  const steeredOrder = [...backlog].reverse();
  handles[queenIndex].send(`queen ${JSON.stringify({ epoch: 1, order: steeredOrder })}`);
  const turn1 = await handles[queenIndex].waitFor(
    (e) => e.evt === 'queen-result' && Number(e.epoch) === 1,
    steerTimeoutMs,
  );
  if (!turn1) throw new Error('runFullLoop: Mug turn 1 never completed');

  const steerSeen = await Promise.all(
    handles.map((h) => h.waitFor((e) => e.evt === 'steer-seen' && Number(e.epoch) >= 1, steerTimeoutMs)),
  );
  const epoch1SeenByAll = steerSeen.every(Boolean);
  if (!epoch1SeenByAll) {
    const missing = steerSeen.map((r, i) => (r ? null : i)).filter((i) => i !== null);
    throw new Error(`runFullLoop: steering epoch 1 never federated to Swarm(s) ${missing.join(',')}`);
  }
  log(`Mug turn 1 steered ${steeredOrder.length} items; epoch 1 visible on every Swarm`);

  // 4. Go.
  const t0 = Date.now();
  for (const h of handles) h.send('go');

  // 5. Chaos.
  let killedAuthority: FullLoopVerdict['killedAuthority'] = null;
  let revokeInfo: { revokedPubkey: string; tAuthorityMs: number } | null = null;

  if (scenario.kind === 'partition') {
    // Wait until work is genuinely in flight (≥2 completions somewhere), then cut.
    const gate = await Promise.race(
      handles.map((h) => h.waitFor((e) => e.evt === 'progress' && Number(e.completed) >= 2, 20_000)),
    );
    if (!gate) log('partition progress gate not seen in 20s — cutting anyway');
    const target = handles[scenario.targetIndex];
    if (scenario.engage) await scenario.engage();
    else {
      target.send('partition on');
      await target.waitFor((e) => e.evt === 'partition-ack' && e.partitioned === true, 10_000);
    }
    log(`partitioned Swarm ${scenario.targetIndex} from the authority`);
    await sleep(scenario.healAfterMs);
    if (scenario.heal) await scenario.heal();
    else {
      target.send('partition off');
      await target.waitFor((e) => e.evt === 'partition-ack' && e.partitioned === false, 10_000);
    }
    log(`healed Swarm ${scenario.targetIndex}`);
  } else if (scenario.kind === 'kill-authority') {
    const gate = await handles[0].waitFor((e) => e.evt === 'progress' && Number(e.completed) >= 1, 20_000);
    if (!gate) log('authority progress gate not seen in 20s — killing on the cap');
    await sleep(scenario.killSettleMs ?? 300);
    log(`killing authority Swarm 0 (${roster[0].devicePubkey.slice(0, 12)}…) mid-run`);
    await slots[0].kill();
    killedAuthority = { swarmIndex: 0, devicePubkey: roster[0].devicePubkey };
  } else if (scenario.kind === 'revoke') {
    // Let the target complete ≥1 item legitimately, then arm the gate at the authority.
    const gate = await handles[scenario.revokeIndex].waitFor(
      (e) => e.evt === 'progress' && Number(e.completed) >= 1,
      30_000,
    );
    if (!gate) log('revoke progress gate not seen in 30s — revoking anyway');
    const pk = roster[scenario.revokeIndex].devicePubkey;
    handles[0].send(`revoke ${pk}`);
    const ack = await handles[0].waitFor((e) => e.evt === 'revoked-ack' && e.pubkey === pk, 10_000);
    if (!ack) throw new Error('runFullLoop: authority never acked the revoke');
    revokeInfo = { revokedPubkey: pk, tAuthorityMs: Number(ack.tAuthority) };
    log(`revoked Swarm ${scenario.revokeIndex} (${pk.slice(0, 12)}…) at the authority`);
  }

  // 6. Collect results from the surviving Swarms.
  const liveIdx = handles.map((_, i) => i).filter((i) => !(killedAuthority && i === killedAuthority.swarmIndex));
  const collected = await Promise.all(liveIdx.map((i) => handles[i].waitFor('result', resultTimeoutMs)));
  const results: LoopAgentResult[] = collected
    .filter((e): e is NonNullable<typeof e> => !!e && e.evt === 'result')
    .map((e) => e as unknown as LoopAgentResult);
  if (results.length !== liveIdx.length) {
    throw new Error(`runFullLoop: only ${results.length}/${liveIdx.length} surviving Swarms reported results`);
  }
  log(`${results.length} Swarms reported; total completions ${results.reduce((n, r) => n + r.completions.length, 0)}`);

  // 7. Convergence: every live Swarm's projection digest equal + whole backlog done.
  const convergence = await waitForConvergence({
    handles: liveIdx.map((i) => handles[i]),
    backlogSize,
    timeoutMs: convergenceTimeoutMs,
    log,
  });
  const fixpointAfterMs = Date.now() - t0;

  // 8. Queen turn 2 (steering monotonicity): what does the Queen NOW see?
  handles[queenIndex].send(`queen ${JSON.stringify({ epoch: 2, order: [] })}`);
  const turn2 = await handles[queenIndex].waitFor(
    (e) => e.evt === 'queen-result' && Number(e.epoch) === 2,
    steerTimeoutMs,
  );
  if (!turn2) throw new Error('runFullLoop: Mug turn 2 never completed');

  // 9. Final authority store dump (adoption's lease-current lookup). Dead authority →
  //    no lease-current view → adoption falls back to the total order (D-007 rule 3).
  let authorityClaims: WorkItemClaim[] = [];
  if (!killedAuthority) {
    const finalSeq = 9_999_999;
    handles[0].send(`dump ${finalSeq}`);
    const st = await handles[0].waitFor((e) => e.evt === 'state' && Number(e.seq) === finalSeq, 15_000);
    if (st) authorityClaims = (st as unknown as { claims: WorkItemClaim[] }).claims;
  }

  await opts.launcher.cleanup();

  return computeFullLoopVerdict({
    scenario,
    swarmCount,
    backlog,
    queenOwner: `swarm-${queenIndex}-${slots[queenIndex].label}`,
    killedAuthority,
    results,
    queenTurn2SawDone: (turn2 as unknown as { sawDone: Record<string, string[]> }).sawDone,
    epoch1SeenByAll,
    authorityClaims,
    convergence: { ...convergence, fixpointAfterMs },
    revokeInfo,
  });
}

async function waitForConvergence(args: {
  handles: Array<{ send(line: string): void; waitFor(m: (e: ClaimAgentEvent) => boolean, t: number): Promise<ClaimAgentEvent | null> }>;
  backlogSize: number;
  timeoutMs: number;
  log: (line: string) => void;
}): Promise<{ digestsEqual: boolean; doneVisibleEverywhere: boolean }> {
  const t0 = Date.now();
  let lastDumps: AgentDump[] = [];
  // Sequenced polls: waitFor scans event HISTORY, so each poll must match its own
  // seq-stamped response (loop-agent echoes the seq).
  let seq = Math.floor(t0 % 1_000_000);
  while (Date.now() - t0 < args.timeoutMs) {
    seq++;
    const thisSeq = seq;
    const dumps = await Promise.all(
      args.handles.map(async (h) => {
        h.send(`dump ${thisSeq}`);
        const st = await h.waitFor((e) => e.evt === 'state' && Number(e.seq) === thisSeq, 10_000);
        return st ? (st as unknown as AgentDump) : null;
      }),
    );
    const ok = dumps.every((d): d is AgentDump => !!d);
    if (ok) {
      lastDumps = dumps as AgentDump[];
      const digests = new Set(lastDumps.map((d) => d.doneDigest));
      const allDone = lastDumps.every((d) => d.doneItems >= args.backlogSize);
      if (digests.size === 1 && allDone) {
        return { digestsEqual: true, doneVisibleEverywhere: true };
      }
    }
    await sleep(1000);
  }
  args.log(
    `convergence timeout: digests=${lastDumps.map((d) => d?.doneDigest).join(',')} done=${lastDumps
      .map((d) => d?.doneItems)
      .join(',')}`,
  );
  const digests = new Set(lastDumps.map((d) => d?.doneDigest));
  return {
    digestsEqual: digests.size === 1 && lastDumps.length > 0,
    doneVisibleEverywhere: lastDumps.length > 0 && lastDumps.every((d) => d?.doneItems >= args.backlogSize),
  };
}

/** Pure verdict computation — exported for unit tests (run-claim-dispatch parity). */
export function computeFullLoopVerdict(input: {
  scenario: LoopScenario;
  swarmCount: number;
  backlog: string[];
  queenOwner: string;
  killedAuthority: FullLoopVerdict['killedAuthority'];
  results: LoopAgentResult[];
  queenTurn2SawDone: Record<string, string[]>;
  epoch1SeenByAll: boolean;
  authorityClaims: WorkItemClaim[];
  convergence: { digestsEqual: boolean; doneVisibleEverywhere: boolean; fixpointAfterMs: number };
  revokeInfo: { revokedPubkey: string; tAuthorityMs: number } | null;
}): FullLoopVerdict {
  const { scenario, swarmCount, backlog, killedAuthority, results } = input;
  const allCompletions: Array<LoopCompletion & { ownerLabel?: string }> = results.flatMap((r) => r.completions);

  const advisory: AdvisoryClaim[] = allCompletions.map((c) => ({
    workItemId: c.workItemId,
    holderPubkey: c.holderPubkey,
    owner: c.owner,
    claimId: c.claimId,
    acquiredTs: c.acquiredTs,
  }));
  const reconciliations = reconcileAll(advisory);

  const completedItems = [...new Set(allCompletions.map((c) => c.workItemId))].sort();
  const completedSet = new Set(completedItems);
  // Starvation counts COMPLETION EVIDENCE, not reporters: a killed Swarm's
  // completions never report a result, but its federated `wi-done` records are
  // legitimate completions (visible in the Queen's converged projection). Only an
  // item with NO evidence anywhere starved. (A dead-reporter completion racing a
  // survivor's fail-open re-claim can double-complete invisibly to this verdict —
  // that residual is production's P-012 cross-swarm double-completion detector.)
  const evidenceDone = new Set([...completedSet, ...Object.keys(input.queenTurn2SawDone)]);
  const starvedItems = backlog.filter((i) => !evidenceDone.has(i));

  const ownersByItem = new Map<string, Set<string>>();
  for (const c of allCompletions) {
    let s = ownersByItem.get(c.workItemId);
    if (!s) ownersByItem.set(c.workItemId, (s = new Set()));
    s.add(c.owner);
  }
  const rawDoubleClaimed = [...ownersByItem.entries()].filter(([, s]) => s.size > 1).map(([k]) => k).sort();

  const doubleCompletedAfterReconcile = reconciliations.filter((r) => !r.winner).map((r) => r.workItemId);
  const reversed = reconcileAll([...advisory].reverse());
  const winnerById = new Map(reconciliations.map((r) => [r.workItemId, r.winner.claimId]));
  const determinismHolds = reversed.every((r) => winnerById.get(r.workItemId) === r.winner.claimId);

  const routeStats = results.reduce(
    (acc, r) => ({
      localAuthority: acc.localAuthority + r.stats.localAuthority,
      remoteAuthority: acc.remoteAuthority + r.stats.remoteAuthority,
      failOpen: acc.failOpen + r.stats.failOpen,
      conflicts: acc.conflicts + r.stats.conflicts,
      refusedRevoked: acc.refusedRevoked + r.stats.refusedRevoked,
    }),
    { localAuthority: 0, remoteAuthority: 0, failOpen: 0, conflicts: 0, refusedRevoked: 0 },
  );

  // Steering: per-Swarm grant order monotone in the steered order.
  const claimsFollowedSteering = results.map((r) => {
    const seq = [...r.completions].sort((a, b) => a.completedAtMs - b.completedAtMs);
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].steerOrderIndex < seq[i - 1].steerOrderIndex) return false;
    }
    return true;
  });

  // Steering monotonicity: every completion by a NON-queen Swarm is visible to the
  // Queen's turn-2 read, attributed to the completing owner.
  const queenMissedItems: string[] = [];
  for (const c of allCompletions) {
    if (c.owner === input.queenOwner) continue;
    const seen = input.queenTurn2SawDone[c.workItemId];
    if (!seen || !seen.includes(c.owner)) queenMissedItems.push(`${c.workItemId}@${c.owner}`);
  }

  // Convergence lag aggregates across Swarms.
  const lagMaxMs = Math.max(0, ...results.map((r) => r.lag.maxMs));
  const lagP95Ms = Math.max(0, ...results.map((r) => r.lag.p95Ms));
  const lagCount = results.reduce((n, r) => n + r.lag.count, 0);

  // D-007 adoption (lease-steal scenario).
  let adoption: FullLoopVerdict['adoption'] = null;
  if (scenario.kind === 'lease-steal') {
    const staller = results.find((r) => r.stalledItem !== null) ?? null;
    const stalledItem = staller?.stalledItem ?? null;
    const records: CompletionRecord[] = allCompletions.map((c) => ({
      workItemId: c.workItemId,
      executor: c.owner,
      claim: {
        workItemId: c.workItemId,
        holderPubkey: c.holderPubkey,
        owner: c.owner,
        claimId: c.claimId,
        acquiredTs: c.acquiredTs,
      },
      completedAtMs: c.completedAtMs,
    }));
    const currentByItem = new Map(input.authorityClaims.map((cl) => [cl.workItemId, cl.claimId]));
    const verdicts = adoptAll(records, (item) => currentByItem.get(item) ?? null);
    const stalledVerdict = stalledItem ? verdicts.find((v) => v.workItemId === stalledItem) ?? null : null;
    const effectOwners = new Map<string, number>();
    for (const r of results) {
      for (const se of r.sideEffects) {
        if (se.workItemId === stalledItem) effectOwners.set(r.owner, (effectOwners.get(r.owner) ?? 0) + 1);
      }
    }
    adoption = {
      stalledItem,
      verdicts,
      stalledItemRule: stalledVerdict?.rule ?? null,
      adoptedOwner: stalledVerdict?.adopted.executor ?? null,
      zombieOwner: staller?.owner ?? null,
      zombieAbortSignaled: (staller?.abortSignals.length ?? 0) > 0,
      sideEffectsDuplicated: effectOwners.size > 1,
    };
  }

  // EI-284 (revoke scenario).
  let revoke: FullLoopVerdict['revoke'] = null;
  if (scenario.kind === 'revoke' && input.revokeInfo) {
    const { revokedPubkey, tAuthorityMs } = input.revokeInfo;
    const refusedCount = results.reduce((n, r) => n + r.stats.refusedRevoked, 0);
    const postRevocationGrants = input.authorityClaims
      .filter((cl) => cl.holderPubkey === revokedPubkey && Date.parse(cl.acquiredTs) > tAuthorityMs)
      .map((cl) => cl.workItemId);
    const postRevocationCompletions = allCompletions
      .filter(
        (c) =>
          c.holderPubkey === revokedPubkey &&
          c.via !== 'fail-open' &&
          Date.parse(c.acquiredTs) > tAuthorityMs,
      )
      .map((c) => c.workItemId);
    revoke = { revokedPubkey, tAuthorityMs, refusedCount, postRevocationGrants, postRevocationCompletions };
  }

  return {
    scenario: scenario.kind,
    swarmCount,
    backlog,
    killedAuthority,
    results,
    reconciliations,
    completedItems,
    starvedItems,
    rawDoubleClaimed,
    doubleCompletedAfterReconcile,
    determinismHolds,
    failOpenObserved: routeStats.failOpen > 0,
    exactlyOnceObserved: rawDoubleClaimed.length === 0,
    routeStats,
    steering: {
      epoch1SeenByAll: input.epoch1SeenByAll,
      claimsFollowedSteering,
      queenSawAllRemoteCompletions: queenMissedItems.length === 0,
      queenMissedItems,
    },
    convergence: {
      digestsEqual: input.convergence.digestsEqual,
      doneVisibleEverywhere: input.convergence.doneVisibleEverywhere,
      fixpointAfterMs: input.convergence.fixpointAfterMs,
      lagMaxMs,
      lagP95Ms,
      lagCount,
    },
    adoption,
    revoke,
  };
}
