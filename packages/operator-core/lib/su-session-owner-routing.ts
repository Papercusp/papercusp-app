/**
 * su-session-owner-routing.ts — WI-10003879: serve every per-session SU request
 * from the operator worker that holds the session's engine.
 *
 * The operator runs N `node:cluster` request workers behind SO_REUSEPORT. A PUI
 * launch attaches the engine (a live child process plus its in-memory event
 * channel) to whichever worker served it. PUI's follow-up snapshot polls,
 * command POSTs and event stream are spread over every worker; before this
 * module a non-owning worker rebuilt a descriptor-only host from the durable row
 * and answered for it, so the snapshot read `executorAttached:false` for ever
 * and the first owner turn was refused "Session is not ready" (P-023, measured
 * on :3070 2026-10-05: launch on worker 254119, polls on its siblings).
 *
 * Mechanism (reuses cluster-owner-rpc, the WI-10003626 relay built for PTYs):
 *   - the worker that attaches an engine records { pid, hostId, nonce } on the
 *     adv row (`recordSuSessionHostOwner`);
 *   - any other worker of the same operator service forwards the request to
 *     that pid, and the owner runs it against its own host;
 *   - the live event stream, which cannot cross a request/response relay as a
 *     stream, is relayed as bounded long-polls over the same channel.
 *
 * Fallback is always the pre-existing local behaviour (rehydrate a
 * descriptor-only host): the owner is gone (worker restarted), unknown, on a
 * different operator service, or a recycled pid that does not carry the
 * recorded nonce. Only a live owner that fails to answer surfaces as an error
 * (`su_session_owner_unreachable`, retryable) — never a silent wrong answer.
 */
import { randomUUID } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { parseLastEventId, sseResponse } from '@papercusp/sse';
import type { SuSessionEvent } from '@papercusp/chat-protocol';
import { callOwnerProcess, ownerRpcAvailable, registerOwnerRpcHandler } from './cluster-owner-rpc';
import { localPtyHostId } from './pty-ticket';
import {
  SuSessionHostError,
  getRegisteredSuSessionHost,
  rehydrateRegisteredSuSessionHost,
  type SuSessionHost,
  type SuSessionSseEvents,
} from './su-session-host';
import {
  readDurableSuSession,
  readSuSessionHostOwner,
  type SuSessionHostOwner,
} from './su-session-persistence';
import { detachSuClientLease, trackSuClientStream } from './su-session-client-lease';
import type { SuSessionCommandStore } from './su-session-commands';

export const SU_SESSION_HOST_RPC_KIND = 'su-session-host';

/** How long the owner holds one events long-poll open when nothing is new. */
export const SU_SESSION_EVENTS_POLL_WAIT_MS = 10_000;
/** Relay budget for one events long-poll (wait + transport slack). */
const EVENTS_POLL_TIMEOUT_MS = SU_SESSION_EVENTS_POLL_WAIT_MS + 10_000;

const TERMINAL_STATES = new Set(['ended', 'failed']);

type Host = SuSessionHost;

export interface SuSessionAddress {
  workspaceId: string;
  harnessSlug: string;
  agentChatId: string;
}

interface RoutingDeps {
  readOwner: typeof readSuSessionHostOwner;
  readDurable: typeof readDurableSuSession;
  /** undefined = the host's production (Postgres) owner-turn store. */
  commandStore?: SuSessionCommandStore;
}

const PRODUCTION_DEPS: RoutingDeps = { readOwner: readSuSessionHostOwner, readDurable: readDurableSuSession };

const routing = pinModuleState('@papercusp/operator-core.su-session-owner-routing', () => ({
  /** Minted once per process: a recycled pid never carries the recorded nonce. */
  nonce: randomUUID(),
  deps: { ...PRODUCTION_DEPS } as RoutingDeps,
}));

/**
 * Test seam: lets a forked worker fixture run the real routing without a
 * database (the cross-process proof in su-session-owner-routing.integration
 * .test.ts). Omitted keys restore production behaviour.
 */
export function _configureSuSessionRoutingForTest(deps: Partial<RoutingDeps> = {}): void {
  routing.deps = { ...PRODUCTION_DEPS, ...deps };
}

/** The ownership record THIS worker writes when it attaches an engine. */
export function localSuSessionHostOwner(now: Date = new Date()): SuSessionHostOwner {
  return { pid: process.pid, hostId: localPtyHostId(), nonce: routing.nonce, recordedAt: now.toISOString() };
}

/** True when a forwarded request was addressed to THIS process (not a recycled pid). */
export function isLocalSuSessionOwner(hostId: string, nonce: string): boolean {
  return hostId === localPtyHostId() && nonce === routing.nonce;
}

/** True when `owner` is a DIFFERENT worker of this operator service that the relay can reach. */
export function isForwardableOwner(owner: SuSessionHostOwner | null): owner is SuSessionHostOwner {
  if (!owner || owner.hostId !== localPtyHostId()) return false;
  if (owner.pid === process.pid) return false; // this process: either the owner or a recycled pid
  return ownerRpcAvailable();
}

export type SuSessionRoute =
  | { kind: 'local'; host: Host }
  | { kind: 'remote'; owner: SuSessionHostOwner }
  | { kind: 'absent' };

/** This process's host for the session (rebuilt from the durable row if needed); never forwards. */
export async function localHost(address: SuSessionAddress): Promise<Host | null> {
  return getRegisteredSuSessionHost(address) ?? (await rehydrateRegisteredSuSessionHost(address));
}

/**
 * Decide who serves this request. A host that holds an engine HERE always wins;
 * otherwise a recorded live owner elsewhere in this service is preferred over a
 * descriptor-only rebuild.
 */
export async function resolveSuSessionRoute(address: SuSessionAddress): Promise<SuSessionRoute> {
  const local = getRegisteredSuSessionHost(address);
  if (local?.hasRuntime()) return { kind: 'local', host: local };
  const owner = await routing.deps.readOwner({ agentChatId: address.agentChatId, workspaceId: address.workspaceId });
  if (isForwardableOwner(owner)) return { kind: 'remote', owner };
  const host = local ?? (await rehydrateRegisteredSuSessionHost(address));
  return host ? { kind: 'local', host } : { kind: 'absent' };
}

// ── operations (run by whichever process holds the host) ─────────────────────

export type SuSessionHostOp =
  | { op: 'snapshot' }
  | { op: 'command'; body: unknown }
  | { op: 'detach' }
  | { op: 'events'; since: number; waitMs: number };

/** A route outcome that survives the IPC hop (plain JSON). */
export interface SuSessionOpResult {
  status: number;
  body: unknown;
  /** An accepted owner turn: the route must not let a watchdog undo it. */
  committed?: boolean;
}

export interface SuSessionEventsBatch {
  events: Array<{ id: number; event: SuSessionEvent }>;
  floorSequence: number;
  lastSequence: number;
  terminal: boolean;
  /** The owner's host channel ended (host disposed) — the stream must close. */
  closed: boolean;
  advSessionId: number;
  snapshot: unknown;
}

const NOT_ATTACHED: SuSessionOpResult = {
  status: 404,
  body: { error: 'no SU session is attached to this agent chat', code: 'su_session_not_attached' },
};

async function runCommand(host: Host, body: unknown): Promise<SuSessionOpResult> {
  try {
    const dispatch = await host.acceptCommand(body, routing.deps.commandStore);
    if (!dispatch.accepted) {
      return { status: 409, body: { ok: false, replayed: dispatch.replayed, terminal: await dispatch.terminal } };
    }
    return {
      status: 202,
      body: { ok: true, replayed: dispatch.replayed, accepted: dispatch.accepted },
      // acceptCommand reserves owner turns before returning an acceptance.
      committed: dispatch.accepted.commandType === 'owner_turn',
    };
  } catch (error) {
    if (error instanceof SuSessionHostError) {
      return { status: error.status, body: { error: error.message, code: error.code } };
    }
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

async function runDetach(host: Host): Promise<SuSessionOpResult> {
  const terminal = { status: 409, body: { error: 'this session has already ended', code: 'session_terminal' } };
  if (host.snapshot().terminal) return terminal;
  const detached = await detachSuClientLease(host.descriptor().identity.advSessionId);
  return detached ? { status: 200, body: { ok: true, detached: true } } : terminal;
}

async function runSnapshot(host: Host, address: SuSessionAddress): Promise<SuSessionOpResult> {
  // pui-chat-first-ux P-010: the snapshot names the directory the session was
  // launched in; null = not recorded, which PUI treats as "unknown".
  const record = await routing.deps.readDurable({ agentChatId: address.agentChatId, workspaceId: address.workspaceId });
  return { status: 200, body: { ok: true, ...host.snapshot(), launchCwd: record?.cwd ?? null } };
}

/**
 * Events newer than `since`. When there are none, wait up to `waitMs` for the
 * next publish (subscribing BEFORE the re-check closes the race with a publish
 * that lands in between).
 */
export async function collectSuSessionEvents(host: Host, since: number, waitMs: number): Promise<SuSessionEventsBatch> {
  let events = [...host.recentSince(since)];
  let closed = false;
  if (events.length === 0 && waitMs > 0 && !host.snapshot().terminal) {
    const iterator = host.subscribe()[Symbol.asyncIterator]();
    try {
      events = [...host.recentSince(since)];
      if (events.length === 0) {
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const elapsed = new Promise<null>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(null); }, waitMs);
          (timer as { unref?: () => void }).unref?.();
        });
        const next = await Promise.race([iterator.next(), elapsed]);
        if (timer) clearTimeout(timer);
        if (!timedOut && next && next.done) closed = true;
        events = [...host.recentSince(since)];
      }
    } finally {
      void iterator.return?.();
    }
  }
  const snapshot = host.snapshot();
  return {
    events: events.map(({ id, event }) => ({ id, event: event as SuSessionEvent })),
    floorSequence: snapshot.floorSequence,
    lastSequence: snapshot.lastSequence,
    terminal: snapshot.terminal,
    closed,
    advSessionId: snapshot.descriptor.identity.advSessionId,
    snapshot,
  };
}

export async function runSuSessionHostOp(
  host: Host,
  request: SuSessionHostOp,
  address: SuSessionAddress,
): Promise<SuSessionOpResult | SuSessionEventsBatch> {
  switch (request.op) {
    case 'snapshot': return runSnapshot(host, address);
    case 'command': return runCommand(host, request.body);
    case 'detach': return runDetach(host);
    case 'events': return collectSuSessionEvents(host, request.since, request.waitMs);
  }
}

// ── the relay hop ────────────────────────────────────────────────────────────

interface ForwardedSuSessionRequest {
  address: SuSessionAddress;
  hostId: string;
  nonce: string;
  request: SuSessionHostOp;
}

type ForwardedSuSessionReply =
  | { status: 'ok'; result: SuSessionOpResult | SuSessionEventsBatch }
  | { status: 'not_owner' }
  | { status: 'absent' };

function parseForwarded(payload: unknown): ForwardedSuSessionRequest | null {
  const p = payload as Partial<ForwardedSuSessionRequest> | null;
  const a = p?.address;
  if (!p || !a || typeof a.workspaceId !== 'string' || typeof a.harnessSlug !== 'string' || typeof a.agentChatId !== 'string') return null;
  if (typeof p.hostId !== 'string' || typeof p.nonce !== 'string') return null;
  const r = p.request as Partial<SuSessionHostOp> | undefined;
  switch (r?.op) {
    case 'snapshot':
    case 'detach':
    case 'command':
      break;
    case 'events': {
      const e = r as Partial<Extract<SuSessionHostOp, { op: 'events' }>>;
      if (typeof e.since !== 'number' || typeof e.waitMs !== 'number') return null;
      break;
    }
    default:
      return null;
  }
  return p as ForwardedSuSessionRequest;
}

/**
 * OWNER side. Answers only when the request was addressed to THIS process's
 * nonce, and never forwards again, so a request cannot bounce between workers.
 */
export async function serveForwardedSuSessionOp(payload: unknown): Promise<ForwardedSuSessionReply> {
  const forwarded = parseForwarded(payload);
  if (!forwarded) throw new Error('malformed su-session owner request');
  if (!isLocalSuSessionOwner(forwarded.hostId, forwarded.nonce)) return { status: 'not_owner' };
  const host = await localHost(forwarded.address);
  if (!host) return { status: 'absent' };
  const waitMs = forwarded.request.op === 'events'
    ? Math.max(0, Math.min(forwarded.request.waitMs, SU_SESSION_EVENTS_POLL_WAIT_MS))
    : 0;
  const request = forwarded.request.op === 'events' ? { ...forwarded.request, waitMs } : forwarded.request;
  return { status: 'ok', result: await runSuSessionHostOp(host, request, forwarded.address) };
}

registerOwnerRpcHandler(SU_SESSION_HOST_RPC_KIND, serveForwardedSuSessionOp);

export type SuSessionForwardOutcome<T> =
  | { kind: 'ok'; result: T }
  /** Serve locally: the owner is gone, not ours, or holds no such session. */
  | { kind: 'fallback'; reason: string }
  /** The owner is alive but did not answer; nothing was changed by this call. */
  | { kind: 'unreachable'; code: string; message: string };

export async function forwardToSuSessionOwner<T extends SuSessionOpResult | SuSessionEventsBatch>(
  owner: SuSessionHostOwner,
  address: SuSessionAddress,
  request: SuSessionHostOp,
  timeoutMs?: number,
): Promise<SuSessionForwardOutcome<T>> {
  const payload: ForwardedSuSessionRequest = { address, hostId: owner.hostId, nonce: owner.nonce, request };
  const outcome = await callOwnerProcess({ targetPid: owner.pid, kind: SU_SESSION_HOST_RPC_KIND, payload, timeoutMs });
  if (outcome.ok) {
    const reply = outcome.result as ForwardedSuSessionReply | null;
    if (reply?.status === 'ok') return { kind: 'ok', result: reply.result as T };
    if (reply?.status === 'not_owner' || reply?.status === 'absent') return { kind: 'fallback', reason: reply.status };
    return { kind: 'unreachable', code: 'protocol_error', message: 'the owning worker returned an unrecognised reply' };
  }
  // owner_gone: the worker exited (its engine went with it) — the durable row is
  // the truth now, exactly as after an operator restart. no_handler/not_clustered:
  // nothing on the far side can serve it either.
  if (outcome.code === 'owner_gone' || outcome.code === 'no_handler' || outcome.code === 'not_clustered') {
    return { kind: 'fallback', reason: outcome.code };
  }
  return { kind: 'unreachable', code: outcome.code, message: outcome.message };
}

function unreachableResponse(owner: SuSessionHostOwner, code: string, message: string): Response {
  return Response.json(
    {
      error: `The worker holding this session (pid ${owner.pid}) did not answer: ${message}. Nothing was changed; retry.`,
      code: 'su_session_owner_unreachable',
      cause: code,
      retryable: true,
    },
    { status: 503 },
  );
}

/**
 * Run a request/response operation (snapshot, command, detach) wherever the
 * session lives and return the outcome. `servedBy` says which process ran it.
 */
export async function runRoutedSuSessionOp(
  address: SuSessionAddress,
  request: Exclude<SuSessionHostOp, { op: 'events' }>,
): Promise<{ result: SuSessionOpResult; servedBy: string } | Response> {
  const route = await resolveSuSessionRoute(address);
  if (route.kind === 'remote') {
    const forwarded = await forwardToSuSessionOwner<SuSessionOpResult>(route.owner, address, request);
    if (forwarded.kind === 'ok') return { result: forwarded.result, servedBy: `forwarded:${route.owner.pid}` };
    if (forwarded.kind === 'unreachable') return unreachableResponse(route.owner, forwarded.code, forwarded.message);
  }
  const host = route.kind === 'local' ? route.host : route.kind === 'remote' ? await localHost(address) : null;
  if (!host) return { result: NOT_ATTACHED, servedBy: `local:${process.pid}` };
  return { result: (await runSuSessionHostOp(host, request, address)) as SuSessionOpResult, servedBy: `local:${process.pid}` };
}

export const SU_SESSION_SERVED_BY_HEADER = 'X-Papercusp-Su-Session-Served-By';

/**
 * The event stream for a session whose engine lives in ANOTHER worker: each
 * owner batch is relayed as SSE `session_event`s with the owner's own sequence
 * ids, so Last-Event-ID resume and replay work exactly as on a local host.
 * When the owner stops answering the stream closes and the client's ordinary
 * reconnect re-resolves the route (falling back to a local host if the owner
 * is gone).
 */
export async function createForwardedSuSessionEventResponse(
  request: Request,
  address: SuSessionAddress,
  owner: SuSessionHostOwner,
): Promise<Response | null> {
  const lastEventId = parseLastEventId(request) ?? 0;
  const first = await forwardToSuSessionOwner<SuSessionEventsBatch>(owner, address, { op: 'events', since: lastEventId, waitMs: 0 });
  if (first.kind === 'fallback') return null;
  if (first.kind === 'unreachable') return unreachableResponse(owner, first.code, first.message);
  const opening = first.result;
  const releaseClient = opening.terminal ? () => undefined : trackSuClientStream(opening.advSessionId);
  request.signal.addEventListener('abort', releaseClient, { once: true });
  let cursor = opening.events.at(-1)?.id ?? lastEventId;

  return sseResponse<SuSessionSseEvents>({
    signal: request.signal,
    lastEventId,
    replay: () => opening.events.map(({ id, event }) => ({ name: 'session_event' as const, data: event, id })),
    resumeBounds: () => ({ floorId: opening.floorSequence, maxId: opening.lastSequence }),
    headers: {
      'X-Papercusp-Su-Session': address.agentChatId,
      [SU_SESSION_SERVED_BY_HEADER]: `forwarded:${owner.pid}`,
    },
    setup: async (sink) => {
      sink.onClose(releaseClient);
      if (opening.terminal) {
        sink.done({ reason: 'terminal', snapshot: opening.snapshot });
        return;
      }
      while (!sink.closed) {
        const next = await forwardToSuSessionOwner<SuSessionEventsBatch>(
          owner, address, { op: 'events', since: cursor, waitMs: SU_SESSION_EVENTS_POLL_WAIT_MS }, EVENTS_POLL_TIMEOUT_MS,
        );
        if (sink.closed) return;
        if (next.kind !== 'ok') {
          sink.close();
          return;
        }
        for (const { id, event } of next.result.events) {
          if (id <= cursor) continue;
          cursor = id;
          sink.event('session_event', event, { id });
          if (event.type === 'lifecycle' && TERMINAL_STATES.has((event as { state?: string }).state ?? '')) {
            sink.done({ reason: 'terminal', snapshot: next.result.snapshot });
            return;
          }
        }
        if (next.result.closed) {
          sink.close();
          return;
        }
      }
    },
  });
}
