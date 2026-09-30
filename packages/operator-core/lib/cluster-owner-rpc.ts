/**
 * cluster-owner-rpc.ts — WI-10003626: route a request to the ONE `node:cluster`
 * worker that owns a process-local runtime object.
 *
 * ── THE BUG CLASS ───────────────────────────────────────────────────────────
 *
 * Some runtime objects cannot be shared between processes at all: a node-pty
 * master file descriptor, an attached agent engine, a live child-process handle.
 * The operator runs N request workers behind SO_REUSEPORT, so the kernel spreads
 * an agent's follow-up calls over every worker. The call that CREATED the object
 * landed on worker A; the next one lands on worker B, finds no entry in B's
 * registry, and fails (N-1)/N of the time. Measured 2026-09-28 on :3070: the
 * grader's `capability:pty_open` was served by worker 794018 and every refused
 * follow-up by worker 794025 — no restart involved.
 *
 * Replication (the agent-state-stamp-cluster.ts answer to WI-6594) does not
 * apply: you cannot copy a file descriptor into another process. The object has
 * to stay where it is, so the REQUEST has to travel to it.
 *
 * ── THE MECHANISM ───────────────────────────────────────────────────────────
 *
 * The owner records its own pid when it creates the object (the capability PTY
 * stores it on the durable task row). A worker that receives a call for an object
 * it does not hold asks the primary to deliver the request to that pid:
 *
 *   worker B callOwnerProcess(pid A) ─▶ primary relay ─▶ worker A handler
 *   worker B ◀── response ─────────── primary relay ◀── worker A result
 *
 * The primary is the hub because only it holds a handle to every worker — the
 * same reason it relays the stamp patches. It also knows authoritatively whether
 * worker A still exists, so "the owner is gone" is a MEASURED answer (`owner_gone`)
 * rather than an inference from a timeout. That distinction is load-bearing for
 * callers: a gone owner means the object is unrecoverable and its durable record
 * can be settled; a timeout means nothing of the kind.
 *
 * Deliberately generic: `kind` names the runtime family and a module registers
 * one handler per kind. The PTY capability is the first user; the SU session
 * host registry has the same defect (WI-10003626 comment 1150076) and can
 * register its own kind without touching this file.
 */

import { pinModuleState } from '@papercusp/module-singleton';

export const OWNER_RPC_REQUEST_TYPE = 'papercusp:owner-rpc-request' as const;
export const OWNER_RPC_RESPONSE_TYPE = 'papercusp:owner-rpc-response' as const;

/** Default budget for one relayed request (worker → primary → owner → back). */
export const OWNER_RPC_DEFAULT_TIMEOUT_MS = 15_000;

export type OwnerRpcFailureCode =
  /** This process is not a cluster worker; there is no relay to ask. */
  | 'not_clustered'
  /** The primary has no live worker with that pid: the owner process is gone. */
  | 'owner_gone'
  /** The owner is alive but has no handler registered for this kind. */
  | 'no_handler'
  /** The owner's handler threw. */
  | 'handler_error'
  /** No response arrived within the budget. Says nothing about owner liveness. */
  | 'timeout'
  /** The request could not be handed to the IPC channel. */
  | 'send_failed';

export interface OwnerRpcRequestMessage {
  type: typeof OWNER_RPC_REQUEST_TYPE;
  id: string;
  fromPid: number;
  targetPid: number;
  kind: string;
  payload: unknown;
}

export interface OwnerRpcResponseMessage {
  type: typeof OWNER_RPC_RESPONSE_TYPE;
  id: string;
  toPid: number;
  ok: boolean;
  result?: unknown;
  code?: OwnerRpcFailureCode;
  message?: string;
}

export type OwnerRpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: OwnerRpcFailureCode; message: string };

export type OwnerRpcHandler = (payload: unknown) => Promise<unknown> | unknown;

export function isOwnerRpcRequest(message: unknown): message is OwnerRpcRequestMessage {
  const m = message as Partial<OwnerRpcRequestMessage> | null;
  return (
    !!m &&
    typeof m === 'object' &&
    m.type === OWNER_RPC_REQUEST_TYPE &&
    typeof m.id === 'string' &&
    typeof m.fromPid === 'number' &&
    typeof m.targetPid === 'number' &&
    typeof m.kind === 'string'
  );
}

export function isOwnerRpcResponse(message: unknown): message is OwnerRpcResponseMessage {
  const m = message as Partial<OwnerRpcResponseMessage> | null;
  return (
    !!m &&
    typeof m === 'object' &&
    m.type === OWNER_RPC_RESPONSE_TYPE &&
    typeof m.id === 'string' &&
    typeof m.toPid === 'number' &&
    typeof m.ok === 'boolean'
  );
}

interface Pending {
  resolve: (outcome: OwnerRpcOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Send = (message: OwnerRpcRequestMessage | OwnerRpcResponseMessage) => boolean | void;

const state = pinModuleState('@papercusp/operator-core.cluster-owner-rpc', () => ({
  handlers: new Map<string, OwnerRpcHandler>(),
  pending: new Map<string, Pending>(),
  /** Set by startWorkerOwnerRpc; null means this process has no relay to ask. */
  send: null as Send | null,
  pid: process.pid,
  seq: 0,
}));

/**
 * Register the handler that serves `kind` requests in THIS process. Idempotent per
 * kind (a re-evaluated module replaces its own handler rather than stacking).
 */
export function registerOwnerRpcHandler(kind: string, handler: OwnerRpcHandler): void {
  state.handlers.set(kind, handler);
}

/** True once this process has a relay to reach sibling workers through. */
export function ownerRpcAvailable(): boolean {
  return state.send !== null;
}

/**
 * Deliver `payload` to the `kind` handler in the worker whose pid is `targetPid`
 * and resolve with its result. Never throws: every failure is a typed outcome, so
 * a caller can tell a gone owner (`owner_gone`) from a slow one (`timeout`).
 */
export function callOwnerProcess(opts: {
  targetPid: number;
  kind: string;
  payload: unknown;
  timeoutMs?: number;
}): Promise<OwnerRpcOutcome> {
  const send = state.send;
  if (!send) {
    return Promise.resolve({
      ok: false,
      code: 'not_clustered',
      message: 'this process is not a cluster worker with an owner-rpc relay',
    });
  }
  const id = `${state.pid}:${++state.seq}:${Date.now().toString(36)}`;
  const timeoutMs = opts.timeoutMs ?? OWNER_RPC_DEFAULT_TIMEOUT_MS;
  return new Promise<OwnerRpcOutcome>((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      resolve({
        ok: false,
        code: 'timeout',
        message: `no response from pid ${opts.targetPid} within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    // Never let an outstanding relay keep a draining worker alive.
    (timer as { unref?: () => void }).unref?.();
    state.pending.set(id, { resolve, timer });
    try {
      send({
        type: OWNER_RPC_REQUEST_TYPE,
        id,
        fromPid: state.pid,
        targetPid: opts.targetPid,
        kind: opts.kind,
        payload: opts.payload,
      });
    } catch (error) {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve({
        ok: false,
        code: 'send_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function settle(message: OwnerRpcResponseMessage): void {
  const pending = state.pending.get(message.id);
  if (!pending) return; // late reply after a timeout — already answered
  state.pending.delete(message.id);
  clearTimeout(pending.timer);
  pending.resolve(
    message.ok
      ? { ok: true, result: message.result }
      : {
          ok: false,
          code: message.code ?? 'handler_error',
          message: message.message ?? 'owner reported failure',
        },
  );
}

async function serve(request: OwnerRpcRequestMessage, send: Send): Promise<void> {
  const reply = (body: Omit<OwnerRpcResponseMessage, 'type' | 'id' | 'toPid'>): void => {
    try {
      send({ type: OWNER_RPC_RESPONSE_TYPE, id: request.id, toPid: request.fromPid, ...body });
    } catch {
      /* the requester times out; nothing else can be done from here */
    }
  };
  const handler = state.handlers.get(request.kind);
  if (!handler) {
    reply({ ok: false, code: 'no_handler', message: `pid ${state.pid} has no handler for ${request.kind}` });
    return;
  }
  try {
    reply({ ok: true, result: await handler(request.payload) });
  } catch (error) {
    reply({
      ok: false,
      code: 'handler_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface OwnerRpcHandle {
  stop(): void;
}

/**
 * WORKER side: serve requests addressed to this pid and settle responses to
 * requests this pid made. Injected `on`/`off`/`send` are for tests; production
 * uses the cluster IPC channel on `process`. A no-op handle when there is no
 * IPC channel (single-process host) — `callOwnerProcess` then reports
 * `not_clustered` instead of hanging.
 */
export function startWorkerOwnerRpc(opts: {
  on?: (event: 'message', cb: (message: unknown) => void) => unknown;
  off?: (event: 'message', cb: (message: unknown) => void) => unknown;
  send?: Send;
  pid?: number;
} = {}): OwnerRpcHandle {
  const send: Send | undefined =
    opts.send ??
    (typeof process.send === 'function'
      ? (m) => process.send!(m)
      : undefined);
  if (!send) return { stop() {} };
  const on = opts.on ?? ((event, cb) => process.on(event, cb));
  const off = opts.off ?? ((event, cb) => process.off(event, cb));
  if (opts.pid != null) state.pid = opts.pid;
  const listener = (message: unknown): void => {
    if (isOwnerRpcResponse(message)) {
      if (message.toPid === state.pid) settle(message);
      return;
    }
    if (isOwnerRpcRequest(message) && message.targetPid === state.pid) {
      void serve(message, send);
    }
  };
  on('message', listener);
  state.send = send;
  return {
    stop() {
      off('message', listener);
      if (state.send === send) state.send = null;
    },
  };
}

/** The slice of `node:cluster` the primary relay needs. */
export interface OwnerRpcClusterLike {
  on(event: 'message', cb: (worker: unknown, message: unknown) => void): unknown;
  off?(event: 'message', cb: (worker: unknown, message: unknown) => void): unknown;
  workers?: Record<string, OwnerRpcWorkerLike | undefined> | undefined;
}

export interface OwnerRpcWorkerLike {
  process: { pid?: number };
  send(message: unknown): boolean | void;
  isDead?(): boolean;
  isConnected?(): boolean;
}

function findLiveWorker(cluster: OwnerRpcClusterLike, pid: number): OwnerRpcWorkerLike | null {
  for (const worker of Object.values(cluster.workers ?? {})) {
    if (!worker || worker.process?.pid !== pid) continue;
    if (worker.isDead?.() === true) return null;
    if (worker.isConnected?.() === false) return null;
    return worker;
  }
  return null;
}

/**
 * PRIMARY side: deliver each request to the worker with the target pid, and each
 * response back to the requesting worker. When the target pid is not a live
 * worker, answer `owner_gone` on the owner's behalf — the primary is the only
 * process that can say that with authority.
 */
export function startPrimaryOwnerRpcRelay(opts: { cluster: OwnerRpcClusterLike }): OwnerRpcHandle {
  const { cluster } = opts;
  const listener = (_worker: unknown, message: unknown): void => {
    if (isOwnerRpcRequest(message)) {
      const target = findLiveWorker(cluster, message.targetPid);
      if (target) {
        try {
          target.send(message);
          return;
        } catch {
          /* fall through: an owner we cannot hand the request to is gone for this call */
        }
      }
      const requester = findLiveWorker(cluster, message.fromPid);
      const response: OwnerRpcResponseMessage = {
        type: OWNER_RPC_RESPONSE_TYPE,
        id: message.id,
        toPid: message.fromPid,
        ok: false,
        code: 'owner_gone',
        message: `no live cluster worker has pid ${message.targetPid}`,
      };
      try {
        requester?.send(response);
      } catch {
        /* requester times out */
      }
      return;
    }
    if (isOwnerRpcResponse(message)) {
      try {
        findLiveWorker(cluster, message.toPid)?.send(message);
      } catch {
        /* requester times out */
      }
    }
  };
  cluster.on('message', listener);
  return {
    stop() {
      cluster.off?.('message', listener);
    },
  };
}

/** Test-only: drop registered handlers, pending calls and the relay binding. */
export function __resetOwnerRpcForTests(): void {
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  state.pending.clear();
  state.handlers.clear();
  state.send = null;
  state.pid = process.pid;
  state.seq = 0;
}
