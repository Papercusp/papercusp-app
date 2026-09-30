/**
 * Versioned, dependency-free voice-turn wire contract.
 *
 * This is the shared boundary between Papercup owner voice, Phone/LiveKit,
 * and any future voice transport. Media stays transport-specific; turn
 * identity, authority, conversation linkage, executor selection, and emitted
 * events do not.
 *
 * Parsers are deliberately defensive and never throw. A server may use the
 * narrower exported parsers while resolving authority, then construct the
 * complete `VoiceTurnRequest` only from server-trusted values.
 */

export const VOICE_PROTOCOL_VERSION = 1 as const;

export const VOICE_TRANSPORTS = ['papercup-local', 'papercup-hosted', 'phone-livekit'] as const;
export type VoiceTransport = (typeof VOICE_TRANSPORTS)[number];

export const VOICE_LATENCY_CLASSES = ['interactive', 'deliberative'] as const;
export type VoiceLatencyClass = (typeof VOICE_LATENCY_CLASSES)[number];

export const VOICE_PRINCIPAL_KINDS = ['owner', 'guest', 'caller', 'unknown'] as const;
export type VoicePrincipalKind = (typeof VOICE_PRINCIPAL_KINDS)[number];

export const VOICE_AUTHORITY_SOURCES = ['owner-session', 'call-ledger', 'invite', 'unknown'] as const;
export type VoiceAuthoritySource = (typeof VOICE_AUTHORITY_SOURCES)[number];

export const VOICE_READ_CAPABILITIES = [
  'conversation-history',
  'personal-memory',
  'contacts',
  'calendar',
  'email',
  'caller-history',
  'call-policy',
] as const;
export type VoiceReadCapability = (typeof VOICE_READ_CAPABILITIES)[number];

export const VOICE_WRITE_CAPABILITIES = ['conversation-turn', 'call-outcome', 'draft'] as const;
export type VoiceWriteCapability = (typeof VOICE_WRITE_CAPABILITIES)[number];

export interface VoicePrincipal {
  kind: VoicePrincipalKind;
  /** Server-resolved user/caller/invite identity; null for an unknown caller. */
  subjectId: string | null;
  authenticated: boolean;
  authoritySource: VoiceAuthoritySource;
}

export interface VoiceCapabilityEnvelope {
  read: VoiceReadCapability[];
  write: VoiceWriteCapability[];
  /** Canonical tool names/patterns admitted by the server policy. */
  tools: string[];
}

export type VoiceConversationRef =
  | {
      kind: 'operator';
      id: string;
      parentOperatorConversationId: null;
    }
  | {
      kind: 'phone-call';
      id: string;
      /** Present only for an explicitly linked authenticated-owner call. */
      parentOperatorConversationId: string | null;
    };

export interface VoiceTurnRequest {
  version: typeof VOICE_PROTOCOL_VERSION;
  turnId: string;
  sequence: number;
  occurredAt: string;
  transport: VoiceTransport;
  latencyClass: VoiceLatencyClass;
  transcript: string;
  conversation: VoiceConversationRef;
  principal: VoicePrincipal;
  capabilities: VoiceCapabilityEnvelope;
}

export interface VoiceTurnMetrics {
  executor: string;
  latencyClass: VoiceLatencyClass;
  firstSentenceMs: number | null;
  totalMs: number;
}

interface VoiceTurnEventBase {
  version: typeof VOICE_PROTOCOL_VERSION;
  turnId: string;
  sequence: number;
  emittedAt: string;
}

export type VoiceTurnEvent =
  | (VoiceTurnEventBase & { type: 'transcript.final'; text: string })
  | (VoiceTurnEventBase & { type: 'assistant.sentence'; text: string; sentenceIndex: number })
  | (VoiceTurnEventBase & { type: 'interruption'; reason: 'user' | 'transport' | 'policy' })
  | (VoiceTurnEventBase & { type: 'completed'; metrics: VoiceTurnMetrics })
  | (VoiceTurnEventBase & { type: 'error'; code: string; message: string; retryable: boolean });

/**
 * Server-shaped input shared by every voice executor. `context` deliberately
 * stays generic: the wire contract owns authority while each server owns the
 * concrete, policy-filtered vault projection it attaches to a turn.
 */
export interface VoiceExecutorRequest<TContext = unknown> {
  readonly turn: VoiceTurnRequest;
  readonly context: TContext;
}

export interface VoiceTurnExecutorDescriptor {
  /** Stable implementation label written to completion metrics. */
  readonly id: string;
  readonly latencyClass: VoiceLatencyClass;
  /** Optional additional classes supported by a transport facade. */
  readonly supportedLatencyClasses?: readonly VoiceLatencyClass[];
  /** Observable implementation class; never an authority or persona choice. */
  readonly delivery: 'streaming' | 'deliberative';
}

export type VoiceTurnEventSink = (event: VoiceTurnEvent) => void | Promise<void>;

export interface VoiceTurnExecutorError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * One active executor turn. Media/provider adapters translate their native
 * callbacks into these four operations; this object owns canonical event
 * ordering, one terminal settlement, and first-sentence/total latency.
 */
export interface VoiceTurnExecutorSession<TContext = unknown> {
  readonly descriptor: VoiceTurnExecutorDescriptor;
  readonly request: Readonly<VoiceExecutorRequest<TContext>>;
  readonly transcriptEvent: Extract<VoiceTurnEvent, { type: 'transcript.final' }>;
  readonly active: boolean;
  assistantSentence(text: string): VoiceTurnEvent | null;
  complete(): VoiceTurnEvent | null;
  interrupt(reason: 'user' | 'transport' | 'policy', atMs?: number): VoiceTurnEvent | null;
  error(error: VoiceTurnExecutorError): VoiceTurnEvent | null;
}

/**
 * Shared lifecycle seam implemented by the low-latency and deliberative
 * adapters. Selection happens by `descriptor.latencyClass`; implementations
 * receive the already-resolved request and cannot replace its authority.
 */
export interface VoiceTurnExecutor<TContext = unknown> {
  readonly descriptor: VoiceTurnExecutorDescriptor;
  begin(
    request: Readonly<VoiceExecutorRequest<TContext>>,
    emit: VoiceTurnEventSink,
  ): VoiceTurnExecutorSession<TContext>;
}

export interface CreateVoiceTurnExecutorSessionOptions<TContext> {
  descriptor: VoiceTurnExecutorDescriptor;
  request: Readonly<VoiceExecutorRequest<TContext>>;
  emit: VoiceTurnEventSink;
  now?: () => number;
  /** Defaults to the canonical transcript occurrence time. */
  startedAtMs?: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown, max = 32_000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function nullableText(value: unknown, max = 500): string | null | undefined {
  if (value === null) return null;
  return text(value, max) ?? undefined;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isoTimestamp(value: unknown): string | null {
  const valueText = text(value, 80);
  return valueText !== null && Number.isFinite(Date.parse(valueText)) ? valueText : null;
}

function uniqueEnumArray<const T extends readonly string[]>(value: unknown, values: T): T[number][] | null {
  if (!Array.isArray(value)) return null;
  const parsed: T[number][] = [];
  for (const item of value) {
    const member = enumValue(item, values);
    if (member === null || parsed.includes(member)) return null;
    parsed.push(member);
  }
  return parsed;
}

function uniqueTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const parsed: string[] = [];
  for (const item of value) {
    const member = text(item, 300);
    if (member === null || parsed.includes(member)) return null;
    parsed.push(member);
  }
  return parsed;
}

export function parseVoicePrincipal(value: unknown): VoicePrincipal | null {
  const raw = record(value);
  if (!raw) return null;
  const kind = enumValue(raw.kind, VOICE_PRINCIPAL_KINDS);
  const subjectId = nullableText(raw.subjectId);
  const authoritySource = enumValue(raw.authoritySource, VOICE_AUTHORITY_SOURCES);
  if (!kind || subjectId === undefined || typeof raw.authenticated !== 'boolean' || !authoritySource) return null;

  // An owner is never inferred from a label alone: both authentication and a
  // concrete server-resolved subject are mandatory.
  if (kind === 'owner' && (!raw.authenticated || subjectId === null || authoritySource !== 'owner-session')) {
    return null;
  }
  // Unknown means exactly that. Carrying an identity or an authenticated bit
  // on this branch would create two conflicting authority truths.
  if (kind === 'unknown' && (raw.authenticated || subjectId !== null || authoritySource !== 'unknown')) {
    return null;
  }
  return { kind, subjectId, authenticated: raw.authenticated, authoritySource };
}

export function parseVoiceCapabilityEnvelope(value: unknown): VoiceCapabilityEnvelope | null {
  const raw = record(value);
  if (!raw) return null;
  const read = uniqueEnumArray(raw.read, VOICE_READ_CAPABILITIES);
  const write = uniqueEnumArray(raw.write, VOICE_WRITE_CAPABILITIES);
  const tools = uniqueTextArray(raw.tools);
  return read && write && tools ? { read, write, tools } : null;
}

export function parseVoiceConversationRef(value: unknown): VoiceConversationRef | null {
  const raw = record(value);
  if (!raw) return null;
  const kind = enumValue(raw.kind, ['operator', 'phone-call'] as const);
  const id = text(raw.id, 500);
  const parentOperatorConversationId = nullableText(raw.parentOperatorConversationId, 500);
  if (!kind || !id || parentOperatorConversationId === undefined) return null;
  if (kind === 'operator') {
    return parentOperatorConversationId === null ? { kind, id, parentOperatorConversationId: null } : null;
  }
  return { kind, id, parentOperatorConversationId };
}

export function parseVoiceTurnRequest(value: unknown): VoiceTurnRequest | null {
  const raw = record(value);
  if (!raw || raw.version !== VOICE_PROTOCOL_VERSION) return null;
  const turnId = text(raw.turnId, 200);
  const sequence = nonNegativeInteger(raw.sequence);
  const occurredAt = isoTimestamp(raw.occurredAt);
  const transport = enumValue(raw.transport, VOICE_TRANSPORTS);
  const latencyClass = enumValue(raw.latencyClass, VOICE_LATENCY_CLASSES);
  const transcript = text(raw.transcript);
  const conversation = parseVoiceConversationRef(raw.conversation);
  const principal = parseVoicePrincipal(raw.principal);
  const capabilities = parseVoiceCapabilityEnvelope(raw.capabilities);
  if (!turnId || sequence === null || !occurredAt || !transport || !latencyClass || !transcript) return null;
  if (!conversation || !principal || !capabilities) return null;
  return {
    version: VOICE_PROTOCOL_VERSION,
    turnId,
    sequence,
    occurredAt,
    transport,
    latencyClass,
    transcript,
    conversation,
    principal,
    capabilities,
  };
}

function parseMetrics(value: unknown): VoiceTurnMetrics | null {
  const raw = record(value);
  if (!raw) return null;
  const executor = text(raw.executor, 300);
  const latencyClass = enumValue(raw.latencyClass, VOICE_LATENCY_CLASSES);
  const firstSentenceMs = raw.firstSentenceMs === null ? null : nonNegativeFinite(raw.firstSentenceMs);
  const totalMs = nonNegativeFinite(raw.totalMs);
  if (!executor || !latencyClass || firstSentenceMs === null && raw.firstSentenceMs !== null || totalMs === null) {
    return null;
  }
  return { executor, latencyClass, firstSentenceMs, totalMs };
}

export function parseVoiceTurnEvent(value: unknown): VoiceTurnEvent | null {
  const raw = record(value);
  if (!raw || raw.version !== VOICE_PROTOCOL_VERSION) return null;
  const turnId = text(raw.turnId, 200);
  const sequence = nonNegativeInteger(raw.sequence);
  const emittedAt = isoTimestamp(raw.emittedAt);
  if (!turnId || sequence === null || !emittedAt) return null;
  const base: VoiceTurnEventBase = { version: VOICE_PROTOCOL_VERSION, turnId, sequence, emittedAt };

  switch (raw.type) {
    case 'transcript.final': {
      const eventText = text(raw.text);
      return eventText ? { ...base, type: raw.type, text: eventText } : null;
    }
    case 'assistant.sentence': {
      const eventText = text(raw.text);
      const sentenceIndex = nonNegativeInteger(raw.sentenceIndex);
      return eventText && sentenceIndex !== null
        ? { ...base, type: raw.type, text: eventText, sentenceIndex }
        : null;
    }
    case 'interruption': {
      const reason = enumValue(raw.reason, ['user', 'transport', 'policy'] as const);
      return reason ? { ...base, type: raw.type, reason } : null;
    }
    case 'completed': {
      const metrics = parseMetrics(raw.metrics);
      return metrics ? { ...base, type: raw.type, metrics } : null;
    }
    case 'error': {
      const code = text(raw.code, 200);
      const message = text(raw.message, 4_000);
      return code && message && typeof raw.retryable === 'boolean'
        ? { ...base, type: raw.type, code, message, retryable: raw.retryable }
        : null;
    }
    default:
      return null;
  }
}

function frozenCanonicalTurn(value: VoiceTurnRequest): VoiceTurnRequest {
  const turn = parseVoiceTurnRequest(value);
  if (!turn) throw new TypeError('voice executor received an invalid canonical turn');
  Object.freeze(turn.principal);
  Object.freeze(turn.conversation);
  Object.freeze(turn.capabilities.read);
  Object.freeze(turn.capabilities.write);
  Object.freeze(turn.capabilities.tools);
  Object.freeze(turn.capabilities);
  return Object.freeze(turn);
}

function executorNow(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  } catch {
    return Date.now();
  }
}

class CanonicalVoiceTurnExecutorSession<TContext> implements VoiceTurnExecutorSession<TContext> {
  readonly descriptor: VoiceTurnExecutorDescriptor;
  readonly request: Readonly<VoiceExecutorRequest<TContext>>;
  readonly transcriptEvent: Extract<VoiceTurnEvent, { type: 'transcript.final' }>;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private eventSequence = 0;
  private sentenceIndex = 0;
  private firstSentenceMs: number | null = null;
  private settled = false;

  constructor(private readonly options: CreateVoiceTurnExecutorSessionOptions<TContext>) {
    const descriptorId = text(options.descriptor.id, 300);
    const latencyClass = enumValue(options.descriptor.latencyClass, VOICE_LATENCY_CLASSES);
    const delivery = enumValue(options.descriptor.delivery, ['streaming', 'deliberative'] as const);
    if (!descriptorId || !latencyClass || !delivery) {
      throw new TypeError('voice executor descriptor is invalid');
    }
    const supported = options.descriptor.supportedLatencyClasses === undefined
      ? [latencyClass]
      : uniqueEnumArray(options.descriptor.supportedLatencyClasses, VOICE_LATENCY_CLASSES);
    if (!supported || !supported.includes(latencyClass)) {
      throw new TypeError('voice executor descriptor is invalid');
    }
    const turn = frozenCanonicalTurn(options.request.turn);
    if (!supported.includes(turn.latencyClass)) {
      throw new TypeError(
        `voice executor ${descriptorId} cannot handle ${turn.latencyClass} turns`,
      );
    }
    this.descriptor = Object.freeze({
      id: descriptorId,
      latencyClass,
      delivery,
      supportedLatencyClasses: Object.freeze([...supported]),
    });
    this.request = Object.freeze({ ...options.request, turn });
    this.now = options.now ?? Date.now;
    const occurredAtMs = Date.parse(turn.occurredAt);
    const suppliedStart = options.startedAtMs;
    this.startedAtMs = typeof suppliedStart === 'number' && Number.isFinite(suppliedStart) && suppliedStart >= 0
      ? suppliedStart
      : occurredAtMs;
    const transcriptEvent = this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'transcript.final',
      turnId: turn.turnId,
      sequence: 0,
      emittedAt: new Date(this.startedAtMs).toISOString(),
      text: turn.transcript,
    });
    if (!transcriptEvent || transcriptEvent.type !== 'transcript.final') {
      throw new TypeError('voice executor could not construct its transcript event');
    }
    this.transcriptEvent = transcriptEvent;
  }

  get active(): boolean {
    return !this.settled;
  }

  assistantSentence(value: string): VoiceTurnEvent | null {
    const sentence = text(value);
    if (this.settled || !sentence) return null;
    const nowMs = executorNow(this.now);
    if (this.firstSentenceMs === null) {
      this.firstSentenceMs = Math.max(0, nowMs - this.startedAtMs);
    }
    this.eventSequence += 1;
    const event = this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'assistant.sentence',
      turnId: this.request.turn.turnId,
      sequence: this.eventSequence,
      emittedAt: new Date(nowMs).toISOString(),
      text: sentence,
      sentenceIndex: this.sentenceIndex,
    });
    if (event) this.sentenceIndex += 1;
    return event;
  }

  complete(): VoiceTurnEvent | null {
    if (this.settled) return null;
    const nowMs = executorNow(this.now);
    this.eventSequence += 1;
    this.settled = true;
    return this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'completed',
      turnId: this.request.turn.turnId,
      sequence: this.eventSequence,
      emittedAt: new Date(nowMs).toISOString(),
      metrics: {
        executor: this.descriptor.id,
        latencyClass: this.descriptor.latencyClass,
        firstSentenceMs: this.firstSentenceMs,
        totalMs: Math.max(0, nowMs - this.startedAtMs),
      },
    });
  }

  interrupt(reason: 'user' | 'transport' | 'policy', atMs?: number): VoiceTurnEvent | null {
    if (this.settled) return null;
    const parsedReason = enumValue(reason, ['user', 'transport', 'policy'] as const);
    if (!parsedReason) return null;
    this.eventSequence += 1;
    this.settled = true;
    return this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'interruption',
      turnId: this.request.turn.turnId,
      sequence: this.eventSequence,
      emittedAt: new Date(
        typeof atMs === 'number' && Number.isFinite(atMs) && atMs >= 0
          ? atMs
          : executorNow(this.now),
      ).toISOString(),
      reason: parsedReason,
    });
  }

  error(input: VoiceTurnExecutorError): VoiceTurnEvent | null {
    const code = text(input.code, 200);
    const message = text(input.message, 4_000);
    if (this.settled || !code || !message) return null;
    this.eventSequence += 1;
    this.settled = true;
    return this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'error',
      turnId: this.request.turn.turnId,
      sequence: this.eventSequence,
      emittedAt: new Date(executorNow(this.now)).toISOString(),
      code,
      message,
      retryable: input.retryable === true,
    });
  }

  private publish(candidate: VoiceTurnEvent): VoiceTurnEvent | null {
    const event = parseVoiceTurnEvent(candidate);
    if (!event) return null;
    try {
      const result = this.options.emit(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Contract observation must never break the provider/media lifecycle.
    }
    return event;
  }
}

/**
 * Build the canonical lifecycle used by every concrete executor adapter.
 * Construction emits `transcript.final`; exactly one terminal event may then
 * follow zero or more ordered `assistant.sentence` events.
 */
export function createVoiceTurnExecutorSession<TContext>(
  options: CreateVoiceTurnExecutorSessionOptions<TContext>,
): VoiceTurnExecutorSession<TContext> {
  return new CanonicalVoiceTurnExecutorSession(options);
}

export function parseVoiceTurnRequestJson(json: string): VoiceTurnRequest | null {
  try {
    return parseVoiceTurnRequest(JSON.parse(json));
  } catch {
    return null;
  }
}

export function parseVoiceTurnEventJson(json: string): VoiceTurnEvent | null {
  try {
    return parseVoiceTurnEvent(JSON.parse(json));
  } catch {
    return null;
  }
}

export function serializeVoiceTurnRequest(request: VoiceTurnRequest): string {
  const parsed = parseVoiceTurnRequest(request);
  if (!parsed) throw new TypeError('serializeVoiceTurnRequest: invalid voice turn request');
  return JSON.stringify(parsed);
}

export function serializeVoiceTurnEvent(event: VoiceTurnEvent): string {
  const parsed = parseVoiceTurnEvent(event);
  if (!parsed) throw new TypeError('serializeVoiceTurnEvent: invalid voice turn event');
  return JSON.stringify(parsed);
}
