/** PUI's attached-engine branch of the shared launch-su door. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { getChat } from './agent-chats-data';
import { getAdvSession, markAdvSessionEnded, setAdvSessionPid } from './adv-sessions';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { nativeSessionHandleForAdvSession } from './native-session-handles';
import { _dropSuSessionHostForTest, getRegisteredSuSessionHost, rehydrateRegisteredSuSessionHost, type SuSessionHost } from './su-session-host';
import { bindSuSessionToAdvSession, persistSuSessionDescriptor, readDurableSuSession } from './su-session-persistence';
import { startClaudeSuEngine, type ClaudeEngineIdentity, type ClaudeSuEngine } from './su-session-claude-engine';
import { loadHarnessRegistry } from './harness-registry';
import type { ClaudeSuRuntimeBinding } from './su-session-claude-adapter';
import { startSuRpcEngine, type SuRpcEngine } from './su-session-rpc-engine';
import type { NativeSessionHandle } from './native-session-handles';
import { activeWorkspaceId } from './workspace-registry';
import { prepareStructuredSuResume } from './su-session-resume';
import { resolveCodexModelSelection } from './model-context-budget.mjs';
import { normalizeModelSpecForAgent } from '../../../apps/operator/scripts/psu-launcher.mjs';

const state = pinModuleState('@papercusp/operator-core.su-attached-launch', () => ({
  starting: new Map<string, Promise<Record<string, unknown>>>(),
  engines: new Map<string, ClaudeSuEngine | SuRpcEngine>(),
  // Each engine's exit bookkeeping (close + ended mark); its engine entry is
  // cleared only when this settles.
  exits: new Map<string, Promise<void>>(),
}));

function trackExit(key: string, exit: Promise<void>): void {
  state.exits.set(key, exit);
  void exit.finally(() => { if (state.exits.get(key) === exit) state.exits.delete(key); });
}

/**
 * Test-only: simulate the death of the operator process that launched one
 * attached PUI session (pui-chat-first-ux-2026-09-28 P-002, session 31362).
 * Everything this process holds for the chat is forgotten, exactly as a fresh
 * process would find it: the in-flight launch, the engine, that engine's exit
 * bookkeeping and the live host. The durable row stays as the dead process last
 * wrote it. The forgotten engine is returned so the caller can take its native
 * process down with it and prove the state really held that engine.
 */
export function _simulateLaunchingProcessLossForTest(input: {
  harnessSlug: string;
  agentChatId: string;
}): ClaudeSuEngine | SuRpcEngine | undefined {
  const key = `${activeWorkspaceId()}:${input.harnessSlug}:${input.agentChatId}`;
  const engine = state.engines.get(key);
  state.starting.delete(key);
  state.engines.delete(key);
  state.exits.delete(key);
  if (engine) _dropSuSessionHostForTest(engine.adapter.host);
  return engine;
}

/** Exact-resume attempts per reconnect: the original plus one automatic retry
 * after a startup-deadline timeout (P-028). A second timeout is reported. */
export const RESUME_STARTUP_ATTEMPTS = 2;

function realDir(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Scope rule of plan pui-chat-first-ux-2026-09-28 D-004/D-005: a Claude chat
 * whose directory lies inside a registered checkout keeps the SU identity,
 * because that tree is shared and the psu hooks carry its lock, secrets and
 * migration rails. Anywhere else it is Claude Code's own coding assistant. */
export function claudeEngineIdentityForCwd(cwd: string, checkoutRoots: readonly string[]): ClaudeEngineIdentity {
  const dir = realDir(cwd);
  const inside = checkoutRoots.some((root) => {
    const rel = relative(realDir(root), dir);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  return inside ? 'su' : 'coding-assistant';
}

/** Recomputed from the same inputs on launch and on resume, so a resumed chat
 * keeps its identity without persisted state. An unreadable registry keeps the
 * SU identity: dropping the rails is the choice that needs positive evidence. */
async function claudeEngineIdentityForLaunch(workspaceId: string, cwd: string | null | undefined): Promise<ClaudeEngineIdentity> {
  if (!cwd) return 'su';
  try {
    const registry = await loadHarnessRegistry(workspaceId);
    return claudeEngineIdentityForCwd(cwd, registry.projects.flatMap((project) => project.path ? [project.path] : []));
  } catch {
    return 'su';
  }
}

/** Classified by the typed error's code rather than `instanceof`, so a
 * duplicated module record or a mocked host module cannot hide the class. */
function isStartupTimeout(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'su_session_startup_timeout';
}

/** True once `key`'s previous engine has finished exiting, waiting at most `ms`. */
async function previousEngineExited(key: string, ms: number): Promise<boolean> {
  const exit = state.exits.get(key);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (exit) await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
  return !state.engines.has(key);
}

// PUI sessions use native approval prompts on both creation and recovery.
// Manual/auto mode is a separate agent policy, never a permission bypass.

export interface AttachedSuLaunchInput {
  agent: string;
  agent_chat_id: string;
  harness_slug: string;
  plan_slug?: string | null;
  account: string;
  carry?: 'warm' | 'cold';
  model?: string | null;
  mode?: string | null;
  context_size?: string;
  compaction_limit?: number | null;
  fleet?: string | null;
  seat?: string | null;
  launch_context?: string | null;
  /** The directory the PUI was launched from. When this host can see it, the
   *  session runs there (Claude Code parity, pui-chat-first-ux P-001);
   *  otherwise bootstrap keeps the project checkout. */
  cwd?: string | null;
}

/** How long one launch may run before it reports the step it is stuck in. */
export const LAUNCH_STALL_REPORT_MS = 15_000;
/** A finished step at least this slow is reported with its duration. */
export const SLOW_LAUNCH_STAGE_MS = 5_000;

export interface LaunchStageTracer {
  /** Enter the next named step, reporting the previous one if it was slow. */
  stage(next: string): void;
  /** The launch settled: report a slow final step and stop the stall report. */
  end(): void;
}

/**
 * A PUI launch that never finishes must say WHICH step it stalled in. The PUI
 * only sees "SU launch did not finish", and without this the stall left no
 * server-side evidence at all (pui-chat-first-ux P-007, 2026-09-30).
 */
export function launchStageTracer(
  key: string,
  log: (line: string) => void = (line) => console.warn(line),
  now: () => number = Date.now,
): LaunchStageTracer {
  const startedAt = now();
  let stage = 'read-chat';
  let stageAt = startedAt;
  const stall = setTimeout(() => {
    log(`[su-launch] ${key} not finished after ${now() - startedAt}ms; stalled in stage=${stage} for ${now() - stageAt}ms`);
  }, LAUNCH_STALL_REPORT_MS);
  stall.unref?.();
  const close = (next: string | null) => {
    const at = now();
    if (at - stageAt >= SLOW_LAUNCH_STAGE_MS) log(`[su-launch] ${key} stage=${stage} took ${at - stageAt}ms`);
    if (next !== null) { stage = next; stageAt = at; }
  };
  return { stage: (next) => close(next), end: () => { close(null); clearTimeout(stall); } };
}

export async function launchAttachedSuSession(request: Request, input: AttachedSuLaunchInput): Promise<Response> {
  if (!['claude', 'codex', 'omp'].includes(input.agent)) {
    return Response.json({ status: 'error', code: 'attached_engine_unavailable', error: `The ${input.agent} engine does not support PUI's structured connection.` }, { status: 409 });
  }
  const workspaceId = activeWorkspaceId();
  const key = `${workspaceId}:${input.harness_slug}:${input.agent_chat_id}`;
  let start = state.starting.get(key);
  let trace: LaunchStageTracer | null = null;
  if (!start) {
    trace = launchStageTracer(key);
    start = create();
    state.starting.set(key, start);
    void start.finally(() => {
      trace?.end();
      if (state.starting.get(key) === start) state.starting.delete(key);
    }).catch(() => undefined);
  }
  try { return Response.json(await start); }
  catch (error) {
    return Response.json({ status: 'error', code: 'attached_engine_start_failed', error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }

  async function create(): Promise<Record<string, unknown>> {
    const chat = await getChat({ slug: input.harness_slug, chatId: input.agent_chat_id });
    if (!chat.ok) throw new Error(chat.error);
    if (chat.data.archived_at) throw new Error('This conversation is archived; restore it before connecting');
    trace?.stage('read-durable-session');
    if (chat.data.su_runtime_class !== 'su-session') throw new Error('This conversation is not classified as an SU session; its existing history was preserved');
    const previous = await readDurableSuSession({ workspaceId, agentChatId: input.agent_chat_id });
    if (previous) {
      if (previous.backend !== input.agent || previous.harnessSlug !== input.harness_slug) throw new Error('The conversation is already bound to a different engine or project');
      const host = getRegisteredSuSessionHost({ workspaceId, harnessSlug: input.harness_slug, agentChatId: input.agent_chat_id });
      const snapshot = host?.snapshot();
      const initializing = state.engines.has(key) && snapshot?.descriptor.lifecycle === 'starting';
      if (!snapshot || snapshot.terminal || (!initializing && (!snapshot.executorAttached || !snapshot.streamReady))) {
        // A dead engine's exit bookkeeping can still be running when the
        // owner's recovery send arrives; wait for it rather than refuse.
        if (state.engines.has(key) && !await previousEngineExited(key, 10_000)) {
          throw new Error('The previous native process is still closing; reconnect after it exits');
        }
        trace?.stage('resume');
        const restored = host ?? await rehydrateRegisteredSuSessionHost({ workspaceId,
          harnessSlug: input.harness_slug, agentChatId: input.agent_chat_id });
        if (!restored) throw new Error('Reconnect requires the saved session descriptor');
        const startResumedEngine = async (record: typeof previous) => {
          const resume = await prepareStructuredSuResume(record);
          let active: ClaudeSuEngine | SuRpcEngine | undefined;
          try {
            const options = { ...resume.options, host: restored, beforeReady: resume.beforeReady,
              onExit: resume.onExit, toolApproval: 'prompt' as const };
            active = record.backend === 'claude'
              ? startClaudeSuEngine(resume.boot, resume.binding as PuiSuSessionBinding & { backend: 'claude' },
                { nativeSession: resume.nativeSession as ClaudeSuRuntimeBinding['nativeSession'], transcriptPath: null },
                { ...options, host: restored as SuSessionHost<'claude'>, resume: resume.exact,
                  identity: await claudeEngineIdentityForLaunch(workspaceId, resume.boot.cwd) })
              : startSuRpcEngine(resume.boot, resume.binding as PuiSuSessionBinding & { backend: 'codex' | 'omp' },
                { ...options, nativeSession: resume.nativeSession as Extract<NativeSessionHandle, { backend: 'codex' | 'omp' }> });
            state.engines.set(key, active);
            await persistSuSessionDescriptor(record.advSessionId, active.adapter.host.descriptor());
          } catch (error) { await active?.close(); await resume.release(); throw error; }
          return { engine: active, resume };
        };
        // P-028: a resume whose startup deadline fires is RECOVERABLE — a fresh
        // attempt runs the exact path an owner's manual reconnect would, under
        // the same exclusivity lease. Bounded, visible on the session's own
        // event stream, and never applied to a refusal (auth, identity, a
        // missing transcript), which a repeat cannot fix.
        const supervise = async (current: Awaited<ReturnType<typeof startResumedEngine>>, attempt: number): Promise<void> => {
          const { engine, resume } = current;
          let retryable: unknown = null;
          try {
            try { await engine.ready; } catch (error) { if (isStartupTimeout(error)) retryable = error; throw error; }
            await engine.done;
          } catch (error) {
            if (!engine.adapter.host.snapshot().terminal) engine.adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
            await engine.close();
            await resume.release();
          } finally {
            // Keep the slot reserved across a retry so a concurrent reconnect
            // waits on it instead of racing a second resume for the lease.
            if (state.engines.get(key) === engine && !(retryable && attempt < RESUME_STARTUP_ATTEMPTS)) state.engines.delete(key);
          }
          if (!retryable || attempt >= RESUME_STARTUP_ATTEMPTS) return;
          const stage = (retryable as { stage?: unknown }).stage;
          engine.adapter.host.emit({ type: 'error', scope: 'transport', code: 'resume_startup_retry', recoverable: true,
            message: `Resume attempt ${attempt} of ${RESUME_STARTUP_ATTEMPTS} did not reach readiness`
              + `${typeof stage === 'string' ? ` (stalled in ${stage})` : ''}; retrying the saved conversation automatically` } as never);
          let next: Awaited<ReturnType<typeof startResumedEngine>>;
          try {
            // The failed attempt advanced the runtime generation on this host;
            // the replacement must advance it again, so resume from the host's
            // own descriptor rather than the pre-attempt durable copy.
            next = await startResumedEngine({ ...previous, descriptor: restored.snapshot().descriptor } as typeof previous);
          } catch (error) {
            if (state.engines.get(key) === engine) state.engines.delete(key);
            throw error;
          }
          return supervise(next, attempt + 1);
        };
        const first = await startResumedEngine(previous);
        trackExit(key, supervise(first, 1).catch((error: unknown) => console.warn('[su-session] resume bookkeeping failed', error)));
        return { status: 'ok', attached: true, resumed: true, transport: 'structured', ready: false,
          advSessionId: previous.advSessionId, ownerId: previous.ownerId, workspaceId,
          harnessSlug: previous.harnessSlug, planSlug: first.resume.binding.planSlug, agent: previous.backend,
          nativeSession: first.resume.nativeSession };
      }
      const row = await getAdvSession(previous.advSessionId);
      const existingEngine = state.engines.get(key);
      return { status: 'ok', attached: true, duplicate: true, transport: 'structured',
        ready: !initializing,
        advSessionId: previous.advSessionId, ownerId: previous.ownerId, workspaceId,
        harnessSlug: previous.harnessSlug, agent: previous.backend,
        nativeSession: existingEngine && 'nativeSession' in existingEngine ? existingEngine.nativeSession()
          : row ? nativeSessionHandleForAdvSession(row) : null };
    }
    trace?.stage('bootstrap');
    const { bootstrapSu } = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
    // PUI owns the visible model picker. Its "server default" choice has the
    // same authority as the PSU picker, even though the native engine has no
    // terminal. Preserve that choice through the headless bootstrap boundary.
    const codexSelection = input.agent === 'codex'
      ? resolveCodexModelSelection(input.model, { source: input.model?.trim() ? 'explicit' : 'configured-default' })
      : null;
    // A fresh PUI launch bypasses psu's CLI argument normalization. Apply the
    // same Claude window marker before both bootstrap's saved launch spec and
    // the structured SDK receive this model; exact resume already normalizes
    // its saved model in prepareStructuredSuResume. Without this, bare sonnet
    // opens a 200k local Claude window and can reject a native-question
    // continuation before its next gateway request (WI-10003087).
    const selectedModel = input.agent === 'claude'
      ? normalizeModelSpecForAgent('claude', input.model)
      : codexSelection?.model ?? input.model;
    // Preserve the request's authenticated principal. Bootstrap remains the one
    // authority for persona, scope, account, mode, membership and native identity.
    const response = await bootstrapSu.handler(new Request(request.url, {
      method: 'POST', headers: request.headers,
      body: JSON.stringify({ ...input, workspace: workspaceId, owner_id: `su-${randomUUID()}`,
        model: selectedModel, ...(codexSelection ? { model_source: codexSelection.source } : {}),
        bootstrap_idempotency_key: `pui:${workspaceId}:${input.agent_chat_id}`,
        ...(input.cwd?.trim() ? { cwd: input.cwd.trim(), cwd_policy: 'caller' } : { cwd: null }),
        headless: true, auto: input.mode === 'auto', mode: input.mode === 'auto' ? null : input.mode,
      }),
    }), undefined as never);
    const result = await response.json() as BootstrapSuResult & { error?: string };
    if (!response.ok || result.status !== 'ok') throw new Error(result.error ?? 'SU bootstrap failed');
    if (!result.sessionId || !result.envelopeEnv.PAPERCUSP_SID
      || result.agent !== input.agent
      || (result.agent === 'claude' && (!result.nativeSessionId || !result.envelopeEnv.CLAUDE_CONFIG_DIR))) {
      if (result.sessionId) await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw new Error('SU bootstrap did not supply a matching identity and configuration');
    }
    let engine: ClaudeSuEngine | SuRpcEngine | undefined;
    try {
      const binding: PuiSuSessionBinding = {
        operation: 'created', backend: result.agent, advSessionId: result.sessionId,
        ownerId: result.envelopeEnv.PAPERCUSP_SID, workspaceId: result.workspaceId,
        harnessSlug: result.harnessSlug, planSlug: result.planSlug, nativeSession: null,
      };
      const nativeSession: NativeSessionHandle | null = result.agent === 'claude' ? {
        backend: 'claude' as const, source: 'adv_sessions' as const, ownerId: binding.ownerId,
        sessionId: result.nativeSessionId, configDir: result.envelopeEnv.CLAUDE_CONFIG_DIR,
        configDirSource: 'live-process' as const, configDirUnresolvedReason: null,
        exactResumeSupported: true as const, missingReason: null,
      } : null;
      binding.nativeSession = nativeSession;
      trace?.stage('bind');
      const bound = await bindSuSessionToAdvSession({ workspaceId, advSessionId: result.sessionId, agentChatId: input.agent_chat_id });
      if (bound.status !== 'bound' && bound.status !== 'already_bound') throw new Error('Could not bind the SU session to this conversation');
      const options = {
        agentChatId: input.agent_chat_id,
        model: result.agent === 'claude'
          ? normalizeModelSpecForAgent('claude', result.model ?? selectedModel)
          : result.model ?? selectedModel,
        accountRoute: input.account,
        carry: input.carry ?? 'warm', modes: input.mode ? [input.mode] : [],
        onExit: async () => { await markAdvSessionEnded(result.sessionId!, null, 'cleanup', { throwOnError: true }); },
        toolApproval: 'prompt' as const,
      };
      trace?.stage('engine-start');
      engine = result.agent === 'claude'
        ? startClaudeSuEngine(result, binding as PuiSuSessionBinding & { backend: 'claude' },
          { nativeSession: nativeSession as ClaudeSuRuntimeBinding['nativeSession'], transcriptPath: null },
          { ...options, identity: await claudeEngineIdentityForLaunch(workspaceId, result.cwd) })
        : startSuRpcEngine(result, binding as PuiSuSessionBinding & { backend: 'codex' | 'omp' }, options);
      state.engines.set(key, engine);
      trace?.stage('persist-descriptor');
      await persistSuSessionDescriptor(result.sessionId, engine.adapter.host.descriptor());
      const active = engine;
      // Launch publishes the durable identity; the existing host stream owns
      // bounded readiness and failure. Waiting here couples native startup to
      // the HTTP route's shorter watchdog and discards a valid launch as 408.
      trackExit(key, (async () => {
        try {
          await active.ready;
          await setAdvSessionPid(result.sessionId!, active.pid(), `pui-structured-${result.agent}`);
          await persistSuSessionDescriptor(result.sessionId!, active.adapter.host.descriptor());
          // done is initialized when the SDK actually starts. Reading it
          // before ready can observe the engine's pre-start placeholder.
          await active.done;
        } catch (error) {
          if (!active.adapter.host.snapshot().terminal) {
            active.adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
          }
          await active.close();
          await markAdvSessionEnded(result.sessionId!, null, 'cleanup', { throwOnError: true });
        } finally {
          if (state.engines.get(key) === active) state.engines.delete(key);
        }
      })().catch((error: unknown) => console.warn('[su-session] engine exit bookkeeping failed', error)));
      return { status: 'ok', transport: 'structured', agent: result.agent, advSessionId: binding.advSessionId,
        ownerId: binding.ownerId, workspaceId: binding.workspaceId, harnessSlug: binding.harnessSlug,
        planSlug: binding.planSlug, nativeSession, ready: false };
    } catch (error) {
      await engine?.close();
      state.engines.delete(key);
      await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw error;
    }
  }
}
