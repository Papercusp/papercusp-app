/**
 * postCardResponse — client wrapper for /api/operator/conversations/:id/card-response.
 *
 * The conversation id in the URL is ignored by the route (the card-
 * correlator looks up by correlationId + expectedWorkspaceId), but
 * Next routes require *some* :id segment. We pass the active
 * conversation id so audit/log searches still associate the response
 * with the user's chat.
 */

export interface CardResponseBody {
  correlationId: string;
  workspaceId: string;
  action: 'submit' | 'decline' | 'cancel';
  payload?: unknown;
  reason?: string;
}

export interface CardResponseResult {
  ok: boolean;
  status: number;
  error?: string;
  details?: unknown;
}

export async function postCardResponse(
  conversationId: string,
  body: CardResponseBody,
): Promise<CardResponseResult> {
  const res = await fetch(
    `/api/operator/conversations/${encodeURIComponent(conversationId)}/card-response`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    },
  );
  if (res.ok) return { ok: true, status: res.status };
  let parsed: { error?: string; details?: unknown } = {};
  try {
    parsed = (await res.json()) as { error?: string; details?: unknown };
  } catch {
    /* non-JSON error body */
  }
  return {
    ok: false,
    status: res.status,
    error: parsed.error,
    details: parsed.details,
  };
}

/**
 * postRunCancel — cancels every pending ctx.askUser card under a runId.
 * Server-side this resolves each card's deferred with action:'cancel'.
 * Used by the chat-level "Cancel" affordance in PendingCardsBar.
 */
export async function postRunCancel(
  conversationId: string,
  body: { runId: string; workspaceId: string },
): Promise<CardResponseResult> {
  const res = await fetch(
    `/api/operator/conversations/${encodeURIComponent(conversationId)}/run-cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    },
  );
  if (res.ok) return { ok: true, status: res.status };
  let parsed: { error?: string; details?: unknown } = {};
  try {
    parsed = (await res.json()) as { error?: string; details?: unknown };
  } catch {
    /* non-JSON error body */
  }
  return {
    ok: false,
    status: res.status,
    error: parsed.error,
    details: parsed.details,
  };
}
