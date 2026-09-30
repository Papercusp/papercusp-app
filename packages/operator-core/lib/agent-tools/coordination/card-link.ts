/**
 * card-link — the inbox ⇄ live-card bridge for inbox-cards-unification Phase D
 * (P-035). When a durable escalation that was linked to a live `ctx.askUser`
 * card (P-034 stashed `cardCorrelationId`/`cardWorkspaceId` in the record's
 * meta) is resolved from the INBOX (coord:resolve), this unblocks the waiting
 * agent by resolving the same card in the correlator.
 *
 * Best-effort + safe by construction:
 *   - No-op when the record carries no `cardCorrelationId` (every flag-off
 *     escalation — so the default path is untouched).
 *   - resolveCardResponse returns not-found (never throws) when the card was
 *     already resolved live or its run ended; the escalation is resolved
 *     regardless.
 */

import { resolveCardResponse } from '@papercusp/agent-mcp';

/**
 * If `record` is linked to a live card, resolve that card with the chosen
 * option so the blocked agent resumes. `choice` is the picked option id.
 */
export function unblockLinkedCard(
  // A coord escalation record (or any bag) — read the link off it. Typed as a
  // plain record so the index-signature'd EscalationRecord assigns cleanly
  // (avoids TS's weak-type check on an all-optional shape).
  record: Record<string, unknown>,
  choice: string,
): { unblocked: boolean } {
  const correlationId = record.cardCorrelationId;
  const workspaceId = record.cardWorkspaceId;
  if (typeof correlationId !== 'string') return { unblocked: false };
  try {
    const res = resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: [choice] },
      ...(typeof workspaceId === 'string' ? { expectedWorkspaceId: workspaceId } : {}),
    });
    return { unblocked: res.ok };
  } catch {
    // The card may already be resolved / its run ended — the escalation is
    // resolved regardless. Never let card-unblock failure surface to coord:resolve.
    return { unblocked: false };
  }
}
