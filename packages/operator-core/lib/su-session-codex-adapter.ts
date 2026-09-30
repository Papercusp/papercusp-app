/**
 * Codex backend for the shared PUI SU-session host.
 *
 * The adapter deliberately reuses four existing seams instead of launching or
 * storing a second kind of session: `openPuiSuSession` for create/attach,
 * `adv_sessions` + the per-session CODEX_HOME for native identity, the shipped
 * Codex timeline parser for rollout records, and the managed-PTY control socket
 * for owner turns and lifecycle controls. P-004 owns durable re-materialisation;
 * this module owns one attached runtime generation and its wire translation.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  assertNeverSuSession,
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
import { nativeSessionHandleForAdvSession, type CodexNativeSessionHandle } from './native-session-handles';
import { bindSuSessionToAdvSession, persistSuSessionDescriptor } from './su-session-persistence';
import {
  findCodexLiveThreadId,
  findCodexRolloutPath,
} from './session-transcript-resolvers';
import { createCodexTimelineParser, type TimelineLineParser } from './session-timeline-parsers';
import { gatewayServedAccountForOwner } from './compaction-usage';
import {
  SuSessionHost,
  registerSuSessionHost,
  type SuSessionCommandContext,
  type SuSessionCommandOutcome,
  type SuSessionEventInput,
  type SuSessionServedAccountReader,
} from './su-session-host';

export type CodexPuiSuSessionInput =
  | (Omit<CreatePuiSuSessionInput, 'backend'> & { backend: 'codex' })
  | (Omit<AttachPuiSuSessionInput, 'backend'> & { backend: 'codex' });

export interface CodexSuRuntimeBinding {
  nativeSession: CodexNativeSessionHandle & {
    rolloutId: string;
  };
  /** Current native rollout. Null is allowed when a caller supplies another
   * append-only native record stream (for example the existing thinking SSE). */
  rolloutPath: string | null;
}

export type CodexNativeCommandVerdict = { ok: true } | { ok: false; code: string; message: string; retryable: boolean };

export interface CodexSuSessionControls {
  ownerTurn(input: { ownerId: string; turnId: string; content: string }): Promise<CodexNativeCommandVerdict>;
  interrupt(input: { ownerId: string; reason?: string }): Promise<CodexNativeCommandVerdict>;
  resume(input: {
    ownerId: string;
    rolloutId: string;
    cause: Extract<SuSessionCommand<'codex'>, { type: 'resume' }>['cause'];
  }): Promise<CodexNativeCommandVerdict>;
  focus(input: { ownerId: string }): Promise<CodexNativeCommandVerdict>;
  end(input: { ownerId: string; reason?: string }): Promise<CodexNativeCommandVerdict>;
}

export interface CodexSuSessionDescriptorOptions {
  agentChatId: string;
  model?: string | null;
  accountRoute?: string | null;
  servedAccountReader?: SuSessionServedAccountReader;
  carry?: 'warm' | 'cold';
  modes?: readonly string[];
  runtimeGeneration?: number;
}

export interface CreateCodexSuSessionAdapterOptions extends CodexSuSessionDescriptorOptions {
  host?: SuSessionHost<'codex'>;
  controls?: Partial<CodexSuSessionControls>;
  ready?: boolean;
  runtimeReady?: () => boolean;
  /** Registration exposes the host through the existing agent-chat SU-session
   * routes. Tests may disable it when exercising an isolated host. */
  register?: boolean;
}

export interface OpenCodexSuSessionOptions extends CreateCodexSuSessionAdapterOptions {
  openSession?: (input: CodexPuiSuSessionInput) => Promise<PuiSuSessionResult>;
  resolveRuntime?: (binding: PuiSuSessionBinding) => Promise<CodexSuRuntimeBinding | null>;
}

export type OpenCodexSuSessionResult =
  | {
      ok: true;
      binding: PuiSuSessionBinding & { backend: 'codex' };
      runtime: CodexSuRuntimeBinding;
      adapter: CodexSuSessionAdapter;
    }
  | { ok: false; code: string; error: string; binding?: PuiSuSessionBinding };

export function codexRolloutIdFromPath(path: string | null): string | null {
  if (!path) return null;
  const match = path.match(/-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match?.[1] ?? null;
}

function materializedCodexHandle(
  handle: CodexNativeSessionHandle | null | undefined,
): CodexSuRuntimeBinding['nativeSession'] | null {
  if (!handle?.codexHome || !handle.rolloutId) return null;
  return { ...handle, rolloutId: handle.rolloutId };
}

export interface ResolveCodexSuRuntimeDeps {
  getSession?: typeof getAdvSession;
  findRolloutPath?: typeof findCodexRolloutPath;
  findLiveThreadId?: typeof findCodexLiveThreadId;
  findHost?: typeof findLiveHost;
}

/**
 * Resolve the existing adv-session/CODEX_HOME identity once.
 *
 * A live Codex TUI creates its native thread id before its first rollout file.
 * PUI must be able to attach during that window so it can SEND the owner turn
 * that causes the rollout to be written. The thread-writer lock is therefore a
 * legitimate live-runtime identity, while `exactResumeSupported` remains false
 * until the rollout file itself exists.
 */
export async function resolveCodexSuRuntime(
  binding: PuiSuSessionBinding,
  deps: ResolveCodexSuRuntimeDeps = {},
): Promise<CodexSuRuntimeBinding | null> {
  if (binding.backend !== 'codex') return null;
  const findPath = deps.findRolloutPath ?? findCodexRolloutPath;
  const host = binding.ownerId ? (deps.findHost ?? findLiveHost)(binding.ownerId) : null;
  const returnedHandle =
    binding.nativeSession?.backend === 'codex' ? materializedCodexHandle(binding.nativeSession) : null;
  if (returnedHandle) {
    const rolloutPath = await findPath(binding.advSessionId, {
      homeOverride: returnedHandle.codexHome,
    });
    if (!rolloutPath && !host) return null;
    return {
      nativeSession: {
        ...returnedHandle,
        exactResumeSupported: Boolean(rolloutPath),
        missingReason: rolloutPath
          ? null
          : 'codex rollout is not persisted yet; the live runtime is attachable but not exactly resumable',
      },
      rolloutPath,
    };
  }

  const row = await (deps.getSession ?? getAdvSession)(binding.advSessionId);
  if (!row || row.agent !== 'codex') return null;
  const provisional = nativeSessionHandleForAdvSession(row);
  if (!provisional || provisional.backend !== 'codex' || !provisional.codexHome) return null;
  const rolloutPath = await findPath(row.id, {
    homeOverride: provisional.codexHome,
  });
  const rolloutId =
    codexRolloutIdFromPath(rolloutPath) ??
    (host ? await (deps.findLiveThreadId ?? findCodexLiveThreadId)(provisional.codexHome) : null);
  if (!rolloutId) return null;
  return {
    nativeSession: {
      ...provisional,
      rolloutId,
      exactResumeSupported: Boolean(rolloutPath),
      missingReason: rolloutPath
        ? null
        : 'codex rollout is not persisted yet; the live runtime is attachable but not exactly resumable',
    },
    rolloutPath,
  };
}

function refused(code: string, message: string, retryable = true): Exclude<CodexNativeCommandVerdict, { ok: true }> {
  return { ok: false, code, message, retryable };
}

function defaultControls(): CodexSuSessionControls {
  return {
    async ownerTurn({ ownerId, content }) {
      const host = findLiveHost(ownerId);
      if (!host) return refused('runtime_unavailable', 'Codex has no live managed-PTY host');
      const delivered = await injectIntoHostWithConfirmation(host.sock, {
        mode: 'turn',
        data: content,
        ownerId,
      });
      if (!delivered.ok) {
        return refused(
          'owner_turn_delivery_failed',
          `Codex owner turn was refused by the managed runtime (${delivered.reason ?? delivered.confirmation})`,
        );
      }
      if (delivered.confirmation !== 'acked') {
        return refused(
          'owner_turn_delivery_unconfirmed',
          'Codex runtime closed the control socket without an application-level acknowledgement',
        );
      }
      return { ok: true };
    },
    async interrupt({ ownerId }) {
      // Esc, NOT Ctrl-C. Codex's TUI binds Ctrl-C (\x03) to QUIT — its own
      // footer string reads "Ctrl+C to exit" — so 'sigint' made the product's
      // interrupt command END the session it was asked to interrupt. Measured
      // (EI-21908787009967815): injecting \x03 into a READY managed session
      // closed adv 21340 six seconds later (ended_by='self', exit_code=0,
      // ended_signal=null, three op.dispatch.shutdown lines in its
      // codex-tui.log), while idle controls 21328/21333 — same create+launch
      // path, nothing injected — lived 130.6s and 120s. Esc is codex's cancel
      // key and is inert at an idle prompt: the SAME interruptViaPty call
      // carrying \x1b left adv 21341 alive for the full 90s watch with zero
      // shutdown lines, which is what exonerates the injection path and pins
      // the defect to the payload. Pinned by su-session-interrupt-key.test.ts.
      return (await interruptViaPty(ownerId, 'esc'))
        ? { ok: true }
        : refused('interrupt_unavailable', 'Codex runtime could not be interrupted');
    },
    async resume({ ownerId }) {
      // Resume of a still-attached runtime is an interaction-state transition.
      // Re-launch/reconciliation after process loss belongs to P-004 and calls
      // replaceRuntime once the exact rollout has been resumed.
      return findLiveHost(ownerId)
        ? { ok: true }
        : refused(
            'runtime_reconciliation_required',
            'Codex runtime is not live; exact native resume must be reconciled before this command can complete',
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
        : refused('end_refused', `Codex runtime did not accept end (${result})`, false);
    },
  };
}

/**
 * The Codex engine's published capability table. Exported so the cross-engine
 * parity pin can assert it directly: it is already part of the public contract
 * (it ships inside every descriptor the PUI reads), and P-006 requires that
 * every non-`supported` entry carry an explanation the PUI can actually show.
 */
export function codexCapabilities(): SuSessionCapabilities {
  return {
    commands: {
      owner_turn: { state: 'supported', implementation: 'native' },
      interrupt: { state: 'supported', implementation: 'native' },
      resume: {
        state: 'conditional',
        implementation: 'native',
        reason: 'requires the tracked rollout and a live or P-004-reconciled managed runtime',
      },
      fork: {
        state: 'unsupported',
        reason: 'the tracked Codex psu path exposes exact resume but no identity-safe native fork transport',
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
      'interactive-cards': {
        state: 'unsupported',
        reason: 'Codex rollout JSONL does not expose Papercusp typed owner-input cards',
      },
      'reasoning-stream': {
        state: 'conditional',
        implementation: 'native',
        reason: 'readable reasoning summaries are emitted; encrypted reasoning bodies remain unavailable',
      },
      usage: {
        state: 'conditional',
        implementation: 'native',
        reason: 'native token-count records are available but the v1 SU-session event contract has no usage event',
      },
      compaction: {
        state: 'conditional',
        implementation: 'host',
        reason: 'Codex carry uses the managed host hard-recycle path and P-004 runtime reconciliation',
      },
      approvals: {
        state: 'conditional',
        implementation: 'native',
        reason: 'PUI attached launches and resumptions use approvalPolicy on-request and a workspace-write sandbox; native requests become owner approval cards. Other managed engine callers must opt into toolApproval prompt.',
      },
      context: {
        state: 'unsupported',
        reason: 'the v1 SU-session contract carries no context event or descriptor field, so Codex context consumption stays inside the native runtime and never reaches the PUI',
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

function nativeError(record: Record<string, unknown>): {
  code: string;
  message: string;
  turnId: string | null;
} | null {
  if (record.type !== 'event_msg') return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const kind = typeof payload.type === 'string' ? payload.type : '';
  const nested = asRecord(payload.error);
  const failed =
    kind === 'error' ||
    ((kind === 'task_complete' || kind === 'turn_completed') &&
      (payload.error != null || ['error', 'failed', 'failure'].includes(String(payload.status ?? ''))));
  if (!failed) return null;
  const code =
    firstString(payload.codex_error_info, payload.error_code, payload.code, nested?.codex_error_info, nested?.code) ??
    'codex_runtime_error';
  const message = firstString(payload.message, nested?.message, nested?.detail) ?? code;
  return {
    code: code
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[.\s-]+/g, '_')
      .toLowerCase(),
    message,
    turnId: firstString(payload.turn_id, payload.turnId, nested?.turn_id, nested?.turnId),
  };
}

function commandRefusal(verdict: Exclude<CodexNativeCommandVerdict, { ok: true }>): SuSessionCommandOutcome {
  const refusal: SuSessionRefusal = {
    code: verdict.code,
    message: verdict.message,
    retryable: verdict.retryable,
  };
  return { status: 'refused', refusal };
}

function descriptorFor(
  binding: PuiSuSessionBinding,
  runtime: CodexSuRuntimeBinding,
  options: CodexSuSessionDescriptorOptions,
): SuSessionDescriptor<'codex'> {
  if (!binding.ownerId || !binding.workspaceId) {
    throw new Error('Codex SU-session binding requires ownerId and workspaceId');
  }
  return {
    identity: {
      agentChatId: options.agentChatId,
      advSessionId: binding.advSessionId,
      backend: 'codex',
      nativeSessionId: runtime.nativeSession.rolloutId,
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
    capabilities: codexCapabilities(),
    backendExtension: {
      backend: 'codex',
      codexHome: runtime.nativeSession.codexHome,
    },
  };
}

/** Translate one attached native Codex runtime into the shared host. */
export class CodexSuSessionAdapter {
  readonly host: SuSessionHost<'codex'>;
  private runtimeValue: CodexSuRuntimeBinding;
  private parser: TimelineLineParser = createCodexTimelineParser();
  private currentTurnId: string | null = null;
  private turnSerial = 0;
  private readonly toolNames = new Map<string, string>();
  private readonly controls: CodexSuSessionControls;
  private readonly unregister: (() => void) | null;
  private lastNativeErrorKey: string | null = null;
  private readonly servedAccountReader: SuSessionServedAccountReader;

  constructor(
    readonly binding: PuiSuSessionBinding & { backend: 'codex' },
    runtime: CodexSuRuntimeBinding,
    options: CreateCodexSuSessionAdapterOptions,
  ) {
    this.runtimeValue = runtime;
    this.servedAccountReader = options.servedAccountReader ?? gatewayServedAccountForOwner;
    this.controls = { ...defaultControls(), ...(options.controls ?? {}) };
    const hostOptions = {
      descriptor: descriptorFor(binding, runtime, options),
      executeCommand: (command: SuSessionCommand<'codex'>, context: SuSessionCommandContext<'codex'>) => this.execute(command, context),
      runtimeReady: options.runtimeReady,
      persistDescriptor: async (descriptor: SuSessionDescriptor<'codex'>) => {
        await persistSuSessionDescriptor(binding.advSessionId, descriptor);
      },
    };
    this.host = options.host ?? new SuSessionHost(hostOptions);
    if (options.host) this.host.attachRuntime(hostOptions);
    // The deferred PUI create writes the adv row before the native pane boots.
    // Bind the chat id once the native adapter exists; the unique index makes
    // a duplicate adapter converge without creating a second identity.
    void bindSuSessionToAdvSession({
      advSessionId: binding.advSessionId,
      agentChatId: options.agentChatId,
      descriptor: this.host.descriptor(),
      workspaceId: binding.workspaceId ?? undefined,
    }).catch(() => undefined);
    this.unregister = options.register === false ? null : registerSuSessionHost(this.host);
    if (options.ready !== false) this.host.transition('ready', 'Codex native runtime attached');
  }

  get runtime(): CodexSuRuntimeBinding {
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

  async materializeRuntime(runtime: CodexSuRuntimeBinding): Promise<void> {
    if (this.host.descriptor().identity.nativeSessionId !== runtime.nativeSession.rolloutId) {
      this.host.materializeNativeSessionId(runtime.nativeSession.rolloutId);
      if (!await this.host.persistDescriptorNow()) {
        throw new Error('Could not persist the native session identity and resume descriptor');
      }
    }
    this.runtimeValue = runtime;
  }

  private nextTurnId(hint?: string | null): string {
    this.turnSerial += 1;
    const safeHint = String(hint ?? '')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 80);
    return safeHint
      ? `codex:${safeHint}:${this.turnSerial}`
      : `codex:${this.host.descriptor().identity.nativeSessionId}:turn-${this.turnSerial}`;
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
      type: 'transcript',
      phase: 'started',
      turnId: input.turnId,
      role: input.role,
      channel: input.channel,
    } as SuSessionEventInput<'codex'>);
    if (input.content) {
      this.host.emit({
        type: 'transcript',
        phase: 'delta',
        turnId: input.turnId,
        role: input.role,
        channel: input.channel,
        content: input.content,
      } as SuSessionEventInput<'codex'>);
    }
    this.host.emit({
      type: 'transcript',
      phase: 'completed',
      turnId: input.turnId,
      role: input.role,
      channel: input.channel,
      ...(input.content ? { content: input.content } : {}),
    } as SuSessionEventInput<'codex'>);
  }

  /** Consume one complete native JSONL record. Partial trailing records must be
   * retained by the source until their newline arrives. */
  ingestNativeLine(line: string, { preserveLifecycle = false }: { preserveLifecycle?: boolean } = {}): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.host.emit({
        type: 'error',
        scope: 'transport',
        code: 'codex_record_malformed',
        message: 'Codex rollout emitted a malformed JSONL record',
        recoverable: true,
      } as SuSessionEventInput<'codex'>);
      return;
    }

    const payload = asRecord(record.payload);
    const payloadType = typeof payload?.type === 'string' ? payload.type : '';
    const nativeTurnHint = firstString(payload?.turn_id, payload?.turnId, payload?.id);

    if (record.type === 'session_meta') {
      const nativeId = firstString(payload?.id, payload?.session_id);
      if (nativeId && nativeId !== this.runtimeValue.nativeSession.rolloutId) {
        this.host.emit({
          type: 'error',
          scope: 'transport',
          code: 'codex_native_identity_mismatch',
          message: `rollout metadata names ${nativeId}; attached runtime is ${this.runtimeValue.nativeSession.rolloutId}`,
          recoverable: false,
        } as SuSessionEventInput<'codex'>);
        return;
      }
    }

    if (record.type === 'turn_context' && typeof payload?.model === 'string') {
      const descriptor = this.host.descriptor();
      if (descriptor.model !== payload.model) {
        this.host.emit({
          type: 'session',
          descriptor: { ...descriptor, model: payload.model },
        } as SuSessionEventInput<'codex'>);
      }
    }

    if (record.type === 'event_msg' && payloadType === 'task_started') {
      this.currentTurnId = this.nextTurnId(nativeTurnHint);
      if (!preserveLifecycle) this.host.transition('running', 'Codex native task started');
    }
    if (record.type === 'compacted') {
      if (!preserveLifecycle) this.host.transition('compacting', 'Codex native transcript compacted');
    }

    const error = nativeError(record);
    if (error) {
      const key = `${error.turnId ?? ''}\u0000${error.code}\u0000${error.message}`;
      if (key !== this.lastNativeErrorKey) {
        this.lastNativeErrorKey = key;
        this.host.emit({
          type: 'error',
          scope: 'turn',
          code: error.code,
          message: error.message,
          recoverable: true,
          details: error.turnId ? { nativeTurnId: error.turnId } : undefined,
        } as SuSessionEventInput<'codex'>);
      }
    }

    for (const entry of this.parser.parseLine(line)) {
      if (entry.kind === 'prompt') {
        this.currentTurnId = this.nextTurnId(nativeTurnHint);
        if (!preserveLifecycle) this.host.transition('running', 'Codex owner turn persisted');
        this.emitTranscript({
          turnId: this.currentTurnId,
          role: 'owner',
          channel: 'text',
          content: entry.text ?? '',
        });
        continue;
      }
      if (entry.kind === 'text') {
        this.emitTranscript({
          turnId: this.ensureTurn(nativeTurnHint),
          role: 'assistant',
          channel: 'text',
          content: entry.text ?? '',
        });
        continue;
      }
      if (entry.kind === 'status' && entry.text?.startsWith('[thinking]')) {
        this.emitTranscript({
          turnId: this.ensureTurn(nativeTurnHint),
          role: 'assistant',
          channel: 'reasoning',
          content: entry.text.replace(/^\[thinking\]\s*/, ''),
        });
        continue;
      }
      if (entry.kind === 'tool_use') {
        const callId = entry.toolId ?? `codex-call-${this.toolNames.size + 1}`;
        const name = entry.toolName ?? 'tool';
        this.toolNames.set(callId, name);
        this.host.emit({
          type: 'tool',
          phase: 'started',
          turnId: this.ensureTurn(nativeTurnHint),
          callId,
          name,
          input: asJsonValue(entry.toolInput),
        } as SuSessionEventInput<'codex'>);
        continue;
      }
      if (entry.kind === 'tool_result') {
        const callId = entry.toolId ?? `codex-result-${this.toolNames.size + 1}`;
        this.host.emit({
          type: 'tool',
          phase: 'completed',
          turnId: this.ensureTurn(nativeTurnHint),
          callId,
          name: this.toolNames.get(callId) ?? 'tool',
          output: asJsonValue(entry.text ?? ''),
          isError: false,
        } as SuSessionEventInput<'codex'>);
      }
    }

    if (record.type === 'event_msg' && (payloadType === 'task_complete' || payloadType === 'turn_completed')) {
      if (!preserveLifecycle) this.host.transition('waiting-for-owner', error ? 'Codex turn failed' : 'Codex turn completed');
      this.currentTurnId = null;
    }
  }

  async consumeNativeLines(lines: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of lines) this.ingestNativeLine(line);
    } catch (error) {
      this.host.emit({
        type: 'error',
        scope: 'transport',
        code: 'codex_transcript_stream_failed',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      } as SuSessionEventInput<'codex'>);
    }
  }

  async consumeRolloutSnapshot({ preserveLifecycle = false }: { preserveLifecycle?: boolean } = {}): Promise<void> {
    if (!this.runtimeValue.rolloutPath) {
      throw new Error('Codex runtime has no resolved rollout path');
    }
    for await (const line of readCodexRolloutSnapshotLines(this.runtimeValue.rolloutPath)) this.ingestNativeLine(line, { preserveLifecycle });
  }

  /** P-004 calls this after an exact resume/carry replacement attaches. The
   * durable SU identity remains unchanged while runtimeGeneration advances. */
  replaceRuntime(runtime: CodexSuRuntimeBinding, reason = 'Codex runtime replaced'): void {
    const generation = this.host.descriptor().runtimeGeneration + 1;
    this.host.transition('resuming', reason, generation);
    this.runtimeValue = runtime;
    this.parser = createCodexTimelineParser();
    this.currentTurnId = null;
    this.toolNames.clear();
    this.lastNativeErrorKey = null;
    this.host.emit({
      type: 'backend',
      extension: {
        backend: 'codex',
        codexHome: runtime.nativeSession.codexHome,
      },
    } as SuSessionEventInput<'codex'>);
    this.host.transition('ready', reason, generation);
  }

  reconcileRuntimeExit(input: {
    expected: boolean;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
  }): void {
    this.host.reconcileRuntimeExit(input);
  }

  private async execute(
    command: SuSessionCommand<'codex'>,
    context: SuSessionCommandContext<'codex'>,
  ): Promise<SuSessionCommandOutcome> {
    const ownerId = context.descriptor().identity.ownerId;
    let verdict: CodexNativeCommandVerdict;
    switch (command.type) {
      case 'owner_turn':
        context.transition('running', 'owner turn accepted');
        verdict = await this.controls.ownerTurn({
          ownerId,
          turnId: command.turnId,
          content: command.content,
        });
        if (!verdict.ok) context.transition('waiting-for-owner', verdict.message);
        break;
      case 'interrupt':
        verdict = await this.controls.interrupt({ ownerId, reason: command.reason });
        break;
      case 'resume':
        context.transition('resuming', `resume requested (${command.cause})`);
        verdict = await this.controls.resume({
          ownerId,
          rolloutId: this.runtimeValue.nativeSession.rolloutId,
          cause: command.cause,
        });
        context.transition(
          verdict.ok ? 'ready' : 'interrupted',
          verdict.ok ? 'Codex runtime resumed' : verdict.message,
        );
        break;
      case 'focus':
        verdict = await this.controls.focus({ ownerId });
        break;
      case 'end':
        verdict = await this.controls.end({ ownerId, reason: command.reason });
        break;
      case 'fork':
        // Capability dispatch refuses this before the executor is reached.
        return commandRefusal(
          refused(
            'unsupported',
            'the tracked Codex psu path exposes exact resume but no identity-safe native fork transport',
            false,
          ),
        );
      default:
        return assertNeverSuSession(command);
    }
    if (verdict.ok) return { status: 'completed' };
    return commandRefusal(verdict);
  }

  dispose(): void {
    if (this.unregister) this.unregister();
    else this.host.dispose('Codex adapter disposed');
  }
}

export function createCodexSuSessionAdapter(
  binding: PuiSuSessionBinding,
  runtime: CodexSuRuntimeBinding,
  options: CreateCodexSuSessionAdapterOptions,
): CodexSuSessionAdapter {
  if (binding.backend !== 'codex') {
    throw new Error(`Codex adapter cannot attach backend ${binding.backend}`);
  }
  return new CodexSuSessionAdapter(binding as PuiSuSessionBinding & { backend: 'codex' }, runtime, options);
}

/** Canonical PUI create/attach entry followed by native Codex materialisation. */
export async function openCodexSuSession(
  input: CodexPuiSuSessionInput,
  options: OpenCodexSuSessionOptions,
): Promise<OpenCodexSuSessionResult> {
  const opened = await (options.openSession ?? openPuiSuSession)(input);
  if (!opened.ok) {
    return {
      ok: false,
      code: 'pui_session_open_failed',
      error: opened.error,
    };
  }
  const binding = opened.session;
  if (binding.backend !== 'codex') {
    return {
      ok: false,
      code: 'backend_mismatch',
      error: `PUI opened ${binding.backend}; expected codex`,
      binding,
    };
  }
  const codexBinding = binding as PuiSuSessionBinding & { backend: 'codex' };
  if (!binding.ownerId || !binding.workspaceId) {
    return {
      ok: false,
      code: 'identity_not_ready',
      error: 'PUI Codex session has no ownerId/workspaceId yet',
      binding,
    };
  }
  const runtime = await (options.resolveRuntime ?? resolveCodexSuRuntime)(codexBinding);
  if (!runtime) {
    return {
      ok: false,
      code: 'native_session_not_ready',
      error: 'Codex native rollout is not materialized yet; attach after the deferred pane starts',
      binding,
    };
  }
  const carry = input.operation === 'create' ? input.carry : options.carry;
  const adapter = createCodexSuSessionAdapter(codexBinding, runtime, {
    ...options,
    carry: carry ?? 'warm',
  });
  return { ok: true, binding: codexBinding, runtime, adapter };
}

/** Finite, record-boundary-safe source for an already-written native rollout.
 * Live callers may pass their existing append-follow AsyncIterable directly to
 * `consumeNativeLines`; this helper is the deterministic snapshot/test entry. */
export async function* readCodexRolloutSnapshotLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) yield line;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
