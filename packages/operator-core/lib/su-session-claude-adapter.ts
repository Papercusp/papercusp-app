/**
 * Claude backend for the shared PUI SU-session host.
 *
 * Claude sessions already have a durable native identity (the Claude session
 * UUID), an isolated CLAUDE_CONFIG_DIR, and an append-only JSONL transcript.
 * This adapter binds those existing surfaces to SuSessionHost; it does not
 * create a second transcript or launcher. P-004 owns durable rematerialisation
 * while this module owns one attached runtime generation and its translation.
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
import { nativeSessionHandleForAdvSession, type ClaudeNativeSessionHandle } from './native-session-handles';
import { bindSuSessionToAdvSession, persistSuSessionDescriptor } from './su-session-persistence';
import { SuOwnerTurnReceiptMatcher, type SuOwnerTurnReceiptRef } from './su-session-commands';
import { findSessionTranscript } from './claude-sessions';
import { gatewayServedAccountForOwner } from './compaction-usage';
import { createAgentTimelineParser } from './endpoint-route/routes/harness/streams';
import type { TimelineLineParser } from './session-timeline-parsers';
import {
  SuSessionHost,
  nativeRecordKey,
  registerSuSessionHost,
  type SuSessionCommandContext,
  type SuSessionCommandOutcome,
  type SuSessionEventInput,
  type SuSessionServedAccountReader,
} from './su-session-host';

export type ClaudePuiSuSessionInput =
  | (Omit<CreatePuiSuSessionInput, 'backend'> & { backend: 'claude' })
  | (Omit<AttachPuiSuSessionInput, 'backend'> & { backend: 'claude' });

export interface ClaudeSuRuntimeBinding {
  nativeSession: ClaudeNativeSessionHandle & {
    sessionId: string;
    exactResumeSupported: true;
    missingReason: null;
  };
  /** Resolved transcript for snapshot/follow consumption. Null before Claude's
   * first turn; a deferred PUI create can resolve it again after materialising. */
  transcriptPath: string | null;
}

export type ClaudeNativeCommandVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface ClaudeSuSessionControls {
  ownerTurn(input: { ownerId: string; turnId: string; content: string }): Promise<ClaudeNativeCommandVerdict>;
  interrupt(input: { ownerId: string; reason?: string }): Promise<ClaudeNativeCommandVerdict>;
  resume(input: {
    ownerId: string;
    sessionId: string;
    cause: Extract<SuSessionCommand<'claude'>, { type: 'resume' }>['cause'];
  }): Promise<ClaudeNativeCommandVerdict>;
  focus(input: { ownerId: string }): Promise<ClaudeNativeCommandVerdict>;
  end(input: { ownerId: string; reason?: string }): Promise<ClaudeNativeCommandVerdict>;
}

export interface ClaudeSuSessionDescriptorOptions {
  agentChatId: string;
  model?: string | null;
  accountRoute?: string | null;
  servedAccountReader?: SuSessionServedAccountReader;
  carry?: 'warm' | 'cold';
  modes?: readonly string[];
  runtimeGeneration?: number;
}

export interface CreateClaudeSuSessionAdapterOptions extends ClaudeSuSessionDescriptorOptions {
  host?: SuSessionHost<'claude'>;
  controls?: Partial<ClaudeSuSessionControls>;
  register?: boolean;
  /** Structured transports set this false until their identity handshake completes. */
  ready?: boolean;
  runtimeReady?: () => boolean;
  ownerTurnCorrelation?: 'command' | 'transport';
  cardSource?: 'transcript' | 'transport';
  /** Saved owner turns for this session (production: loadSuOwnerTurnReceipts).
   * A replayed prompt takes its saved turn id; without them it gets a fresh one. */
  ownerTurnReceipts?: (identity: SuSessionDescriptor<'claude'>['identity']) => Promise<readonly SuOwnerTurnReceiptRef[]>;
}

export interface OpenClaudeSuSessionOptions extends CreateClaudeSuSessionAdapterOptions {
  openSession?: (input: ClaudePuiSuSessionInput) => Promise<PuiSuSessionResult>;
  resolveRuntime?: (binding: PuiSuSessionBinding) => Promise<ClaudeSuRuntimeBinding | null>;
}

export type OpenClaudeSuSessionResult =
  | {
      ok: true;
      binding: PuiSuSessionBinding & { backend: 'claude' };
      runtime: ClaudeSuRuntimeBinding;
      adapter: ClaudeSuSessionAdapter;
    }
  | { ok: false; code: string; error: string; binding?: PuiSuSessionBinding };

function materializedClaudeHandle(
  handle: ClaudeNativeSessionHandle | null | undefined,
): ClaudeSuRuntimeBinding['nativeSession'] | null {
  if (!handle?.sessionId || !handle.exactResumeSupported || handle.missingReason) return null;
  return {
    ...handle,
    sessionId: handle.sessionId,
    exactResumeSupported: true,
    missingReason: null,
  };
}

/** Resolve the existing adv-session/native Claude identity once. A missing
 * transcript is normal before the first native turn and is represented as a
 * null path rather than a made-up session. */
export async function resolveClaudeSuRuntime(binding: PuiSuSessionBinding): Promise<ClaudeSuRuntimeBinding | null> {
  if (binding.backend !== 'claude') return null;
  const returnedHandle = binding.nativeSession?.backend === 'claude'
    ? materializedClaudeHandle(binding.nativeSession)
    : null;
  if (returnedHandle) {
    return {
      nativeSession: returnedHandle,
      transcriptPath: await findClaudeTranscript(returnedHandle),
    };
  }

  const row = await getAdvSession(binding.advSessionId);
  if (!row || row.agent !== 'claude') return null;
  const provisional = nativeSessionHandleForAdvSession(row);
  if (!provisional || provisional.backend !== 'claude') return null;
  const native = materializedClaudeHandle(provisional);
  if (!native) return null;
  return { nativeSession: native, transcriptPath: await findClaudeTranscript(native) };
}

async function findClaudeTranscript(handle: ClaudeNativeSessionHandle): Promise<string | null> {
  if (!handle.sessionId) return null;
  const roots = handle.configDir ? [join(handle.configDir, 'projects')] : undefined;
  return findSessionTranscript(handle.sessionId, {
    owner: handle.ownerId,
    roots,
  });
}

function refused(code: string, message: string, retryable = true): Exclude<ClaudeNativeCommandVerdict, { ok: true }> {
  return { ok: false, code, message, retryable };
}

function defaultControls(): ClaudeSuSessionControls {
  return {
    async ownerTurn({ ownerId, content }) {
      const host = findLiveHost(ownerId);
      if (!host) return refused('runtime_unavailable', 'Claude has no live managed-PTY host');
      const delivered = await injectIntoHostWithConfirmation(host.sock, {
        mode: 'turn',
        data: content,
        ownerId,
      });
      if (!delivered.ok) {
        return refused(
          'owner_turn_delivery_failed',
          `Claude owner turn was refused by the managed runtime (${delivered.reason ?? delivered.confirmation})`,
        );
      }
      if (delivered.confirmation !== 'acked') {
        return refused(
          'owner_turn_delivery_unconfirmed',
          'Claude runtime closed the control socket without an application-level acknowledgement',
        );
      }
      return { ok: true };
    },
    async interrupt({ ownerId }) {
      return (await interruptViaPty(ownerId, 'sigint'))
        ? { ok: true }
        : refused('interrupt_unavailable', 'Claude runtime could not be interrupted');
    },
    async resume({ ownerId }) {
      return findLiveHost(ownerId)
        ? { ok: true }
        : refused(
            'runtime_reconciliation_required',
            'Claude runtime is not live; exact native resume must be reconciled before this command can complete',
          );
    },
    async focus() {
      // Pane focus is host behavior; PUI owns the actual terminal-pane action.
      return { ok: true };
    },
    async end({ ownerId, reason }) {
      const result = await shutdownViaPty(ownerId, { reason });
      return result === 'sent'
        ? { ok: true }
        : refused('end_refused', `Claude runtime did not accept end (${result})`, false);
    },
  };
}

/**
 * The Claude engine's published capability table. Exported so the cross-engine
 * parity pin can assert it directly: it is already part of the public contract
 * (it ships inside every descriptor the PUI reads), and P-006 requires that
 * every non-`supported` entry carry an explanation the PUI can actually show.
 */
export function claudeCapabilities(): SuSessionCapabilities {
  return {
    commands: {
      owner_turn: { state: 'supported', implementation: 'native' },
      interrupt: { state: 'supported', implementation: 'native' },
      resume: {
        state: 'conditional',
        implementation: 'native',
        reason: 'requires the tracked Claude session UUID and a live or P-004-reconciled managed runtime',
      },
      fork: {
        state: 'conditional',
        implementation: 'native',
        reason: 'forks must be created through the tracked launcher so they receive a new durable identity',
      },
      focus: { state: 'supported', implementation: 'host' },
      end: {
        state: 'conditional',
        implementation: 'native',
        reason: 'the managed host may refuse to close a human-attended runtime',
      },
    },
    features: {
      'tool-events': { state: 'supported', implementation: 'native' },
      'interactive-cards': { state: 'supported', implementation: 'native' },
      'reasoning-stream': {
        state: 'conditional',
        implementation: 'native',
        reason: 'Claude transcript records may include thinking blocks when the native runtime exposes them',
      },
      usage: {
        state: 'conditional',
        implementation: 'native',
        reason: 'Claude result records carry usage/cost metadata but the v1 SU-session event contract has no usage event',
      },
      compaction: {
        state: 'conditional',
        implementation: 'host',
        reason: 'Claude carry uses the managed host hard-recycle path and P-004 runtime reconciliation',
      },
      approvals: {
        state: 'conditional',
        implementation: 'native',
        reason: 'PUI attached launches and resumptions use the native default permission policy; requests reach the owner as typed cards via canUseTool. Other managed engine callers must opt into toolApproval prompt.',
      },
      context: {
        state: 'unsupported',
        reason: 'the v1 SU-session contract carries no context event or descriptor field, so Claude context consumption stays inside the native runtime and never reaches the PUI',
      },
      modes: {
        state: 'conditional',
        implementation: 'host',
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
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function commandRefusal(verdict: Exclude<ClaudeNativeCommandVerdict, { ok: true }>): SuSessionCommandOutcome {
  const refusal: SuSessionRefusal = {
    code: verdict.code,
    message: verdict.message,
    retryable: verdict.retryable,
  };
  return { status: 'refused', refusal };
}

function descriptorFor(
  binding: PuiSuSessionBinding,
  runtime: ClaudeSuRuntimeBinding,
  options: ClaudeSuSessionDescriptorOptions,
): SuSessionDescriptor<'claude'> {
  if (!binding.ownerId || !binding.workspaceId) {
    throw new Error('Claude SU-session binding requires ownerId and workspaceId');
  }
  return {
    identity: {
      agentChatId: options.agentChatId,
      advSessionId: binding.advSessionId,
      backend: 'claude',
      nativeSessionId: runtime.nativeSession.sessionId,
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
    capabilities: claudeCapabilities(),
    backendExtension: {
      backend: 'claude',
      configDir: runtime.nativeSession.configDir,
      configDirSource: runtime.nativeSession.configDirSource,
    },
  };
}

type CardRecord = {
  correlationId: string;
  turnId: string;
};

function cardFromClaudeQuestion(callId: string, turnId: string, input: unknown): OpenCardSnapshot | null {
  const rec = asRecord(input);
  const questions = Array.isArray(rec?.questions) ? rec.questions : [];
  const question = asRecord(questions[0]);
  if (!question) return null;
  const prompt = firstString(question.question, question.prompt);
  if (!prompt) return null;
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  const options = rawOptions
    .map((value, index) => {
      const option = asRecord(value);
      const label = firstString(option?.label, option?.name) ?? `Option ${index + 1}`;
      const id = firstString(option?.id) ?? `${callId}:option-${index + 1}`;
      const description = firstString(option?.description);
      return { id, label, ...(description ? { description } : {}) };
    });
  const multiSelect = question.multiSelect === true;
  return {
    correlationId: callId,
    createdAt: Date.now(),
    prompt,
    fallbackText: prompt,
    allowDecline: true,
    presentation: {
      kind: multiSelect ? 'checkbox' : 'radio',
      ...(options.length ? { options } : {}),
    },
  };
}

function toolResultError(record: Record<string, unknown>, callId: string): boolean {
  const content = asRecord(record.message)?.content;
  if (!Array.isArray(content)) return false;
  const block = content.find((value) => asRecord(value)?.tool_use_id === callId);
  const result = asRecord(block);
  return result?.is_error === true || result?.isError === true;
}

function recordIndicatesCompaction(record: Record<string, unknown>): boolean {
  if (record.isCompactSummary === true || record.is_compact_summary === true) return true;
  const subtype = String(record.subtype ?? record.status ?? '').toLowerCase();
  return subtype.includes('compact');
}

interface ClaudeTextStream {
  turnId: string;
  content: string;
  started: boolean;
}

/** Translate one attached native Claude runtime into the shared host. */
export class ClaudeSuSessionAdapter {
  readonly host: SuSessionHost<'claude'>;
  private runtimeValue: ClaudeSuRuntimeBinding;
  private parser: TimelineLineParser = createAgentTimelineParser();
  private currentTurnId: string | null = null;
  private turnSerial = 0;
  private readonly toolNames = new Map<string, string>();
  private readonly cards = new Map<string, CardRecord>();
  private readonly controls: ClaudeSuSessionControls;
  private readonly unregister: (() => void) | null;
  private lastErrorKey: string | null = null;
  private readonly transportCorrelatesTurns: boolean;
  private readonly transportHandlesCards: boolean;
  private streamingMessageId: string | null = null;
  private readonly textStreams = new Map<string, Map<number, ClaudeTextStream>>();
  private readonly servedAccountReader: SuSessionServedAccountReader;
  private readonly receiptMatcher = new SuOwnerTurnReceiptMatcher();
  private readonly ownerTurnReceipts: CreateClaudeSuSessionAdapterOptions['ownerTurnReceipts'] | null;

  constructor(
    readonly binding: PuiSuSessionBinding & { backend: 'claude' },
    runtime: ClaudeSuRuntimeBinding,
    options: CreateClaudeSuSessionAdapterOptions,
  ) {
    this.runtimeValue = runtime;
    this.servedAccountReader = options.servedAccountReader ?? gatewayServedAccountForOwner;
    this.transportCorrelatesTurns = options.ownerTurnCorrelation === 'transport';
    this.transportHandlesCards = options.cardSource === 'transport';
    this.ownerTurnReceipts = options.ownerTurnReceipts ?? null;
    this.controls ={ ...defaultControls(), ...(options.controls ?? {}) };
    const hostOptions = {
      descriptor: descriptorFor(binding, runtime, options),
      executeCommand: (command: SuSessionCommand<'claude'>, context: SuSessionCommandContext<'claude'>) => this.execute(command, context),
      runtimeReady: options.runtimeReady,
      persistDescriptor: async (descriptor: SuSessionDescriptor<'claude'>) => {
        await persistSuSessionDescriptor(binding.advSessionId, descriptor);
      },
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
    if (options.ready !== false) this.host.transition('ready', 'Claude native runtime attached');
  }

  get runtime(): ClaudeSuRuntimeBinding {
    return this.runtimeValue;
  }

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

  /** The structured transport calls this when a queued owner turn is sent. */
  correlateOwnerTurn(turnId: string): void {
    this.currentTurnId = turnId;
    this.receiptMatcher.markUsed(turnId);
  }

  /** A replayed prompt opens its own turn: Claude's saved transcript has no
   * `result` records, so the live end-of-turn reset never runs on replay and
   * every restored prompt would share the first one's id (WI-10004252). */
  private replayTurnId(content: string, recordId: string | null): string {
    return this.receiptMatcher.take(content) ?? this.nextTurnId(recordId);
  }

  private nextTurnId(hint?: string | null): string {
    this.turnSerial += 1;
    const safeHint = String(hint ?? '')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 80);
    return safeHint
      ? `claude:${safeHint}:${this.turnSerial}`
      : `claude:${this.host.descriptor().identity.nativeSessionId}:turn-${this.turnSerial}`;
  }

  private ensureTurn(hint?: string | null): string {
    if (!this.currentTurnId) this.currentTurnId = this.nextTurnId(hint);
    return this.currentTurnId;
  }

  private emitTranscript(input: {
    turnId: string;
    role: 'owner' | 'assistant' | 'system';
    channel: 'text' | 'reasoning';
    content: string;
  }): void {
    this.host.emit({
      type: 'transcript', phase: 'started', turnId: input.turnId,
      role: input.role, channel: input.channel,
    } as SuSessionEventInput<'claude'>);
    if (input.content) {
      this.host.emit({
        type: 'transcript', phase: 'delta', turnId: input.turnId,
        role: input.role, channel: input.channel, content: input.content,
      } as SuSessionEventInput<'claude'>);
    }
    this.host.emit({
      type: 'transcript', phase: 'completed', turnId: input.turnId,
      role: input.role, channel: input.channel,
      ...(input.content ? { content: input.content } : {}),
    } as SuSessionEventInput<'claude'>);
  }

  private appendStreamText(stream: ClaudeTextStream, content: string): void {
    if (!content) return;
    if (!stream.started) {
      this.host.emit({ type: 'transcript', phase: 'started', turnId: stream.turnId, role: 'assistant', channel: 'text' });
      stream.started = true;
    }
    stream.content += content;
    this.host.emit({ type: 'transcript', phase: 'delta', turnId: stream.turnId, role: 'assistant', channel: 'text', content });
  }

  private finishStreamText(stream: ClaudeTextStream, content = stream.content): void {
    // Complete with the canonical value. A missing partial tail is appended
    // before completion; a corrected value replaces the live segment.
    if (content.startsWith(stream.content)) this.appendStreamText(stream, content.slice(stream.content.length));
    if (stream.started) this.host.emit({
      type: 'transcript', phase: 'completed', turnId: stream.turnId,
      role: 'assistant', channel: 'text', content,
    });
  }

  private ingestPartial(record: Record<string, unknown>): void {
    if (record.parent_tool_use_id || record.isSidechain === true) return;
    const event = asRecord(record.event);
    if (!event) return;
    if (event.type === 'message_start') {
      const message = asRecord(event.message);
      this.streamingMessageId = message?.role === 'assistant' ? firstString(message.id) : null;
      if (this.streamingMessageId) this.textStreams.set(this.streamingMessageId, new Map());
      return;
    }
    const blocks = this.streamingMessageId ? this.textStreams.get(this.streamingMessageId) : undefined;
    if (!blocks || !Number.isInteger(event.index)) return;
    const block = asRecord(event.content_block);
    const delta = asRecord(event.delta);
    const text = event.type === 'content_block_start' && block?.type === 'text' ? block.text
      : event.type === 'content_block_delta' && delta?.type === 'text_delta' ? delta.text : undefined;
    if (typeof text !== 'string') return;
    const index = event.index as number;
    let stream = blocks.get(index);
    if (!stream) {
      stream = { turnId: this.ensureTurn(this.streamingMessageId), content: '', started: false };
      blocks.set(index, stream);
    }
    this.appendStreamText(stream, text);
  }

  private reconcileStreamedRecord(record: Record<string, unknown>): Record<string, unknown> {
    if (record.type !== 'assistant' || record.parent_tool_use_id || record.isSidechain === true) return record;
    const message = asRecord(record.message);
    const id = firstString(message?.id);
    const streams = id ? this.textStreams.get(id) : undefined;
    if (!streams?.size || !Array.isArray(message?.content)) return record;
    // The SDK emits one canonical assistant record per completed block. They
    // share message.id; their content indexes restart at zero in each record.
    // Consume streamed TEXT blocks in source order, preserving tool blocks for
    // the existing timeline parser. Identical text in two blocks is two spans.
    const content = message.content.filter((value) => {
      const block = asRecord(value);
      if (block?.type !== 'text' || typeof block.text !== 'string') return true;
      const first = streams.entries().next().value;
      if (!first) return true;
      const [index, stream] = first;
      this.finishStreamText(stream, block.text);
      streams.delete(index);
      return false;
    });
    return { ...record, message: { ...message, content } };
  }

  private finishPartialText(): void {
    for (const streams of this.textStreams.values()) {
      for (const stream of streams.values()) this.finishStreamText(stream);
    }
    this.textStreams.clear();
    this.streamingMessageId = null;
  }

  /** Consume one complete Claude JSONL record. The source retains a partial
   * trailing record until its newline arrives. */
  ingestNativeLine(line: string, { preserveLifecycle = false, replay = false }: { preserveLifecycle?: boolean; replay?: boolean } = {}): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (!this.host.claimNativeRecord(nativeRecordKey(line, {})) && replay) return;
      this.host.emit({
        type: 'error', scope: 'transport', code: 'claude_record_malformed',
        message: 'Claude transcript emitted a malformed JSONL record', recoverable: true,
      } as SuSessionEventInput<'claude'>);
      return;
    }
    // A replayed snapshot only adds records this host has not shown yet: the
    // same transcript is read early and again once the engine is up, and a
    // resume retry replays it on the same host (WI-10004162).
    if (!this.host.claimNativeRecord(nativeRecordKey(line, record)) && replay) return;

    if (record.type === 'stream_event') {
      this.ingestPartial(record);
      return;
    }
    // An interrupted SDK response can end without a canonical assistant
    // block. Keep the partial text and close its segment before the lifecycle.
    if (record.type === 'result') this.finishPartialText();
    record = this.reconcileStreamedRecord(record);

    // A default/alias is only a launch request. Native initialization and root
    // assistant records name the model that actually ran, including on replay.
    const nativeModel = record.type === 'system' && record.subtype === 'init'
      ? firstString(record.model)
      : record.type === 'assistant' && !record.parent_tool_use_id && record.isSidechain !== true
        ? firstString(asRecord(record.message)?.model) : null;
    if (nativeModel && nativeModel !== '<synthetic>' && this.host.descriptor().model !== nativeModel) {
      this.host.emit({
        type: 'session', descriptor: { ...this.host.descriptor(), model: nativeModel },
      } as SuSessionEventInput<'claude'>);
    }

    const recordId = firstString(record.uuid, record.id, record.message_id);
    if (!preserveLifecycle && recordIndicatesCompaction(record)) {
      this.host.transition('compacting', 'Claude native transcript compacted');
    }

    const parsed = this.parser.parseLine(JSON.stringify(record));
    for (const entry of parsed) {
      const turnId = entry.kind === 'prompt'
        ? (replay
          ? (this.currentTurnId = this.replayTurnId(entry.text ?? '', recordId))
          : (this.currentTurnId ??= this.nextTurnId(recordId)))
        : this.ensureTurn(recordId);
      if (entry.kind === 'prompt') {
        if (!preserveLifecycle) this.host.transition('running', 'Claude owner turn persisted');
        this.emitTranscript({ turnId, role: 'owner', channel: 'text', content: entry.text ?? '' });
      } else if (entry.kind === 'text') {
        this.emitTranscript({ turnId, role: 'assistant', channel: 'text', content: entry.text ?? '' });
      } else if (entry.kind === 'status') {
        const text = entry.text ?? '';
        this.emitTranscript({ turnId, role: 'system', channel: 'text', content: text });
      } else if (entry.kind === 'tool_use') {
        const callId = entry.toolId ?? `claude-call-${this.toolNames.size + 1}`;
        const name = entry.toolName ?? 'tool';
        this.toolNames.set(callId, name);
        this.host.emit({
          type: 'tool', phase: 'started', turnId, callId, name,
          input: asJsonValue(entry.toolInput),
        } as SuSessionEventInput<'claude'>);
        if (name === 'AskUserQuestion' && !this.transportHandlesCards) {
          const card = cardFromClaudeQuestion(callId, turnId, entry.toolInput);
          if (card) {
            this.cards.set(callId, { correlationId: callId, turnId });
            this.host.emit({ type: 'card', phase: 'opened', turnId, card } as SuSessionEventInput<'claude'>);
          }
        }
      } else if (entry.kind === 'tool_result') {
        const callId = entry.toolId ?? `claude-result-${this.toolNames.size + 1}`;
        const name = this.toolNames.get(callId) ?? 'tool';
        const isError = toolResultError(record, callId);
        this.host.emit({
          type: 'tool', phase: 'completed', turnId, callId, name,
          output: asJsonValue(entry.text ?? ''), isError,
        } as SuSessionEventInput<'claude'>);
        const card = this.cards.get(callId);
        if (card) {
          this.host.emit({
            type: 'card', phase: 'closed', turnId: card.turnId, correlationId: card.correlationId,
            resolution: isError ? 'cancelled' : 'submitted',
          } as SuSessionEventInput<'claude'>);
          this.cards.delete(callId);
        }
      } else if (entry.kind === 'result') {
        if (!preserveLifecycle) this.host.transition('waiting-for-owner', 'Claude native turn completed');
      }
    }

    if (record.type === 'result') {
      const isError = record.is_error === true || String(record.subtype ?? '').toLowerCase().includes('error');
      if (isError) {
        const code = firstString(record.error_code, record.subtype) ?? 'claude_runtime_error';
        const message = firstString(record.result, record.error) ?? code;
        const key = `${code}\u0000${message}`;
        if (key !== this.lastErrorKey) {
          this.lastErrorKey = key;
          this.host.emit({
            type: 'error', scope: 'turn', code, message, recoverable: true,
            details: asJsonValue({ subtype: record.subtype ?? null }),
          } as SuSessionEventInput<'claude'>);
        }
      }
      if (!preserveLifecycle) this.host.transition('waiting-for-owner', isError ? 'Claude turn failed' : 'Claude turn completed');
      this.currentTurnId = null;
    }
  }

  async consumeNativeLines(lines: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of lines) this.ingestNativeLine(line);
      for (const entry of this.parser.flush()) {
        if (entry.kind === 'text' || entry.kind === 'status') {
          this.emitTranscript({
            turnId: this.ensureTurn(),
            role: entry.kind === 'status' ? 'system' : 'assistant',
            channel: 'text', content: entry.text ?? '',
          });
        }
      }
    } catch (error) {
      this.host.emit({
        type: 'error', scope: 'transport', code: 'claude_transcript_stream_failed',
        message: error instanceof Error ? error.message : String(error), recoverable: true,
      } as SuSessionEventInput<'claude'>);
    }
  }

  async consumeTranscriptSnapshot({ preserveLifecycle = false }: { preserveLifecycle?: boolean } = {}): Promise<void> {
    this.runtimeValue.transcriptPath ??= await findClaudeTranscript(this.runtimeValue.nativeSession);
    if (!this.runtimeValue.transcriptPath) {
      throw new Error('Claude runtime has no resolved transcript path');
    }
    // Best-effort: without the saved receipts a restored prompt still gets its
    // own (fresh) turn id, so a failed read degrades the id, never the replay.
    if (this.ownerTurnReceipts) {
      this.receiptMatcher.load(await this.ownerTurnReceipts(this.host.descriptor().identity).catch(() => []));
    }
    for await (const line of readClaudeTranscriptSnapshotLines(this.runtimeValue.transcriptPath)) this.ingestNativeLine(line, { preserveLifecycle, replay: true });
  }

  /** P-004 calls this after exact Claude resume/carry replacement attaches. The
   * durable SU identity remains unchanged while runtimeGeneration advances. */
  replaceRuntime(runtime: ClaudeSuRuntimeBinding, reason = 'Claude runtime replaced'): void {
    const generation = this.host.descriptor().runtimeGeneration + 1;
    this.host.transition('resuming', reason, generation);
    this.runtimeValue = runtime;
    this.parser = createAgentTimelineParser();
    this.finishPartialText();
    this.currentTurnId = null;
    this.toolNames.clear();
    this.cards.clear();
    this.lastErrorKey = null;
    this.host.emit({
      type: 'backend',
      extension: {
        backend: 'claude',
        configDir: runtime.nativeSession.configDir,
        configDirSource: runtime.nativeSession.configDirSource,
      },
    } as SuSessionEventInput<'claude'>);
    this.host.transition('ready', reason, generation);
  }

  reconcileRuntimeExit(input: {
    expected: boolean;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
  }): void {
    this.finishPartialText();
    this.host.reconcileRuntimeExit(input);
  }

  private async execute(
    command: SuSessionCommand<'claude'>,
    context: SuSessionCommandContext<'claude'>,
  ): Promise<SuSessionCommandOutcome> {
    const ownerId = context.descriptor().identity.ownerId;
    let verdict: ClaudeNativeCommandVerdict;
    switch (command.type) {
      case 'owner_turn':
        if (!this.transportCorrelatesTurns) this.currentTurnId = command.turnId;
        this.receiptMatcher.markUsed(command.turnId);
        context.transition('running', 'owner turn accepted');
        verdict = await this.controls.ownerTurn({ ownerId, turnId: command.turnId, content: command.content });
        if (!verdict.ok) context.transition('waiting-for-owner', verdict.message);
        break;
      case 'interrupt':
        verdict = await this.controls.interrupt({ ownerId, reason: command.reason });
        break;
      case 'resume':
        context.transition('resuming', `resume requested (${command.cause})`);
        verdict = await this.controls.resume({
          ownerId,
          sessionId: this.runtimeValue.nativeSession.sessionId,
          cause: command.cause,
        });
        context.transition(verdict.ok ? 'ready' : 'interrupted', verdict.ok ? 'Claude runtime resumed' : verdict.message);
        break;
      case 'focus':
        verdict = await this.controls.focus({ ownerId });
        break;
      case 'end':
        verdict = await this.controls.end({ ownerId, reason: command.reason });
        break;
      case 'fork':
        // Claude's native --fork-session path is represented by the existing
        // launcher; the host cannot safely mint the new adv row itself.
        return commandRefusal(refused(
          'fork_requires_launcher',
          'Claude native fork must be created through the tracked launcher so it receives a new durable identity',
          true,
        ));
      default:
        return assertNeverSuSession(command);
    }
    if (verdict.ok) return { status: 'completed' };
    return commandRefusal(verdict);
  }

  dispose(): void {
    if (this.unregister) this.unregister();
    else this.host.dispose('Claude adapter disposed');
  }
}

export function createClaudeSuSessionAdapter(
  binding: PuiSuSessionBinding,
  runtime: ClaudeSuRuntimeBinding,
  options: CreateClaudeSuSessionAdapterOptions,
): ClaudeSuSessionAdapter {
  if (binding.backend !== 'claude') throw new Error(`Claude adapter cannot attach backend ${binding.backend}`);
  return new ClaudeSuSessionAdapter(binding as PuiSuSessionBinding & { backend: 'claude' }, runtime, options);
}

/** Canonical PUI create/attach entry followed by native Claude materialisation. */
export async function openClaudeSuSession(
  input: ClaudePuiSuSessionInput,
  options: OpenClaudeSuSessionOptions,
): Promise<OpenClaudeSuSessionResult> {
  const opened = await (options.openSession ?? openPuiSuSession)(input);
  if (!opened.ok) return { ok: false, code: 'pui_session_open_failed', error: opened.error };
  const binding = opened.session;
  if (binding.backend !== 'claude') {
    return { ok: false, code: 'backend_mismatch', error: `PUI opened ${binding.backend}; expected claude`, binding };
  }
  const claudeBinding = binding as PuiSuSessionBinding & { backend: 'claude' };
  if (!binding.ownerId || !binding.workspaceId) {
    return { ok: false, code: 'identity_not_ready', error: 'PUI Claude session has no ownerId/workspaceId yet', binding };
  }
  const runtime = await (options.resolveRuntime ?? resolveClaudeSuRuntime)(claudeBinding);
  if (!runtime) {
    return {
      ok: false,
      code: 'native_session_not_ready',
      error: 'Claude native session is not materialized yet; attach after the deferred pane starts',
      binding,
    };
  }
  const carry = input.operation === 'create' ? input.carry : options.carry;
  const model = options.model ?? (input.operation === 'create' ? input.model ?? null : null);
  const accountRoute = options.accountRoute ?? (input.operation === 'create' ? input.account ?? null : null);
  const adapter = createClaudeSuSessionAdapter(claudeBinding, runtime, {
    ...options,
    model,
    accountRoute,
    carry: carry ?? 'warm',
  });
  return { ok: true, binding: claudeBinding, runtime, adapter };
}

/** Finite, record-boundary-safe source for an already-written Claude transcript. */
export async function* readClaudeTranscriptSnapshotLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.trim()) yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Stable UUID extraction used by tests and diagnostics when a caller has only
 * a Claude transcript path. */
export function claudeSessionIdFromTranscriptPath(path: string): string | null {
  if (!/\.jsonl$/i.test(path)) return null;
  const id = basename(path).replace(/\.jsonl$/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{5,}$/.test(id) ? id : null;
}
