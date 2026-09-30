/**
 * transcript-wire — the shared, single-definition vocabulary for reading agent
 * transcript payloads (WI-41498).
 *
 * WHY THIS MODULE EXISTS. Two independent modules read the SAME codex rollout
 * records and had drifted apart about which fields they live in:
 *
 *   - `search/session-ingest.ts` (the corpus) read
 *     `payload.arguments ?? payload.input ?? payload.query` and treated an
 *     `output` block ARRAY as text;
 *   - `session-timeline-parsers.ts` (the live thinking stream, which is what the
 *     HUD conversation popup renders) read only `payload.arguments` and
 *     `JSON.stringify`d anything else.
 *
 * Current Codex writes `custom_tool_call` with **`input`**, not `arguments`, and
 * writes tool output as an array of `{ type:'input_text', text }` blocks.
 * Measured on one live rollout (adv 18014): `custom_tool_call` 155 vs
 * `function_call` 4, so ~97% of that session's tool calls reached the popup with
 * NO input at all — a wall of contentless `exec` chips — and 30 of its 31 tool
 * results rendered as a raw `[{"type":"input_text",…}]` dump. The corpus copy
 * had been right the whole time; nothing connected the two, so nothing failed
 * when one of them fell behind the wire.
 *
 * The fix is not "copy the right field list into the second reader" — that is
 * how there came to be two. Both readers now import the vocabulary from here, so
 * the next wire change is one edit and the drift cannot silently reopen.
 *
 * Deliberately dependency-free: this sits on the SSE route's load path, so it
 * must not pull in the search/ingest graph (or anything else) to be used.
 */

/**
 * The readable text of a payload field that may be a string, an array of
 * content blocks, or something structured.
 *
 * Block arrays are the current shape of codex `function_call_output` /
 * `custom_tool_call_output` and of claude tool_result content; the JSON fallback
 * keeps an image/structured block from silently becoming an empty string.
 *
 * (Was `partPayloadText` in session-ingest.ts, which now re-exports this so
 * there is exactly one implementation.)
 */
export function blockPayloadText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (Array.isArray(v)) {
    const blocks = v.map((p) => {
      if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
        return { kind: 'text' as const, value: (p as { text: string }).text };
      }
      const type = p && typeof p === 'object' ? (p as { type?: unknown }).type : undefined;
      return {
        kind: 'marker' as const,
        value: typeof type === 'string' ? `[${type}]` : '[structured block]',
      };
    });
    if (blocks.some((block) => block.kind === 'text')) {
      // A mixed text/image array must retain the text-less blocks too. The
      // fallback below is still useful for an all-image array, but it is never
      // reached when even one text block exists. Keep the marker compact so a
      // data URL cannot bloat the timeline or search corpus.
      return blocks.map((block) => block.value).join('\n');
    }
  }
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Claude Code has emitted two owner-dialog result lead-ins in live JSONL: the
 * older single-question form and the current batched-question form. An
 * AskUserQuestion answer is owner speech delivered inside a synthetic
 * `tool_result` user line — general tool results are NOT owner speech and must
 * stay out of any recall/verification corpus, so this allow-list is
 * deliberately narrow: only these two verified AskUserQuestion carriers count.
 *
 * (EI-22171324436610992: moved here from search/session-ingest.ts, which
 * re-exports it for back-compat, so turn-provenance/turn-ref.ts — which
 * session-ingest.ts itself imports from — can share this vocabulary too
 * without a circular import. Two readers independently deciding "is this
 * tool_result block actually an owner answer" is exactly the drift this
 * module exists to prevent; see the file header.)
 */
export const CLAUDE_OWNER_DIALOG_RESULT_PREFIXES = [
  'The user answered:',
  'Your questions have been answered:',
] as const;

/**
 * The RAW arguments of a codex tool-call response item, whatever field this
 * build of Codex put them in — `function_call` uses `arguments` (a JSON
 * string), `custom_tool_call` uses `input` (usually the raw script/text), and
 * `tool_search_call` uses `query`.
 *
 * Returns the value UNCONVERTED so each caller can shape it: the timeline wants
 * structured input for its tool chip, the corpus wants flattened text. What is
 * shared — and what actually broke — is knowing which fields to look in.
 *
 * `??` rather than a truthiness chain: an explicitly empty `arguments: ''` is a
 * real answer from the record, not a reason to go looking in another field.
 */
export function codexToolCallArgsRaw(payload: {
  arguments?: unknown;
  input?: unknown;
  query?: unknown;
}): unknown {
  return payload.arguments ?? payload.input ?? payload.query;
}
