/**
 * supersede.ts — make a DELIVERED coord message addressable, so a correction
 * reaches the people who got the original instead of a fresh N-recipient blast.
 *
 * ## Why (plan `agent-epistemics-2026-08-02` P-004)
 *
 * From the 2026-08-02 session audit:
 *
 *     "A wrong broadcast to 17 agents can only be corrected by another broadcast
 *      to 17 agents — which invites a counter-retraction, and the Nth flip carries
 *      less information than the first. You built plans:add-decision precisely
 *      because 'a message is not addressable after delivery' — but that only
 *      covers rulings. There's no equivalent for retracting an observation,
 *      which is what actually cascaded."
 *
 * Two halves, and the second is the one nobody notices:
 *
 *  1. **Reaching the right people.** Already solvable and simply unused — the
 *     stored envelope preserves `to`, so the original audience can be re-resolved
 *     from the row. The sender never re-addresses anyone by hand.
 *  2. **The reader who arrives LATER.** A peer running `coord:catch-up` after the
 *     fact reads the original as live and acts on retracted information. That
 *     produces no message, no argument and no signal — which is exactly why it
 *     survives a retraction cascade that everyone believes they have cleaned up.
 *
 * ## The integrity rule
 *
 * Only the ORIGINAL SENDER may supersede a message. This is not politeness — a
 * retraction inherits the original's audience and authority, so letting a third
 * party issue one would let any agent put words in another's mouth to that
 * agent's own recipients. Correcting someone ELSE's claim is an ordinary reply,
 * which already works and is visibly attributed to you.
 */

/** The subset of a stored `coord_event_log.body` this module reasons about. */
export interface StoredCoordEnvelope {
  msg_id?: unknown;
  from?: unknown;
  to?: unknown;
  summary?: unknown;
  kind?: unknown;
}

export interface SupersedeRefusal {
  ok: false;
  /** Machine-readable so callers branch on the CAUSE, not on message text. */
  reason: 'not-found' | 'not-sender' | 'no-audience' | 'already-superseded' | 'self-reference';
  detail: string;
}

export interface SupersedePlan {
  ok: true;
  /** The recipient selectors from the ORIGINAL envelope, re-sent verbatim. */
  audience: string[];
  /** Summary line for the correction. */
  summary: string;
  /** The correction body, which always cites what it replaces. */
  body: string;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const el of v) {
    if (typeof el === 'string' && el.trim() !== '') out.push(el.trim());
  }
  return out;
}

/**
 * Re-resolve the audience a correction must reach: the ORIGINAL envelope's `to`,
 * verbatim.
 *
 * Verbatim — not the expanded member list captured at send time — is deliberate.
 * A selector like `@fleet:x` re-resolves to whoever is in that fleet NOW, and
 * "who needs to stop believing the wrong thing" is a question about the CURRENT
 * membership, not the historical one. A member who has since left does not need
 * the correction; one who has since joined and will read the history does.
 */
export function resolveSupersessionAudience(envelope: StoredCoordEnvelope): string[] {
  return asStringArray(envelope.to);
}

/** Is `ownerId` the agent who sent this message? */
export function isOriginalSender(envelope: StoredCoordEnvelope, ownerId: string): boolean {
  return typeof envelope.from === 'string' && envelope.from.trim() !== '' && envelope.from.trim() === ownerId.trim();
}

/**
 * Decide whether `ownerId` may supersede `envelope` with `correction`, and if so
 * produce the exact audience + text to send.
 *
 * Returns a REFUSAL OBJECT rather than throwing, and never a bare null: the
 * caller must be able to tell "you are not the sender" from "this message does
 * not exist" — those have different next actions (reply vs. check the id), and
 * collapsing them into one failure is the shape that sends an agent looking for
 * a bug that is not there.
 */
export function planSupersession(args: {
  envelope: StoredCoordEnvelope | null;
  ownerId: string;
  correction: string;
  correctionSummary?: string;
  supersededByMsgId?: string | null;
  newMsgId?: string;
}): SupersedePlan | SupersedeRefusal {
  const { envelope, ownerId, correction } = args;
  if (!envelope) {
    return { ok: false, reason: 'not-found', detail: 'no coord message with that msg_id in this workspace' };
  }
  if (args.supersededByMsgId) {
    return {
      ok: false,
      reason: 'already-superseded',
      detail:
        `already superseded by ${args.supersededByMsgId} — supersede THAT message instead, so the chain stays ` +
        'linear and a reader can always follow it forward to the current claim',
    };
  }
  if (args.newMsgId && typeof envelope.msg_id === 'string' && envelope.msg_id === args.newMsgId) {
    return { ok: false, reason: 'self-reference', detail: 'a message cannot supersede itself' };
  }
  if (!isOriginalSender(envelope, ownerId)) {
    return {
      ok: false,
      reason: 'not-sender',
      detail:
        `only the original sender (${typeof envelope.from === 'string' ? envelope.from : 'unknown'}) may supersede ` +
        'their own message — a retraction inherits the original audience AND authority, so a third-party retraction ' +
        "would put words in another agent's mouth to that agent's own recipients. To correct someone else's claim, " +
        'reply to it: that is visibly attributed to you.',
    };
  }
  const audience = resolveSupersessionAudience(envelope);
  if (audience.length === 0) {
    return {
      ok: false,
      reason: 'no-audience',
      detail: 'the stored envelope records no recipients, so there is no original audience to re-reach',
    };
  }
  const originalSummary = typeof envelope.summary === 'string' ? envelope.summary : '';
  const originalId = typeof envelope.msg_id === 'string' ? envelope.msg_id : '(unknown id)';
  const summary =
    args.correctionSummary?.trim() ||
    `CORRECTION superseding ${originalId}${originalSummary ? `: ${originalSummary.slice(0, 80)}` : ''}`;

  return {
    ok: true,
    audience,
    summary,
    // The body leads with what is being RETRACTED so a skimming reader cannot
    // mistake the correction for a fresh independent claim — the failure mode
    // that makes the Nth flip in a cascade less informative than the first.
    body:
      `⚠ SUPERSEDES ${originalId}${originalSummary ? ` ("${originalSummary.slice(0, 120)}")` : ''}.\n` +
      `That message is now marked superseded in the coord log, so anyone catching up later sees this correction ` +
      `instead of acting on it.\n\n${correction.trim()}`,
  };
}
