/**
 * Shared host for one durable SU session.
 *
 * This deliberately extends the shipped agent-chats + SSE substrate instead
 * of introducing another session service. Backend adapters feed typed events
 * into the host; PUI attaches through the existing agent-chat route family.
 * Persistence/re-materialisation across operator replacement belongs to the
 * downstream P-004 lane.
 */
import { createHash } from 'node:crypto';
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  isSuSessionCommandType,
  isSuApprovalsMode,
  type SuApprovalsMode,
  type SuPlanItem,
  type SuSessionUsage,
  type SuSessionBackend,
  type SuSessionCommand,
  type SuSessionCommandResultEvent,
  type SuSessionDescriptor,
  type SuSessionEvent,
  type SuSessionIdentity,
  type SuSessionJsonValue,
  type SuSessionLifecycleState,
  type SuSessionRefusal,
} from '@papercusp/chat-protocol';
import { pinModuleState } from '@papercusp/module-singleton';
import { dropChannel, getChannel, parseLastEventId, sseResponse, type BusChannel } from '@papercusp/sse';
import {
  classifySuSessionRuntime,
  persistSuSessionDescriptor,
  readDurableSuSession,
  type RuntimeReconciliation,
} from './su-session-persistence';
import { pgSuSessionCommandStore, type SuSessionCommandStore } from './su-session-commands';
import { trackSuClientStream } from './su-session-client-lease';

/**
 * Is `pid` a live OS process? Signal 0 = existence check; EPERM = alive-not-ours.
 * A local copy of the identical helper in adv-sessions.ts / adv-roster.ts for the
 * same reason they keep their own: importing either back into this module would
 * close a cycle. Injected into {@link classifySuSessionRuntime} so the pure
 * classifier stays deterministic under test.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

type EventEnvelopeKey = 'schema' | 'protocolVersion' | 'eventId' | 'sequence' | 'at' | 'session';

type StripEventEnvelope<T> = T extends unknown ? Omit<T, EventEnvelopeKey> : never;

/** Event payload accepted from runtime adapters; the host owns the envelope. */
export type SuSessionEventInput<B extends SuSessionBackend = SuSessionBackend> = StripEventEnvelope<SuSessionEvent<B>>;

/** Read the gateway's owner-scoped serving account after a native turn settles. */
export type SuSessionServedAccountReader = (ownerId: string) => Promise<string | null>;

export type SuSessionCommandOutcome = { status: 'completed' } | { status: 'refused'; refusal: SuSessionRefusal };

export interface SuSessionCommandContext<B extends SuSessionBackend> {
  descriptor(): SuSessionDescriptor<B>;
  emit(event: SuSessionEventInput<B>): SuSessionEvent<B>;
  transition(state: SuSessionLifecycleState, reason?: string, runtimeGeneration?: number): SuSessionEvent<B> | null;
}

export type SuSessionCommandExecutor<B extends SuSessionBackend> = (
  command: SuSessionCommand<B>,
  context: SuSessionCommandContext<B>,
) => Promise<SuSessionCommandOutcome> | SuSessionCommandOutcome;

type CommandResult<B extends SuSessionBackend> = SuSessionCommandResultEvent<B>;

export interface SuSessionCommandDispatch<B extends SuSessionBackend> {
  /** Immediate owner-turn/control acknowledgement; null for an immediate refusal. */
  accepted: CommandResult<B> | null;
  /** Resolves to the single terminal result event for this command id. */
  terminal: Promise<CommandResult<B>>;
  /** True when command-id idempotency returned an existing dispatch. */
  replayed: boolean;
}

interface StoredCommand<B extends SuSessionBackend> {
  fingerprint: string;
  accepted: CommandResult<B> | null;
  terminal: Promise<CommandResult<B>>;
}

export interface SuSessionHostOptions<B extends SuSessionBackend> {
  descriptor: SuSessionDescriptor<B>;
  executeCommand?: SuSessionCommandExecutor<B>;
  /** Live transports can withdraw readiness when their engine stream closes. */
  runtimeReady?: () => boolean;
  /** Persist changed descriptor snapshots in order, coalescing pending changes.
   * Persistence never blocks the live stream; persistDescriptorNow is the
   * explicit durability barrier for native identity materialization. */
  persistDescriptor?: (descriptor: SuSessionDescriptor<B>) => void | boolean | Promise<void | boolean>;
  /**
   * How this host's runtime was reconciled against the durable adv row when it
   * was rebuilt after an operator/PUI restart. `null` (the default) means no
   * reconciliation was performed because the host was created live at launch —
   * it is NOT "reconciled clean", and PUI must not render it as progress.
   */
  runtimeReconciliation?: RuntimeReconciliation | null;
  /** Retained events available to Last-Event-ID reconnects. Default 1024. */
  replaySize?: number;
  /** Per-live-client queue before the shared SSE layer closes/replays. */
  subscriberQueueSize?: number;
  now?: () => Date;
}

export interface SuSessionHostSnapshot<B extends SuSessionBackend = SuSessionBackend> {
  descriptor: SuSessionDescriptor<B>;
  floorSequence: number;
  lastSequence: number;
  terminal: boolean;
  /** A saved descriptor alone does not establish execution readiness. */
  executorAttached: boolean;
  streamReady: boolean;
  /**
   * The restart reconciliation that produced this host, or `null` when it was
   * created live at launch and never rehydrated. PUI reads this to surface
   * runtime replacement and archive/rematerialize progress; without it the
   * client cannot distinguish "attached to a running runtime" from "rebuilt an
   * ended session out of the archive", which renders as an identical empty pane.
   */
  runtimeReconciliation: RuntimeReconciliation | null;
}

export class SuSessionHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SuSessionHostError';
  }
}

/** A structured engine did not reach readiness within its startup deadline.
 * Typed so a resume supervisor can tell this recoverable class (a stalled step
 * that a fresh attempt may clear) from a refusal it must not repeat. `stage`
 * names the step that was still running when the deadline fired. */
export class SuSessionStartupTimeoutError extends Error {
  readonly code = 'su_session_startup_timeout';
  constructor(message: string, readonly stage: string | null = null) {
    super(message);
    this.name = 'SuSessionStartupTimeoutError';
  }
}

const TERMINAL_STATES = new Set<SuSessionLifecycleState>(['ended', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function identityMatches(expected: SuSessionIdentity, actual: SuSessionIdentity): boolean {
  return (
    expected.agentChatId === actual.agentChatId &&
    expected.advSessionId === actual.advSessionId &&
    expected.backend === actual.backend &&
    expected.nativeSessionId === actual.nativeSessionId &&
    expected.ownerId === actual.ownerId &&
    expected.workspaceId === actual.workspaceId &&
    expected.harnessSlug === actual.harnessSlug
  );
}

function validateDescriptor<B extends SuSessionBackend>(descriptor: SuSessionDescriptor<B>): void {
  const identity = descriptor.identity;
  if (descriptor.role !== 'su') {
    throw new SuSessionHostError('invalid_descriptor', 'SU-session role must be su');
  }
  if (!identity.agentChatId || !identity.ownerId || !identity.workspaceId) {
    throw new SuSessionHostError(
      'invalid_descriptor',
      'SU-session identity requires agentChatId, ownerId, and workspaceId',
    );
  }
  if (!Number.isSafeInteger(identity.advSessionId) || identity.advSessionId <= 0) {
    throw new SuSessionHostError('invalid_descriptor', 'SU-session advSessionId must be a positive safe integer');
  }
  if (
    descriptor.backendExtension.backend !== identity.backend ||
    descriptor.runtimeGeneration < 0 ||
    !Number.isSafeInteger(descriptor.runtimeGeneration)
  ) {
    throw new SuSessionHostError(
      'invalid_descriptor',
      'backend extension and runtime generation must match the durable identity',
    );
  }
}

function parseCommand<B extends SuSessionBackend>(input: unknown): SuSessionCommand<B> {
  if (!isRecord(input)) {
    throw new SuSessionHostError('invalid_command', 'command body must be an object');
  }
  if (input.schema !== SU_SESSION_SCHEMA || input.protocolVersion !== SU_SESSION_PROTOCOL_VERSION) {
    throw new SuSessionHostError(
      'unsupported_protocol',
      `expected ${SU_SESSION_SCHEMA} protocol ${SU_SESSION_PROTOCOL_VERSION}`,
      409,
    );
  }
  if (
    typeof input.type !== 'string' ||
    !isSuSessionCommandType(input.type) ||
    typeof input.commandId !== 'string' ||
    input.commandId.length === 0 ||
    typeof input.issuedAt !== 'string' ||
    !isRecord(input.target)
  ) {
    throw new SuSessionHostError(
      'invalid_command',
      'command requires a known type, commandId, issuedAt, and target identity',
    );
  }
  return input as unknown as SuSessionCommand<B>;
}

function hostChannelKey(identity: SuSessionIdentity): string {
  return `su-session:${encodeURIComponent(identity.workspaceId)}:${encodeURIComponent(
    identity.harnessSlug ?? '',
  )}:${encodeURIComponent(identity.agentChatId)}`;
}

/** Stable identity of one native transcript record for `claimNativeRecord`:
 * its own id when the backend writes one (Claude `uuid`, OMP `id`), else the
 * exact line, which an append-only transcript never rewrites. */
export function nativeRecordKey(line: string, record: Record<string, unknown>): string {
  const id = typeof record.uuid === 'string' && record.uuid ? record.uuid
    : typeof record.id === 'string' && record.id ? record.id : null;
  return id ? `id:${id}` : `line:${createHash('sha256').update(line).digest('hex')}`;
}

export class SuSessionHost<B extends SuSessionBackend = SuSessionBackend> {
  readonly channelKey: string;
  private readonly channel: BusChannel<SuSessionEvent<B>>;
  private readonly now: () => Date;
  private executeCommand?: SuSessionCommandExecutor<B>;
  private runtimeReady: () => boolean;
  private readonly persistDescriptor?: (descriptor: SuSessionDescriptor<B>) => void | boolean | Promise<void | boolean>;
  private readonly commands = new Map<string, StoredCommand<B>>();
  private readonly durableCommands = new Map<string, {
    fingerprint: string;
    dispatch: Promise<SuSessionCommandDispatch<B>>;
  }>();
  private runtimeReconciliation: RuntimeReconciliation | null;
  private descriptorValue: SuSessionDescriptor<B>;
  private activeCommands = 0;
  private disposed = false;
  private descriptorWrite: Promise<void> | null = null;
  private descriptorWriteKey: string | undefined;
  private descriptorWriteRevision = 0;
  private pendingDescriptorWrite: { descriptor: SuSessionDescriptor<B>; key: string; revision: number } | null = null;
  private descriptorWriteWaiters: Array<{ revision: number; resolve: (ok: boolean) => void }> = [];
  /** Native transcript records this host has already turned into events, keyed
   * by `nativeRecordKey`. It outlives any one adapter, so a transcript replayed
   * by a second engine on the same host (a resume retry, an early and a late
   * replay) adds nothing the owner has already been shown (WI-10004162). */
  private readonly nativeRecords = new Set<string>();

  /** Record that this host has ingested one native record. True the first time
   * a key is seen; false when the host already holds it. */
  claimNativeRecord(key: string): boolean {
    if (this.nativeRecords.has(key)) return false;
    this.nativeRecords.add(key);
    return true;
  }

  constructor(options: SuSessionHostOptions<B>) {
    validateDescriptor(options.descriptor);
    this.descriptorValue = jsonClone(options.descriptor);
    this.now = options.now ?? (() => new Date());
    this.executeCommand = options.executeCommand;
    this.runtimeReady = options.runtimeReady ?? (() => true);
    this.persistDescriptor = options.persistDescriptor;
    this.runtimeReconciliation = options.runtimeReconciliation ?? null;
    this.channelKey = hostChannelKey(this.descriptorValue.identity);
    this.channel = getChannel<SuSessionEvent<B>>(this.channelKey, {
      ringSize: options.replaySize ?? 1024,
      subscriberQueueSize: options.subscriberQueueSize ?? 4096,
      // A durable session may remain owner-idle for hours. The host registry,
      // not the generic channel's producer-idle backstop, owns its lifetime.
      idleReapMs: 24 * 60 * 60 * 1000,
    });
    this.emit({
      type: 'session',
      descriptor: this.descriptorValue,
    } as SuSessionEventInput<B>);
  }

  descriptor(): SuSessionDescriptor<B> {
    return jsonClone(this.descriptorValue);
  }

  /**
   * Publish fresh serving-account provenance without changing the requested
   * route. A null value is intentional: it means the gateway has no current
   * route or the account could not be established, never "default".
   */
  updateAccountServed(accountServed: string | null): SuSessionEvent<B> | null {
    if (this.descriptorValue.accountServed === accountServed) return null;
    return this.emit({
      type: 'session',
      descriptor: { ...this.descriptorValue, accountServed },
    } as SuSessionEventInput<B>);
  }

  /** P-026: publish the model the engine now runs on, after it applied an
   * owner's switch, so the footer and /status read the engine's model rather
   * than the PUI's guess. */
  updateModel(model: string | null): SuSessionEvent<B> | null {
    if (this.descriptorValue.model === model) return null;
    return this.emit({
      type: 'session',
      descriptor: { ...this.descriptorValue, model },
    } as SuSessionEventInput<B>);
  }

  /** D-026: publish the approvals mode the engine now runs in, after it applied
   * an owner's switch, so /status reads the engine's mode. */
  updateApprovals(approvals: SuApprovalsMode): SuSessionEvent<B> | null {
    if (this.descriptorValue.approvals === approvals) return null;
    return this.emit({
      type: 'session',
      descriptor: { ...this.descriptorValue, approvals },
    } as SuSessionEventInput<B>);
  }

  /** D-029/D-031: merge fresh usage measurements into the descriptor. A field
   * the engine did not report keeps its last value; nothing is guessed. Emits
   * only when a value actually changed, so a repeated record costs nothing. */
  updateUsage(usage: SuSessionUsage): SuSessionEvent<B> | null {
    const measured = Object.fromEntries(
      Object.entries(usage).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0),
    ) as SuSessionUsage;
    const next: SuSessionUsage = { ...(this.descriptorValue.usage ?? {}), ...measured };
    const previous = this.descriptorValue.usage ?? {};
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof SuSessionUsage>;
    if (![...keys].some((key) => previous[key] !== next[key])) return null;
    return this.emit({
      type: 'session',
      descriptor: { ...this.descriptorValue, usage: next },
    } as SuSessionEventInput<B>);
  }

  /** D-029/D-031: replace the agent's todo/plan list. Emits only on change. */
  updatePlan(plan: readonly SuPlanItem[]): SuSessionEvent<B> | null {
    const next: readonly SuPlanItem[] = plan.map((item) => ({ text: item.text, status: item.status }));
    if (JSON.stringify(this.descriptorValue.plan ?? null) === JSON.stringify(next)) return null;
    return this.emit({
      type: 'session',
      descriptor: { ...this.descriptorValue, plan: next },
    } as SuSessionEventInput<B>);
  }

  /** Attach one replacement engine to a descriptor-only restored host. Keep
   * its channel and replay receipts; an existing executor cannot be displaced. */
  attachRuntime(options: Pick<SuSessionHostOptions<B>, 'descriptor' | 'executeCommand' | 'runtimeReady'>): void {
    validateDescriptor(options.descriptor);
    if (this.disposed || this.executeCommand || this.activeCommands || !options.executeCommand) {
      throw new SuSessionHostError('runtime_already_attached', 'only a restored host without an executor can be reattached', 409);
    }
    if (!identityMatches(this.descriptorValue.identity, options.descriptor.identity)
      || options.descriptor.runtimeGeneration <= this.descriptorValue.runtimeGeneration) {
      throw new SuSessionHostError('identity_conflict', 'resume must preserve identity and advance the runtime generation', 409);
    }
    this.executeCommand = options.executeCommand;
    this.runtimeReady = options.runtimeReady ?? (() => false);
    this.runtimeReconciliation = { action: 'reattach', reason: 'runtime_replacement', stalePid: false };
    this.emit({ type: 'session', descriptor: options.descriptor } as SuSessionEventInput<B>);
  }

  /** Codex/OMP assign their native id during the structured handshake. An
   * empty id represents initialization, never a resumable or writable session.
   * Only that initial empty slot can be filled; later identity changes remain
   * forbidden, including after a runtime replacement. */
  materializeNativeSessionId(nativeSessionId: string): void {
    if (this.disposed || this.descriptorValue.lifecycle !== 'starting'
      || this.descriptorValue.identity.nativeSessionId || !nativeSessionId.trim()) {
      throw new SuSessionHostError('identity_conflict', 'native identity can only be bound once during initialization', 409);
    }
    this.descriptorValue = {
      ...this.descriptorValue,
      identity: { ...this.descriptorValue.identity, nativeSessionId },
    } as SuSessionDescriptor<B>;
    this.emit({ type: 'session', descriptor: this.descriptorValue } as SuSessionEventInput<B>);
  }

  /**
   * Await the descriptor write that follows runtime identity materialization.
   * Ordinary lifecycle/event persistence remains best-effort, but a native id
   * must reach the adv row before a fast process exit can trigger archival.
   */
  async persistDescriptorNow(): Promise<boolean> {
    if (!this.persistDescriptor) return true;
    const revision = this.queueDescriptorWrite(true);
    return new Promise<boolean>((resolve) => { this.descriptorWriteWaiters.push({ revision, resolve }); });
  }

  private queueDescriptorWrite(force = false): number {
    if (!this.persistDescriptor) return this.descriptorWriteRevision;
    const descriptor = this.descriptor();
    const key = canonicalJson(descriptor);
    if (!force && key === this.descriptorWriteKey) return this.descriptorWriteRevision;
    this.descriptorWriteKey = key;
    const revision = ++this.descriptorWriteRevision;
    this.pendingDescriptorWrite = { descriptor, key, revision };
    this.drainDescriptorWrites();
    return revision;
  }

  private drainDescriptorWrites(): void {
    if (this.descriptorWrite || !this.persistDescriptor) return;
    const persist = this.persistDescriptor;
    // Start in a microtask so synchronous event bursts collapse to their latest
    // snapshot and durability waiters register before any write can settle.
    this.descriptorWrite = Promise.resolve().then(async () => {
      while (this.pendingDescriptorWrite) {
        const next = this.pendingDescriptorWrite;
        this.pendingDescriptorWrite = null;
        let ok = false;
        try { ok = (await persist(next.descriptor)) !== false; } catch { /* best-effort stream persistence */ }
        if (!ok && this.descriptorWriteKey === next.key) this.descriptorWriteKey = undefined;
        const settled = this.descriptorWriteWaiters.filter((waiter) => waiter.revision <= next.revision);
        this.descriptorWriteWaiters = this.descriptorWriteWaiters.filter((waiter) => waiter.revision > next.revision);
        for (const waiter of settled) waiter.resolve(ok);
      }
    }).finally(() => {
      this.descriptorWrite = null;
      // A mutation can arrive between the drain settling and this finally.
      if (this.pendingDescriptorWrite) this.drainDescriptorWrites();
    });
  }

  snapshot(): SuSessionHostSnapshot<B> {
    const recent = this.channel.recent;
    const lastSequence = recent.at(-1)?.id ?? 0;
    return {
      descriptor: this.descriptor(),
      floorSequence: recent[0]?.id ?? lastSequence,
      lastSequence,
      terminal: TERMINAL_STATES.has(this.descriptorValue.lifecycle),
      executorAttached: Boolean(this.descriptorValue.identity.nativeSessionId) && Boolean(this.executeCommand) && !this.disposed && this.runtimeReady(),
      streamReady: Boolean(this.descriptorValue.identity.nativeSessionId) && !this.disposed && this.runtimeReady(),
      runtimeReconciliation: this.runtimeReconciliation,
    };
  }

  /**
   * True when THIS process holds an engine for the session (an executor was
   * attached at launch or by a resume). A descriptor-only host rebuilt from the
   * durable row is false: on a clustered operator that is the signal to route
   * the request to the worker that does hold it (WI-10003879).
   */
  hasRuntime(): boolean {
    return Boolean(this.executeCommand) && !this.disposed;
  }

  get subscriberCount(): number {
    return this.channel.subscriberCount;
  }

  get recent(): ReadonlyArray<{ id: number; event: SuSessionEvent<B> }> {
    return this.channel.recent;
  }

  recentSince(sequence: number): ReadonlyArray<{ id: number; event: SuSessionEvent<B> }> {
    return this.channel.recentSince(sequence);
  }

  subscribe(): AsyncIterable<{ id: number; event: SuSessionEvent<B> }> {
    return this.channel.subscribe();
  }

  emit(input: SuSessionEventInput<B>): SuSessionEvent<B> {
    if (this.disposed) {
      throw new SuSessionHostError('host_disposed', 'SU-session host is disposed', 410);
    }
    const sequence = (this.channel.recent.at(-1)?.id ?? 0) + 1;
    const event = {
      ...jsonClone(input),
      schema: SU_SESSION_SCHEMA,
      protocolVersion: SU_SESSION_PROTOCOL_VERSION,
      eventId: `${this.descriptorValue.identity.agentChatId}:${sequence}`,
      sequence,
      at: this.now().toISOString(),
      session: jsonClone(this.descriptorValue.identity),
    } as unknown as SuSessionEvent<B>;

    if (event.type === 'lifecycle') {
      const current = this.descriptorValue.lifecycle;
      if (TERMINAL_STATES.has(current) && event.state !== current) {
        throw new SuSessionHostError(
          'terminal_state_conflict',
          `session already converged to ${current}; cannot transition to ${event.state}`,
          409,
        );
      }
      this.descriptorValue = {
        ...this.descriptorValue,
        lifecycle: event.state,
        runtimeGeneration: event.runtimeGeneration,
      } as SuSessionDescriptor<B>;
    } else if (event.type === 'session') {
      validateDescriptor(event.descriptor);
      if (!identityMatches(this.descriptorValue.identity, event.descriptor.identity)) {
        throw new SuSessionHostError(
          'identity_conflict',
          'session event cannot replace the durable SU-session identity',
          409,
        );
      }
      this.descriptorValue = jsonClone(event.descriptor) as SuSessionDescriptor<B>;
    } else if (event.type === 'backend') {
      this.descriptorValue = {
        ...this.descriptorValue,
        backendExtension: jsonClone(event.extension),
      } as SuSessionDescriptor<B>;
    }

    // Transcript chunks, tool updates and receipts do not change the descriptor.
    // Writing them used to create one overlapping adv_sessions UPDATE per event,
    // competing with command acceptance and allowing older snapshots to win.
    if (event.type === 'lifecycle' || event.type === 'session' || event.type === 'backend') {
      this.queueDescriptorWrite();
    }

    const id = this.channel.publish(event);
    if (id !== sequence) {
      throw new SuSessionHostError('sequence_conflict', `channel assigned ${id}; host expected ${sequence}`, 500);
    }
    return event;
  }

  transition(
    state: SuSessionLifecycleState,
    reason?: string,
    runtimeGeneration = this.descriptorValue.runtimeGeneration,
  ): SuSessionEvent<B> | null {
    const current = this.descriptorValue.lifecycle;
    if (current === state) return null;
    if (TERMINAL_STATES.has(current)) return null;
    // A terminal runtime can execute nothing. Release its executor so a
    // replacement can attach to THIS host (attachRuntime) and keep its channel
    // and receipts, as a restored host does after an operator restart; kept,
    // it refused every in-process reconnect with runtime_already_attached.
    if (TERMINAL_STATES.has(state)) {
      this.executeCommand = undefined;
      this.runtimeReady = () => false;
    }
    return this.emit({
      type: 'lifecycle',
      previousState: current,
      state,
      runtimeGeneration,
      ...(reason ? { reason } : {}),
    } as SuSessionEventInput<B>);
  }

  reconcileRuntimeExit(input: {
    expected: boolean;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
  }): SuSessionEvent<B> | null {
    // An engine's teardown can finish after its host was disposed (a reopen or
    // session end released it first). Nothing can observe that exit any more,
    // and emit() throws on a disposed host, which escaped as an unhandled error
    // from the engine's own cleanup.
    if (this.disposed) return null;
    const state: SuSessionLifecycleState = input.expected || input.exitCode === 0 ? 'ended' : 'failed';
    const detail =
      input.reason ??
      ([input.exitCode == null ? null : `exit=${input.exitCode}`, input.signal ? `signal=${input.signal}` : null]
        .filter(Boolean)
        .join(' ') ||
        (state === 'ended' ? 'runtime ended' : 'runtime exited unexpectedly'));
    return this.transition(state, detail);
  }

  /**
   * Production command door. Owner turns are committed with their exact text
   * before an acceptance event or engine call can escape. A prior receipt from
   * another host is replayed, never re-executed, even if delivery is uncertain.
   */
  async acceptCommand(
    input: unknown,
    store: SuSessionCommandStore = pgSuSessionCommandStore(),
  ): Promise<SuSessionCommandDispatch<B>> {
    const command = parseCommand<B>(input);
    if (command.type !== 'owner_turn') return this.startCommand(command);
    if (typeof command.content !== 'string' || !command.content.trim() || !command.turnId) {
      throw new SuSessionHostError('invalid_command', 'owner turn requires turnId and non-empty content');
    }
    // P-026: an omitted model keeps the current one; a present one must be a spec.
    if (command.model !== undefined && (typeof command.model !== 'string' || !command.model.trim())) {
      throw new SuSessionHostError('invalid_command', 'owner turn model must be a non-empty model[:effort] spec');
    }
    // D-026: an omitted approvals mode keeps the current one.
    if (command.approvals !== undefined && !isSuApprovalsMode(command.approvals)) {
      throw new SuSessionHostError('invalid_command', 'owner turn approvals must be one of ask, auto-edit, read-only');
    }
    const fingerprint = canonicalJson(command);
    const pending = this.durableCommands.get(command.commandId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new SuSessionHostError('command_id_conflict', 'commandId was reused with a different payload', 409);
      }
      return { ...(await pending.dispatch), replayed: true };
    }
    if (!identityMatches(this.descriptorValue.identity, command.target)) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'target_mismatch', message: 'command target does not match the attached durable SU session', retryable: false,
      });
    }
    if (!this.executeCommand || this.disposed || !this.runtimeReady() || ['starting', 'resuming', 'compacting'].includes(this.descriptorValue.lifecycle)) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'session_not_ready', message: 'the session executor and stream are not ready', retryable: true,
      });
    }
    const dispatch = (async (): Promise<SuSessionCommandDispatch<B>> => {
      const reserved = await store.reserve(command, fingerprint);
      if (reserved.receipt.fingerprint !== fingerprint) {
        throw new SuSessionHostError('command_id_conflict', 'commandId was already committed with a different payload', 409);
      }
      if (!reserved.created) {
        const outcome = reserved.receipt.outcome;
        const accepted = this.emit({
          type: 'command_result', commandId: command.commandId, commandType: command.type, status: 'accepted',
        } as SuSessionEventInput<B>) as CommandResult<B>;
        const terminal = this.emit({
          type: 'command_result', commandId: command.commandId, commandType: command.type,
          ...(outcome ?? {
            status: 'refused',
            refusal: {
              code: 'command_delivery_unknown',
              message: 'This turn was saved by an earlier host. Reconcile its delivery before retrying; it was not sent again.',
              retryable: false,
            },
          }),
        } as SuSessionEventInput<B>) as CommandResult<B>;
        return { accepted, terminal: Promise.resolve(terminal), replayed: true };
      }
      // A readiness refusal was not an acceptance and must not poison a later
      // retry after the executor attaches.
      this.commands.delete(command.commandId);
      const result = this.dispatchCommand(command, (outcome) => store.finish(command, fingerprint, outcome));
      if (!result.accepted) {
        const terminal = await result.terminal;
        if (terminal.status === 'refused') await store.finish(command, fingerprint, {
          status: 'refused', refusal: terminal.refusal,
        });
      }
      return result;
    })();
    this.durableCommands.set(command.commandId, { fingerprint, dispatch });
    try {
      return await dispatch;
    } catch (error) {
      this.durableCommands.delete(command.commandId);
      throw error;
    }
  }

  /** In-memory dispatch for attached adapters/tests; HTTP uses acceptCommand. */
  startCommand(input: unknown): SuSessionCommandDispatch<B> {
    return this.dispatchCommand(input);
  }

  private dispatchCommand(
    input: unknown,
    persistOutcome?: (outcome: SuSessionCommandOutcome) => Promise<void>,
  ): SuSessionCommandDispatch<B> {
    const command = parseCommand<B>(input);
    const fingerprint = canonicalJson(command);
    const existing = this.commands.get(command.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.emit({
          type: 'error',
          scope: 'command',
          code: 'command_id_conflict',
          message: `commandId ${command.commandId} was reused with a different payload`,
          recoverable: false,
          commandId: command.commandId,
        } as SuSessionEventInput<B>);
        throw new SuSessionHostError(
          'command_id_conflict',
          `commandId ${command.commandId} already belongs to a different command`,
          409,
        );
      }
      return {
        accepted: existing.accepted,
        terminal: existing.terminal,
        replayed: true,
      };
    }

    const identity = this.descriptorValue.identity;
    if (!identityMatches(identity, command.target)) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'target_mismatch',
        message: 'command target does not match the attached durable SU session',
        retryable: false,
      });
    }
    if (TERMINAL_STATES.has(this.descriptorValue.lifecycle)) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'session_terminal',
        message: `session is already ${this.descriptorValue.lifecycle}`,
        retryable: false,
      });
    }

    const support = this.descriptorValue.capabilities.commands[command.type];
    if (support.state === 'unsupported') {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'unsupported',
        message: support.reason,
        retryable: false,
      });
    }
    if (!this.executeCommand) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'backend_adapter_unavailable',
        message: `no ${identity.backend} runtime adapter is attached`,
        retryable: true,
      });
    }

    const accepted = this.emit({
      type: 'command_result',
      commandId: command.commandId,
      commandType: command.type,
      status: 'accepted',
    } as SuSessionEventInput<B>) as CommandResult<B>;

    this.activeCommands += 1;
    const terminal = Promise.resolve().then(async () => {
      try {
        const outcome = await this.executeCommand!(command, {
          descriptor: () => this.descriptor(),
          emit: (event) => this.emit(event),
          transition: (state, reason, runtimeGeneration) => this.transition(state, reason, runtimeGeneration),
        });
        if (persistOutcome) {
          try {
            await persistOutcome(outcome);
          } catch (error) {
            throw new SuSessionHostError('command_delivery_unknown',
              `The engine returned but its receipt could not be settled: ${error instanceof Error ? error.message : String(error)}. Reconcile delivery before retrying.`);
          }
        }
        const result = this.emit(
          outcome.status === 'completed'
            ? ({
                type: 'command_result',
                commandId: command.commandId,
                commandType: command.type,
                status: 'completed',
              } as SuSessionEventInput<B>)
            : ({
                type: 'command_result',
                commandId: command.commandId,
                commandType: command.type,
                status: 'refused',
                refusal: outcome.refusal,
              } as SuSessionEventInput<B>),
        ) as CommandResult<B>;

        if (outcome.status === 'completed' && command.type === 'interrupt') {
          this.transition('interrupted', 'interrupt command completed');
        }
        if (outcome.status === 'completed' && command.type === 'end') {
          this.transition('ended', 'end command completed');
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof SuSessionHostError ? error.code : 'runtime_command_failed';
        this.emit({
          type: 'error',
          scope: 'command',
          code,
          message,
          recoverable: true,
          commandId: command.commandId,
          details: { backend: identity.backend } as SuSessionJsonValue,
        } as SuSessionEventInput<B>);
        return this.emit({
          type: 'command_result',
          commandId: command.commandId,
          commandType: command.type,
          status: 'refused',
          refusal: {
            code,
            message,
            retryable: code !== 'command_delivery_unknown',
          },
        } as SuSessionEventInput<B>) as CommandResult<B>;
      } finally {
        this.activeCommands = Math.max(0, this.activeCommands - 1);
      }
    });
    // A host disposed mid-command (startup exit, reopen or end released it) can
    // no longer emit, so this chain rejects with host_disposed. The HTTP door
    // returns on acceptance and never awaits it, so mark the rejection handled
    // here; a caller that does await `terminal` still observes it.
    terminal.catch((error: unknown) => {
      if (error instanceof SuSessionHostError && error.code === 'host_disposed') return;
      console.warn('[su-session] command terminal failed', error);
    });

    this.commands.set(command.commandId, { fingerprint, accepted, terminal });
    return { accepted, terminal, replayed: false };
  }

  private rememberImmediateRefusal(
    command: SuSessionCommand<B>,
    fingerprint: string,
    refusal: SuSessionRefusal,
  ): SuSessionCommandDispatch<B> {
    const terminalEvent = this.emit({
      type: 'command_result',
      commandId: command.commandId,
      commandType: command.type,
      status: 'refused',
      refusal,
    } as SuSessionEventInput<B>) as CommandResult<B>;
    const terminal = Promise.resolve(terminalEvent);
    this.commands.set(command.commandId, {
      fingerprint,
      accepted: null,
      terminal,
    });
    return { accepted: null, terminal, replayed: false };
  }

  dispose(reason = 'host disposed'): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.done({ reason, activeCommands: this.activeCommands });
    dropChannel(this.channelKey);
  }
}

type RegisteredHost = SuSessionHost<SuSessionBackend>;
const hostRegistry = pinModuleState(
  '@papercusp/operator-core.su-session-host-registry',
  () => new Map<string, RegisteredHost>(),
);

function registry(): Map<string, RegisteredHost> {
  return hostRegistry;
}

export function registerSuSessionHost<B extends SuSessionBackend>(host: SuSessionHost<B>): () => void {
  const key = host.channelKey;
  const existing = registry().get(key);
  if (existing && existing !== (host as unknown as RegisteredHost)) {
    throw new SuSessionHostError(
      'host_already_registered',
      `a different SU-session host is already registered for ${key}`,
      409,
    );
  }
  registry().set(key, host as unknown as RegisteredHost);
  return () => {
    if (registry().get(key) === (host as unknown as RegisteredHost)) {
      registry().delete(key);
      host.dispose('host unregistered');
    }
  };
}

export function getRegisteredSuSessionHost(input: {
  workspaceId: string;
  harnessSlug: string | null;
  agentChatId: string;
}): RegisteredHost | null {
  const key = hostChannelKey({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    agentChatId: input.agentChatId,
    advSessionId: 1,
    backend: 'claude',
    nativeSessionId: '',
    ownerId: '',
  });
  return registry().get(key) ?? null;
}

/**
 * Rehydrate a host after an operator/PUI runtime restart. The descriptor is
 * loaded from the same `adv_sessions` row that owns the native identity; no
 * new adv row or native id is minted. A rehydrated host has no runtime
 * executor until the backend adapter reattaches, so command POSTs fail closed
 * with the existing retryable adapter-unavailable refusal.
 */
export async function rehydrateRegisteredSuSessionHost(input: {
  workspaceId: string;
  harnessSlug: string | null;
  agentChatId: string;
}): Promise<RegisteredHost | null> {
  const existing = getRegisteredSuSessionHost(input);
  if (existing) return existing;
  const record = await readDurableSuSession({
    agentChatId: input.agentChatId,
    workspaceId: input.workspaceId,
  });
  if (!record?.descriptor) return null;
  const { descriptor } = record;
  if (
    descriptor.identity.agentChatId !== input.agentChatId ||
    descriptor.identity.workspaceId !== input.workspaceId ||
    (descriptor.identity.harnessSlug !== null && descriptor.identity.harnessSlug !== input.harnessSlug)
  ) return null;
  // Classify the durable row against the runtime we actually found. This is the
  // ONLY production caller of classifySuSessionRuntime: rebuilding a host from a
  // persisted descriptor IS the restart reconciliation the classifier describes,
  // so a rehydrate that skipped it left PUI unable to tell an ended/archived
  // session being rematerialised from a live reattach.
  const runtimeReconciliation = classifySuSessionRuntime(record, isPidAlive);
  try {
    const host = new SuSessionHost({
      descriptor,
      runtimeReconciliation,
      persistDescriptor: async (next) => {
        await persistSuSessionDescriptor(next.identity.advSessionId, next);
      },
    });
    registerSuSessionHost(host);
    return host as unknown as RegisteredHost;
  } catch {
    return getRegisteredSuSessionHost(input);
  }
}

export type SuSessionSseEvents = Record<'session_event', SuSessionEvent> & Record<string, unknown>;

/**
 * Bridge one host onto the existing SSE transport. Subscription is installed
 * before the replay snapshot is captured; queued items at/below the snapshot
 * ceiling are de-duplicated, closing the replay/live race.
 */
export function createSuSessionEventResponse(
  request: Request,
  host: RegisteredHost,
  options: {
    heartbeatMs?: number;
    backpressureTimeoutMs?: number;
    /** Renew the session's client lease while this stream is open (P-009). */
    trackClient?: boolean;
  } = {},
): Response {
  const lastEventId = parseLastEventId(request) ?? 0;
  const source = host.subscribe();
  const replay = [...host.recentSince(lastEventId)];
  const replayCeiling = replay.at(-1)?.id ?? lastEventId;
  const snapshot = host.snapshot();
  // P-009: an open stream is the evidence that a client is watching this
  // session. Any worker serving one renews the durable lease, so the worker
  // that owns the engine can tell an attended session from an abandoned one.
  const releaseClient = options.trackClient === false || snapshot.terminal
    ? () => undefined
    : trackSuClientStream(host.descriptor().identity.advSessionId);
  request.signal.addEventListener('abort', releaseClient, { once: true });

  return sseResponse<SuSessionSseEvents>({
    signal: request.signal,
    lastEventId,
    heartbeatMs: options.heartbeatMs,
    backpressureTimeoutMs: options.backpressureTimeoutMs,
    replay: () =>
      replay.map(({ id, event }) => ({
        name: 'session_event' as const,
        data: event,
        id,
      })),
    resumeBounds: () => ({
      floorId: snapshot.floorSequence,
      maxId: snapshot.lastSequence,
    }),
    headers: {
      'X-Papercusp-Su-Session': host.descriptor().identity.agentChatId,
    },
    setup: async (sink) => {
      const iterator = source[Symbol.asyncIterator]();
      sink.onClose(() => {
        releaseClient();
        void iterator.return?.();
      });
      if (host.snapshot().terminal) {
        sink.done({ reason: 'terminal', snapshot: host.snapshot() });
        return;
      }
      while (!sink.closed) {
        const next = await iterator.next();
        if (next.done) {
          // The host's channel closed without a terminal event: the host was
          // disposed (unregistered, or its process is going away), not the
          // session. Returning alone would leave this response open on
          // heartbeats forever, so a client would wait on a host that can never
          // emit again (pui-chat-first-ux-2026-09-28 P-002). Close it so the
          // client re-subscribes to whatever host now serves the chat.
          sink.close();
          return;
        }
        if (next.value.id <= replayCeiling) continue;
        sink.event('session_event', next.value.event, { id: next.value.id });
        if (next.value.event.type === 'lifecycle' && TERMINAL_STATES.has(next.value.event.state)) {
          sink.done({ reason: 'terminal', snapshot: host.snapshot() });
          return;
        }
      }
    },
  });
}

/**
 * Test-only: simulate the death of the process that owned ONE host. The host
 * leaves this process's registry and its SSE channel closes, while the durable
 * row stays exactly as that process last wrote it, so the next request meets a
 * rehydrated descriptor-only host. That is the pui-chat-first-ux-2026-09-28
 * P-002 seam (session 31362: the launching operator worker died mid-startup).
 */
export function _dropSuSessionHostForTest(host: { channelKey: string }): void {
  const registered = registry().get(host.channelKey);
  if (!registered) return;
  registry().delete(host.channelKey);
  registered.dispose('owning process lost (test)');
}

/** Test-only: dispose all registered hosts and clear their channels. */
export function _resetSuSessionHostsForTest(): void {
  for (const host of registry().values()) host.dispose('test reset');
  registry().clear();
}
