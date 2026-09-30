/**
 * run-eviction-proof.ts — the ≥3-peer cross-machine LOCK-AUTHORITY φ+SWIM EVICTION E2E
 * orchestrator (P-016 of shared-hive-hardening-2026-06-13, D-010), the eviction analog of
 * run-claim-dispatch.ts.
 *
 * Transport-agnostic over an `EvictionLauncher` (local child processes OR real Hetzner frames),
 * so the SAME scenario runs $0 on loopback and paid across machines. It:
 *   1. assigns each peer a deterministic election pubkey (argmin = slot 0 = the authority),
 *      builds the shared roster (pubkey → HTTP base URL), and launches every agent;
 *   2. lets presence converge + the φ detectors learn the heartbeat cadence (stabilize);
 *   3. CONTROL: every peer agrees the authority is slot 0 and nothing is evicted;
 *   4. KILLS the authority (slot 0) — its `GET /alive` stops answering, so its presence freezes
 *      on the survivors → φ rises → each survivor relay-probes a witness (`peer.probe` over the
 *      real HTTP transport) → the witness confirms it dead → it is EXCLUDED from candidacy;
 *   5. measures how fast (vs the staleness floor) the survivors evict the dead authority and
 *      promote the next LIVE peer, then routes a `lock.acquire` from a survivor to prove it
 *      lands on the promoted LIVE authority (`remote-authority`) rather than failing open to the
 *      corpse.
 *
 * With `evictionEnabled:false` it runs the pre-P-016 CONTROL: no monitor, so the killed
 * authority stays "elected" until the 90s floor and the acquire fails open — the A/B contrast.
 *
 * Returns a structured verdict; the test asserts on it. The verdict computation is a PURE
 * function ({@link computeEvictionVerdict}) so the test (and a measurement run) can re-derive it.
 */

import type { EvictionAgentConfig, EvictionRosterEntry } from './eviction-agent';
import type { AgentHandle, EvictionLauncher } from './eviction-launcher';

export interface RunEvictionProofOpts {
  launcher: EvictionLauncher;
  scope?: string;
  coordinationDomain?: string;
  /** Install the eviction monitor (true, default) or run the staleness-only control (false). */
  evictionEnabled?: boolean;
  // Agent tuning (forwarded into each EvictionAgentConfig).
  heartbeatMs?: number;
  evictionStaleMs?: number;
  authorityStaleMs?: number;
  refreshThrottleMs?: number;
  pollTimeoutMs?: number;
  rpcTimeoutMs?: number;
  // Orchestration timing.
  readyTimeoutMs?: number;
  /** Let presence converge + φ detectors learn the cadence before the control check. */
  stabilizeMs?: number;
  /** Max wait for the survivors to evict the dead authority after the kill. */
  evictWaitMs?: number;
  /** State-poll cadence during the post-kill wait. */
  pollIntervalMs?: number;
  /** The path a survivor acquires post-eviction (to prove the promoted authority serves it). */
  acquirePath?: string;
  /** Query timeout for a single `state`/`acquire` round-trip. */
  queryTimeoutMs?: number;
  log?: (line: string) => void;
}

/** A peer's view, the parsed answer to a `state <nonce>` query. */
export interface PeerStateSnapshot {
  index: number;
  devicePubkey: string;
  authorityPubkey: string | null;
  isSelf: boolean;
  evicted: string[];
  presenceAgeMs: Record<string, number>;
  heldPaths: string[];
}

/** The raw data the orchestrator gathers — input to the pure verdict computation. */
export interface EvictionProofRaw {
  peerCount: number;
  evictionEnabled: boolean;
  killedAuthority: { peerIndex: number; devicePubkey: string };
  /** Index-ordered roster pubkeys (slot 0 sorts lowest). */
  rosterPubkeys: string[];
  preKillSnapshots: PeerStateSnapshot[];
  finalSnapshots: PeerStateSnapshot[];
  /** kill → first survivor evicted the dead authority (null if never / eviction off). */
  evictLatencyMs: number | null;
  /** how stale the dead authority was (survivor's vantage) when first evicted — proves < floor. */
  deadStaleAtEvictMs: number | null;
  authorityStaleMs: number;
  acquire: { fromIndex: number; via: string; ok: boolean; authorityPubkey: string | null } | null;
}

export interface EvictionProofVerdict {
  peerCount: number;
  evictionEnabled: boolean;
  killedAuthority: { peerIndex: number; devicePubkey: string };
  // Control (pre-kill).
  preKillAuthorityAgreed: boolean;
  preKillAuthorityPubkey: string | null;
  preKillNoEvictions: boolean;
  // Post-kill.
  survivorsEvictedDead: boolean;
  survivorsAgreeNewAuthority: boolean;
  newAuthorityPubkey: string | null;
  newAuthorityIsLive: boolean;
  evictLatencyMs: number | null;
  deadStaleAtEvictMs: number | null;
  authorityStaleMs: number;
  /** Eviction strictly beat the staleness floor (dead peer still "fresh" by the floor when evicted). */
  beatStalenessFloor: boolean;
  // Post-eviction acquire (or post-kill acquire in the control).
  acquireVia: 'local-authority' | 'remote-authority' | 'fail-open' | null;
  acquireOk: boolean | null;
  acquireAuthorityPubkey: string | null;
  finalSnapshots: PeerStateSnapshot[];
}

/** Deterministic election pubkey: slot 0 sorts lowest → slot 0 is the initial authority. */
export function pubkeyFor(index: number): string {
  return `${String(index).padStart(4, '0')}-evict-e2e-device-pubkey`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let NONCE = 0;
const nextNonce = (): string => `n${++NONCE}`;

/** Send `state <nonce>` and parse the matching snapshot (null on timeout/close). */
async function queryState(
  handle: AgentHandle,
  index: number,
  devicePubkey: string,
  timeoutMs: number,
): Promise<PeerStateSnapshot | null> {
  const nonce = nextNonce();
  handle.send(`state ${nonce}`);
  const e = await handle.waitFor((ev) => ev.evt === 'state' && ev.nonce === nonce, timeoutMs);
  if (!e) return null;
  return {
    index,
    devicePubkey,
    authorityPubkey: (e.authorityPubkey as string | null) ?? null,
    isSelf: !!e.isSelf,
    evicted: Array.isArray(e.evicted) ? (e.evicted as string[]) : [],
    presenceAgeMs: (e.presenceAgeMs as Record<string, number>) ?? {},
    heldPaths: Array.isArray(e.heldPaths) ? (e.heldPaths as string[]) : [],
  };
}

export async function runEvictionProof(opts: RunEvictionProofOpts): Promise<EvictionProofVerdict> {
  const log = opts.log ?? (() => {});
  const slots = opts.launcher.slots;
  const peerCount = slots.length;
  if (peerCount < 3) {
    throw new Error(`runEvictionProof: φ+SWIM eviction needs ≥3 peers (a witness besides the authority + corpse), have ${peerCount}`);
  }

  const scope = opts.scope ?? 'evict-e2e-h1';
  const coordinationDomain = opts.coordinationDomain ?? '/shared/evict-e2e';
  const evictionEnabled = opts.evictionEnabled !== false;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const stabilizeMs = opts.stabilizeMs ?? 3_000;
  const evictWaitMs = opts.evictWaitMs ?? 20_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 400;
  const queryTimeoutMs = opts.queryTimeoutMs ?? 10_000;
  const authorityStaleMs = opts.authorityStaleMs ?? 90_000;
  const acquirePath = opts.acquirePath ?? '/shared/evict-e2e/contended.txt';

  // 1. Roster: every peer's election identity + HTTP base URL.
  const roster: EvictionRosterEntry[] = slots.map((s, i) => ({
    devicePubkey: pubkeyFor(i),
    githubUserId: i + 1,
    machineLabel: s.label,
    baseUrl: `http://${s.host}:${s.httpPort}`,
  }));
  const rosterPubkeys = roster.map((r) => r.devicePubkey);

  // 2. Launch every agent with the full roster.
  const handles = slots.map((slot, i) => {
    const cfg: EvictionAgentConfig = {
      peerIndex: i,
      devicePubkey: roster[i].devicePubkey,
      githubUserId: roster[i].githubUserId,
      owner: `peer-${i}-${slot.label}`,
      machineLabel: slot.label,
      scope,
      coordinationDomain,
      roster,
      httpPort: slot.httpPort,
      httpHost: slot.bindHost,
      evictionEnabled,
      ...(opts.heartbeatMs != null ? { heartbeatMs: opts.heartbeatMs } : {}),
      ...(opts.evictionStaleMs != null ? { evictionStaleMs: opts.evictionStaleMs } : {}),
      ...(opts.authorityStaleMs != null ? { authorityStaleMs: opts.authorityStaleMs } : {}),
      ...(opts.refreshThrottleMs != null ? { refreshThrottleMs: opts.refreshThrottleMs } : {}),
      ...(opts.pollTimeoutMs != null ? { pollTimeoutMs: opts.pollTimeoutMs } : {}),
      ...(opts.rpcTimeoutMs != null ? { rpcTimeoutMs: opts.rpcTimeoutMs } : {}),
    };
    return slot.launch(cfg);
  });

  // 3. Wait for every agent to be ready (server + ops + loops up).
  const readys = await Promise.all(handles.map((h) => h.waitFor('ready', readyTimeoutMs)));
  const notReady = readys.map((r, i) => (r ? null : i)).filter((i): i is number => i !== null);
  if (notReady.length) throw new Error(`runEvictionProof: peer(s) ${notReady.join(',')} never became ready`);
  log(`all ${peerCount} peers ready; scope=${scope}; eviction=${evictionEnabled ? 'on' : 'off'}`);

  // 4. Let presence converge + φ detectors learn the cadence.
  await sleep(stabilizeMs);

  // 5. CONTROL: snapshot every peer (expect authority = slot 0, nothing evicted).
  const preKillSnapshots = (
    await Promise.all(handles.map((h, i) => queryState(h, i, rosterPubkeys[i], queryTimeoutMs)))
  ).filter((s): s is PeerStateSnapshot => s !== null);
  log(`control: ${preKillSnapshots.length}/${peerCount} peers report authority=${preKillSnapshots[0]?.authorityPubkey?.slice(0, 12)}…`);

  // 6. Kill the authority (slot 0).
  const killTs = Date.now();
  await slots[0].kill();
  const killedAuthority = { peerIndex: 0, devicePubkey: rosterPubkeys[0] };
  log(`killed authority slot 0 (${rosterPubkeys[0].slice(0, 12)}…)`);

  // 7. Post-kill wait: poll survivors until every one evicts the dead authority (eviction on),
  //    or evictWaitMs elapses (always, for the off control). Record first-eviction latency.
  const survivorIdx = slots.map((_, i) => i).filter((i) => i !== 0);
  const deadPk = rosterPubkeys[0];
  let evictLatencyMs: number | null = null;
  let deadStaleAtEvictMs: number | null = null;
  let finalSnapshots: PeerStateSnapshot[] = [];
  const deadline = killTs + evictWaitMs;
  for (;;) {
    const snaps = (
      await Promise.all(survivorIdx.map((i) => queryState(handles[i], i, rosterPubkeys[i], queryTimeoutMs)))
    ).filter((s): s is PeerStateSnapshot => s !== null);
    finalSnapshots = snaps;
    // First time ANY survivor reports the dead peer evicted → record latency + its staleness then.
    if (evictLatencyMs == null) {
      const firstEvicted = snaps.find((s) => s.evicted.includes(deadPk));
      if (firstEvicted) {
        evictLatencyMs = Date.now() - killTs;
        deadStaleAtEvictMs = firstEvicted.presenceAgeMs[deadPk] ?? null;
        log(`first eviction at +${evictLatencyMs}ms; dead peer was ${deadStaleAtEvictMs}ms stale (floor=${authorityStaleMs}ms)`);
      }
    }
    const allEvicted = snaps.length === survivorIdx.length && snaps.every((s) => s.evicted.includes(deadPk));
    if (allEvicted || Date.now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  // 8. Acquire from the HIGHEST-index survivor (NOT the new authority) → proves the promoted
  //    LIVE authority serves it (remote-authority), vs failing open to the corpse.
  const acquirerIdx = survivorIdx[survivorIdx.length - 1];
  const acqNonce = nextNonce();
  handles[acquirerIdx].send(`acquire ${acqNonce} ${acquirePath}`);
  const acqEvt = await handles[acquirerIdx].waitFor((e) => e.evt === 'acquired' && e.nonce === acqNonce, queryTimeoutMs);
  const acquire = acqEvt
    ? {
        fromIndex: acquirerIdx,
        via: String(acqEvt.via),
        ok: !!acqEvt.ok,
        authorityPubkey: (acqEvt.authorityPubkey as string | null) ?? null,
      }
    : null;
  log(`acquire from survivor ${acquirerIdx}: via=${acquire?.via} ok=${acquire?.ok}`);

  await opts.launcher.cleanup();

  return computeEvictionVerdict({
    peerCount,
    evictionEnabled,
    killedAuthority,
    rosterPubkeys,
    preKillSnapshots,
    finalSnapshots,
    evictLatencyMs,
    deadStaleAtEvictMs,
    authorityStaleMs,
    acquire,
  });
}

/** Pure verdict computation — exported so the unit test (and a measurement run) re-derive it. */
export function computeEvictionVerdict(raw: EvictionProofRaw): EvictionProofVerdict {
  const deadPk = raw.killedAuthority.devicePubkey;
  const survivorPks = raw.rosterPubkeys.filter((_, i) => i !== raw.killedAuthority.peerIndex);
  const expectedNewAuthority = [...survivorPks].sort()[0] ?? null; // argmin among survivors

  // Control (pre-kill): every peer present AND all elected slot 0 AND nothing evicted.
  const preAuth = raw.preKillSnapshots.map((s) => s.authorityPubkey);
  const preKillAuthorityPubkey = preAuth[0] ?? null;
  const preKillAuthorityAgreed =
    raw.preKillSnapshots.length === raw.peerCount && preAuth.every((a) => a === raw.rosterPubkeys[0]);
  const preKillNoEvictions = raw.preKillSnapshots.every((s) => s.evicted.length === 0);

  // Post-kill.
  const survivorsReported = raw.finalSnapshots.length === raw.peerCount - 1;
  const survivorsEvictedDead = survivorsReported && raw.finalSnapshots.every((s) => s.evicted.includes(deadPk));
  const newAuthPks = raw.finalSnapshots.map((s) => s.authorityPubkey);
  const newAuthorityPubkey = newAuthPks[0] ?? null;
  const survivorsAgreeNewAuthority =
    survivorsReported && newAuthPks.length > 0 && newAuthPks.every((a) => a === expectedNewAuthority);
  const newAuthorityIsLive =
    newAuthorityPubkey != null && newAuthorityPubkey !== deadPk && survivorPks.includes(newAuthorityPubkey);
  const beatStalenessFloor =
    raw.deadStaleAtEvictMs != null && raw.deadStaleAtEvictMs < raw.authorityStaleMs;

  return {
    peerCount: raw.peerCount,
    evictionEnabled: raw.evictionEnabled,
    killedAuthority: raw.killedAuthority,
    preKillAuthorityAgreed,
    preKillAuthorityPubkey,
    preKillNoEvictions,
    survivorsEvictedDead,
    survivorsAgreeNewAuthority,
    newAuthorityPubkey,
    newAuthorityIsLive,
    evictLatencyMs: raw.evictLatencyMs,
    deadStaleAtEvictMs: raw.deadStaleAtEvictMs,
    authorityStaleMs: raw.authorityStaleMs,
    beatStalenessFloor,
    acquireVia: (raw.acquire?.via as EvictionProofVerdict['acquireVia']) ?? null,
    acquireOk: raw.acquire?.ok ?? null,
    acquireAuthorityPubkey: raw.acquire?.authorityPubkey ?? null,
    finalSnapshots: raw.finalSnapshots,
  };
}
