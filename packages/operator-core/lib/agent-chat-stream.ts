/**
 * Operator-side wrapper around the shared agent chat-stream runner.
 *
 * The runtime lives in `@papercusp/papercusp-shared/agent/chat-stream` so
 * apps/papercup can call it too (visitor chatbot at /api/_hono/
 * public-papercup.ts). This file just hooks the operator's
 * /settings/agent persistence (`agent-config.ts`) into the shared
 * runner so saved backend/cmd/models settings land in process.env on
 * the first spawn after a server restart.
 *
 * Existing imports (`from './agent-chat-stream'`) keep working —
 * we re-export the same symbols.
 *
 * When the dev-only env var `PAPERCUSP_FAKE_LLM=1` is set, runAgentChat
 * yields a deterministic scripted stream instead of spawning a real
 * agent. Lets the Playwright suite cover the full route → SSE → client
 * pipeline without a live model.
 */
import {
  runAgentChat as realRunAgentChat,
  resolveBackend,
  setAgentConfigBootstrap,
  classifyHttpError,
  classifyTurnError,
  probeStatelessTransport,
  type AgentBackend,
  type ChatEvent,
  type RunAgentChatOptions,
  type TurnError,
  type TurnProvider,
  type TurnBackend,
} from '@papercusp/papercusp-shared/agent';
import { applyToProcessEnv, readAgentConfig } from './agent-config';

setAgentConfigBootstrap(async () => applyToProcessEnv(await readAgentConfig()));

/** Prompt sentinel that makes the fake-LLM seam yield a terminal `error` event
 *  instead of deltas — lets a test/e2e exercise the SSE error path (the
 *  rate-limit / backend-failure case) deterministically, with no real model. */
export const FAKE_LLM_ERROR_SENTINEL = '__FAKE_LLM_ERROR__';

async function* fakeRunAgentChat(opts: RunAgentChatOptions): AsyncGenerator<ChatEvent, void, void> {
  const prompt = opts.promptText || '';
  if (prompt.includes(FAKE_LLM_ERROR_SENTINEL)) {
    await new Promise((r) => setTimeout(r, 5));
    yield { type: 'error', message: '[fake-llm] forced error (FAKE_LLM_ERROR_SENTINEL)' };
    return;
  }
  const tail = prompt.slice(-32) || 'fake-llm';
  const deltas = [
    `[fake-llm] received "${tail}". `,
    'Generating deterministic output for tests. ',
    'Stream terminates after three deltas.',
  ];
  for (const text of deltas) {
    await new Promise((r) => setTimeout(r, 5));
    yield { type: 'delta', text };
  }
  yield {
    type: 'result',
    costUsd: 0,
    tokensIn: 0,
    tokensOut: deltas.join('').length,
    finalText: deltas.join(''),
  };
}

export async function* runAgentChat(opts: RunAgentChatOptions): AsyncGenerator<ChatEvent, void, void> {
  if (process.env.PAPERCUSP_FAKE_LLM === '1') {
    yield* fakeRunAgentChat(opts);
    return;
  }
  yield* realRunAgentChat(opts);
}

export type { AgentBackend, ChatEvent, RunAgentChatOptions, TurnError, TurnProvider, TurnBackend };
// Re-export the turn-error classifiers + transport probe so operator modules import the agent
// taxonomy through this one shim (a direct `@papercusp/papercusp-shared/agent` value-import from a
// test-loaded operator module trips vitest's `@/`-alias resolution on the transitive agent-config
// chain).
export { classifyHttpError, classifyTurnError, probeStatelessTransport };
// WI-5071: converse needs the runner's effective-backend resolution (session
// reuse is a claude-code-only lever) — re-exported through the same shim.
export { resolveBackend };
// P-007 (own-tui-full-divorce-2026-08-24): the agent-loop's gateway-native
// ModelPort adapter (lib/agent-loop/anthropic-port.ts) reuses the stateless
// family's transport resolution + tier headers + OAuth-framed system param —
// re-exported through this shim like everything else operator-core consumes.
export {
  resolveStatelessTransport,
  priorityTierHeaders,
  headersToRecord,
  ownerHeaders,
  routeAccountHeaders,
  buildSystemParam,
  type StatelessTransport,
} from '@papercusp/papercusp-shared/agent';
