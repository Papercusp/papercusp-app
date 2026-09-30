/**
 * papercup-deep-answer-wait — the SAME-TURN return leg of the deep-delegation
 * lane (papercup-chat-one-component-one-contract-2026-09-06 P-005, D-007 §3).
 *
 * The pane papercup gets a settled delegation pushed back as `[deep-answer
 * WI-NNN] …` pane input (papercup-deep-watch.ts). The converse brain has no
 * pane: its turn ENDS when the model stops, so a push after that reaches no
 * one. For the converse surfaces the delegation tool therefore WAITS (bounded)
 * for the work item to settle and returns the completion summary as the tool
 * result — the model presents the answer in the same turn, exactly like a
 * chat:ask_choice card blocking on the user's pick.
 *
 * Pure polling core with an injected reader/clock so it unit-tests without PG.
 */

export interface DeepAnswerProbe {
  state: string;
  /** The completing agent's completion.summary — the ANSWER. */
  terminalCompletionRef: string | null;
  title: string;
}

export interface AwaitDeepAnswerInput {
  workItemId: string;
  harness: string | null;
  /** Total wait budget. */
  waitMs: number;
  /** Poll interval; default 2s. */
  pollMs?: number;
  read: (workItemId: string, harness: string | null) => Promise<DeepAnswerProbe | null>;
  isTerminal: (state: string) => boolean;
  /** The calling turn's abort signal — an aborted turn stops waiting at once. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type AwaitDeepAnswerResult =
  | { settled: true; state: string; answer: string | null; title: string }
  | { settled: false; state: string | null; waitedMs: number };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

export async function awaitDeepAnswer(input: AwaitDeepAnswerInput): Promise<AwaitDeepAnswerResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const pollMs = Math.max(250, input.pollMs ?? 2_000);
  const started = now();
  let lastState: string | null = null;
  for (;;) {
    const probe = await input.read(input.workItemId, input.harness).catch(() => null);
    if (probe) {
      lastState = probe.state;
      if (input.isTerminal(probe.state)) {
        const answer = probe.terminalCompletionRef?.trim() || null;
        return { settled: true, state: probe.state, answer, title: probe.title };
      }
    }
    const elapsed = now() - started;
    if (input.signal?.aborted || elapsed + pollMs > input.waitMs) {
      return { settled: false, state: lastState, waitedMs: elapsed };
    }
    await sleep(pollMs);
  }
}

/** Render the tool-result line the brain relays when the wait timed out. */
export function renderDeepAnswerPending(workItemId: string, waitedMs: number): string {
  const secs = Math.round(waitedMs / 1000);
  return (
    `The deep dive ${workItemId} is still running after ${secs}s. Tell the user it is in flight ` +
    `and that the answer will be delivered when it settles; do not invent one.`
  );
}
