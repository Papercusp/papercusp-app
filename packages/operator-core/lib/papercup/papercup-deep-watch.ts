/**
 * sentinel-deep-watch — the answer-return leg of the deep-thinking delegation
 * lane (voice-unified-sentinel-pipeline-2026-07-01, P-006, D-003).
 *
 * When a `deep-delegation` work_item SETTLES, its completion summary (the
 * terminal_completion_ref the completing agent recorded — the ANSWER) is
 * injected back into the Sentinel pane as `[deep-answer WI-NNN] …` via the same
 * sentinel-pane-input mechanics every other input takes. The pane then presents
 * it: text in the pane + voice:say (→ the says pump → spoken on the bus) — so a
 * delegated answer reaches the user exactly like a direct one, one pipeline.
 *
 * Mirrors operator-sentinel-handoff-watch: fired fire-and-forget from the
 * work_items settled-events seam; the gate is the durable `deep-delegation`
 * topic the delegate stamps. Never throws.
 */
import { DEEP_DELEGATION_LABEL } from './papercup-deep-delegate';

/** The pane-input prefix the sentinel persona keys on to present a returned answer. */
export const DEEP_ANSWER_PREFIX = '[deep-answer';

/** Compose the pane-input line for a settled delegation. Exported for tests. */
export function composeDeepAnswerLine(item: {
  id: string;
  title: string;
  state: string;
  terminalCompletionRef?: string | null;
}): string {
  const answer = item.terminalCompletionRef?.trim();
  if (answer) return `${DEEP_ANSWER_PREFIX} ${item.id}] ${answer}`;
  return `${DEEP_ANSWER_PREFIX} ${item.id}] The deep dive "${item.title}" settled (${item.state}) without a recorded answer summary — check the item.`;
}

/**
 * Inject a settled deep-delegation item's answer into the Sentinel pane, but
 * ONLY when the item actually is one — i.e. it carries the `deep-delegation`
 * topic the delegate stamps. Ports are injectable so the watch unit-tests
 * without PG or zellij; the defaults wire the real substrate. Fire-and-forget
 * by contract (the caller is the setWorkItemState settled-events seam).
 */
export async function injectDeepAnswerIfTracked(
  item: {
    id: string;
    title: string;
    state: string;
    harness?: string | null;
    terminalCompletionRef?: string | null;
    topics?: readonly string[];
  },
  getTopics?: (id: string, harness: string | null) => Promise<readonly string[]>,
  inject?: (line: string) => Promise<unknown>,
): Promise<void> {
  try {
    let topics = item.topics;
    if (topics == null) {
      if (!getTopics) return; // no way to tell — skip rather than guess
      topics = await getTopics(item.id, item.harness ?? null);
    }
    if (!topics.includes(DEEP_DELEGATION_LABEL)) return;
    const line = composeDeepAnswerLine(item);
    const doInject =
      inject ??
      (async (l: string) => {
        const { writeToSentinelPane } = await import('./papercup-pane-input');
        const res = await writeToSentinelPane(l);
        if (!res.ok) {
          // The pane is down — fall back to the hindsight channel so the answer
          // still reaches the user "[While you were away]" instead of vanishing.
          const { notifyOperatorHindsight } = await import('../operator-hindsight');
          await notifyOperatorHindsight(l, 'deep-answer').catch(() => {});
        }
        return res;
      });
    await doInject(line);
  } catch {
    /* fire-and-forget: an answer-return failure must never break the lifecycle write */
  }
}
