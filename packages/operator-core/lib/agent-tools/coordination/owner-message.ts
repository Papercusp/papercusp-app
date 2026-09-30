/**
 * owner-message.ts — the wrapper that lets a NON-AGENT sender (the operator
 * GUI: the HUD session chat, the Agents-pill composer, the nudge button) speak
 * the message protocol the agent-facing `coord:send` now requires.
 *
 * unified-agent-state-plane-2026-07-27 P-033 [owner 2026-07-27]: *"add to the
 * plan to make sure all existing places that send coord things like via the gui
 * … get updated to use our new format. For example, the chat in the HUD tab is
 * now broken, we'll have to add a wrapper around our new function for when the
 * owner sends a message that populates our new properties with the appropriate
 * values."*
 *
 * ⚠ THE BREAK THIS FIXES IS REAL AND PREDATES THE SECTION WORK. `/api/admin/
 * coord/send` re-dispatches into the `coord:send` TOOL, where D-048 made
 * `expects` REQUIRED with deliberately no default. All three GUI call sites
 * (SessionChatModal.sendToSessionOwner, AgentsRunningPill's composer + nudge)
 * post without it — so every one of them has been failing validation since
 * D-048 landed. The owner reported it as "the chat in the HUD tab is now
 * broken"; it is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A DEFAULT HERE IS NOT THE DEFECT D-048 DELETED
 *
 * D-048 removed `expectsReply`'s silent derivation because a default is how a
 * field dies: every AGENT took the default, so the field carried no sender
 * intent while `unanswered_directed` depended on it meaning something.
 *
 * That rule governs an agent AUTHORING a message. A human clicking Send in a
 * chat box is not authoring a protocol field and cannot be made to — the only
 * alternative to a derived value is a broken chat box, which is what we have.
 *
 * So the value is derived, and — this is the load-bearing half — **it is
 * STAMPED as derived**. `fieldProvenance` marks exactly which fields were
 * filled by this wrapper rather than authored by the sender, so the D-070
 * measurement (judge these fields by their VALUES, never their fill rate) can
 * exclude GUI-derived values instead of counting them as intent. An unstamped
 * default would silently inflate every adoption number this plan is judged on —
 * which IS the P-029 failure (a field 100% populated, a third of it a mechanism
 * string), and is the reason this file stamps rather than just fills.
 *
 * ⚠ POPULATE ONLY WHAT CAN BE POPULATED HONESTLY. `why` (a goal ref), `premises`,
 * `youMayNotKnow`, `couldNotDetermine` and `basedOn` are NOT invented here.
 * A GUI has no goal ref, no reasoning chain, and no read-trace, and inventing
 * plausible values for them would produce exactly the healthy-looking, empty
 * schema D-064 warns about.
 */

import type { ExpectsKind } from './tools/send';
import type { ForYouBecause } from './message-fields';

/** Which fields this wrapper supplied, so measurement can exclude them. */
export const OWNER_FIELD_PROVENANCE = 'owner-gui-derived' as const;

export interface OwnerMessageInput {
  to?: unknown;
  summary?: unknown;
  body?: unknown;
  wake?: unknown;
  expects?: unknown;
  blocking?: unknown;
  forYouBecause?: unknown;
  [key: string]: unknown;
}

export interface OwnerMessageDefaults {
  expects: ExpectsKind;
  blocking: boolean;
  forYouBecause: ForYouBecause;
  fieldProvenance: Record<string, typeof OWNER_FIELD_PROVENANCE>;
}

/**
 * Derive `expects` from the SHAPE of what the owner actually did — the only
 * honest signal available without asking them:
 *
 *   • a bare nudge (a wake with no body of its own) expects nothing back — the
 *     point is to make the agent take a turn, not to ask it a question;
 *   • anything the owner typed a body for expects ACTION. An owner does not
 *     open a chat box to send an FYI, and 'action' is the reading that keeps
 *     the message in `unanswered_directed` until the agent responds — the
 *     failure mode to avoid is an owner's instruction silently reading as
 *     status and never being chased.
 */
export function deriveOwnerExpects(input: OwnerMessageInput): ExpectsKind {
  const hasBody = typeof input.body === 'string' && input.body.trim().length > 0;
  const isNudge = Boolean(input.wake) && !hasBody;
  return isNudge ? 'none' : 'action';
}

/**
 * Build the field set for an owner-originated send. Caller-supplied values
 * always win — this fills gaps, it never overrides an explicit choice, so a
 * future GUI surface that DOES know its goal ref or reply-expectation keeps it.
 */
export function ownerMessageDefaults(input: OwnerMessageInput): OwnerMessageDefaults {
  const fieldProvenance: Record<string, typeof OWNER_FIELD_PROVENANCE> = {};

  let expects = input.expects as ExpectsKind | undefined;
  if (expects === undefined) {
    expects = deriveOwnerExpects(input);
    fieldProvenance.expects = OWNER_FIELD_PROVENANCE;
  }

  // The owner is not "blocked" in the sense a scheduler acts on — they are
  // frequently away or asleep when this lands. false is the honest value, and
  // asserting it explicitly is better than leaving a consumer to guess.
  let blocking = input.blocking as boolean | undefined;
  if (blocking === undefined) {
    blocking = false;
    fieldProvenance.blocking = OWNER_FIELD_PROVENANCE;
  }

  // D-043: the owner's reason for addressing you is NOT a computed coupling, so
  // 'other' is the correct relation rather than the nearest-fitting structural
  // one — and 'other' is excluded from the asserted-vs-computed divergence
  // check BY CONSTRUCTION, which is exactly right here: scoring an owner's
  // choice of recipient against the coupling graph would be a category error.
  // The note is REQUIRED with 'other', and this one is true.
  let forYouBecause = input.forYouBecause as ForYouBecause | undefined;
  if (forYouBecause === undefined) {
    forYouBecause = {
      relation: 'other',
      note: 'addressed directly by the owner from the operator UI',
    };
    fieldProvenance.forYouBecause = OWNER_FIELD_PROVENANCE;
  }

  return { expects, blocking, forYouBecause, fieldProvenance };
}

/**
 * Apply the defaults to a raw `/api/admin/coord/send` payload, returning the
 * body to dispatch into the coord:send tool.
 *
 * Applied SERVER-SIDE, at the one route every GUI sender already goes through,
 * rather than at each call site: three surfaces are broken today and patching
 * them individually leaves the trap armed for the fourth. `forYouBecause` is a
 * PER-SECTION field, so it rides a section — which is also what upgrades these
 * senders to the new body format without any GUI change.
 */
export function applyOwnerMessageDefaults(body: OwnerMessageInput): Record<string, unknown> {
  const d = ownerMessageDefaults(body);
  const out: Record<string, unknown> = { ...body, expects: d.expects, blocking: d.blocking };

  const rawBody = typeof body.body === 'string' ? body.body : undefined;
  // Only build a section when there is text to attach it to. A bare nudge stays
  // a bare nudge — inventing an empty section to carry a derived field would be
  // fill-rate theatre.
  if (rawBody && rawBody.trim().length > 0 && !Array.isArray(body.body)) {
    out.body = [{ text: rawBody, forYouBecause: d.forYouBecause }];
  }
  out.fieldProvenance = d.fieldProvenance;
  return out;
}
