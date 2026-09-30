/**
 * inbox.ts — the pure inbox filter predicate. PURE.
 *
 * Given every line loaded from the message surfaces, select the ones
 * addressed to `ownerId` (or broadcast), honouring the since/kind/
 * exclude-own options. The union-scan I/O lives behind the CoordEventLog
 * seam; this is the filter + sort over what was loaded.
 *
 * (Extracted from coordination/messages.ts:readInbox.)
 */

import { type CoordEnvelope, type CoordKind, compareByTsThenId } from './envelope';

export interface InboxOptions {
  /** Only return envelopes whose ts is strictly after this ISO timestamp. */
  since_ts?: string;
  /** Filter to one or more kinds. Omit → all kinds EXCEPT `notify` (the
   *  auto-generated watch firehose has no push value — opt in explicitly
   *  with `kinds: ['notify']`). Plan fleet-coordination-painpoints D-002. */
  kinds?: CoordKind[];
  /** Filter out the caller's own outbox lines (default true). */
  excludeOwn?: boolean;
}

/**
 * EI-28: `kind:'notify'` also carries the coord:ask ask→answer loop (a
 * question routed TO you, or an answer to a question YOU asked) —
 * conversations-core.ts stamps these `notify_kind`s. D-002's default exclusion
 * was scoped to the auto-generated WATCH firehose (file-lock acquisitions,
 * broad `any`-subscription noise); it was never meant to swallow a directed
 * ask/answer, but because both ride the same `notify` kind, the default inbox
 * read silently dropped them — the whole subscribe→inject / ask→answer
 * promise broke at the last hop (verified live 2026-06-05: neither the asker
 * nor the answerer saw the other's turn in a default coord:inbox read).
 *
 * Kept deliberately NARROW (only the two coord:ask notify_kinds) rather than
 * "any directed (non-'*') notify" — every fanout-delivery.ts notify is
 * addressed to one subscriber_id (never '*'), so a broadcast-vs-directed test
 * on `to` would let ALL subscription noise through too, defeating D-002 for
 * topic-subscribe callers (which already have their own full/digest/mention
 * tiering for that). This exception targets exactly the reported gap.
 */
const DIRECTED_NOTIFY_KINDS = new Set(['question_opened', 'answer_posted']);

/**
 * Filter `lines` to those addressed to `ownerId` (or `'*'`), applying the
 * inbox options. Sorted ascending by (ts, msg_id).
 */
export function filterInbox(
  lines: CoordEnvelope[],
  ownerId: string,
  opts: InboxOptions = {},
): CoordEnvelope[] {
  const excludeOwn = opts.excludeOwn ?? true;
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  const kindFilter = opts.kinds ? new Set<CoordKind>(opts.kinds) : null;
  const out: CoordEnvelope[] = [];
  for (const l of lines) {
    if (excludeOwn && l.from === ownerId) continue;
    if (!Array.isArray(l.to)) continue;
    if (!l.to.includes(ownerId) && !l.to.includes('*')) continue;
    if (sinceMs && new Date(l.ts).getTime() <= sinceMs) continue;
    if (kindFilter) {
      if (!kindFilter.has(l.kind)) continue;
    } else if (l.kind === 'notify' && !DIRECTED_NOTIFY_KINDS.has(l.notify_kind as string)) {
      // Default: exclude the auto-generated notify firehose (D-002), EXCEPT
      // the coord:ask ask/answer interrupts (EI-28) — see DIRECTED_NOTIFY_KINDS.
      // Callers that want the full notify firehose pass kinds: ['notify'].
      continue;
    }
    out.push(l);
  }
  return out.sort(compareByTsThenId);
}
