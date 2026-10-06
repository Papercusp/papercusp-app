/**
 * Completion receipts for consult verbs that persist a post before finishing
 * follow-up work such as advancing the responder cascade. A receipt identifies
 * the post produced by this completed call; it does not make the write globally
 * idempotent.
 */
import type { AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { asRecord, completedResultPayload } from '../abort-completion-payload';

function consultResultPayload(result: ToolResult): Record<string, unknown> | null {
  return completedResultPayload(result);
}

type ConsultPostingVerb = 'consult:reply' | 'consult:decline';

/**
 * If a completed consult post call returns after its deadline, let dispatch
 * report the committed post identity instead of a misleading retryable timeout.
 * Missing or malformed success evidence fails closed as recovery-incomplete.
 */
export function consultPostAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
  verb: ConsultPostingVerb,
): AbortCompletionReceipt {
  const payload = consultResultPayload(result);
  const postId = payload?.post_id;
  const conversationId = asRecord(args)?.conversation_id;
  if (payload?.ok === true && typeof postId === 'number' && Number.isSafeInteger(postId) && postId > 0) {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return {
        status: 'recovery-incomplete',
        reason: `${verb} args did not identify the conversation for the recorded post`,
        failures: ['missing-conversation-id'],
      };
    }
    return {
      status: 'recorded',
      effectRef: `${verb.replace(':', '-')}:${conversationId}:${String(postId)}`,
    };
  }
  return {
    status: 'recovery-incomplete',
    reason: `${verb} result did not confirm a persisted post id after abort`,
    failures: ['missing-post-id'],
  };
}

/**
 * `consult:get_feedback` opens a new conversation before its potentially slow
 * routing and answering-session dispatch. If that completed handler returns
 * after its deadline, the conversation id identifies the consult that landed
 * and prevents an unsafe duplicate retry.
 */
export function consultFeedbackAbortCompletionReceipt(
  _args: unknown,
  result: ToolResult,
): AbortCompletionReceipt {
  const payload = consultResultPayload(result);
  const conversationId = payload?.conversation_id;
  if (
    payload?.ok === true &&
    typeof conversationId === 'string' &&
    conversationId.trim().length > 0
  ) {
    return { status: 'recorded', effectRef: `consult-get-feedback:${conversationId}` };
  }
  return {
    status: 'recovery-incomplete',
    reason: 'consult:get_feedback result did not confirm a persisted conversation id after abort',
    failures: ['missing-conversation-id'],
  };
}
