/**
 * Cross-tab control-stream coordination.
 *
 * A browser page may have several same-origin tabs open at once.  Keeping one
 * EventSource in every tab spends one of the origin's scarce HTTP/1.1
 * connections per tab even though all of those sockets carry the same control
 * events.  This wrapper elects one visible tab as the physical owner, fans the
 * owner's events out over BroadcastChannel, and lets another tab take the
 * lease when the owner disappears.
 *
 * The wrapper deliberately composes `createResilientEventSource`; reconnect,
 * heartbeat/zombie handling, Last-Event-ID tracking, and the handler contract
 * remain in one place.  A browser without a usable BroadcastChannel falls
 * back to the conservative profile: every tab owns its own resilient source.
 * That fallback is intentional.  Missing coordination must never turn into a
 * silent loss of control events.
 */

import {
  createResilientEventSource,
  type ResilientEventSource,
  type ResilientEventSourceOptions,
  type ResilientEventSourceStatus,
} from './resilient-event-source';

const PROTOCOL_VERSION = 1;

/** Election settles quickly, while still allowing async BroadcastChannel
 * delivery from tabs that were already open. */
export const DEFAULT_CONTROL_ELECTION_WINDOW_MS = 150;
/** Owner heartbeats are deliberately much shorter than the lease. */
export const DEFAULT_CONTROL_OWNER_HEARTBEAT_MS = 2_000;
export const DEFAULT_CONTROL_OWNER_LEASE_MS = 8_000;
export const DEFAULT_CONTROL_VISIBILITY_PAUSE_MS = 60_000;

export type CrossTabControlRole =
  | 'electing'
  | 'owner'
  | 'follower'
  | 'standalone'
  | 'paused'
  | 'closed';

/** Small structural surface makes the primitive testable without a DOM. */
export interface ControlBroadcastChannel {
  readonly name?: string;
  postMessage(message: unknown): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
}

export type ControlBroadcastChannelCtor = new (name: string) => ControlBroadcastChannel;

export interface ControlDocumentLike {
  readonly visibilityState?: string;
  addEventListener?(type: 'visibilitychange', listener: () => void): void;
  removeEventListener?(type: 'visibilitychange', listener: () => void): void;
}

export interface ControlWindowLike {
  addEventListener?(type: 'pagehide' | 'pageshow', listener: (event?: unknown) => void): void;
  removeEventListener?(type: 'pagehide' | 'pageshow', listener: (event?: unknown) => void): void;
}

export interface CrossTabControlState {
  role: CrossTabControlRole;
  tabId: string;
  ownerTabId: string | null;
  /** False in the standalone/conservative profile. */
  coordinationAvailable: boolean;
  visible: boolean;
}

export interface CrossTabControlStreamOptions
  extends Omit<
    ResilientEventSourceOptions,
    'url' | 'handlers' | 'onOpen' | 'onStatusChange' | 'onSignal' | 'onError' | 'visibilityPause' | 'visibilityPauseMs'
  > {
  url: string;
  handlers: ResilientEventSourceOptions['handlers'];

  /** Set false to deliberately use one source per tab. */
  coordination?: boolean;
  /** Stable scope override.  The default strips credentials and includes the
   * current workspace marker when one is available. */
  channelKey?: string;
  electionWindowMs?: number;
  ownerLeaseMs?: number;
  ownerHeartbeatMs?: number;

  /** Hidden tabs relinquish a physical owner after this delay. */
  pauseWhenHidden?: boolean;
  /** Alias accepted at the boundary for callers that already use the
   * resilient source's option name.  Defaults to true for this control path. */
  visibilityPause?: boolean;
  visibilityPauseMs?: number;

  /** Dependency injection seams for tests and embedded webviews. */
  broadcastChannelCtor?: ControlBroadcastChannelCtor;
  documentRef?: ControlDocumentLike;
  windowRef?: ControlWindowLike;
  tabId?: string;

  /** Called for both a physical owner and a follower receiving owner-open. */
  onOpen?: () => void;
  onStatusChange?: (status: ResilientEventSourceStatus) => void;
  onSignal?: () => void;
  /** Physical-source errors are reported by the owner only. */
  onError?: (error: Error) => void;
  /** Ownership state (boolean first for easy scheduler integration). */
  onOwnerChange?: (isOwner: boolean, state: CrossTabControlState) => void;
  onRoleChange?: (state: CrossTabControlState) => void;
  /** Called exactly when this tab starts/stops holding a physical source. */
  onPhysicalStreamChange?: (active: boolean) => void;
}

export interface CrossTabControlStream extends ResilientEventSource {
  readonly role: CrossTabControlRole;
  readonly tabId: string;
  readonly ownerTabId: string | null;
  readonly coordinationAvailable: boolean;
  readonly isOwner: boolean;
}

type OwnerStatus = ResilientEventSourceStatus;

interface BaseMessage {
  v: typeof PROTOCOL_VERSION;
  scope: string;
  kind: string;
  from: string;
}

interface AnnounceMessage extends BaseMessage {
  kind: 'announce';
  visible: boolean;
  at: number;
}

interface ClaimMessage extends BaseMessage {
  kind: 'claim';
  visible: boolean;
  at: number;
}

interface OwnerMessage extends BaseMessage {
  kind: 'owner';
  epoch: string;
  leaseUntil: number;
  status: OwnerStatus;
  visible: boolean;
}

interface LeavingMessage extends BaseMessage {
  kind: 'leaving';
  epoch: string;
  reason: string;
}

interface EventMessage extends BaseMessage {
  kind: 'event';
  epoch: string;
  sequence: number;
  eventType: string;
  data: string;
  lastEventId?: string;
}

interface SignalMessage extends BaseMessage {
  kind: 'signal';
  epoch: string;
}

type ControlMessage =
  | AnnounceMessage
  | ClaimMessage
  | OwnerMessage
  | LeavingMessage
  | EventMessage
  | SignalMessage;

const STATUS_VALUES: readonly ResilientEventSourceStatus[] = [
  'idle',
  'connecting',
  'open',
  'failing',
  'closed',
];

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function safeInvoke(fn: (() => void) | undefined): void {
  try { fn?.(); } catch { /* observer errors never break the control path */ }
}

function safeInvokeStatus(
  fn: ((status: ResilientEventSourceStatus) => void) | undefined,
  status: ResilientEventSourceStatus,
): void {
  try { fn?.(status); } catch { /* observers are isolated */ }
}

function safeInvokeError(fn: ((error: Error) => void) | undefined, error: Error): void {
  try { fn?.(error); } catch { /* observers are isolated */ }
}

function maybeUnref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  const candidate = timer as unknown as { unref?: () => void };
  try { candidate.unref?.(); } catch { /* browser timers have no unref */ }
}

function makeTabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function currentWindow(): ControlWindowLike | undefined {
  return typeof window !== 'undefined' ? (window as unknown as ControlWindowLike) : undefined;
}

function currentDocument(): ControlDocumentLike | undefined {
  return typeof document !== 'undefined' ? (document as unknown as ControlDocumentLike) : undefined;
}

function workspaceMarker(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const candidate = (window as unknown as { __PAPERCUSP_WS__?: unknown }).__PAPERCUSP_WS__;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  } catch {
    /* fall through to the URL */
  }
  try {
    const value = new URL(window.location.href).searchParams.get('ws');
    return value?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build a channel scope without putting bearer-like query values into the
 * channel name.  Workspace identity is part of the scope: two tabs on the
 * same operator origin may be looking at different workspaces and must not
 * exchange their sync events.
 */
export function defaultControlChannelKey(url: string): string {
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const parsed = new URL(url, base);
    const safeParams = [...parsed.searchParams.entries()]
      .filter(([key]) => !/(?:token|secret|password|authorization|bearer)/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const marker = workspaceMarker();
    if (marker && !safeParams.some(([key]) => key === 'ws' || key === 'workspace')) {
      safeParams.push(['ws', marker]);
    }
    const query = safeParams
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return url.split(/[?#]/, 1)[0] || url;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isControlMessage(value: unknown, scope: string, ownTabId: string): value is ControlMessage {
  if (!isRecord(value)) return false;
  if (value.v !== PROTOCOL_VERSION || value.scope !== scope) return false;
  if (typeof value.kind !== 'string' || typeof value.from !== 'string' || value.from === ownTabId) return false;
  return true;
}

function validStatus(value: unknown): value is ResilientEventSourceStatus {
  return typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value);
}

function eventFor(data: string, eventType: string, lastEventId?: string): MessageEvent {
  return {
    data,
    type: eventType,
    lastEventId: lastEventId ?? '',
  } as MessageEvent;
}

/**
 * Create a coordinated control stream.  The API intentionally mirrors the
 * framework-free resilient EventSource API, so a caller can adopt it without
 * changing its event handlers or reconnect policy.
 */
export function createCrossTabControlStream(
  opts: CrossTabControlStreamOptions,
): CrossTabControlStream {
  const electionWindowMs = positiveInt(opts.electionWindowMs, DEFAULT_CONTROL_ELECTION_WINDOW_MS);
  const ownerHeartbeatMs = positiveInt(opts.ownerHeartbeatMs, DEFAULT_CONTROL_OWNER_HEARTBEAT_MS);
  const ownerLeaseMs = Math.max(
    ownerHeartbeatMs * 2 + 1,
    positiveInt(opts.ownerLeaseMs, DEFAULT_CONTROL_OWNER_LEASE_MS),
  );
  const pauseWhenHidden = opts.pauseWhenHidden ?? opts.visibilityPause ?? true;
  const visibilityPauseMs = positiveInt(opts.visibilityPauseMs, DEFAULT_CONTROL_VISIBILITY_PAUSE_MS);
  const tabId = opts.tabId ?? makeTabId();
  const scope = opts.channelKey ?? defaultControlChannelKey(opts.url);
  const doc = opts.documentRef ?? currentDocument();
  const win = opts.windowRef ?? currentWindow();
  const browserLike = typeof window !== 'undefined' || !!opts.windowRef || !!opts.documentRef;
  const requestedCoordination = opts.coordination !== false;

  let url = opts.url;
  let status: ResilientEventSourceStatus = 'idle';
  let role: CrossTabControlRole = 'electing';
  let ownerTabId: string | null = null;
  let ownerEpoch: string | null = null;
  let ownerLeaseUntil = 0;
  let lastEventId: string | null = opts.initialLastEventId || null;
  let coordinationAvailable = false;
  let channel: ControlBroadcastChannel | null = null;
  let channelListener: ((event: { data: unknown }) => void) | null = null;
  let source: ResilientEventSource | null = null;
  let physicalActive = false;
  let cancelled = false;
  let stoppingSource = false;
  let disablingCoordination = false;
  let electionTimer: ReturnType<typeof setTimeout> | null = null;
  let leaseTimer: ReturnType<typeof setTimeout> | null = null;
  let ownerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let electionGeneration = 0;
  let ownerGeneration = 0;
  let sequence = 0;
  let lastSequence = 0;
  let lastOwnerValue: boolean | null = null;
  let openNotifiedEpoch: string | null = null;
  const candidates = new Map<string, { visible: boolean; at: number }>();
  // BroadcastChannel preserves order per sender in browsers, but test doubles
  // and a few embedded bridges can deliver an already-queued heartbeat after
  // a graceful `leaving`.  Tombstone that owner epoch so a late heartbeat can
  // never resurrect a closed source or cancel a replacement election.
  const departedEpochs = new Set<string>();

  const stateSnapshot = (): CrossTabControlState => ({
    role,
    tabId,
    ownerTabId,
    coordinationAvailable,
    visible: doc?.visibilityState !== 'hidden',
  });

  const isOwnerRole = (): boolean => role === 'owner' || role === 'standalone';

  const notifyRole = (): void => {
    const snapshot = stateSnapshot();
    const owner = isOwnerRole();
    if (owner !== lastOwnerValue) {
      lastOwnerValue = owner;
      try { opts.onOwnerChange?.(owner, snapshot); } catch { /* observer isolation */ }
    }
    try { opts.onRoleChange?.(snapshot); } catch { /* observer isolation */ }
  };

  const setRole = (next: CrossTabControlRole): void => {
    if (role === next) {
      notifyRole();
      return;
    }
    role = next;
    notifyRole();
  };

  const publishStatus = (next: ResilientEventSourceStatus): void => {
    if (status === next) return;
    status = next;
    safeInvokeStatus(opts.onStatusChange, next);
  };

  const setPhysical = (active: boolean): void => {
    if (physicalActive === active) return;
    physicalActive = active;
    try { opts.onPhysicalStreamChange?.(active); } catch { /* observer isolation */ }
  };

  const clearElection = (): void => {
    if (electionTimer !== null) {
      clearTimeout(electionTimer);
      electionTimer = null;
    }
  };

  const clearLease = (): void => {
    if (leaseTimer !== null) {
      clearTimeout(leaseTimer);
      leaseTimer = null;
    }
  };

  const clearHidden = (): void => {
    if (hiddenTimer !== null) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
  };

  const stopOwnerHeartbeat = (): void => {
    if (ownerHeartbeatTimer !== null) {
      clearInterval(ownerHeartbeatTimer);
      ownerHeartbeatTimer = null;
    }
  };

  const closeChannel = (): void => {
    if (channel && channelListener) {
      try { channel.removeEventListener?.('message', channelListener); } catch { /* ignore */ }
      if (channel.onmessage === channelListener) channel.onmessage = null;
    }
    channelListener = null;
    if (channel) {
      try { channel.close(); } catch { /* ignore */ }
    }
    channel = null;
  };

  /** Forward-declared through a function declaration below; the callback is
   * assigned once the source/coordination helpers exist. */
  let disableCoordination: () => void = () => {};

  const post = (message: ControlMessage): boolean => {
    if (!channel || !coordinationAvailable || cancelled) return false;
    try {
      channel.postMessage(message);
      return true;
    } catch {
      // Safari private windows and embedded WebViews can expose the constructor
      // but throw on postMessage.  Treat that as unavailable and use the safe
      // one-source-per-tab profile.
      disableCoordination();
      return false;
    }
  };

  const epoch = (): string => `${Date.now().toString(36)}-${tabId}-${++ownerGeneration}`;

  const ownerMessage = (): OwnerMessage => ({
    v: PROTOCOL_VERSION,
    scope,
    // Heartbeats are represented by the same owner lease message. Keeping one
    // wire shape means late joiners can recover from either a fresh election or
    // an ordinary renewal without another protocol branch.
    kind: 'owner',
    from: tabId,
    epoch: ownerEpoch ?? '',
    leaseUntil: Date.now() + ownerLeaseMs,
    status,
    visible: doc?.visibilityState !== 'hidden',
  });

  const stopPhysicalSource = (): void => {
    const current = source;
    if (current?.lastEventId) lastEventId = current.lastEventId;
    source = null;
    stoppingSource = true;
    try { current?.close(); } catch { /* close is idempotent */ }
    stoppingSource = false;
    setPhysical(false);
  };

  const broadcastOwner = (): void => {
    if (!coordinationAvailable || role !== 'owner' || !ownerEpoch) return;
    post(ownerMessage());
  };

  const scheduleLease = (): void => {
    clearLease();
    if (!coordinationAvailable || role !== 'follower' || !ownerTabId) return;
    const delay = Math.max(1, ownerLeaseUntil - Date.now());
    leaseTimer = setTimeout(() => {
      leaseTimer = null;
      if (cancelled || role !== 'follower') return;
      if (Date.now() < ownerLeaseUntil) {
        scheduleLease();
        return;
      }
      ownerTabId = null;
      ownerEpoch = null;
      ownerLeaseUntil = 0;
      lastSequence = 0;
      if (doc?.visibilityState === 'hidden') {
        setRole('paused');
        publishStatus('idle');
      } else {
        beginElection('lease-expired');
      }
    }, delay);
    maybeUnref(leaseTimer);
  };

  const startOwnerHeartbeat = (): void => {
    stopOwnerHeartbeat();
    broadcastOwner();
    ownerHeartbeatTimer = setInterval(() => {
      if (cancelled || role !== 'owner') return;
      broadcastOwner();
    }, ownerHeartbeatMs);
    maybeUnref(ownerHeartbeatTimer);
  };

  const wrappedHandlers: Record<string, (data: string, ev: MessageEvent) => void> = {};

  const startPhysicalSource = (): void => {
    if (cancelled || source) return;
    const ctorAvailable = opts.eventSourceCtor
      ?? (typeof globalThis !== 'undefined'
        ? (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource
        : undefined);
    if (!ctorAvailable) {
      publishStatus('idle');
      return;
    }
    setPhysical(true);
    const sourceHandlers = opts.handlers ?? {};
    for (const [eventType, handler] of Object.entries(sourceHandlers)) {
      wrappedHandlers[eventType] = (data, ev) => {
        if (coordinationAvailable && role === 'owner' && ownerEpoch) {
          const nextSequence = ++sequence;
          post({
            v: PROTOCOL_VERSION,
            scope,
            kind: 'event',
            from: tabId,
            epoch: ownerEpoch,
            sequence: nextSequence,
            eventType,
            data,
            ...(ev.lastEventId ? { lastEventId: ev.lastEventId } : {}),
          });
        }
        try { handler(data, ev); } catch { /* resilient source isolates handlers too */ }
      };
    }

    const underlying = createResilientEventSource({
      ...opts,
      url,
      initialLastEventId: lastEventId,
      handlers: wrappedHandlers,
      // Coordinated ownership handles visibility itself.  In the standalone
      // profile the underlying resilient source owns the normal pause timer.
      visibilityPause: !coordinationAvailable && pauseWhenHidden,
      visibilityPauseMs,
      onOpen: () => {
        publishStatus('open');
        if (coordinationAvailable && role === 'owner') broadcastOwner();
        safeInvoke(opts.onOpen);
      },
      onStatusChange: (next) => {
        // Closing a source during an ownership hand-off is intentional.  Do
        // not expose that internal close as a transport failure to followers
        // or to a caller that may switch transports on `closed`.
        if (stoppingSource && next === 'closed') return;
        publishStatus(next);
        if (coordinationAvailable && role === 'owner' && ownerEpoch) broadcastOwner();
      },
      onSignal: () => {
        if (coordinationAvailable && role === 'owner' && ownerEpoch) {
          post({ v: PROTOCOL_VERSION, scope, kind: 'signal', from: tabId, epoch: ownerEpoch });
        }
        safeInvoke(opts.onSignal);
      },
      onError: (error) => {
        safeInvokeError(opts.onError, error);
      },
    });
    source = underlying;
  };

  const becomeStandalone = (): void => {
    if (cancelled) return;
    coordinationAvailable = false;
    ownerTabId = tabId;
    ownerEpoch = null;
    ownerLeaseUntil = 0;
    clearElection();
    clearLease();
    stopOwnerHeartbeat();
    setRole('standalone');
    publishStatus('connecting');
    startPhysicalSource();
  };

  disableCoordination = (): void => {
    if (disablingCoordination || cancelled) return;
    disablingCoordination = true;
    coordinationAvailable = false;
    clearElection();
    clearLease();
    stopOwnerHeartbeat();
    closeChannel();
    becomeStandalone();
    disablingCoordination = false;
  };

  const adoptOwner = (message: OwnerMessage): void => {
    if (cancelled || !coordinationAvailable) return;
    if (departedEpochs.has(`${message.from}:${message.epoch}`)) return;
    const incomingOwner = message.from;
    const currentLeaseValid = ownerTabId !== null && Date.now() < ownerLeaseUntil;
    if (role === 'owner') {
      // Deterministic conflict resolution: the lexicographically lower tab id
      // wins.  This closes the two-owner race when two tabs wake together.
      if (incomingOwner.localeCompare(tabId) >= 0) return;
      stopOwnerHeartbeat();
      stopPhysicalSource();
    } else if (
      currentLeaseValid &&
      ownerTabId !== incomingOwner &&
      (ownerTabId ?? '').localeCompare(incomingOwner) < 0
    ) {
      // A currently valid lower-id owner beats a later, higher-id announcement.
      return;
    }
    if (message.visible === false && doc?.visibilityState !== 'hidden') {
      // Never follow a hidden owner from a visible tab; ask it to release and
      // let the normal election choose a visible owner.
      post({
        v: PROTOCOL_VERSION,
        scope,
        kind: 'claim',
        from: tabId,
        visible: true,
        at: Date.now(),
      });
      if (incomingOwner !== ownerTabId) return;
    }
    clearElection();
    const ownerChanged = ownerTabId !== incomingOwner || ownerEpoch !== message.epoch;
    ownerTabId = incomingOwner;
    ownerEpoch = message.epoch;
    ownerLeaseUntil = Math.max(Date.now() + 1, message.leaseUntil);
    if (ownerChanged) lastSequence = 0;
    // A hidden tab has deliberately relinquished (or never acquired) the
    // physical stream.  It may remember who currently owns the lease, but it
    // must stay paused until it becomes visible again; otherwise a heartbeat
    // from the visible replacement would wake background work in this tab.
    if (doc?.visibilityState === 'hidden') {
      setRole('paused');
      publishStatus('idle');
      return;
    }
    setRole('follower');
    const nextStatus = validStatus(message.status) ? message.status : 'connecting';
    const shouldNotifyOpen = nextStatus === 'open' && openNotifiedEpoch !== message.epoch;
    publishStatus(nextStatus);
    if (shouldNotifyOpen) {
      openNotifiedEpoch = message.epoch;
      safeInvoke(opts.onOpen);
    }
    scheduleLease();
  };

  const beginElection = (reason: string): void => {
    if (cancelled || !coordinationAvailable) return;
    clearElection();
    clearLease();
    ownerTabId = null;
    ownerEpoch = null;
    ownerLeaseUntil = 0;
    lastSequence = 0;
    if (doc?.visibilityState === 'hidden') {
      setRole('paused');
      publishStatus('idle');
      return;
    }
    const generation = ++electionGeneration;
    candidates.clear();
    candidates.set(tabId, { visible: true, at: Date.now() });
    setRole('electing');
    publishStatus('connecting');
    post({
      v: PROTOCOL_VERSION,
      scope,
      kind: 'announce',
      from: tabId,
      visible: true,
      at: Date.now(),
    });
    electionTimer = setTimeout(() => {
      electionTimer = null;
      if (cancelled || generation !== electionGeneration || role !== 'electing') return;
      const visible = [...candidates.entries()]
        .filter(([, candidate]) => candidate.visible)
        .map(([id]) => id)
        .sort((a, b) => a.localeCompare(b));
      const winner = visible[0] ?? tabId;
      if (winner === tabId) {
        ownerTabId = tabId;
        ownerEpoch = epoch();
        ownerLeaseUntil = Date.now() + ownerLeaseMs;
        sequence = 0;
        setRole('owner');
        publishStatus('connecting');
        startOwnerHeartbeat();
        startPhysicalSource();
      } else {
        ownerTabId = winner;
        ownerEpoch = null;
        ownerLeaseUntil = Date.now() + ownerLeaseMs;
        setRole('follower');
        publishStatus('connecting');
        scheduleLease();
      }
    }, electionWindowMs);
    maybeUnref(electionTimer);
    void reason; // retained for diagnostics/call-site readability
  };

  const relinquish = (reason: string): void => {
    if (role !== 'owner') return;
    if (coordinationAvailable && ownerEpoch) {
      post({ v: PROTOCOL_VERSION, scope, kind: 'leaving', from: tabId, epoch: ownerEpoch, reason });
    }
    stopOwnerHeartbeat();
    stopPhysicalSource();
    ownerTabId = null;
    ownerEpoch = null;
    ownerLeaseUntil = 0;
    lastSequence = 0;
    setRole('paused');
    publishStatus('idle');
  };

  const handleEvent = (message: EventMessage): void => {
    if (typeof message.eventType !== 'string' || typeof message.data !== 'string') return;
    if (message.data.length > 2_000_000) return;
    if (ownerTabId !== message.from || ownerEpoch !== message.epoch) return;
    if (!Number.isFinite(message.sequence) || message.sequence <= lastSequence) return;
    lastSequence = message.sequence;
    if (message.lastEventId) lastEventId = message.lastEventId;
    const handler = opts.handlers[message.eventType];
    if (handler) {
      try { handler(message.data, eventFor(message.data, message.eventType, message.lastEventId)); }
      catch { /* one follower handler cannot break the fanout */ }
    }
    safeInvoke(opts.onSignal);
  };

  const handleSignal = (message: SignalMessage): void => {
    if (ownerTabId !== message.from || ownerEpoch !== message.epoch) return;
    safeInvoke(opts.onSignal);
  };

  const handleMessage = (raw: unknown): void => {
    if (!isControlMessage(raw, scope, tabId)) return;
    const message = raw as ControlMessage;
    if (message.kind === 'announce') {
      if (typeof message.visible !== 'boolean') return;
      const alreadyKnown = candidates.has(message.from);
      candidates.set(message.from, { visible: message.visible, at: Number.isFinite(message.at) ? message.at : Date.now() });
      // An announcer may have started just after this tab posted its own
      // announcement, so it never saw us (BroadcastChannel does not replay
      // messages sent before a channel was constructed).  Echo our announce
      // once when we first learn about that peer; this closes the asymmetric
      // startup race without creating an announce ping-pong.
      if (!alreadyKnown && role === 'electing' && doc?.visibilityState !== 'hidden') {
        post({
          v: PROTOCOL_VERSION,
          scope,
          kind: 'announce',
          from: tabId,
          visible: true,
          at: Date.now(),
        });
      }
      if (role === 'owner') {
        if (message.visible && doc?.visibilityState === 'hidden') {
          relinquish('visible-peer');
        } else {
          broadcastOwner();
        }
      }
      return;
    }
    if (message.kind === 'claim') {
      if (typeof message.visible !== 'boolean') return;
      if (role === 'owner' && message.visible && doc?.visibilityState === 'hidden') {
        relinquish('visible-peer');
      }
      return;
    }
    if (message.kind === 'owner') {
      if (
        typeof message.epoch !== 'string' ||
        !Number.isFinite(message.leaseUntil) ||
        typeof message.visible !== 'boolean' ||
        !validStatus(message.status)
      ) return;
      adoptOwner(message);
      return;
    }
    if (message.kind === 'leaving') {
      if (ownerTabId !== message.from || ownerEpoch !== message.epoch) return;
      departedEpochs.add(`${message.from}:${message.epoch}`);
      clearLease();
      ownerTabId = null;
      ownerEpoch = null;
      ownerLeaseUntil = 0;
      lastSequence = 0;
      if (doc?.visibilityState === 'hidden') {
        setRole('paused');
        publishStatus('idle');
      } else {
        beginElection('owner-left');
      }
      return;
    }
    if (message.kind === 'event') {
      if (!Number.isFinite(message.sequence)) return;
      handleEvent(message);
      return;
    }
    if (message.kind === 'signal') {
      handleSignal(message);
    }
  };

  const installChannel = (): boolean => {
    if (!requestedCoordination || !browserLike) return false;
    const ctor = opts.broadcastChannelCtor
      ?? (typeof globalThis !== 'undefined'
        ? (globalThis as unknown as { BroadcastChannel?: ControlBroadcastChannelCtor }).BroadcastChannel
        : undefined);
    if (!ctor) return false;
    try {
      channel = new ctor(`papercusp-control-sse:${scope}`);
      coordinationAvailable = true;
      channelListener = (event) => handleMessage(event?.data);
      if (channel.addEventListener) channel.addEventListener('message', channelListener);
      else channel.onmessage = channelListener;
      notifyRole();
      return true;
    } catch {
      closeChannel();
      coordinationAvailable = false;
      return false;
    }
  };

  const onVisibilityChange = (): void => {
    if (cancelled) return;
    const visible = doc?.visibilityState !== 'hidden';
    if (!coordinationAvailable) return; // standalone source has its own hook
    if (!visible) {
      if (role === 'owner' && pauseWhenHidden) {
        clearHidden();
        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          if (!cancelled && doc?.visibilityState === 'hidden' && role === 'owner') {
            relinquish('hidden');
          }
        }, visibilityPauseMs);
        maybeUnref(hiddenTimer);
      } else if (role === 'electing') {
        clearElection();
        setRole('paused');
        publishStatus('idle');
      }
      return;
    }
    clearHidden();
    if (role === 'paused' || role === 'electing' || !ownerTabId || Date.now() >= ownerLeaseUntil) {
      beginElection('visible');
    } else if (role === 'follower') {
      post({ v: PROTOCOL_VERSION, scope, kind: 'claim', from: tabId, visible: true, at: Date.now() });
    }
  };

  const onPageHide = (): void => {
    clearHidden();
    if (!coordinationAvailable) return;
    if (role === 'owner') relinquish('pagehide');
    else if (role === 'electing') {
      clearElection();
      setRole('paused');
      publishStatus('idle');
    }
  };

  const onPageShow = (): void => {
    if (cancelled || !coordinationAvailable) return;
    if (doc?.visibilityState !== 'hidden' && (role === 'paused' || !ownerTabId)) {
      beginElection('pageshow');
    }
  };

  if (coordinationAvailable === false && installChannel()) {
    if (doc?.addEventListener) doc.addEventListener('visibilitychange', onVisibilityChange);
    if (win?.addEventListener) {
      win.addEventListener('pagehide', onPageHide);
      win.addEventListener('pageshow', onPageShow);
    }
    beginElection('startup');
  } else {
    // No usable coordination surface: every tab is deliberately standalone.
    becomeStandalone();
  }

  const handle: CrossTabControlStream = {
    get status() { return status; },
    get lastEventId() {
      if (source?.lastEventId) return source.lastEventId;
      return lastEventId;
    },
    get role() { return role; },
    get tabId() { return tabId; },
    get ownerTabId() { return ownerTabId; },
    get coordinationAvailable() { return coordinationAvailable; },
    get isOwner() { return isOwnerRole(); },
    setUrl(next: string) {
      if (next === url) return;
      url = next;
      lastEventId = null;
      if (source) source.setUrl(next);
    },
    reconnect() {
      if (cancelled) return;
      if (source && isOwnerRole()) {
        source.reconnect();
      } else if (coordinationAvailable) {
        beginElection('manual-reconnect');
      }
    },
    close() {
      if (cancelled) return;
      if (role === 'owner' && coordinationAvailable && ownerEpoch) {
        post({ v: PROTOCOL_VERSION, scope, kind: 'leaving', from: tabId, epoch: ownerEpoch, reason: 'close' });
      }
      cancelled = true;
      clearElection();
      clearLease();
      clearHidden();
      stopOwnerHeartbeat();
      if (doc?.removeEventListener) doc.removeEventListener('visibilitychange', onVisibilityChange);
      if (win?.removeEventListener) {
        win.removeEventListener('pagehide', onPageHide);
        win.removeEventListener('pageshow', onPageShow);
      }
      closeChannel();
      stopPhysicalSource();
      setRole('closed');
      publishStatus('closed');
    },
  };

  return handle;
}

/** Naming aliases keep the primitive discoverable for callers that describe
 * the same contract as a coordinated EventSource or a control stream. */
export const createCoordinatedEventSource = createCrossTabControlStream;
export const createControlStream = createCrossTabControlStream;
