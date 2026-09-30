/**
 * agent-state-stamp-cluster.ts — WI-6594: make P-009's stamp coherent across the
 * `node:cluster` worker set.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 *
 * `agent-state-stamp.ts` holds each agent's three declaration pointers in a
 * MODULE-SCOPED `Map`, i.e. one process's view. The operator runs 16 request
 * workers behind SO_REUSEPORT, and the producers are three separate tool calls —
 * `coord:declare-intent`, `work_items:claim`, `facts:assert`. Each lands on
 * whichever worker the kernel picked, so worker A learns the intent, worker B
 * learns the goal, and neither can stamp both. The column then says "this call
 * was made under intent X with no goal" about an agent that demonstrably held one.
 *
 * Measured 2026-07-28: calls carrying both stamps fell 1217 -> 39 while each stamp
 * alone stayed healthy; the survivors were ~1/16 of traffic, which is the worker
 * count. It red the fleet gate through `lint:plane-ratchet`, whose stamped
 * divergence leg needs two goal-bearing calls in ONE intent bucket and had not
 * seen a single comparable bucket in nine consecutive windows.
 *
 * ── WHY PUSH, AND WHY IPC ───────────────────────────────────────────────────
 *
 * D-014 fixes the shape of the fix: the dispatcher's read must stay one `Map.get`
 * with NO I/O, because it is on the hot path of every tool call. So the read
 * cannot consult a shared store, and the WRITES — rare, a few per task — are the
 * only place a fan-out can live. Each local declaration is published once and
 * applied into every worker's map, leaving the read byte-identical.
 *
 * The transport is `node:cluster` IPC, reusing the convention already established
 * twice rather than inventing a third: `cluster-lag-watchdog.ts` for the
 * worker -> primary leg (a typed message constant + `process.send`) and
 * `sync/hyperbee/cluster-booted-handles-sync.ts` for primary -> workers
 * (`ClusterHandle.broadcast`). The primary is the hub because only it holds
 * handles to every worker.
 *
 * A declaration therefore travels: worker A `note*()` -> publish -> primary relay
 * -> broadcast to every worker (A included) -> `applyReplicatedStamp`. The echo
 * back to A is harmless — it re-applies identical values — and only LOCAL writes
 * publish, so the ring terminates. The primary applies the patch to its own map
 * too: it runs the background machinery (sweeps, routines), which makes tool calls
 * of its own that deserve a correct stamp.
 *
 * ── DELIBERATELY NOT DURABLE ────────────────────────────────────────────────
 *
 * This replicates BETWEEN live processes; it does not survive a restart. That is
 * the pre-existing behaviour (the map has always been in-memory) and it is
 * self-healing on the same timescale as before: an agent re-declares intent on
 * every wake via `coord:orient`. Persisting the stamp is a separate, larger
 * question about where declared state lives — it is NOT smuggled in here, where
 * the whole point is that the read path does not change.
 */

import {
  applyReplicatedStamp,
  setAgentStampPublisher,
  type AgentStampPatchEvent,
} from './agent-state-stamp';

/** IPC message carrying one owner's declaration between cluster processes. */
export const AGENT_STAMP_PATCH_TYPE = 'papercusp:agent-state-stamp-patch' as const;

export interface AgentStampPatchMessage {
  type: typeof AGENT_STAMP_PATCH_TYPE;
  event: AgentStampPatchEvent;
}

/** Is this a well-formed stamp-patch message? Total, never throws — an IPC
 *  channel carries other traffic (heartbeats, booted-handle snapshots, the test
 *  runner's own worker protocol) and every one of those must be ignored. */
export function isAgentStampPatchMessage(message: unknown): message is AgentStampPatchMessage {
  const m = message as Partial<AgentStampPatchMessage> | null | undefined;
  if (m?.type !== AGENT_STAMP_PATCH_TYPE) return false;
  const e = m.event as Partial<AgentStampPatchEvent> | undefined;
  return (
    !!e &&
    typeof e.ownerId === 'string' &&
    e.ownerId.length > 0 &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    !!e.patch &&
    typeof e.patch === 'object'
  );
}

export interface AgentStampReplicationHandle {
  stop(): void;
}

/**
 * WORKER side, leg 1: publish this process's local declarations to the primary.
 *
 * A no-op handle when `process.send` is absent (single-process host, or a test),
 * in which case no publisher is installed at all and `agent-state-stamp` keeps its
 * original single-process behaviour rather than paying for a dead channel.
 */
export function startWorkerStampPublisher(
  opts: { send?: (m: AgentStampPatchMessage) => void } = {},
): AgentStampReplicationHandle {
  const send =
    opts.send ??
    (typeof process.send === 'function' ? (m: AgentStampPatchMessage) => process.send!(m) : undefined);
  if (!send) return { stop() {} };
  setAgentStampPublisher((event) => send({ type: AGENT_STAMP_PATCH_TYPE, event }));
  return {
    stop() {
      setAgentStampPublisher(null);
    },
  };
}

/**
 * WORKER side, leg 2: apply patches the primary relays from its peers.
 *
 * `on`/`off` are injectable because synthetically emitting `'message'` on the REAL
 * `process` object collides with the test runner's own worker IPC — the same
 * reason `cluster-booted-handles-sync` takes them.
 */
export function startWorkerStampReceiver(
  opts: {
    on?: (event: 'message', cb: (message: unknown) => void) => void;
    off?: (event: 'message', cb: (message: unknown) => void) => void;
  } = {},
): AgentStampReplicationHandle {
  const on = opts.on ?? ((event: 'message', cb: (message: unknown) => void) => process.on(event, cb));
  const off = opts.off ?? ((event: 'message', cb: (message: unknown) => void) => process.off(event, cb));
  const listener = (message: unknown): void => {
    if (!isAgentStampPatchMessage(message)) return;
    applyReplicatedStamp(message.event);
  };
  on('message', listener);
  return {
    stop() {
      off('message', listener);
    },
  };
}

/** The subset of `node:cluster` this relay needs — narrow so a test can pass a
 *  plain EventEmitter instead of the real module. */
export interface StampRelayClusterLike {
  on(event: 'message', cb: (worker: unknown, message: unknown) => void): unknown;
  off?(event: 'message', cb: (worker: unknown, message: unknown) => void): unknown;
}

/**
 * PRIMARY side: relay each worker's declaration to every OTHER worker, and apply
 * it locally.
 *
 * The broadcast deliberately includes the originating worker. Filtering it out
 * would need a worker identity on the message and buy nothing — re-applying a
 * patch is idempotent, and a replicated apply never re-publishes.
 */
export function startPrimaryStampRelay(opts: {
  cluster: StampRelayClusterLike;
  broadcast: (message: AgentStampPatchMessage) => void;
}): AgentStampReplicationHandle {
  const listener = (_worker: unknown, message: unknown): void => {
    if (!isAgentStampPatchMessage(message)) return;
    // Locally first: the primary runs the background machinery, whose own tool
    // calls are stamped from this same map.
    applyReplicatedStamp(message.event);
    try {
      opts.broadcast(message);
    } catch {
      /* best-effort, exactly like the booted-handles broadcaster */
    }
  };
  opts.cluster.on('message', listener);
  return {
    stop() {
      opts.cluster.off?.('message', listener);
    },
  };
}
