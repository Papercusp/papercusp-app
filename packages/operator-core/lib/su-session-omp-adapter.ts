/**
 * OMP backend for the shared PUI SU-session host.
 *
 * OMP already persists a thread id and append-only JSONL session under its
 * per-session agent home. This adapter binds that native identity to the
 * existing PUI/adv-session and SuSessionHost surfaces; it does not introduce a
 * parallel OMP store or launcher. P-004 owns durable rematerialisation.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';

import {
  assertNeverSuSession,
  type OpenCardSnapshot,
  type SuSessionCapabilities,
  type SuSessionCommand,
  type SuSessionDescriptor,
  type SuSessionJsonValue,
  type SuSessionRefusal,
} from '@papercusp/chat-protocol';

import { getAdvSession } from './adv-sessions';
import {
  findLiveHost,
  injectIntoHostWithConfirmation,
  interruptViaPty,
  shutdownViaPty,
} from './events/await/psu-pty-discovery';
import {
  openPuiSuSession,
  type AttachPuiSuSessionInput,
  type CreatePuiSuSessionInput,
  type PuiSuSessionBinding,
  type PuiSuSessionResult,
} from './launch-agent';
import { nativeSessionHandleForAdvSession, type OmpNativeSessionHandle } from './native-session-handles';
import { bindSuSessionToAdvSession, persistSuSessionDescriptor } from './su-session-persistence';
import { findOmpSessionPath, ompAgentHomeForSessionKey } from './session-transcript-resolvers';
import { createOmpTimelineParser, type TimelineLineParser } from './session-timeline-parsers';
import { gatewayServedAccountForOwner } from './compaction-usage';
import {
  SuSessionHost,
  registerSuSessionHost,
  type SuSessionCommandContext,
  type SuSessionCommandOutcome,
  type SuSessionEventInput,
  type SuSessionServedAccountReader,
} from './su-session-host';

export type OmpPuiSuSessionInput =
  | (Omit<CreatePuiSuSessionInput, 'backend'> & { backend: 'omp' })
  | (Omit<AttachPuiSuSessionInput, 'backend'> & { backend: 'omp' });

export interface OmpSuRuntimeBinding {
  nativeSession: OmpNativeSessionHandle & {
    ompThreadId: string;
  };
  /** Null before OMP writes its first session record. */
  transcriptPath: string | null;
}

export type OmpNativeCommandVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface OmpSuSessionControls {
  ownerTurn(input: { ownerId: string; turnId: string; content: string }): Promise<OmpNativeCommandVerdict>;
  interrupt(input: { ownerId: string; reason?: string }): Promise<OmpNativeCommandVerdict>;
  resume(input: {
    ownerId: string;
    threadId: string;
    cause: Extract<SuSessionCommand<'omp'>, { type: 'resume' }>['cause'];
  }): Promise<OmpNativeCommandVerdict>;
  focus(input: { ownerId: string }): Promise<OmpNativeCommandVerdict>;
  end(input: { ownerId: string; reason?: string }): Promise<OmpNativeCommandVerdict>;
}

export interface OmpSuSessionDescriptorOptions {
  agentChatId: string;
  model?: string | null;
  accountRoute?: string | null;
  servedAccountReader?: SuSessionServedAccountReader;
  carry?: 'warm' | 'cold';
  modes?: readonly string[];
  runtimeGeneration?: number;
}

export interface CreateOmpSuSessionAdapterOptions extends OmpSuSessionDescriptorOptions {
  host?: SuSessionHost<'omp'>;
  controls?: Partial<OmpSuSessionControls>;
  ready?: boolean;
  runtimeReady?: () => boolean;
  register?: boolean;
}

export interface OpenOmpSuSessionOptions extends CreateOmpSuSessionAdapterOptions {
  openSession?: (input: OmpPuiSuSessionInput) => Promise<PuiSuSessionResult>;
  resolveRuntime?: (binding: PuiSuSessionBinding) => Promise<OmpSuRuntimeBinding | null>;
}

export type OpenOmpSuSessionResult =
  | {
      ok: true;
      binding: PuiSuSessionBinding & { backend: 'omp' };
      runtime: OmpSuRuntimeBinding;
      adapter: OmpSuSessionAdapter;
    }
  | { ok: false; code: string; error: string; binding?: PuiSuSessionBinding };

function materializedOmpHandle(
  handle: OmpNativeSessionHandle | null | undefined,
  advSessionId?: number,
): OmpSuRuntimeBinding['nativeSession'] | null {
  if (!handle?.ompThreadId || !handle.exactResumeSupported || handle.missingReason) return null;
  return {
    ...handle,
    // launch-su attach responses historically normalized adv rows against the
    // operator's ambient shared OMP home. The adv row is the authority for a
    // tracked session, and its store is always keyed by that row id; repair the
    // returned handle at the adapter boundary rather than trusting a stale root.
    agentHome: advSessionId == null ? handle.agentHome : ompAgentHomeForSessionKey(advSessionId),
    ompThreadId: handle.ompThreadId,
    exactResumeSupported: true,
    missingReason: null,
  };
}

async function findOmpTranscript(handle: OmpNativeSessionHandle, advSessionId: number): Promise<string | null> {
  if (!handle.ompThreadId) return null;
  const rootOverride = handle.agentHome ? join(handle.agentHome, 'sessions') : undefined;
  return findOmpSessionPath(handle.ompThreadId, {
    rootOverride,
    sessionKey: rootOverride ? undefined : advSessionId,
  });
}

/** Resolve the existing adv-session/native OMP identity once. */
export async function resolveOmpSuRuntime(binding: PuiSuSessionBinding): Promise<OmpSuRuntimeBinding | null> {
  if (binding.backend !== 'omp') return null;
  const returnedHandle = binding.nativeSession?.backend === 'omp'
    ? materializedOmpHandle(binding.nativeSession, binding.advSessionId)
    : null;
  if (returnedHandle) {
    return {
      nativeSession: returnedHandle,
      transcriptPath: await findOmpTranscript(returnedHandle, binding.advSessionId),
    };
  }

  const row = await getAdvSession(binding.advSessionId);
  if (!row || row.agent !== 'omp') return null;
  const provisional = nativeSessionHandleForAdvSession(row);
  if (!provisional || provisional.backend !== 'omp') return null;
  const native = materializedOmpHandle(provisional);
  if (!native) return null;
  return {
    nativeSession: native,
    transcriptPath: await findOmpTranscript(native, binding.advSessionId),
  };
}

function refused(code: string, message: string, retryable = true): Exclude<OmpNativeCommandVerdict, { ok: true }> {
  return { ok: false, code, message, retryable };
}

function defaultControls(): OmpSuSessionControls {
  return {
    async ownerTurn({ ownerId, content }) {
      const host = findLiveHost(ownerId);
      if (!host) return refused('runtime_unavailable', 'OMP has no live managed-PTY host');
      const delivered = await injectIntoHostWithConfirmation(host.sock, { mode: 'turn', data: content, ownerId });
      if (!delivered.ok) {
        return refused(
          'owner_turn_delivery_failed',
          `OMP owner turn was refused by the managed runtime (${delivered.reason ?? delivered.confirmation})`,
        );
      }
      if (delivered.confirmation !== 'acked') {
        return refused(
          'owner_turn_delivery_unconfirmed',
          'OMP runtime closed the control socket without an application-level acknowledgement',
        );
      }
      return { ok: true };
    },
    async interrupt({ ownerId }) {
      return (await interruptViaPty(ownerId, 'sigint'))
        ? { ok: true }
        : refused('interrupt_unavailable', 'OMP runtime could not be interrupted');
    },
    async resume({ ownerId }) {
      return findLiveHost(ownerId)
        ? { ok: true }
        : refused(
            'runtime_reconciliation_required',
            'OMP runtime is not live; exact native resume must be reconciled before this command can complete',
          );
    },
    async focus() {
      return { ok: true };
    },
    async end({ ownerId, reason }) {
      const result = await shutdownViaPty(ownerId, { reason });
      return result === 'sent'
        ? { ok: true }
        : refused('end_refused', `OMP runtime did not accept end (${result})`, false);
    },
  };
}

/**
 * The OMP engine's published capability table. Exported so the cross-engine
 * parity pin can assert it directly: it is already part of the public contract
 * (it ships inside every descriptor the PUI reads), and P-006 requires that
 * every non-`supported` entry carry an explanation the PUI can actually show.
 */
export function ompCapabilities(): SuSessionCapabilities {
  return {
    commands: {
      owner_turn: { state: 'supported', implementation: 'native' },
      interrupt: { state: 'supported', implementation: 'native' },
      resume: {
        state: 'conditional', implementation: 'native',
        reason: 'requires the tracked OMP thread id and a live or P-004-reconciled managed runtime',
      },
      fork: {
        state: 'conditional', implementation: 'native',
        reason: 'forks must be created through the tracked launcher so they receive a new durable identity',
      },
      focus: { state: 'supported', implementation: 'host' },
      end: {
        state: 'conditional', implementation: 'native',
        reason: 'the managed host may refuse to close a human-attended runtime',
      },
    },
    features: {
      'tool-events': { state: 'supported', implementation: 'native' },
      'interactive-cards': {
        state: 'conditional', implementation: 'native',
        reason: 'OMP tool-call records can carry AskUserQuestion-compatible input when a model emits it',
      },
      'reasoning-stream': { state: 'supported', implementation: 'native' },
      usage: {
        state: 'conditional', implementation: 'native',
        reason: 'OMP message records may carry usage/cost metadata but the v1 SU-session event contract has no usage event',
      },
      compaction: {
        state: 'conditional', implementation: 'host',
        reason: 'OMP carry uses the managed host hard-recycle path and P-004 runtime reconciliation',
      },
      approvals: {
        state: 'conditional', implementation: 'native',
        reason: 'PUI attached launches and resumptions install OMP native question callbacks with always-ask approval. Other managed engine callers must opt into toolApproval prompt.',
      },
      context: {
        state: 'unsupported',
        reason: 'the v1 SU-session contract carries no context event or descriptor field, so OMP context consumption stays inside the native runtime and never reaches the PUI',
      },
      modes: {
        state: 'conditional', implementation: 'host',
        reason: 'the descriptor reports modes supplied by the managed launch and preserved across resume, but the v1 command set has no mode-change command and the descriptor is not refreshed when modes change mid-session',
      },
    },
  };
}

function asJsonValue(value: unknown): SuSessionJsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as SuSessionJsonValue;
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function commandRefusal(verdict: Exclude<OmpNativeCommandVerdict, { ok: true }>): SuSessionCommandOutcome {
  const refusal: SuSessionRefusal = { code: verdict.code, message: verdict.message, retryable: verdict.retryable };
  return { status: 'refused', refusal };
}

function descriptorFor(
  binding: PuiSuSessionBinding,
  runtime: OmpSuRuntimeBinding,
  options: OmpSuSessionDescriptorOptions,
): SuSessionDescriptor<'omp'> {
  if (!binding.ownerId || !binding.workspaceId) throw new Error('OMP SU-session binding requires ownerId and workspaceId');
  return {
    identity: {
      agentChatId: options.agentChatId,
      advSessionId: binding.advSessionId,
      backend: 'omp',
      nativeSessionId: runtime.nativeSession.ompThreadId,
      ownerId: binding.ownerId,
      workspaceId: binding.workspaceId,
      harnessSlug: binding.harnessSlug,
    },
    lifecycle: 'starting',
    runtimeGeneration: options.runtimeGeneration ?? 0,
    role: 'su',
    model: options.model ?? null,
    accountServed: null,
    accountRoute: options.accountRoute ?? null,
    carry: options.carry ?? 'warm',
    modes: [...(options.modes ?? [])],
    capabilities: ompCapabilities(),
    backendExtension: { backend: 'omp', agentHome: runtime.nativeSession.agentHome },
  };
}

function cardFromOmpTool(callId: string, turnId: string, input: unknown): OpenCardSnapshot | null {
  const rec = asRecord(input);
  const questions = Array.isArray(rec?.questions) ? rec.questions : [];
  const question = asRecord(questions[0]);
  const prompt = firstString(question?.question, question?.prompt);
  if (!question || !prompt) return null;
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  const options = rawOptions.map((value, index) => {
    const option = asRecord(value);
    const label = firstString(option?.label, option?.name) ?? `Option ${index + 1}`;
    const id = firstString(option?.id) ?? `${callId}:option-${index + 1}`;
    const description = firstString(option?.description);
    return { id, label, ...(description ? { description } : {}) };
  });
  return {
    correlationId: callId,
    createdAt: Date.now(),
    prompt,
    fallbackText: prompt,
    allowDecline: true,
    presentation: { kind: question.multiSelect === true ? 'checkbox' : 'radio', ...(options.length ? { options } : {}) },
  };
}

function toolResultError(record: Record<string, unknown>, callId: string): boolean {
  const message = asRecord(record.message);
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  const block = content.find((value) => asRecord(value)?.toolCallId === callId || asRecord(value)?.tool_call_id === callId);
  const result = asRecord(block);
  return result?.isError === true || result?.is_error === true;
}

function recordIndicatesCompaction(record: Record<string, unknown>): boolean {
  const type = String(record.type ?? '').toLowerCase();
  const subtype = String(record.subtype ?? record.status ?? '').toLowerCase();
  return type.includes('compact') || subtype.includes('compact') || record.isCompaction === true;
}

function recordEndsTurn(record: Record<string, unknown>): boolean {
  const type = String(record.type ?? '').toLowerCase();
  if (type === 'turn_end' || type === 'message_end') return true;
  const message = asRecord(record.message);
  return type === 'message' && message?.role === 'assistant' && message?.stopReason != null;
}

export class OmpSuSessionAdapter {
  readonly host: SuSessionHost<'omp'>;
  private runtimeValue: OmpSuRuntimeBinding;
  private parser: TimelineLineParser = createOmpTimelineParser();
  private currentTurnId: string | null = null;
  private turnSerial = 0;
  private readonly toolNames = new Map<string, string>();
  private readonly cards = new Map<string, { correlationId: string; turnId: string }>();
  private readonly controls: OmpSuSessionControls;
  private readonly unregister: (() => void) | null;
  private lastErrorKey: string | null = null;
  private readonly servedAccountReader: SuSessionServedAccountReader;
  /**
   * Set once a `model_change` record has named the resolved model. OMP stamps
   * assistant messages with a BARE id (`stealth/ox-alpha`) while `model_change`
   * carries the provider-qualified one (`openrouter/stealth/ox-alpha`), so
   * accepting both would flap the descriptor between two spellings of the same
   * model. `model_change` wins; the assistant stamp is only a fallback for a
   * transcript that never emitted one.
   */
  private sawResolvedModel = false;

  constructor(
    readonly binding: PuiSuSessionBinding & { backend: 'omp' },
    runtime: OmpSuRuntimeBinding,
    options: CreateOmpSuSessionAdapterOptions,
  ) {
    this.runtimeValue = runtime;
    this.servedAccountReader = options.servedAccountReader ?? gatewayServedAccountForOwner;
    this.controls = { ...defaultControls(), ...(options.controls ?? {}) };
    const hostOptions = {
      descriptor: descriptorFor(binding, runtime, options),
      executeCommand: (command: SuSessionCommand<'omp'>, context: SuSessionCommandContext<'omp'>) => this.execute(command, context),
      runtimeReady: options.runtimeReady,
      persistDescriptor: async (descriptor: SuSessionDescriptor<'omp'>) => { await persistSuSessionDescriptor(binding.advSessionId, descriptor); },
    };
    this.host = options.host ?? new SuSessionHost(hostOptions);
    if (options.host) this.host.attachRuntime(hostOptions);
    void bindSuSessionToAdvSession({
      advSessionId: binding.advSessionId,
      agentChatId: options.agentChatId,
      descriptor: this.host.descriptor(),
      workspaceId: binding.workspaceId ?? undefined,
    }).catch(() => undefined);
    this.unregister = options.register === false ? null : registerSuSessionHost(this.host);
    if (options.ready !== false) this.host.transition('ready', 'OMP native runtime attached');
  }

  get runtime(): OmpSuRuntimeBinding { return this.runtimeValue; }

  /** Refresh gateway serving-account provenance after a known native turn. */
  async refreshAccountServed(): Promise<void> {
    let account: string | null;
    try {
      account = await this.servedAccountReader(this.host.descriptor().identity.ownerId);
    } catch {
      return;
    }
    this.host.updateAccountServed(account);
  }

  async materializeRuntime(runtime: OmpSuRuntimeBinding): Promise<void> {
    if (this.host.descriptor().identity.nativeSessionId !== runtime.nativeSession.ompThreadId) {
      this.host.materializeNativeSessionId(runtime.nativeSession.ompThreadId);
      if (!await this.host.persistDescriptorNow()) {
        throw new Error('Could not persist the native session identity and resume descriptor');
      }
    }
    this.runtimeValue = runtime;
  }

  private nextTurnId(hint?: string | null): string {
    this.turnSerial += 1;
    const safeHint = String(hint ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    return safeHint
      ? `omp:${safeHint}:${this.turnSerial}`
      : `omp:${this.host.descriptor().identity.nativeSessionId}:turn-${this.turnSerial}`;
  }

  private ensureTurn(hint?: string | null): string {
    if (!this.currentTurnId) this.currentTurnId = this.nextTurnId(hint);
    return this.currentTurnId;
  }

  private emitTranscript(input: { turnId: string; role: 'owner' | 'assistant' | 'system'; channel: 'text' | 'reasoning'; content: string }): void {
    this.host.emit({ type: 'transcript', phase: 'started', turnId: input.turnId, role: input.role, channel: input.channel } as SuSessionEventInput<'omp'>);
    if (input.content) this.host.emit({ type: 'transcript', phase: 'delta', turnId: input.turnId, role: input.role, channel: input.channel, content: input.content } as SuSessionEventInput<'omp'>);
    this.host.emit({ type: 'transcript', phase: 'completed', turnId: input.turnId, role: input.role, channel: input.channel, ...(input.content ? { content: input.content } : {}) } as SuSessionEventInput<'omp'>);
  }

  ingestNativeLine(line: string, { preserveLifecycle = false }: { preserveLifecycle?: boolean } = {}): void {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; }
    catch {
      this.host.emit({ type: 'error', scope: 'transport', code: 'omp_record_malformed', message: 'OMP transcript emitted a malformed JSONL record', recoverable: true } as SuSessionEventInput<'omp'>);
      return;
    }
    const recordId = firstString(record.id, record.entryId, record.messageId);
    const messageRecord = asRecord(record.message);
    const messageToolId = firstString(messageRecord?.toolCallId, messageRecord?.tool_call_id);
    if (!preserveLifecycle && recordIndicatesCompaction(record)) this.host.transition('compacting', 'OMP native transcript compacted');

    // A launch `--model` is only a REQUEST. OMP resolves it — and records
    // `resolvedModelIsFallback` when the requested model was not available — so
    // the descriptor must be corrected to the model that actually ran, exactly
    // as the Claude (system/init + assistant records) and Codex (turn_context)
    // adapters do. Without this an OMP session shows the requested model for
    // its whole life, including after a mid-session `model_change`.
    const resolvedModel = record.type === 'model_change'
      ? firstString(record.model)
      : !this.sawResolvedModel && record.type === 'message' && messageRecord?.role === 'assistant'
        ? firstString(messageRecord?.model)
        : null;
    if (resolvedModel) {
      if (record.type === 'model_change') this.sawResolvedModel = true;
      const descriptor = this.host.descriptor();
      if (descriptor.model !== resolvedModel) {
        this.host.emit({
          type: 'session',
          descriptor: { ...descriptor, model: resolvedModel },
        } as SuSessionEventInput<'omp'>);
      }
    }

    for (const entry of this.parser.parseLine(line)) {
      const turnId = entry.kind === 'prompt'
        ? (this.currentTurnId = this.nextTurnId(recordId))
        : this.ensureTurn(recordId);
      if (entry.kind === 'prompt') {
        if (!preserveLifecycle) this.host.transition('running', 'OMP owner turn persisted');
        this.emitTranscript({ turnId, role: 'owner', channel: 'text', content: entry.text ?? '' });
      } else if (entry.kind === 'text') {
        this.emitTranscript({ turnId, role: 'assistant', channel: 'text', content: entry.text ?? '' });
      } else if (entry.kind === 'status') {
        const text = entry.text ?? '';
        const thinking = text.startsWith('[thinking]');
        this.emitTranscript({ turnId, role: thinking ? 'assistant' : 'system', channel: thinking ? 'reasoning' : 'text', content: text.replace(/^\[thinking\]\s*/, '') });
      } else if (entry.kind === 'tool_use') {
        const callId = entry.toolId ?? `omp-call-${this.toolNames.size + 1}`;
        const name = entry.toolName ?? 'tool';
        this.toolNames.set(callId, name);
        this.host.emit({ type: 'tool', phase: 'started', turnId, callId, name, input: asJsonValue(entry.toolInput) } as SuSessionEventInput<'omp'>);
        if (name === 'AskUserQuestion') {
          const card = cardFromOmpTool(callId, turnId, entry.toolInput);
          if (card) {
            this.cards.set(callId, { correlationId: callId, turnId });
            this.host.emit({ type: 'card', phase: 'opened', turnId, card } as SuSessionEventInput<'omp'>);
          }
        }
      } else if (entry.kind === 'tool_result') {
        const callId = entry.toolId ?? messageToolId ?? `omp-result-${this.toolNames.size + 1}`;
        const name = this.toolNames.get(callId) ?? 'tool';
        const isError = toolResultError(record, callId);
        this.host.emit({ type: 'tool', phase: 'completed', turnId, callId, name, output: asJsonValue(entry.text ?? ''), isError } as SuSessionEventInput<'omp'>);
        const card = this.cards.get(callId);
        if (card) {
          this.host.emit({ type: 'card', phase: 'closed', turnId: card.turnId, correlationId: card.correlationId, resolution: isError ? 'cancelled' : 'submitted' } as SuSessionEventInput<'omp'>);
          this.cards.delete(callId);
        }
      }
    }
    const message = asRecord(record.message);
    const errorMessage = firstString(message?.errorMessage, message?.error);
    if (errorMessage && String(message?.stopReason ?? '').toLowerCase() === 'error') {
      const key = `error\u0000${errorMessage}`;
      if (key !== this.lastErrorKey) {
        this.lastErrorKey = key;
        this.host.emit({ type: 'error', scope: 'turn', code: 'omp_runtime_error', message: errorMessage, recoverable: true } as SuSessionEventInput<'omp'>);
      }
    }
    if (recordEndsTurn(record)) {
      if (!preserveLifecycle) this.host.transition('waiting-for-owner', errorMessage ? 'OMP turn failed' : 'OMP turn completed');
      this.currentTurnId = null;
    }
  }

  async consumeNativeLines(lines: AsyncIterable<string>): Promise<void> {
    try { for await (const line of lines) this.ingestNativeLine(line); }
    catch (error) {
      this.host.emit({ type: 'error', scope: 'transport', code: 'omp_transcript_stream_failed', message: error instanceof Error ? error.message : String(error), recoverable: true } as SuSessionEventInput<'omp'>);
    }
  }

  async consumeTranscriptSnapshot({ preserveLifecycle = false }: { preserveLifecycle?: boolean } = {}): Promise<void> {
    if (!this.runtimeValue.transcriptPath) throw new Error('OMP runtime has no resolved transcript path');
    for await (const line of readOmpTranscriptSnapshotLines(this.runtimeValue.transcriptPath)) this.ingestNativeLine(line, { preserveLifecycle });
  }

  replaceRuntime(runtime: OmpSuRuntimeBinding, reason = 'OMP runtime replaced'): void {
    const generation = this.host.descriptor().runtimeGeneration + 1;
    this.host.transition('resuming', reason, generation);
    this.runtimeValue = runtime;
    this.parser = createOmpTimelineParser();
    this.currentTurnId = null;
    this.toolNames.clear();
    this.cards.clear();
    this.lastErrorKey = null;
    this.host.emit({ type: 'backend', extension: { backend: 'omp', agentHome: runtime.nativeSession.agentHome } } as SuSessionEventInput<'omp'>);
    this.host.transition('ready', reason, generation);
  }

  reconcileRuntimeExit(input: { expected: boolean; reason?: string; exitCode?: number | null; signal?: string | null }): void {
    this.host.reconcileRuntimeExit(input);
  }

  private async execute(command: SuSessionCommand<'omp'>, context: SuSessionCommandContext<'omp'>): Promise<SuSessionCommandOutcome> {
    const ownerId = context.descriptor().identity.ownerId;
    let verdict: OmpNativeCommandVerdict;
    switch (command.type) {
      case 'owner_turn':
        context.transition('running', 'owner turn accepted');
        verdict = await this.controls.ownerTurn({ ownerId, turnId: command.turnId, content: command.content });
        if (!verdict.ok) context.transition('waiting-for-owner', verdict.message);
        break;
      case 'interrupt':
        verdict = await this.controls.interrupt({ ownerId, reason: command.reason });
        break;
      case 'resume':
        context.transition('resuming', `resume requested (${command.cause})`);
        verdict = await this.controls.resume({ ownerId, threadId: this.runtimeValue.nativeSession.ompThreadId, cause: command.cause });
        context.transition(verdict.ok ? 'ready' : 'interrupted', verdict.ok ? 'OMP runtime resumed' : verdict.message);
        break;
      case 'focus':
        verdict = await this.controls.focus({ ownerId });
        break;
      case 'end':
        verdict = await this.controls.end({ ownerId, reason: command.reason });
        break;
      case 'fork':
        return commandRefusal(refused('fork_requires_launcher', 'OMP fork must be created through the tracked launcher so it receives a new durable identity', true));
      default:
        return assertNeverSuSession(command);
    }
    if (verdict.ok) return { status: 'completed' };
    return commandRefusal(verdict);
  }

  dispose(): void {
    if (this.unregister) this.unregister();
    else this.host.dispose('OMP adapter disposed');
  }
}

export function createOmpSuSessionAdapter(binding: PuiSuSessionBinding, runtime: OmpSuRuntimeBinding, options: CreateOmpSuSessionAdapterOptions): OmpSuSessionAdapter {
  if (binding.backend !== 'omp') throw new Error(`OMP adapter cannot attach backend ${binding.backend}`);
  return new OmpSuSessionAdapter(binding as PuiSuSessionBinding & { backend: 'omp' }, runtime, options);
}

export async function openOmpSuSession(input: OmpPuiSuSessionInput, options: OpenOmpSuSessionOptions): Promise<OpenOmpSuSessionResult> {
  const opened = await (options.openSession ?? openPuiSuSession)(input);
  if (!opened.ok) return { ok: false, code: 'pui_session_open_failed', error: opened.error };
  const binding = opened.session;
  if (binding.backend !== 'omp') return { ok: false, code: 'backend_mismatch', error: `PUI opened ${binding.backend}; expected omp`, binding };
  const ompBinding = binding as PuiSuSessionBinding & { backend: 'omp' };
  if (!binding.ownerId || !binding.workspaceId) return { ok: false, code: 'identity_not_ready', error: 'PUI OMP session has no ownerId/workspaceId yet', binding };
  const runtime = await (options.resolveRuntime ?? resolveOmpSuRuntime)(ompBinding);
  if (!runtime) return { ok: false, code: 'native_session_not_ready', error: 'OMP native session is not materialized yet; attach after the deferred pane starts', binding };
  const carry = input.operation === 'create' ? input.carry : options.carry;
  const model = options.model ?? (input.operation === 'create' ? input.model ?? null : null);
  const accountRoute = options.accountRoute ?? (input.operation === 'create' ? input.account ?? null : null);
  const adapter = createOmpSuSessionAdapter(ompBinding, runtime, { ...options, model, accountRoute, carry: carry ?? 'warm' });
  return { ok: true, binding: ompBinding, runtime, adapter };
}

export async function* readOmpTranscriptSnapshotLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) if (line.trim()) yield line; }
  finally { lines.close(); stream.destroy(); }
}

export function ompThreadIdFromTranscriptPath(path: string): string | null {
  const name = basename(path);
  const match = name.match(/_([A-Za-z0-9_-]{6,})\.jsonl$/i);
  return match?.[1] ?? null;
}
