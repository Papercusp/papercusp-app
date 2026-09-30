/**
 * Papercup transport adapter for the shared voice-turn event contract.
 *
 * The local browser pipeline and the hosted operator-voice session keep their
 * existing media, lease, persistence, and provider lifecycles. This adapter is
 * the narrow boundary that turns those transport-specific callbacks into the
 * same dependency-free `VoiceTurnEvent` stream.
 */
import {
  VOICE_PROTOCOL_VERSION,
  createVoiceTurnExecutorSession,
  parseVoiceTurnRequest,
  parseVoiceTurnEvent,
  type VoiceCapabilityEnvelope,
  type VoiceExecutorRequest,
  type VoiceLatencyClass,
  type VoicePrincipal,
  type VoiceTransport,
  type VoiceTurnEvent,
  type VoiceTurnEventSink,
  type VoiceTurnExecutor,
  type VoiceTurnExecutorDescriptor,
  type VoiceTurnExecutorSession,
  type VoiceTurnRequest,
} from '@papercusp/chat-protocol';

export const PAPERCUP_VOICE_TURN_EVENT = 'papercusp:voiceTurnEvent' as const;

export type PapercupVoiceTransport = Extract<
  VoiceTransport,
  'papercup-local' | 'papercup-hosted'
>;

export interface PapercupVoiceTurnStart<TContext = unknown> {
  text: string;
  transport: PapercupVoiceTransport;
  latencyClass: VoiceLatencyClass;
  executor: string;
  /** Preserve a gateway-issued id when one already exists. */
  turnId?: string;
  /** Optional server-routed request carrying the real authority/context. */
  request?: Readonly<VoiceExecutorRequest<TContext>>;
  /** Context for an observer-only turn when no routed request is supplied. */
  context?: TContext;
  sequence?: number;
  occurredAt?: string | number | Date;
}

export interface PapercupVoiceTurnAdapterDeps<TContext = unknown> {
  emit(event: VoiceTurnEvent): void;
  /** Deliberative provider facade used for server-routed canonical turns. */
  executor?: VoiceTurnExecutor<TContext>;
  /** Optional per-turn factory for transport-specific streaming/deep facades. */
  createExecutor?: (
    id: string,
    latencyClass: VoiceLatencyClass,
  ) => VoiceTurnExecutor<TContext>;
  /** Safe context value for observer-only turns without a routed request. */
  observerContext?: TContext;
  now?: () => number;
  createTurnId?: (transport: PapercupVoiceTransport, nowMs: number) => string;
}

export const PAPERCUP_DEEP_EXECUTOR_ID = 'papercup-deep' as const;

/**
 * Papercup's deliberative implementation of the shared executor lifecycle.
 * The existing pane/deep-delegation machinery still performs cognition; this
 * facade only translates its callbacks into the canonical immutable turn.
 */
export class PapercupDeepVoiceExecutor<TContext = unknown>
implements VoiceTurnExecutor<TContext> {
  readonly descriptor: VoiceTurnExecutorDescriptor;
  private readonly now: () => number;

  constructor(options: { id?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.descriptor = Object.freeze({
      id: normalizeText(options.id, 300) ?? PAPERCUP_DEEP_EXECUTOR_ID,
      latencyClass: 'deliberative',
      delivery: 'deliberative',
    });
  }

  begin(
    request: Readonly<VoiceExecutorRequest<TContext>>,
    emit: VoiceTurnEventSink,
  ): VoiceTurnExecutorSession<TContext> {
    return createVoiceTurnExecutorSession({
      descriptor: this.descriptor,
      request,
      emit,
      now: this.now,
    });
  }
}

/** Low-latency facade for existing local/hosted Papercup provider callbacks. */
class PapercupStreamingVoiceExecutor<TContext = unknown>
implements VoiceTurnExecutor<TContext> {
  readonly descriptor: VoiceTurnExecutorDescriptor;
  private readonly now: () => number;

  constructor(options: { id: string; now: () => number }) {
    this.now = options.now;
    this.descriptor = Object.freeze({
      id: normalizeText(options.id, 300) ?? 'papercup-streaming',
      latencyClass: 'interactive',
      delivery: 'streaming',
    });
  }

  begin(
    request: Readonly<VoiceExecutorRequest<TContext>>,
    emit: VoiceTurnEventSink,
  ): VoiceTurnExecutorSession<TContext> {
    return createVoiceTurnExecutorSession({
      descriptor: this.descriptor,
      request,
      emit,
      now: this.now,
    });
  }
}

let fallbackTurnOrdinal = 0;

function normalizeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function defaultTurnId(transport: PapercupVoiceTransport, nowMs: number): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* deterministic fallback below */
  }
  fallbackTurnOrdinal += 1;
  return `${transport}:${Math.max(0, Math.trunc(nowMs))}:${fallbackTurnOrdinal}`;
}

/**
 * Stateful normalizer for one transport stream. All methods are observational:
 * invalid/empty input and a failing event sink never disturb the live voice UX.
 */
export class PapercupVoiceTurnAdapter<TContext = unknown> {
  private readonly now: () => number;
  private readonly createTurnId: (transport: PapercupVoiceTransport, nowMs: number) => string;
  private executorSession: VoiceTurnExecutorSession<TContext> | null = null;

  constructor(private readonly deps: PapercupVoiceTurnAdapterDeps<TContext>) {
    this.now = deps.now ?? Date.now;
    this.createTurnId = deps.createTurnId ?? defaultTurnId;
  }

  get activeTurnId(): string | null {
    return this.executorSession?.request.turn.turnId ?? null;
  }

  /** Frozen, server-routed request visible to the concrete deep executor. */
  get activeRequest(): Readonly<VoiceExecutorRequest<TContext>> | null {
    return this.executorSession?.request ?? null;
  }

  /**
   * Start a server-routed turn after authority and vault context are resolved.
   * Existing local/hosted media lifecycles call the methods below with their
   * provider callbacks; the shared session owns event ordering and timing.
   */
  beginExecutorTurn(
    request: Readonly<VoiceExecutorRequest<TContext>>,
    executor?: VoiceTurnExecutor<TContext>,
  ): Extract<VoiceTurnEvent, { type: 'transcript.final' }> | null {
    const occurredAtMs = Date.parse(request.turn.occurredAt);
    if (this.executorSession) {
      this.interrupt(
        'user',
        Number.isFinite(occurredAtMs) && occurredAtMs >= 0 ? occurredAtMs : this.safeNow(),
      );
    }
    const selectedExecutor = executor
      ?? this.deps.executor
      ?? new PapercupDeepVoiceExecutor<TContext>({ now: this.now });
    try {
      const session = selectedExecutor.begin(request, (event) => {
        this.publish(event);
      });
      this.executorSession = session;
      return session.transcriptEvent;
    } catch {
      // Canonical observation must never disturb the live provider path.
      return null;
    }
  }

  /** A settled STT transcript begins one canonical turn. */
  finalTranscript(input: PapercupVoiceTurnStart<TContext>): VoiceTurnEvent | null {
    const text = normalizeText(input.text, 32_000);
    const executor = normalizeText(input.executor, 300);
    if (!text || !executor) return null;

    const nowMs = this.safeNow();
    const suppliedId = normalizeText(input.request?.turn.turnId ?? input.turnId, 200);
    let generatedId: string | null = null;
    try {
      generatedId = normalizeText(this.createTurnId(input.transport, nowMs), 200);
    } catch {
      generatedId = null;
    }
    const turnId = suppliedId ?? generatedId;
    if (!turnId) return null;
    const request = input.request ?? this.observerRequest({
      turnId,
      text,
      transport: input.transport,
      latencyClass: input.latencyClass,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      context: input.context,
      nowMs,
    });
    if (
      !request
      || request.turn.turnId !== turnId
      || request.turn.transcript !== text
      || request.turn.transport !== input.transport
      || request.turn.latencyClass !== input.latencyClass
    ) return null;
    return this.beginExecutorTurn(request, this.executorFor(executor, input.latencyClass));
  }

  /** One clean, speakable assistant sentence for the active turn. */
  assistantSentence(value: string): VoiceTurnEvent | null {
    const text = normalizeText(value, 32_000);
    return text ? this.executorSession?.assistantSentence(text) ?? null : null;
  }

  /** Terminal success with first-sentence and end-to-end timing. */
  complete(): VoiceTurnEvent | null {
    if (this.executorSession) {
      const session = this.executorSession;
      const event = session.complete();
      if (event) this.executorSession = null;
      return event;
    }
    return null;
  }

  /** Terminal interruption. An explicit timestamp keeps barge-in ordering exact. */
  interrupt(
    reason: 'user' | 'transport' | 'policy',
    atMs: number = this.safeNow(),
  ): VoiceTurnEvent | null {
    const session = this.executorSession;
    if (!session) return null;
    const event = session.interrupt(reason, atMs);
    if (event) this.executorSession = null;
    return event;
  }

  /** Terminal adapter/executor failure for the active turn. */
  error(input: { code: string; message: string; retryable: boolean }): VoiceTurnEvent | null {
    const session = this.executorSession;
    if (!session) return null;
    const event = session.error(input);
    if (event) this.executorSession = null;
    return event;
  }

  private executorFor(id: string, latencyClass: VoiceLatencyClass): VoiceTurnExecutor<TContext> {
    if (this.deps.executor) return this.deps.executor;
    if (this.deps.createExecutor) return this.deps.createExecutor(id, latencyClass);
    return latencyClass === 'deliberative'
      ? new PapercupDeepVoiceExecutor<TContext>({ id, now: this.now })
      : new PapercupStreamingVoiceExecutor<TContext>({ id, now: this.now });
  }

  /**
   * Build a conservative observer request for legacy callers that have not
   * adopted the server router yet. It intentionally carries unknown authority
   * and no tools; production callers should pass `request` with server-resolved
   * owner/caller capabilities and vault context.
   */
  private observerRequest(input: {
    turnId: string;
    text: string;
    transport: PapercupVoiceTransport;
    latencyClass: VoiceLatencyClass;
    sequence?: number;
    occurredAt?: string | number | Date;
    context?: TContext;
    nowMs: number;
  }): VoiceExecutorRequest<TContext> | null {
    const occurredAt = input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : typeof input.occurredAt === 'number'
        ? new Date(input.occurredAt).toISOString()
        : input.occurredAt ?? new Date(input.nowMs).toISOString();
    const sequence = input.sequence ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(Date.parse(occurredAt))) {
      return null;
    }
    const principal: VoicePrincipal = {
      kind: 'unknown',
      subjectId: null,
      authenticated: false,
      authoritySource: 'unknown',
    };
    const capabilities: VoiceCapabilityEnvelope = {
      read: ['call-policy'],
      write: ['conversation-turn', 'call-outcome'],
      tools: [],
    };
    const turn: VoiceTurnRequest | null = parseVoiceTurnRequest({
      version: VOICE_PROTOCOL_VERSION,
      turnId: input.turnId,
      sequence,
      occurredAt,
      transport: input.transport,
      latencyClass: input.latencyClass,
      transcript: input.text,
      conversation: {
        kind: 'phone-call',
        id: `papercup-observer:${input.transport}`,
        parentOperatorConversationId: null,
      },
      principal,
      capabilities,
    });
    if (!turn) return null;
    return {
      turn,
      context: input.context ?? this.deps.observerContext as TContext,
    };
  }

  private safeNow(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private publish(candidate: VoiceTurnEvent): VoiceTurnEvent | null {
    const event = parseVoiceTurnEvent(candidate);
    if (!event) return null;
    try {
      this.deps.emit(event);
    } catch {
      // Contract telemetry must never break the transport it observes.
    }
    return event;
  }
}

export function createPapercupVoiceTurnAdapter<TContext = unknown>(
  deps: PapercupVoiceTurnAdapterDeps<TContext>,
): PapercupVoiceTurnAdapter<TContext> {
  return new PapercupVoiceTurnAdapter(deps);
}
