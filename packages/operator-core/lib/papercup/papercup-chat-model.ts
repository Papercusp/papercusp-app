/**
 * papercup-chat-model — the QUICK model the chat's `papercup` role runs on
 * (papercup-chat-one-component-one-contract-2026-09-06 P-005, D-007 §3).
 *
 * The papercup chat role is a quick model with the deep-delegation TOOL in its
 * toolset: hard questions route to a papercup-deep session and the answer comes
 * back into the turn. Its model is therefore pinned SEPARATELY from the operator
 * brain's own default (converse.ts resolveBrainModel — untouched), on the same
 * env > agent-config > pin ladder every other role uses:
 *
 *   model:   PAPERCUP_CHAT_MODEL env  >  agent-config models['papercup']  >  PIN.model
 *   backend: PAPERCUP_CHAT_BACKEND env >  agent-config roleBackends['papercup']
 *            >  PIN.backend when the model came from the pin
 *            >  the operator surface's backend (an INFORMED model override runs
 *               wherever the operator brain runs, unless a backend was also set)
 *
 * The backend is PART of the pin (PAPERCUP_CHAT_MODEL_PIN carries both): WI-4623
 * is what a bare luna id does to a claude-CLI-backed role (`--model gpt-5.6-luna`
 * hard-downed kettle@papercusp 2026-07-16). Pure — no I/O — so it unit-tests
 * against injected env/config.
 */
import {
  AGENT_BACKENDS,
  PAPERCUP_CHAT_FAILOVER,
  PAPERCUP_CHAT_MODEL_PIN,
  type AgentBackend,
} from '../agent-config-constants';
import type { ChatModelFailure } from '../chat-model-failure';

export type PapercupChatModelSource = 'env' | 'agent-config' | 'pin';
export type PapercupChatBackendSource = 'env' | 'agent-config' | 'pin' | 'surface' | 'inherit';

export interface PapercupChatModelInput {
  /** Process env (or a test double). Only the two PAPERCUP_CHAT_* keys are read. */
  env?: Partial<Record<'PAPERCUP_CHAT_MODEL' | 'PAPERCUP_CHAT_BACKEND', string | undefined>>;
  /** The workspace agent-config (readAgentConfig()), or null when PG was unreachable. */
  config?: { models?: Record<string, string>; roleBackends?: Record<string, AgentBackend> } | null;
  /** The operator surface's backend override (surfaceBackend('operator')) — the
   *  backend an explicitly-overridden model inherits when no backend was set. */
  fallbackBackend?: AgentBackend | undefined;
}

export interface PapercupChatModelResolution {
  model: string;
  /** undefined ⇒ inherit the process-global $AGENT_BACKEND (runAgentChat's default). */
  backend: AgentBackend | undefined;
  modelSource: PapercupChatModelSource;
  backendSource: PapercupChatBackendSource;
}

function isAgentBackend(v: unknown): v is AgentBackend {
  return typeof v === 'string' && (AGENT_BACKENDS as readonly string[]).includes(v);
}

export function resolvePapercupChatModel(input: PapercupChatModelInput = {}): PapercupChatModelResolution {
  const envModel = input.env?.PAPERCUP_CHAT_MODEL?.trim();
  const cfgModel = input.config?.models?.['papercup']?.trim();
  let model: string;
  let modelSource: PapercupChatModelSource;
  if (envModel) {
    model = envModel;
    modelSource = 'env';
  } else if (cfgModel) {
    model = cfgModel;
    modelSource = 'agent-config';
  } else {
    model = PAPERCUP_CHAT_MODEL_PIN.model;
    modelSource = 'pin';
  }

  const envBackend = input.env?.PAPERCUP_CHAT_BACKEND?.trim();
  const cfgBackend = input.config?.roleBackends?.['papercup'];
  let backend: AgentBackend | undefined;
  let backendSource: PapercupChatBackendSource;
  if (isAgentBackend(envBackend)) {
    backend = envBackend;
    backendSource = 'env';
  } else if (isAgentBackend(cfgBackend)) {
    backend = cfgBackend;
    backendSource = 'agent-config';
  } else if (modelSource === 'pin') {
    backend = PAPERCUP_CHAT_MODEL_PIN.backend;
    backendSource = 'pin';
  } else if (input.fallbackBackend) {
    backend = input.fallbackBackend;
    backendSource = 'surface';
  } else {
    backend = undefined;
    backendSource = 'inherit';
  }

  return { model, backend, modelSource, backendSource };
}

/** The account failures that will not clear inside one turn's retry window. */
export type PapercupChatFailoverCause = Extract<
  ChatModelFailure['code'],
  'model_usage_limited' | 'model_auth_required'
>;

export interface PapercupChatFailover {
  model: string;
  backend: AgentBackend;
  cause: PapercupChatFailoverCause;
}

function isFailoverCause(code: ChatModelFailure['code']): code is PapercupChatFailoverCause {
  return code === 'model_usage_limited' || code === 'model_auth_required';
}

/**
 * The model + backend the papercup role's RETRY runs on after an attempt that produced
 * nothing, or null to retry where it was (WI-10003608).
 *
 * Only a usage cap or a dead credential moves the retry: re-running the same backend
 * cannot succeed against either (a cap lifts in hours or days; a revoked login needs a
 * human). A transient rate limit or an unclassified failure keeps the existing
 * same-backend retry. `engine` is the backend that actually RAN (resolveBackend), not
 * the configured one, so an inherited backend fails over correctly too.
 */
export function papercupChatFailover(input: {
  engine: string | undefined;
  failure: ChatModelFailure | null;
}): PapercupChatFailover | null {
  const code = input.failure?.code;
  if (!code || !isFailoverCause(code)) return null;
  if (!isAgentBackend(input.engine)) return null;
  const alternate = PAPERCUP_CHAT_FAILOVER[input.engine];
  if (!alternate || alternate.backend === input.engine) return null;
  return { model: alternate.model, backend: alternate.backend, cause: code };
}
