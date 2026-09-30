/**
 * ack-keys.ts — the argument keys `coord:ack` actually accepts, plus the parser that
 * reads `coord:ack { … }` snippets back out of agent-facing prose.
 *
 * WHY THIS EXISTS (EI-21329316352681219): the fleet wind-down cue told members to
 * "ack this exact cue with coord:ack { msg_id: 'X' } to send your one-line disposition
 * to the leader". That purpose clause attaches free text to a tool that carries NONE —
 * `appendAck` sends only `{ to, kind:'ack', related_msg_id }` — so a member who followed
 * the instruction literally called `coord:ack { msg_id, summary }` and was refused
 * `invalid_args` by the central `.strict()` in define-tool.ts.
 *
 * The INSTRUCTION was the defect, not the tool: a one-line disposition already has a
 * home in `coord:send { expects:'none', summary }` (send.ts's structured-body gate
 * deliberately exempts 'none'/'ack', and an omitted `wake` is a plain inject, so it does
 * not re-invoke the wound-down leader). Widening coord:ack would have duplicated that
 * channel and bypassed the `expects` discipline.
 *
 * This module is DEPENDENCY-FREE on purpose. It is the shared pin between two cheap
 * guards that would otherwise each need a heavy import:
 *   • ack.test.ts          — asserts the REAL zod arg schema's keys equal this list, so
 *                            the constant can never drift from the tool it describes;
 *   • control-core.test.ts — asserts no generated cue names a `coord:ack { … }` argument
 *                            outside this list.
 * Together they turn "prose promises an argument coord:ack does not accept" into a build
 * failure instead of a runtime `invalid_args` a member discovers mid-wind-down.
 */

/** The ONLY argument keys `coord:ack` accepts. Pinned to ack.ts's schema by ack.test.ts. */
export const COORD_ACK_ACCEPTED_KEYS = ['msg_id', 'id', 'msg_ids', 'items'] as const;

export type CoordAckAcceptedKey = (typeof COORD_ACK_ACCEPTED_KEYS)[number];

/**
 * Extract every argument NAME mentioned inside a `coord:ack { … }` snippet in prose
 * (a cue body, a refusal hint, a prompt line). Returns [] when the text names no such call.
 *
 * Reads only the KEY side of each comma-separated entry, so a quoted value can never be
 * mistaken for an argument name: `coord:ack { msg_id: 'm-cue' }` yields ['msg_id'], while
 * the regression this guards against — `coord:ack { msg_id, summary }` — yields
 * ['msg_id','summary'] and fails the subset check.
 */
export function coordAckArgNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const call of text.matchAll(/coord:ack\s*\{([^}]*)\}/g)) {
    for (const entry of (call[1] ?? '').split(',')) {
      const key = entry.split(':')[0]?.trim();
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !names.includes(key)) names.push(key);
    }
  }
  return names;
}
