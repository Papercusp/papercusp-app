/** Native structured engines for PUI. Codex owns an app-server thread; OMP
 * owns an RPC session. Bootstrap/configuration, adapters, durable commands and
 * tracked process teardown are the same seams used by other SU launches. */
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SuSessionJsonValue } from '@papercusp/chat-protocol';
import {
  applyGithubTokenEnv, assertLaunchPersona, modelArgsFor, ompCoreToolNames,
  ompResponsesCompatibilityEnv, recordSessionOwner, resolveOmpInjectHookPath,
  resolveOmpSessionModel, sanitizeInheritedEnv, suLaunchArgs, writeOmpSessionConfigDir,
} from '../../../apps/operator/scripts/psu-launcher.mjs';
import { splitModelSpec } from './agent-config-constants';
import { setAdvSessionOmpThreadId } from './adv-sessions';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { resolveSpawnHostOperatorBaseUrl } from './mcp-base-url';
import type { CodexNativeSessionHandle, OmpNativeSessionHandle } from './native-session-handles';
import { createCodexSuSessionAdapter, type CodexSuSessionAdapter } from './su-session-codex-adapter';
import { createOmpSuSessionAdapter, type OmpSuSessionAdapter } from './su-session-omp-adapter';
import { makeCodingAssistantCodexHome } from './role-codex-home';
import type { ClaudeEngineIdentity } from './su-session-claude-engine';
import { persistSuSessionDescriptor } from './su-session-persistence';
import { findCodexRolloutPathByUuid } from './session-transcript-resolvers';
import { SuSessionStartupTimeoutError, type SuSessionEventInput, type SuSessionHost, type SuSessionServedAccountReader } from './su-session-host';
import { startSuStdioPeer, type RpcFrame, type SuStdioPeer } from './su-session-stdio-peer';
import { SuNativeCards } from './su-session-native-cards';
import { readSuperuserToken } from './superuser-token';

type Backend = 'codex' | 'omp';
type NativeHandle = CodexNativeSessionHandle | OmpNativeSessionHandle;
export interface SuRpcEngineOptions {
  agentChatId: string;
  model?: string | null;
  accountRoute?: string | null;
  servedAccountReader?: SuSessionServedAccountReader;
  /** Acceptance-only opt-in to the native permission request/card path. */
  toolApproval?: 'prompt';
  carry?: 'warm' | 'cold';
  modes?: readonly string[];
  runtimeGeneration?: number;
  nativeSession?: NativeHandle;
  host?: SuSessionHost;
  beforeReady?: (pid: number | null) => Promise<void>;
  register?: boolean;
  startupTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  peerFactory?: typeof startSuStdioPeer;
  onExit?: () => Promise<void>;
  /** P-016: 'coding-assistant' runs the backend's own identity, with no SU
   * playbook, Papercusp hooks or papercusp-su MCP (default 'su'). */
  identity?: ClaudeEngineIdentity;
}

/** The user's own OMP MCP servers, minus papercusp-su (P-016). */
function ompUserMcpJsonWithoutSu(home: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.omp', 'agent', 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    const servers = { ...(parsed.mcpServers ?? {}) };
    for (const name of Object.keys(servers)) if (/^papercusp(?:[-_]su)?$/i.test(name)) delete servers[name];
    return JSON.stringify({ ...parsed, mcpServers: servers }, null, 2);
  } catch {
    return JSON.stringify({ mcpServers: {} });
  }
}

/** OMP launch flags for its own identity: suLaunchArgs minus the SU system
 * prompt, and without the native-LSP strip (stock OMP keeps its LSP tool). */
export function ompCodingAssistantArgs(promptFile: string): string[] {
  const args = [...suLaunchArgs('omp', { promptFile, allowNativeLsp: true }).args];
  const at = args.indexOf('--system-prompt');
  if (at >= 0) args.splice(at, 2);
  return args;
}
export interface SuRpcEngine {
  adapter: CodexSuSessionAdapter | OmpSuSessionAdapter;
  ready: Promise<void>;
  done: Promise<void>;
  close(): Promise<void>;
  pid(): number | null;
  nativeSession(): NativeHandle;
}

function object(value: unknown): RpcFrame {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RpcFrame : {};
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function startSuRpcEngine(
  boot: BootstrapSuResult,
  binding: PuiSuSessionBinding & { backend: Backend },
  options: SuRpcEngineOptions,
): SuRpcEngine {
  const backend = binding.backend;
  if (boot.agent !== backend || boot.sessionId !== binding.advSessionId
    || boot.workspaceId !== binding.workspaceId || boot.harnessSlug !== binding.harnessSlug
    || boot.envelopeEnv.PAPERCUSP_SID !== binding.ownerId) {
    throw new Error('Structured engine bootstrap does not match the durable SU identity');
  }
  if (options.nativeSession && options.nativeSession.backend !== backend) throw new Error('Resume handle has a different backend');
  assertLaunchPersona(boot.promptFile);
  const su = (options.identity ?? 'su') === 'su';
  const env = { ...sanitizeInheritedEnv(process.env), ...boot.envelopeEnv };
  delete env.PAPERCUSP_TTY;
  env.PAPERCUSP_OPERATOR_URL = resolveSpawnHostOperatorBaseUrl();
  let selectedModel = options.model;
  let args: string[];
  let native: NativeHandle;
  let nativePath: string | null = null;
  if (backend === 'codex') {
    if (!env.CODEX_HOME) throw new Error('Codex SU bootstrap did not supply CODEX_HOME');
    if (!su) makeCodingAssistantCodexHome(env.CODEX_HOME, env.HOME || homedir());
    native =options.nativeSession ?? { backend, source: 'adv_sessions', ownerId: binding.ownerId,
      codexHome: env.CODEX_HOME, rolloutId: '', exactResumeSupported: false, missingReason: 'Codex is initializing' };
    // App-server accepts config overrides rather than the TUI's -m flag.
    const modelArgs = modelArgsFor('codex', selectedModel) as string[];
    args = [...suLaunchArgs('codex').args, 'app-server'];
    for (let index = 0; index < modelArgs.length; index++) {
      if (modelArgs[index] === '-m') args.push('-c', `model=${JSON.stringify(modelArgs[++index])}`);
      else args.push(modelArgs[index]);
    }
  } else {
    selectedModel = resolveOmpSessionModel(env.PAPERCUSP_OMP_MODEL_SELECTOR || selectedModel, options.accountRoute);
    const configDir = options.nativeSession?.backend === 'omp' && options.nativeSession.agentHome
      ? null : writeOmpSessionConfigDir(binding.advSessionId, {
        discoveryOff: su, toolsAllowlist: su ? ompCoreToolNames(env) : null, model: selectedModel,
        modelsYml: env.PAPERCUSP_OMP_MODELS_YML || null, clientId: binding.ownerId,
        operatorUrl: env.PAPERCUSP_OPERATOR_URL, interactive: false,
        // WI-10003604: this engine runs INSIDE the operator it points OMP at, so the bearer the
        // session needs is exactly the one this process validates — never the user template's.
        operatorBearer: su ? readSuperuserToken() : null,
        // P-016: an explicit server map is used verbatim: the user's own servers only.
        ...(su ? {} : { mcpJsonContents: ompUserMcpJsonWithoutSu(env.HOME || homedir()) }),
      });
    const agentHome = options.nativeSession?.backend === 'omp' ? options.nativeSession.agentHome
      : configDir ? join(homedir(), configDir, 'agent') : null;
    if (!agentHome) throw new Error('OMP could not materialize its isolated SU configuration');
    env.PI_CODING_AGENT_DIR = agentHome;
    if (configDir) env.PI_CONFIG_DIR = configDir;
    Object.assign(env, ompResponsesCompatibilityEnv('omp', selectedModel, env));
    native = options.nativeSession ?? { backend, source: 'adv_sessions', ownerId: binding.ownerId,
      agentHome, ompThreadId: '', exactResumeSupported: false, missingReason: 'OMP is initializing' };
    args = [...su ? suLaunchArgs('omp', { promptFile: boot.promptFile, coordExtPath: boot.coordExtPath,
      injectHookPath: resolveOmpInjectHookPath('omp'), allowNativeLsp: env.PAPERCUSP_OMP_NATIVE_LSP === '1' }).args
      : ompCodingAssistantArgs(boot.promptFile),
      // rpc-ui keeps structured stdio and installs OMP's native question
      // callbacks. Plain rpc deliberately omits that interactive capability.
      ...modelArgsFor('omp', selectedModel), '--mode', 'rpc-ui'];
    if (options.toolApproval === 'prompt') {
      const approvalMode = args.indexOf('--approval-mode');
      if (approvalMode < 0 || args[approvalMode + 1] !== 'yolo') {
        throw new Error('OMP structured launch is missing its managed approval mode');
      }
      args[approvalMode + 1] = 'always-ask';
    }
    if (native.backend === 'omp' && native.ompThreadId) args.push('--resume', native.ompThreadId);
  }
  if (!options.peerFactory) applyGithubTokenEnv(env);
  let peer: SuStdioPeer | undefined;
  let ready = false;
  let closed = false;
  let failureReported = false;
  let ompReadinessFailure: string | undefined;
  let ownerTurnId = '';
  let nativeTurnId = '';
  let turnCompletionSettled = false;
  let turnFinished: (() => void) | undefined;
  let turnCompletion: Promise<void> | undefined;
  let nativeStart: Promise<RpcFrame> | undefined;
  let inputTail = Promise.resolve();
  const streams = new Map<string, string>();
  const tools = new Map<string, string>();
  const initializingFrames: RpcFrame[] = [];
  let initializingFrameBytes = 0;
  const unavailable = (message: string) => ({ ok: false as const, code: 'engine_delivery_unknown', message, retryable: false });
  const controls = {
    async ownerTurn({ content, turnId }: { content: string; turnId: string }) {
      if (!ready || closed) return unavailable(`${backend} connection is not ready`);
      let acknowledged!: (verdict: { ok: true } | ReturnType<typeof unavailable>) => void;
      const receipt = new Promise<{ ok: true } | ReturnType<typeof unavailable>>((resolve) => { acknowledged = resolve; });
      inputTail = inputTail.then(async () => {
        if (!ready || closed) { acknowledged(unavailable('The engine closed before this saved turn was sent')); return; }
        ownerTurnId = turnId;
        turnCompletionSettled = false;
        const finished = new Promise<void>((resolve) => { turnFinished = resolve; });
        turnCompletion = finished;
        try {
          if (backend === 'codex') {
            nativeStart = peer!.request({ method: 'turn/start', params: {
              threadId: nativeId(), input: [{ type: 'text', text: content }],
            } }, options.deliveryTimeoutMs ?? 30_000);
            const result = await nativeStart;
            nativeTurnId = string(object(result.turn).id);
            if (!nativeTurnId) throw new Error('Codex accepted no identifiable native turn');
          } else await peer!.request({ type: 'prompt', message: content }, options.deliveryTimeoutMs ?? 30_000);
          await refreshResumeEvidence();
          acknowledged({ ok: true });
          await finished;
        } catch (error) {
          acknowledged(unavailable(String(error)));
          // The native turn may have begun despite a lost response. Do not
          // send queued input into an uncorrelated turn or replay this one.
          ready = false;
          adapter.reconcileRuntimeExit({ expected: false, reason: `Native delivery is unknown: ${String(error)}` });
          await close();
        } finally { turnFinished = undefined; turnCompletion = undefined; nativeStart = undefined; ownerTurnId = ''; nativeTurnId = ''; streams.clear(); }
      });
      return receipt;
    },
    async interrupt() {
      if (!peer || closed) return unavailable('The engine is disconnected');
      cards.cancel();
      const completing = turnCompletion;
      try {
        if (backend === 'codex') {
          if (!nativeTurnId && nativeStart) nativeTurnId = string(object((await nativeStart).turn).id);
          if (nativeTurnId) await peer.request({ method: 'turn/interrupt', params: { threadId: nativeId(), turnId: nativeTurnId } });
        } else {
          await peer.request({ type: 'abort' }, options.deliveryTimeoutMs ?? 30_000);
          // OMP responds only after session.abort has cancelled setup and
          // awaited native idle. A turn cancelled before agent_start has no
          // agent_end event, so that idle acknowledgement settles delivery.
          turnFinished?.();
        }
        if (completing) {
          let timer: ReturnType<typeof setTimeout>;
          try {
            await Promise.race([completing, new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Native interrupt did not finish the active turn')), options.deliveryTimeoutMs ?? 30_000);
            })]);
          } finally { clearTimeout(timer!); }
        }
      } catch (error) {
        reportRuntimeFailure(error);
        await close();
        return unavailable(String(error));
      }
      host.transition('interrupted', 'Owner interrupted the native turn');
      return { ok: true as const };
    },
    async resume() { return ready && !closed ? { ok: true as const } : unavailable('Reconnect the saved structured session before resuming'); },
    async focus() { return { ok: true as const }; },
    async end() { await close(); return { ok: true as const }; },
  };
  const shared = { ...options, controls, ready: false, runtimeReady: () => ready && !closed };
  const adapter = backend === 'codex'
    ? createCodexSuSessionAdapter(binding, { nativeSession: { ...native as CodexNativeSessionHandle, rolloutId: nativeId() }, rolloutPath: null }, { ...shared, host: options.host as SuSessionHost<'codex'> | undefined })
    : createOmpSuSessionAdapter(binding, { nativeSession: { ...native as OmpNativeSessionHandle, ompThreadId: nativeId() }, transcriptPath: null }, { ...shared, host: options.host as SuSessionHost<'omp'> | undefined });
  const host = adapter.host as SuSessionHost<Backend>;
  const cards = new SuNativeCards(binding.workspaceId!, `pui-native:${binding.advSessionId}:${options.runtimeGeneration ?? 0}`, (event) => {
    if (closed) return;
    emit(event as SuSessionEventInput<Backend>);
    if (event.type === 'card') host.transition(event.phase === 'opened' ? 'waiting-for-owner' : 'running',
      event.phase === 'opened' ? 'Native engine is waiting for your response' : 'Native response delivered');
  }, boot.cwd);
  function nativeId(): string { return native.backend === 'codex' ? native.rolloutId ?? '' : native.ompThreadId ?? ''; }
  function resumeHandle(): NativeHandle {
    const persisted = Boolean(nativePath && existsSync(nativePath));
    native = { ...native, exactResumeSupported: persisted,
      missingReason: persisted ? null : `${backend} has not persisted this native session yet` };
    binding.nativeSession = native;
    return native;
  }
  async function refreshResumeEvidence(): Promise<void> {
    if (native.backend === 'codex' && native.rolloutId && (!nativePath || !existsSync(nativePath))) {
      nativePath = await findCodexRolloutPathByUuid(native.rolloutId, { homeOverride: native.codexHome });
    }
    resumeHandle();
  }
  function emit(input: SuSessionEventInput<Backend>): void { host.emit(input); }
  function reportRuntimeFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (!failureReported) {
      failureReported = true;
      emit({ type: 'error', scope: 'transport', code: `${backend}_connection_failed`, message, recoverable: true });
    }
    if (!host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: false, reason: message });
  }
  function transcript(key: string, channel: 'text' | 'reasoning', delta: string, completed = false): void {
    if (!ownerTurnId) return;
    if (!streams.has(key)) {
      streams.set(key, '');
      emit({ type: 'transcript', phase: 'started', turnId: ownerTurnId, role: 'assistant', channel });
    }
    if (delta) {
      streams.set(key, streams.get(key)! + delta);
      emit({ type: 'transcript', phase: 'delta', turnId: ownerTurnId, role: 'assistant', channel, content: delta });
    }
    if (completed) emit({ type: 'transcript', phase: 'completed', turnId: ownerTurnId, role: 'assistant', channel, content: streams.get(key) });
  }
  async function finish(status: string, error?: string): Promise<void> {
    if (turnCompletionSettled) return;
    turnCompletionSettled = true;
    if (error) emit({ type: 'error', scope: 'turn', code: `${backend}_turn_failed`, message: error, recoverable: true });
    // The native transcript/RPC frame carries completion, but not the account
    // selected by Papercusp's inference gateway. Refresh that provenance before
    // resolving the owner command so success and known failure both publish a
    // settled descriptor. The adapter's reader is injectable and null-safe.
    await adapter.refreshAccountServed();
    host.transition(status === 'interrupted' ? 'interrupted' : 'waiting-for-owner', error ?? `${backend} turn ${status}`);
    turnFinished?.();
  }
  function onMessage(frame: RpcFrame): void {
    if (closed) return;
    const frameThreadId = object(frame.params).threadId;
    if (backend === 'codex' && frameThreadId && !nativeId()) {
      // App-server can announce MCP startup before thread/start responds.
      // Defer these frames until that correlated response pins the identity;
      // never treat an unbound identity as permission to dispatch a request.
      initializingFrameBytes += Buffer.byteLength(JSON.stringify(frame));
      if (initializingFrames.length >= 256 || initializingFrameBytes > 1_048_576) {
        throw new Error('Codex emitted too many thread events before identifying its session');
      }
      initializingFrames.push(frame);
      return;
    }
    if (backend === 'codex' && frameThreadId && frameThreadId !== nativeId()) throw new Error('Codex event belongs to a different thread');
    if (cards.handle(backend, frame, ownerTurnId || 'startup', (response) => { if (!closed) peer?.send(response); })) return;
    if (backend === 'codex') {
      const method = string(frame.method), params = object(frame.params);
      const eventTurnId = string(params.turnId) || string(object(params.turn).id);
      if (method !== 'turn/started' && eventTurnId && nativeTurnId && eventTurnId !== nativeTurnId) return;
      if (frame.id != null && method) {
        // Do not execute or approve a request this PUI cannot answer yet.
        peer?.send({ id: frame.id, error: { code: -32601, message: `PUI cannot answer ${method}` } });
        emit({ type: 'error', scope: 'command', code: 'native_request_unsupported', message: `This Codex request is unavailable in PUI: ${method}`, recoverable: true });
      } else if (method === 'turn/started') {
        nativeTurnId = string(object(params.turn).id); host.transition('running', 'Codex native turn started');
      } else if (method === 'turn/completed') {
        const turn = object(params.turn); void finish(string(turn.status), string(object(turn.error).message) || undefined);
      } else if (method === 'item/agentMessage/delta') {
        transcript(string(params.itemId), 'text', string(params.delta));
      } else if (method === 'item/reasoning/summaryTextDelta') {
        transcript(`${params.itemId}:reasoning`, 'reasoning', string(params.delta));
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = object(params.item), id = string(item.id), type = string(item.type);
        if (type === 'agentMessage' && method === 'item/completed') {
          transcript(id, 'text', streams.has(id) ? '' : string(item.text), true);
        } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(type) && ownerTurnId) {
          const name = string(item.tool) || type;
          if (method === 'item/started') {
            tools.set(id, name);
            emit({ type: 'tool', phase: 'started', turnId: ownerTurnId, callId: id, name, input: item as SuSessionJsonValue });
          } else {
            emit({ type: 'tool', phase: 'completed', turnId: ownerTurnId, callId: id, name: tools.get(id) ?? name,
              output: item as SuSessionJsonValue, isError: item.status === 'failed' || item.exitCode != null && item.exitCode !== 0 });
            tools.delete(id);
          }
        }
      } else if (method === 'error') void finish('failed', string(object(params.error).message) || 'Codex reported an error');
    } else {
      const type = string(frame.type);
      if (type === 'message_update') {
        const event = object(frame.assistantMessageEvent);
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          const channel = event.type === 'text_delta' ? 'text' : 'reasoning';
          transcript(`${channel}:${event.contentIndex ?? 0}`, channel, string(event.delta));
        }
      } else if (type === 'message_end' && object(frame.message).role === 'assistant') {
        const message = object(frame.message);
        for (const [index, value] of (Array.isArray(message.content) ? message.content : []).entries()) {
          const block = object(value), channel = block.type === 'thinking' ? 'reasoning' : 'text';
          if (block.type === 'text' || block.type === 'thinking') {
            const key = `${channel}:${index}`;
            transcript(key, channel, streams.has(key) ? '' : string(block.text ?? block.thinking), true);
          }
        }
        if (message.errorMessage) void finish('failed', string(message.errorMessage));
        streams.clear();
      } else if ((type === 'tool_execution_start' || type === 'tool_execution_end') && ownerTurnId) {
        const callId = string(frame.toolCallId), name = string(frame.toolName);
        if (type === 'tool_execution_start') emit({ type: 'tool', phase: 'started', turnId: ownerTurnId, callId, name, input: frame.args as SuSessionJsonValue });
        else emit({ type: 'tool', phase: 'completed', turnId: ownerTurnId, callId, name, output: frame.result as SuSessionJsonValue, isError: frame.isError === true });
      } else if (type === 'agent_end' || type === 'prompt_result' && frame.agentInvoked === false) void finish('completed');
      else if (type === 'agent_start') host.transition('running', 'OMP native turn started');
      else if (type === 'auto_compaction_start') host.transition('compacting', 'OMP is compacting its native context');
      else if (type === 'response' && frame.success === false) void finish('failed', string(frame.error));
    }
  }
  let done: Promise<void> = Promise.resolve();
  let starting: Promise<void>;
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; ready = false; turnFinished?.(); cards.cancel();
    closing = (async () => { await peer?.close(); })();
    return closing;
  }
  starting = (async () => {
    if (options.nativeSession) {
      // WI-10004162: show the saved conversation before the native peer starts
      // (seconds, or never when startup fails). Best-effort: the replay once the
      // peer is up stays authoritative and adds only what it wrote since.
      await (backend === 'codex'
        ? (adapter as CodexSuSessionAdapter).consumeRolloutSnapshot({ preserveLifecycle: true })
        : (adapter as OmpSuSessionAdapter).consumeTranscriptSnapshot({ preserveLifecycle: true })
      ).catch(() => undefined);
      if (closed) throw new Error('Structured connection closed during startup');
    }
    peer = await (options.peerFactory ?? startSuStdioPeer)({
      binary: backend, args, cwd: boot.cwd, env, ownerId: binding.ownerId!, workspaceId: boot.workspaceId, onMessage,
      spec: { class: 'agent-session', title: `PUI ${backend} structured engine`, launchedBy: 'pui-su-session',
        argv: [backend, ...args],
        harnessSlug: binding.harnessSlug, planSlug: binding.planSlug, cwd: boot.cwd,
        detail: { coordOwnerId: binding.ownerId, advSessionId: binding.advSessionId, transport: 'structured' } },
    });
    if (closed) { await peer.close(); throw new Error('Structured engine startup was cancelled'); }
    done = peer.done.catch((error: unknown) => {
      if (!closed) reportRuntimeFailure(error);
      throw error;
    }).finally(async () => {
      ready = false; turnFinished?.();
      if (!host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: closed, reason: `${backend} connection closed` });
      await options.onExit?.();
    });
    void done.catch(() => undefined);
    let actualModel: string;
    if (backend === 'codex') {
      await peer.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_pui', title: 'Papercusp PUI', version: '1' } } });
      peer.send({ method: 'initialized', params: {} });
      const params = { cwd: boot.cwd,
        approvalPolicy: options.toolApproval === 'prompt' ? 'on-request' : 'never',
        sandbox: options.toolApproval === 'prompt' ? 'workspace-write' : 'danger-full-access',
        ...(nativeId() ? { threadId: nativeId() } : {}) };
      const result = await peer.request({ method: nativeId() ? 'thread/resume' : 'thread/start', params });
      const thread = object(result.thread), id = string(thread.id);
      if (!id || nativeId() && id !== nativeId()) throw new Error('Codex did not return the requested native identity');
      if (thread.cwd && resolve(string(thread.cwd)) !== resolve(boot.cwd)) throw new Error('Codex started in a different project');
      nativePath = string(thread.path) || null;
      native = { ...native as CodexNativeSessionHandle, rolloutId: id, exactResumeSupported: false, missingReason: 'Checking native persistence' };
      await (adapter as CodexSuSessionAdapter).materializeRuntime({ nativeSession: { ...native, rolloutId: id }, rolloutPath: nativePath });
      for (const frame of initializingFrames.splice(0)) onMessage(frame);
      initializingFrameBytes = 0;
      if (su) {
        const servers = await peer.request({ method: 'mcpServerStatus/list', params: {} });
        const suServer = (Array.isArray(servers.data) ? servers.data : []).map(object).find((server) => server.name === 'papercusp-su');
        if (!suServer || !Object.keys(object(suServer.tools)).length) throw new Error('Codex SU tools are not connected');
      }
      actualModel = string(result.model);
    } else {
      let state: RpcFrame;
      let id = '';
      let readinessDelayMs = 100;
      // RPC readiness precedes OMP's asynchronous MCP inventory updates.
      // Keep input closed until positive SU connection evidence arrives, using
      // the existing startup deadline. RPC exposes this inventory in get_state.
      while (true) {
        state = await peer.request({ type: 'get_state' });
        const observedId = string(state.sessionId), expectedId = id || nativeId();
        if (!observedId || expectedId && observedId !== expectedId) throw new Error('OMP did not return the requested native identity');
        id = observedId;
        const toolNames = Array.isArray(state.dumpTools) ? state.dumpTools.map((tool) => string(object(tool).name)) : [];
        const promptParts = (Array.isArray(state.systemPrompt) ? state.systemPrompt : [])
          .filter((part): part is string => typeof part === 'string');
        // OMP's current runtime mounts connected MCP tools as xd:// devices;
        // dumpTools lists only top-level tools. The separate generated mapping
        // section comes from its live MCP route registry. OMP can join it into
        // the base prompt string instead of returning a separate array entry.
        const mountedRoutes = promptParts
          .flatMap((part) => part.split(/^## MCP Tool Routes\r?$/m).slice(1))
          .flatMap((section) => section.split(/^#{1,2} /m, 1)[0].match(/xd:\/\/[^`\s]+/g) ?? []);
        const suRoute = mountedRoutes.some((route) => /papercusp[-_]su/i.test(route));
        // The native route map is a bounded preview and can omit this server.
        // OMP separately emits server instructions from MCPManager's connected
        // registry after initialize, including each exact server name. Like
        // Claude's connected status, this is positive native connection evidence.
        const connectedServers = promptParts
          .flatMap((part) => part.split(/^## MCP Server Instructions\r?$/m).slice(1))
          .flatMap((section) => [...section.split(/^#{1,2} /m, 1)[0].matchAll(/^### ([^\r\n]+)\r?$/gm)]
            .map((match) => match[1]));
        // P-016: a coding-assistant session has no SU server to wait for.
        if (su && !toolNames.some((name) => /papercusp/i.test(name)) && !suRoute && !connectedServers.includes('papercusp-su')) {
          ompReadinessFailure = `OMP SU tools are not connected (available: ${toolNames.slice(0, 30).join(', ') || 'none'}; mounted: ${mountedRoutes.slice(0, 8).join(', ') || 'none'})`;
          await new Promise<void>((resolve) => setTimeout(resolve, readinessDelayMs));
          readinessDelayMs = Math.min(readinessDelayMs * 2, 1_000);
          if (closed) throw new Error('OMP startup was cancelled before its SU tools connected');
          continue;
        }
        ompReadinessFailure = undefined;
        break;
      }
      nativePath = string(state.sessionFile) || null;
      native = { ...native as OmpNativeSessionHandle, ompThreadId: id, exactResumeSupported: false, missingReason: 'Checking native persistence' };
      const linked = await setAdvSessionOmpThreadId(binding.advSessionId, id);
      if (linked !== 'linked' && linked !== 'already_linked') throw new Error(`OMP native identity link failed (${linked})`);
      await (adapter as OmpSuSessionAdapter).materializeRuntime({ nativeSession: { ...native, ompThreadId: id }, transcriptPath: nativePath });
      const model = object(state.model);
      actualModel = [string(model.provider), string(model.id)].filter(Boolean).join('/');
    }
    if (!actualModel) throw new Error('Native engine did not identify its selected model');
    if (backend === 'omp') resolveOmpSessionModel(actualModel, options.accountRoute);
    const requested = splitModelSpec(selectedModel).model;
    if (backend === 'codex' && requested && actualModel !== requested) throw new Error(`Codex selected ${actualModel}, expected ${requested}`);
    if (backend === 'omp' && requested && actualModel !== requested
      && (requested.includes('/') || !actualModel.endsWith(`/${requested}`))) {
      throw new Error(`OMP selected ${actualModel}, expected ${requested}`);
    }
    const descriptor = host.descriptor();
    host.emit({ type: 'session', descriptor: { ...descriptor, model: actualModel,
      capabilities: { ...descriptor.capabilities, features: { ...descriptor.capabilities.features,
        'interactive-cards': { state: 'supported', implementation: 'native' },
      } },
    } } as SuSessionEventInput<Backend>);
    if (!options.peerFactory) recordSessionOwner(nativeId(), binding.ownerId, { advSessionId: binding.advSessionId });
    await refreshResumeEvidence();
    if (!await persistSuSessionDescriptor(binding.advSessionId, host.descriptor(), boot.workspaceId)) {
      throw new Error('Could not persist the native session identity and resume descriptor');
    }
    if (options.nativeSession) {
      // The native runtime restores inference context; the adapter restores
      // the owner's visible history before this connection accepts new input.
      // Historical turn completion must not advertise current readiness.
      host.transition('resuming', 'Restoring saved conversation before attaching the executor');
      if (backend === 'codex') await (adapter as CodexSuSessionAdapter).consumeRolloutSnapshot({ preserveLifecycle: true });
      else await (adapter as OmpSuSessionAdapter).consumeTranscriptSnapshot({ preserveLifecycle: true });
    }
    if (closed) throw new Error('Structured connection closed during startup');
    await options.beforeReady?.(peer.pid());
    if (closed) throw new Error(`${backend} closed while finalizing resume`);
    ready = true;
    host.transition('ready', `${backend} structured stream, SU tools and command executor attached`);
  })();
  let timer: ReturnType<typeof setTimeout>;
  const readyPromise = Promise.race([starting, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(ompReadinessFailure
      ? new Error(ompReadinessFailure)
      : new SuSessionStartupTimeoutError(`${backend} initialization timed out`)), options.startupTimeoutMs ?? 45_000);
  })]).catch(async (error) => {
    reportRuntimeFailure(error);
    await close(); throw error;
  }).finally(() => clearTimeout(timer));
  return { adapter, ready: readyPromise, get done() { return done; }, close, pid: () => peer?.pid() ?? null, nativeSession: resumeHandle };
}
