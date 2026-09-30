/**
 * Tiny, decoupled JSON extractor for Scout LLM responses. Prefers the structured
 * `json` field of a {@link ScoutLlmCall} result, else parses the text — tolerating
 * ```json fences and surrounding prose, which the cheaper critic/recombine models
 * sometimes emit despite `responseFormat: 'json'`. Kept self-contained (not the
 * gym's parse-json) so the Scout module stays decoupled from the heavily-edited
 * Phase-2 gym package.
 */
export function parseLlmJson(res: { text: string; json?: unknown }): unknown {
  if (res.json != null) return res.json;
  const raw = res.text ?? '';
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(body);
  } catch {
    // Last resort: the first balanced-looking {...} block in the text.
    const m = body.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}
