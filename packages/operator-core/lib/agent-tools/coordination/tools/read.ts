/**
 * coord:read — fetch ONE coord message's FULL, untruncated envelope by
 * `msg_id`. EI-9942: coord:inbox's default render caps a body at ~600 chars
 * (`FULL_TIER.bodyChars` in tools/inbox.ts) so a normal inbox sweep never
 * overflows the agent result cap — but that leaves no CHEAP way to read back
 * the full text of ONE specific oversized finding. The 2026-07-12 p2p-ship
 * incident: a 2615-char root-cause report rendered truncated at ~550 chars;
 * the reader needed 2 extra fetch calls (including `payloadTier:'full'`,
 * which did not affect per-entry body truncation at the time) and still never
 * saw the full body via coord — it only became readable once the sender
 * ALSO copied it onto a work-item's summary.
 *
 * Reuse-first: the full-body lookup already existed as `getMessageById`
 * (WI-3832 — an indexed `coord_event_log` fast-path read with a readLines
 * fallback), but it was wired ONLY into internal resolvers
 * (ref-hydrate-resolve, relay-provenance-resolve) — no tool exposed it.
 * `coord:thread { root_msg_id }` can ALSO return one message's full body
 * (`foldThread` degrades to a singleton when there is no `related_msg_id`
 * chain), but it always does a full un-indexed scan of the whole `messages`
 * surface (`coordLog.readLines('messages')`) and is framed as "reconstruct a
 * conversation" — not discoverable as "read one message's full text
 * cheaply". This tool is a thin, additive wrapper over the SAME
 * `getMessageById` used elsewhere — no change to coord:send's existing
 * behavior, no new storage, no new ledger.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveMessageRef } from '../messages';
import { projectAuthoredFields } from '../message-fields';
import { COORD_READ_ROLES } from '../roles';

// Keep the complete envelope available as MCP structuredContent for programmatic
// callers (ptool / MCP clients). The human-facing text projection still passes
// through the ordinary result door, but a large message must not be serialized
// into one text item that the door can cut in the middle.
const coordReadResultSchema = z
  .object({
    ok: z.boolean(),
    found: z.boolean(),
    msg_id: z.string(),
    resolved_msg_id: z.string().optional(),
    resolved_from: z.literal('prefix').optional(),
    error: z.literal('msg_id_ambiguous').optional(),
    candidates: z.array(z.string()).optional(),
    detail: z.string().optional(),
    message: z.record(z.string(), z.unknown()).nullable(),
    authored: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export default defineTool({
  name: 'coord:read',
  description:
    "Fetch ONE coord message's FULL, untruncated body by `msg_id` — the cheap fix for a finding that rendered truncated in coord:inbox (its default ~600-char per-entry render cap). A fresh coord:inbox call with `payloadTier:'full'` now also restores raw entry content, but this direct lookup is the cheapest recovery path for one known message. Returns { ok, found, msg_id, message } where `message` is the complete envelope (from/to/ts/kind/summary/body/files/…) with no truncation applied. `found:false` when no message with that id exists (never throws). Prefer checkpointing a substantive finding onto its work-item instead of relying on this — coord:read is the recovery path for a body that already went out oversized, not a substitute for the write-side discipline.",
  guidance: {
    when: 'A coord:inbox / coord:feed entry rendered with `body_truncated:true` (or you were told "see coord msg <id>") and you need its exact full text — one cheap lookup by msg_id instead of a since_ts poll; a fresh coord:inbox call with payloadTier:"full" also restores raw entry content, but reads a window.',
    notWhen: 'For the whole conversation around a message (replies/acks/resolutions) — use coord:thread. For a fresh inbox sweep — use coord:inbox. Before SENDING a long finding — write it onto the work-item (work_items:checkpoint / a comment) and send only a 1-line pointer; do not rely on the recipient coord:read-ing it back.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_READ_ROLES],
  args: z.object({
    msg_id: z.string().min(1).describe('The coord message id to fetch in full (as seen on a coord:inbox/coord:feed entry, or returned by coord:send).'),
  }),
  result: coordReadResultSchema,
  async handler(args) {
    // WI-6725: resolve, don't exact-match. A truncated id (the form that
    // circulates in prose) used to return a well-formed EMPTY result that read
    // exactly like "does not exist" — and a leader retracted a real, unanswered
    // commitment on that false negative. A unique prefix now RESOLVES; an
    // ambiguous one says so with candidates; only a genuine miss is found:false.
    const resolution = await resolveMessageRef(args.msg_id);
    const message = resolution.status === 'found' ? resolution.message : null;
    // P-033 (e): the authored fields (sections / premisesClassified / why / blocking /
    // fieldProvenance) ride the ENVELOPE — the send path flattens them onto it — and the
    // `body` a reader sees is a FLATTENED text projection of them. So on this surface,
    // whose whole job is "show me this message in full", the structure the sender
    // authored was invisible. Surface it as `authored`; absent for a message that
    // carries nothing.
    //
    // ⚠ Pass the envelope, NOT `.extra` — there is no `extra` key on a stored envelope
    // (see projectAuthoredFields). This call read `.extra` until 2026-08-02 and so
    // returned `undefined` for every message ever fetched here.
    const authored = message ? projectAuthoredFields(message) : undefined;
    const payload = {
      ok: true,
      found: message !== null,
      msg_id: args.msg_id,
      ...(resolution.status === 'found' && resolution.resolvedFrom === 'prefix'
        ? {
            resolved_msg_id: resolution.msgId,
            resolved_from: 'prefix' as const,
            detail: `'${args.msg_id}' is a TRUNCATED msg_id — resolved by unique prefix to '${resolution.msgId}'. Cite the full id to look it up directly.`,
          }
        : {}),
      ...(resolution.status === 'ambiguous'
        ? {
            error: 'msg_id_ambiguous' as const,
            candidates: resolution.candidates,
            detail: `'${args.msg_id}' is a truncated msg_id matching ${resolution.candidates.length}+ messages — supply more of the id, or the full one from coord:inbox.`,
          }
        : {}),
      ...(resolution.status === 'not-found' && resolution.looksTruncated
        ? {
            detail: `No message id starts with '${args.msg_id}'. Note this is NOT a full msg_id (expected '<short>-0000-<32 hex>') — if you copied it out of prose it may have been truncated at the source.`,
          }
        : {}),
      message,
      ...(authored ? { authored } : {}),
    };
    return { data: payload };
  },
});
