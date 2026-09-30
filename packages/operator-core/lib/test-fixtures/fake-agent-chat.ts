/**
 * Test fixture: fake `runAgentChat` async generator.
 *
 * Replaces the real omp/claude-code subprocess call with a scripted
 * event stream. Used by chat-surface e2e tests to drive the dispatcher
 * + replay buffer + state channel without spawning a real LLM.
 *
 * Seam: all 5 chat surfaces import `runAgentChat` from
 * `@/lib/agent-chat-stream`. Vitest mocks that module with
 * `createFakeRunAgentChatMock(script)` and the dispatcher path
 * receives the scripted events verbatim.
 *
 * Wire format: matches `ChatEvent` from
 * `@papercusp/papercusp-shared/agent/chat-stream` — same union the real
 * generator yields. The fixture does NOT emit raw omp JSON-line bytes
 * because the seam is post-parse.
 *
 * Step F (Tier-1 promoted) of the Tier-1/Tier-2 follow-up arc.
 * See `~/.claude/.../memory/project_session_2026-05-14_tier_arc.md`.
 */

import type { ChatEvent } from '@papercusp/papercusp-shared/agent';
import { vi } from 'vitest';

export interface FakeAgentChatScript {
  /** Text deltas emitted in order. Each becomes a `{type:'delta'}` event. */
  deltas?: Array<{ text: string; delayMs?: number }>;
  /** Tool-call events emitted after the corresponding delta index. */
  toolCalls?: Array<{ afterDelta: number; name: string; input: unknown }>;
  /** Final rollup. Defaults to zero cost / zero tokens / concatenated delta text. */
  result?: {
    costUsd?: number;
    tokensIn?: number;
    tokensOut?: number;
    finalText?: string;
  };
  /**
   * Terminate the stream with an `error` event instead of `result`.
   * If set, takes precedence over `result`.
   */
  error?: { message: string; stderr?: string; afterDelta?: number };
}

/**
 * Build an async generator that yields the scripted events.
 *
 * Always yields exactly one terminal event (`result` or `error`) so
 * consumers can rely on it for the same contract the real generator
 * guarantees.
 */
export async function* fakeRunAgentChat(
  script: FakeAgentChatScript,
): AsyncGenerator<ChatEvent, void, void> {
  const deltas = script.deltas ?? [];
  const toolCalls = script.toolCalls ?? [];
  const sleep = (ms?: number) =>
    ms && ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

  let accum = '';
  for (let i = 0; i < deltas.length; i += 1) {
    const d = deltas[i];
    await sleep(d.delayMs);
    accum += d.text;
    yield { type: 'delta', text: d.text };

    // Emit tool_call events that were scheduled to fire after this delta.
    for (const tc of toolCalls.filter((t) => t.afterDelta === i)) {
      yield { type: 'tool_call', name: tc.name, input: tc.input };
    }

    // Error short-circuit: if `afterDelta` matches this index, terminate.
    if (script.error && (script.error.afterDelta ?? -1) === i) {
      yield {
        type: 'error',
        message: script.error.message,
        stderr: script.error.stderr,
      };
      return;
    }
  }

  if (script.error && script.error.afterDelta === undefined) {
    yield {
      type: 'error',
      message: script.error.message,
      stderr: script.error.stderr,
    };
    return;
  }

  yield {
    type: 'result',
    costUsd: script.result?.costUsd ?? 0,
    tokensIn: script.result?.tokensIn ?? 0,
    tokensOut: script.result?.tokensOut ?? 0,
    finalText: script.result?.finalText ?? accum,
  };
}

/**
 * Build a Vitest mock function shaped like `runAgentChat`.
 *
 * Usage:
 *   import * as agentChat from '../agent-chat-stream';
 *   vi.spyOn(agentChat, 'runAgentChat').mockImplementation(
 *     createFakeRunAgentChatMock({ deltas: [{ text: 'hi' }] })
 *   );
 */
export function createFakeRunAgentChatMock(
  script: FakeAgentChatScript,
): ReturnType<typeof vi.fn> {
  return vi.fn(() => fakeRunAgentChat(script));
}

/**
 * Drain a fakeRunAgentChat generator into an array — convenience for
 * tests that want to assert on the full event sequence.
 */
export async function collectEvents(
  gen: AsyncGenerator<ChatEvent, void, void>,
): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
