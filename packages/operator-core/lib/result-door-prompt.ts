/**
 * The standing-context teaching for the per-result door (agent-context-firewall
 * P-015) — rendered ONCE per session into the su playbook, never per tool.
 *
 * WHY THIS EXISTS. opencode interpolates its live cap constants straight into its
 * bash tool description, so the model learns the cap BEFORE tripping it. We cannot
 * copy that shape: with ~550 tools against the P-011 prompt-weight budget (1500
 * soft / 1600 hard chars per tool), per-tool cap text is the expensive form and
 * `tools-md-sync` would red on it. The same property is available for the price of
 * ONE section in standing context — the door number, and the knob that avoids it.
 *
 * WHY IT IS GENERATED AND NOT PROSE. The number is read from `computeTurnDoors`,
 * the SAME function `applyResultDoor` calls to enforce it (result-door.ts). Hand-
 * written prose would state a number that silently stops being true the first time
 * anyone touches DOOR_SPLIT or the maxTurn floor — and a prompt that confidently
 * teaches a stale cap is worse than one that says nothing, because the agent stops
 * checking. `resultDoorPromptTokens()` and the enforcement path cannot disagree.
 *
 * SCOPE OF THE NUMBER. The door resolves per-caller constants at call time
 * (`getDoorConstantsSync(ownerId)`), which a launch-time render cannot know, so
 * this states the DEFAULT and points at `config:doors-get` for the live effective
 * value. Note both compute at effectiveWindow=0 — the door is pinned to the maxTurn
 * FLOOR regardless of the model's window, so a bigger context window does not buy a
 * bigger per-result budget.
 */

import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors, type DoorConstants } from './context-doors';
import { MAX_PICK_PATHS } from './result-projection/parse';

/**
 * The per-result door, in tokens — read through the same `computeTurnDoors` the
 * enforcer uses. `effectiveWindow: 0` mirrors `result-door.ts` exactly: the door is
 * taken at the maxTurn floor, not scaled to the session's window.
 */
export function resultDoorPromptTokens(c: DoorConstants = BAKED_DOOR_CONSTANTS): number {
  return computeTurnDoors(0, c).resultEach;
}

/** Concurrent tool-result slots the hop budget allows for — same source. */
export function resultDoorPromptSlots(c: DoorConstants = BAKED_DOOR_CONSTANTS): number {
  return computeTurnDoors(0, c).resultSlots;
}

/**
 * The generated "## Tool results are capped" section, spliced at
 * RESULT_DOOR_MARKER by renderSuPlaybook / writeSplicedPlaybook.
 *
 * The pick-vs-pipe paragraph is the load-bearing half and is measured, not
 * asserted (2026-08-02, wire-level against the live operator): an MCP tool result
 * is a JSON object serialized on ONE line, so the line operators cannot reduce it
 * — `head n:3` returned the ENTIRE payload and a non-matching `grep` returned an
 * empty body. The result-door footer leads with `pipe` "for text", which is the
 * wrong half for the JSON results it is attached to; an agent that follows it gets
 * all-or-nothing and concludes the knob is broken. Same one-line-JSON artifact
 * that struck OMP's 512-column cap from this plan (D-006).
 */
export function renderResultDoorSection(c: DoorConstants = BAKED_DOOR_CONSTANTS): string {
  const tokens = resultDoorPromptTokens(c);
  const slots = resultDoorPromptSlots(c);
  const chars = tokens * CHARS_PER_TOKEN_ESTIMATE;
  return `## Tool results are capped — reduce BEFORE you call, not after

Every tool result is capped at **~${tokens.toLocaleString('en-US')} tokens** (~${chars.toLocaleString('en-US')} chars). Past it the result is
TRUNCATED and the full text spilled to a scratch file — you get a pointer, and paging
it back costs a second round-trip you could have avoided. The cap is PER RESULT and a
hop budgets ${slots} result slots, so two large results in the same hop are both cut. It is
pinned to the hop floor: a bigger context window does not buy a bigger per-result
budget. (Default shown; \`config:doors-get\` reads the live effective value.)

So when a call could return a lot, bound it AT THE SOURCE first — the tool's own
\`limit\`/filter/\`since\` args, or a narrower query. When you cannot, reduce it in
flight with \`projection\`.

**\`projection\` is a DISPATCH argument accepted on EVERY tool** — a sibling of the
tool's own arguments, not one of them. With \`tools:invoke\` BOTH placements work: one
beside \`name\`/\`args\` is forwarded into the target for you; one nested inside \`args\`
is honoured as sent — prefer nesting if your client validates the published schema,
which declares only \`name\`/\`args\`. Sending both reduces twice: inner, then wrapper.

    projection: { pick: ["results[].id", "results[].workItem.state"] } // work_items:get object-root envelope
    projection: { pick: ["[].id", "[].title"] }                 // ARRAY-root body (a bare list)
    projection: { pick: ["items[].item.id", "items[].item.effectiveStatus"] } // plans:items keyed envelope
    projection: { pipe: [{ op: "grep", pattern: "ERROR" }, { op: "tail", n: 20 }] }

Common keyed envelopes keep fields under their emitted roots — copy the shape, not a
generic field name:
    projection: { pick: ["event_inspection.current_generation", "event_inspection.current_state", "active_awaits"] } // events:status
    projection: { pick: ["results[].id", "results[].workItem.state", "results[].workItem.assignee", "results[].checkpoint"] } // work_items:get

Path shape follows the BODY's root: a tool that returns a bare array (work_items:list,
…) is selected with \`[].field\` — a bare \`field\` addresses an object root and matches
nothing there. Keyed envelopes use their emitted array key (for example,
plans:items uses \`items[].item.id\`); the door auto-adjusts the obvious case and tells you.

A single \`pick\` list accepts at most ${MAX_PICK_PATHS} paths; split larger field selections
across calls instead of sending an over-sized list.

**Choose by the result's SHAPE — this is the part that is easy to get wrong.** An MCP
tool result is a JSON object serialized on ONE line, so the line operators cannot
reduce it: \`head\` hands back the whole payload and a non-matching \`grep\` hands back
nothing. Use **\`pick\`** for any JSON result — it is JSON-aware and is the only form
that actually shrinks one. Keep **\`pipe\`** for genuinely line-oriented text: log
reads, command output, file bodies. Operators: grep (fixed/ignoreCase/invert/before/
after/context), head, tail, sort, uniq, cut, count — applied in order.

\`grep.pattern\` uses JavaScript \`RegExp\` syntax, not PCRE/GNU grep. Do not use inline PCRE
flags such as \`(?i)\`; set \`ignoreCase: true\`, for example \`projection: { pipe: [{ op: "grep", pattern: "error", ignoreCase: true }] }\`.
Use \`fixed: true\` for literal substrings.`;
}
