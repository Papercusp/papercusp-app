/**
 * Shared content-budget constants for coordination inbox reads.
 *
 * Keep these in a leaf module so the write path can describe the receiver's
 * default view without importing the `coord:inbox` defineTool (which would
 * pull the whole read-side graph into `coord:send`). The sender-side
 * projection is deliberately labelled as a default-view estimate: a receiver
 * can choose a different limit, tier, or an explicit full read.
 */

export const DEFAULT_INBOX_LIMIT = 50;
export const INBOX_ENTRY_BUDGET = 15_000;

export const INBOX_TIER_DEFAULTS = {
  trimmed: { limit: 15, bodyChars: 250 },
  standard: { limit: 30, bodyChars: 400 },
  full: { limit: DEFAULT_INBOX_LIMIT, bodyChars: 600 },
} as const;

export type InboxContextTier = keyof typeof INBOX_TIER_DEFAULTS;

/**
 * The per-entry content cap used by a default inbox read.
 *
 * `coord:inbox` scales the cap down when the requested page is large. The
 * sender does not know the recipient's page size, so callers that need the
 * sender-visible diagnostic use the one-entry cap (the documented maximum)
 * and expose that scope in the returned fields.
 */
export function inboxBodyCharCap(
  tier: InboxContextTier = 'full',
  entryCount: number = 1,
): number {
  const defaults = INBOX_TIER_DEFAULTS[tier];
  const count = Math.max(1, Math.floor(entryCount));
  return Math.min(defaults.bodyChars, Math.floor(INBOX_ENTRY_BUDGET / count));
}

/** The largest body a one-entry default `coord:inbox` read can show. */
export const DEFAULT_INBOX_BODY_CAP = inboxBodyCharCap('full', 1);

/** RSR-P-008-B: coord:send delivers an over-cap body as at most this many
 *  inbox-sized parts (send-chunking.ts). Lives here, beside the cap it scales,
 *  so the body schema's description can state it without importing the
 *  chunker (which imports the schema module). 12 parts carry about 6.5k chars,
 *  above the longest agent-authored coord:send body in the P-008 census. */
export const COORD_SEND_MAX_CHUNK_PARTS = 12;

export interface SenderBodyDeliveryDiagnostics {
  /** True when even the one-entry default inbox view clips the body. */
  bodyTruncated: boolean;
  /** True when a crowded default page may clip the body. */
  bodyMayBeTruncated: boolean;
  /** Original body length authored by the sender. */
  bodyAuthoredChars: number;
  /** Alias matching the receiver-side `body_full_chars` marker. */
  bodyFullChars: number;
  /** Characters visible in the one-entry default inbox projection. */
  bodyDeliveredChars: number;
  /** The cap used for `bodyDeliveredChars`; a crowded page may use less. */
  bodyDeliveryCap: number;
  /** Lower cap possible with the default full-tier page size. */
  bodyCrowdedPageCap: number;
}

/** These describe the recipient's inbox view, not missing bytes in a send receipt. */
export function isCoordSendDeliveryDiagnostic(toolName: string | undefined, key: string): boolean {
  return toolName === 'coord:send' && (key === 'bodyTruncated' || key === 'bodyMayBeTruncated');
}

export const COORD_SEND_RECEIPT_RECOVERY =
  'Do not repeat coord:send to recover its result. Inspect the returned reference and use coord:read ' +
  'with results[].msg_id or results[].bodyReadRef to read the persisted messages.';

/**
 * Describe what a normal recipient inbox read can see without performing a
 * second read or changing the durable message. The message itself remains
 * complete in coord_event_log; `coord:read { msg_id }` is the full-body path.
 */
export function senderBodyDeliveryDiagnostics(
  body: string | undefined,
): SenderBodyDeliveryDiagnostics | undefined {
  if (typeof body !== 'string') return undefined;

  const bodyDeliveryCap = inboxBodyCharCap('full', 1);
  const bodyCrowdedPageCap = inboxBodyCharCap('full', DEFAULT_INBOX_LIMIT);
  const bodyAuthoredChars = body.length;

  return {
    bodyTruncated: bodyAuthoredChars > bodyDeliveryCap,
    bodyMayBeTruncated: bodyAuthoredChars > bodyCrowdedPageCap,
    bodyAuthoredChars,
    bodyFullChars: bodyAuthoredChars,
    bodyDeliveredChars: Math.min(bodyAuthoredChars, bodyDeliveryCap),
    bodyDeliveryCap,
    bodyCrowdedPageCap,
  };
}
