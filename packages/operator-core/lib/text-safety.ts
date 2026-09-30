/**
 * text-safety.ts — neutralize tool-call-lookalike markup in untrusted free-text
 * before it is stored, so a work-item/issue title/body can never be misread by
 * an agent as a literal continuation of its own tool-call transcript (EI-9267).
 *
 * Papercusp's agent harness renders tool calls as `<invoke name="...">` /
 * `<parameter name="...">` / `</invoke>` (or the `antml:`-prefixed variants)
 * XML-ish tags. A work-item title/body that happens to CONTAIN such tags —
 * whether pasted in by accident (a prior agent's own transcript got copied
 * into a captured improvement) or planted deliberately — reads, when later
 * surfaced via `scheduler:get_next` / `work_items:get` / `improvements:capture`
 * results, exactly like a live continuation of the READING agent's own
 * tool-call stream. An agent that doesn't scrupulously treat tool-RESULT
 * content as untrusted DATA (never an instruction) can be tricked into
 * executing the embedded call — the concrete repro that motivated this file:
 * EI-9262's body ended with a fabricated `</invoke><invoke
 * name="work_items:claim">…` block asking to claim three unrelated items.
 *
 * `neutralizeToolCallTags` is applied once, at `createIssue` (the single
 * choke point both `improvements:capture` and `work_items:create` funnel
 * issue-family titles/bodies through — see issues-engineer.ts), so the
 * poison is defused at ingestion rather than needing to be re-defused at
 * every future read call site.
 *
 * Deliberately narrow (an exact-name denylist), NOT a general HTML/XML
 * stripper: work-item text legitimately contains arbitrary markdown, code,
 * and other angle-bracket content that must survive completely untouched.
 * The swap is cosmetic (a look-alike full-width `＜` for the tag's leading
 * `<`) so a reader still sees the tag shape when quoting it for
 * documentation (exactly as this docstring and EI-9267's own body do) — it
 * just can no longer parse as a live tag.
 */

const TOOL_CALL_TAG_NAMES = [
  'invoke',
  'parameter',
  'function_calls',
  'function_results',
  'antml:invoke',
  'antml:parameter',
  'antml:function_calls',
  'antml:function_results',
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TAG_PATTERN = new RegExp(
  `<(/?)(${TOOL_CALL_TAG_NAMES.map(escapeRegExp).join('|')})\\b`,
  'gi',
);

/**
 * Replace the leading `<` of any tool-call-lookalike tag (open OR closing,
 * exact-name match) with the visually-similar, inert full-width character
 * `＜`. Idempotent and non-destructive — safe to re-run, and a false positive
 * (text genuinely discussing these tag names) just gets the same cosmetic
 * swap, never dropped or truncated content. `null`/`undefined`/empty input
 * passes through unchanged.
 */
export function neutralizeToolCallTags<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  TAG_PATTERN.lastIndex = 0;
  return text.replace(TAG_PATTERN, (_m, slash: string, name: string) => `＜${slash}${name}`) as T;
}

/**
 * Remove control characters that cannot be meaningfully stored in persisted
 * agent-authored text. Keep tab/newline/carriage-return because they carry
 * ordinary formatting semantics in titles, descriptions, and source excerpts;
 * strip the remaining C0 controls plus DEL, including NUL (U+0000), which
 * PostgreSQL rejects from text values. The operation is intentionally silent
 * and idempotent: a control byte in a pasted source excerpt must not discard
 * the entire filing at the database boundary.
 */
export function sanitizePersistedText<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') as T;
}

/** True iff `text` contains a tool-call-lookalike tag — for logging/telemetry
 *  without necessarily mutating the stored text. */
export function containsToolCallLookalike(text: string | null | undefined): boolean {
  if (!text) return false;
  TAG_PATTERN.lastIndex = 0;
  return TAG_PATTERN.test(text);
}
