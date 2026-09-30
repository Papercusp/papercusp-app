/**
 * run-claim-dispatch.ts — the ≥3-Swarm decentralized work-item-claim E2E orchestrator
 * (decentralized-dispatch-scaling-2026-06-08 P-013), the claim analog of run-tier3.ts.
 *
 * Transport-agnostic over a `ClaimLauncher` (local child processes OR real Hetzner frames),
 * so the SAME scenario runs $0 on loopback and paid across machines. It:
 *   1. assigns each Swarm a deterministic election pubkey (argmin = slot 0 = the authority),
 *      builds the shared roster (pubkey → authority HTTP address), and launches every agent;
 *   2. starts the claim loops (`go`) — each Swarm work-steals items off the shared backlog
 *      through the per-Hive authority, with NO central dispatcher;
 *   3. (optional) kills the authority Swarm mid-run → survivors' authority RPC is refused →
 *      they FAIL OPEN to local advisory leases (D-007 hybrid);
 *   4. collects every (surviving) Swarm's completions, runs the deterministic RECONCILE
 *      (`reconcileAll`) over all reported claims, and computes the P-013 verdicts:
 *        • no starvation — every backlog item was completed by someone;
 *        • reconcile resolves every contested item to a SINGLE deterministic winner
 *          (so no double-completed work survives);
 *        • exactly-once when the authority stays alive (zero raw double-claims, no fail-open).
 *
 * It returns a structured verdict; the test asserts on it. No assertions here (so it can
 * be reused for a measurement run too).
 */

import {
  reconcileAll,
  type AdvisoryClaim,
  type ClaimResolution,
} from '../../work-item-claim-reconcile';
import type { ClaimAgentConfig, ClaimAgentResult, ClaimCompletion, ClaimRosterEntry } from './claim-agent';
import type { ClaimLauncher } from './claim-launcher';

export interface RunClaimDispatchOpts {
  launcher: ClaimLauncher;
  potSlug?: string;
  workspaceId?: string;
  harnessSlug?: string;
  /** Backlog size M — items F-001..F-00M every Swarm contends to claim+complete. */
  backlogSize?: number;
  /** Kill the elected authority (slot 0) this long after `go` (omit / killAuthority:false → no kill). */
  killAuthority?: boolean;
  /** Fallback cap (ms) on the wait for the authority's "≥2 grants" progress signal before killing. */
  killAfterMs?: number;
  /** Small settle delay (ms) after the progress gate before the kill, so survivors have work in flight. */
  killSettleMs?: number;
  readyTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** Per-agent claim knobs (forwarded into each ClaimAgentConfig). */
  ttlSec?: number;
  workMinMs?: number;
  workMaxMs?: number;
  sweepDelayMs?: number;
  maxSweeps?: number;
  agentDeadlineMs?: number;
  rpcTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface ClaimDispatchVerdict {
  swarmCount: number;
  backlog: string[];
  killedAuthority: { swarmIndex: number; devicePubkey: string } | null;
  /** Per-Swarm results that reported in (the killed one will be absent). */
  results: ClaimAgentResult[];
  reconciliations: ClaimResolution[];
  /** Union of completed items across all Swarms. */
  completedItems: string[];
  /** Backlog items NO Swarm completed — MUST be empty (no starvation). */
  starvedItems: string[];
  /** Items completed by >1 distinct owner — the tolerated fail-open waste (pre-reconcile). */
  rawDoubleClaimed: string[];
  /** After reconcile, items that still resolve to ≠1 winner — MUST be empty. */
  doubleCompletedAfterReconcile: string[];
  /** Did reconcile pick the SAME winner under a reversed input order (determinism)? */
  determinismHolds: boolean;
  /** Did any Swarm take a fail-open lease (proves the kill actually partitioned them)? */
  failOpenObserved: boolean;
  /** No raw double-claims at all (the authority-alive exactly-once steady state). */
  exactlyOnceObserved: boolean;
  /** Aggregate route counts across surviving Swarms. */
  routeStats: { localAuthority: number; remoteAuthority: number; failOpen: number; conflicts: number };
}

/** Deterministic election pubkey: slot 0 sorts lowest → slot 0 is always the authority. */
function pubkeyFor(index: number): string {
  return `${String(index).padStart(4, '0')}-swarm-claim-e2e-device-pubkey`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runClaimDispatch(opts: RunClaimDispatchOpts): Promise<ClaimDispatchVerdict> {
  const log = opts.log ?? (() => {});
  const slots = opts.launcher.slots;
  const swarmCount = slots.length;
  if (swarmCount < 3) throw new Error(`runClaimDispatch: need ≥3 Swarms, have ${swarmCount}`);

  const potSlug = opts.potSlug ?? 'claim-e2e-hive';
  // Synthetic ≥3-Swarm E2E test-rig scope (siblings 'claim-e2e-hive' / 'claim-e2e-h1') — a
  // self-contained decentralized-dispatch scenario over loopback / ephemeral Hetzner frames
  // that never reads or writes real workspace data, an explicit documented local default.
  // allow-scope-default: E2E test-rig local scope, never real workspace data (D-003).
  const workspaceId = opts.workspaceId ?? 'default';
  const harnessSlug = opts.harnessSlug ?? 'claim-e2e-h1';
  const backlogSize = opts.backlogSize ?? 12;
  const backlog = Array.from({ length: backlogSize }, (_, i) => `F-${String(i + 1).padStart(3, '0')}`);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const resultTimeoutMs = opts.resultTimeoutMs ?? 120_000;

  // 1. Build the shared roster (every Swarm's election identity + authority address).
  const roster: ClaimRosterEntry[] = slots.map((s, i) => ({
    devicePubkey: pubkeyFor(i),
    githubUserId: i + 1,
    machineLabel: s.label,
    baseUrl: `http://${s.host}:${s.httpPort}`,
  }));

  // 2. Launch every agent with the full roster.
  const handles = slots.map((slot, i) => {
    const cfg: ClaimAgentConfig = {
      swarmIndex: i,
      devicePubkey: roster[i].devicePubkey,
      githubUserId: roster[i].githubUserId,
      owner: `swarm-${i}-${slot.label}`,
      machineLabel: slot.label,
      workspaceId,
      harnessSlug,
      potSlug,
      backlog,
      roster,
      httpPort: slot.httpPort,
      httpHost: slot.bindHost,
      ...(opts.ttlSec != null ? { ttlSec: opts.ttlSec } : {}),
      ...(opts.workMinMs != null ? { workMinMs: opts.workMinMs } : {}),
      ...(opts.workMaxMs != null ? { workMaxMs: opts.workMaxMs } : {}),
      ...(opts.sweepDelayMs != null ? { sweepDelayMs: opts.sweepDelayMs } : {}),
      ...(opts.maxSweeps != null ? { maxSweeps: opts.maxSweeps } : {}),
      ...(opts.agentDeadlineMs != null ? { deadlineMs: opts.agentDeadlineMs } : {}),
      ...(opts.rpcTimeoutMs != null ? { rpcTimeoutMs: opts.rpcTimeoutMs } : {}),
    };
    return slot.launch(cfg);
  });

  // 3. Wait for every agent to be ready (store + authority op + HTTP server up).
  const readys = await Promise.all(handles.map((h) => h.waitFor('ready', readyTimeoutMs)));
  const notReady = readys.map((r, i) => (r ? null : i)).filter((i): i is number => i !== null);
  if (notReady.length) throw new Error(`runClaimDispatch: Swarm(s) ${notReady.join(',')} never became ready`);
  log(`all ${swarmCount} Swarms ready; backlog=${backlog.length} items; hive=${potSlug}`);

  // 4. Go — every Swarm starts work-stealing off the shared backlog.
  for (const h of handles) h.send('go');

  // 5. Optionally kill the authority (slot 0) mid-run — once it has actually started
  //    serializing work (≥2 grants observed), so the kill reliably lands while the survivors
  //    are still claiming (fail-open genuinely exercised) regardless of machine speed. The
  //    killAfterMs cap is a fallback if the progress signal is delayed.
  let killedAuthority: { swarmIndex: number; devicePubkey: string } | null = null;
  if (opts.killAuthority) {
    const cap = opts.killAfterMs ?? 5_000;
    const gate = await handles[0].waitFor((e) => e.evt === 'progress' && Number(e.completed) >= 2, cap);
    if (!gate) log(`authority progress gate not seen within ${cap}ms — killing on the cap`);
    // A tiny beat so the survivors have a contended item or two in flight at kill time.
    await sleep(opts.killSettleMs ?? 150);
    log(`killing authority Swarm 0 (${roster[0].devicePubkey.slice(0, 12)}…) mid-run`);
    await slots[0].kill();
    killedAuthority = { swarmIndex: 0, devicePubkey: roster[0].devicePubkey };
  }

  // 6. Collect results from the surviving Swarms (the killed one never reports).
  const surviving = handles.filter((_, i) => !(killedAuthority && i === killedAuthority.swarmIndex));
  const collected = await Promise.all(surviving.map((h) => h.waitFor('result', resultTimeoutMs)));
  const results: ClaimAgentResult[] = collected
    .filter((e): e is NonNullable<typeof e> => !!e && e.evt === 'result')
    .map((e) => e as unknown as ClaimAgentResult);
  log(`${results.length}/${surviving.length} surviving Swarms reported results`);

  await opts.launcher.cleanup();

  return computeVerdict({ swarmCount, backlog, killedAuthority, results });
}

/** Pure verdict computation — exported so the test (and a measurement run) can re-derive it. */
export function computeVerdict(input: {
  swarmCount: number;
  backlog: string[];
  killedAuthority: { swarmIndex: number; devicePubkey: string } | null;
  results: ClaimAgentResult[];
}): ClaimDispatchVerdict {
  const { swarmCount, backlog, killedAuthority, results } = input;
  const allCompletions: ClaimCompletion[] = results.flatMap((r) => r.completions);

  const advisory: AdvisoryClaim[] = allCompletions.map((c) => ({
    workItemId: c.workItemId,
    holderPubkey: c.holderPubkey,
    owner: c.owner,
    claimId: c.claimId,
    acquiredTs: c.acquiredTs,
  }));

  const reconciliations = reconcileAll(advisory);

  // Completed union + starvation.
  const completedItems = [...new Set(allCompletions.map((c) => c.workItemId))].sort();
  const completedSet = new Set(completedItems);
  const starvedItems = backlog.filter((i) => !completedSet.has(i));

  // Raw (pre-reconcile) double-claims: items completed by ≥2 distinct OWNERS.
  const ownersByItem = new Map<string, Set<string>>();
  for (const c of allCompletions) {
    let s = ownersByItem.get(c.workItemId);
    if (!s) ownersByItem.set(c.workItemId, (s = new Set()));
    s.add(c.owner);
  }
  const rawDoubleClaimed = [...ownersByItem.entries()].filter(([, s]) => s.size > 1).map(([k]) => k).sort();

  // After reconcile, every contested item must resolve to exactly ONE winner.
  const doubleCompletedAfterReconcile = reconciliations
    .filter((r) => !r.winner)
    .map((r) => r.workItemId);

  // Determinism: reconcile a REVERSED copy → identical winner per item.
  const reversed = reconcileAll([...advisory].reverse());
  const winnerById = new Map(reconciliations.map((r) => [r.workItemId, r.winner.claimId]));
  const determinismHolds = reversed.every((r) => winnerById.get(r.workItemId) === r.winner.claimId);

  const routeStats = results.reduce(
    (acc, r) => ({
      localAuthority: acc.localAuthority + r.stats.localAuthority,
      remoteAuthority: acc.remoteAuthority + r.stats.remoteAuthority,
      failOpen: acc.failOpen + r.stats.failOpen,
      conflicts: acc.conflicts + r.stats.conflicts,
    }),
    { localAuthority: 0, remoteAuthority: 0, failOpen: 0, conflicts: 0 },
  );

  return {
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
  };
}
