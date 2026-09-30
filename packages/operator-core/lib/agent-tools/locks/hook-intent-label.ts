/**
 * hook-intent-label — pins the CONTRACT between the automatic file-lock hook (which SENDS a
 * lock `intent`) and `isLifecycleIntent` (which must RECOGNIZE what it sends).
 *
 * EI-20055604348536487: the hook acquires with `intent: f'PreToolUse:{tool_name}'`, and
 * locks:acquire persisted that verbatim into edit_attribution_ledger.intent — 97.5% of the
 * column was the name of a hook rather than any intent. The writer now recovers the agent's
 * declared intent whenever the incoming value is a lifecycle label.
 *
 * That recovery is only as good as the predicate's ability to RECOGNIZE the label, and the two
 * artifacts sit on opposite sides of a process boundary: a Python hook in
 * `apps/operator/scripts/hooks/cc/`, a TypeScript predicate here. Nothing links them. Re-word
 * the hook's f-string — 'Edit via PreToolUse', 'hook:Edit', a leading emoji — and the predicate
 * silently stops matching, the sentinel silently returns to the ledger, and the only symptom is
 * a column that reads plausible until someone measures the distribution again.
 *
 * So: extract what the hook actually sends and assert the predicate still catches it.
 */

/** A lock `intent` literal as the hook would send it, with f-string placeholders realized. */
export interface HookIntentLiteral {
  /** 1-indexed line in the hook source. */
  line: number;
  /** The literal with `{placeholders}` substituted, e.g. 'PreToolUse:Edit'. */
  realized: string;
  /** The raw source form, e.g. "f'PreToolUse:{tool_name}'". */
  raw: string;
}

/**
 * Every value the hook passes as the lock `intent`, realized into the string the server receives.
 *
 * Deliberately SHALLOW — a regex over Python source, not a parser. The failure mode that matters
 * is a *changed literal*, which a regex sees; if the hook ever computes its intent through a
 * variable this returns nothing, and the caller must treat an EMPTY result as "could not verify"
 * rather than "verified clean". That distinction is the whole point: an extractor that silently
 * finds nothing is indistinguishable from a system with no problem — the same false-clean shape
 * this fix exists to remove.
 *
 * @param sample value substituted for `{placeholder}` spans (the hook interpolates the tool name).
 */
export function extractHookLockIntentLiterals(source: string, sample = 'Edit'): HookIntentLiteral[] {
  const out: HookIntentLiteral[] = [];
  const lines = (source ?? '').split('\n');
  // Matches:  'intent': f'...'   |   'intent': '...'   |   "intent": f"..."   (single or double)
  const re = /['"]intent['"]\s*:\s*(f?)(['"])(.*?)\2/;
  lines.forEach((text, i) => {
    const m = re.exec(text);
    if (!m) return;
    const [, fPrefix, quote, body] = m;
    out.push({
      line: i + 1,
      raw: `${fPrefix}${quote}${body}${quote}`,
      realized: fPrefix ? body.replace(/\{[^}]*\}/g, sample) : body,
    });
  });
  return out;
}
