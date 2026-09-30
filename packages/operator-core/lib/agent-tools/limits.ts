/**
 * Shared agent-tool string-length limits + zod helpers
 * (agent-tooling-token-efficiency-2026-06-25 P-001).
 *
 * A telemetry audit found ~1,000+ agent tool calls in 14 days FAILED purely on
 * too-long string args — the agent then blind-retried the SAME over-length value.
 * Two structural fixes live here so the failure class can't silently recur:
 *
 *   - `hardText(maxChars, {min?})` — a string that REJECTS over `maxChars`
 *     (`z.string().min(min ?? 1).max(maxChars)`). Use ONLY where an over-length
 *     value is genuinely invalid downstream (an id/key, a single plan-item line, a
 *     stored body with a real bound). A reject is now RECOVERABLE in one retry: the
 *     dispatch's invalid_args message (agent-mcp/server.ts, P-003) tells the agent
 *     exactly how far over it is and the target length.
 *
 *   - `softText(maxChars, {min?})` — an advisory/echoed free-text string that is
 *     NEVER bounced on length: it advertises a plain (optionally min-bounded)
 *     string, and the handler clamps the accepted value to `maxChars` with
 *     `clampText()`. Use for goals/notes/briefs/summaries the tool only echoes —
 *     bouncing them on length is pure friction.
 *
 * Why the clamp is HANDLER-side and not a zod `.transform()`: a transform is
 * unrepresentable in JSON Schema and `z.toJSONSchema(def.args)` runs (with no
 * try/catch) at `defineTool` registration AND in the HTTP MCP tools/list handler —
 * a transform there crashes schema-gen for the whole catalog. So `softText` keeps
 * the advertised schema a plain string and the cap is enforced where the value is
 * consumed (`clampText`).
 *
 * Char-count tiers. These only RAISE/standardize caps — NEVER lower a field below
 * its current cap.
 */
import { z } from 'zod';

export const LIMITS = {
  /** ids, keys, exact event keys, short handles. */
  IDENT: 200,
  /**
   * A provenance LABEL — `foundDuring` ("what were you doing when you hit this").
   * Soft by nature (EI-10943): it is a label the tool only stores + echoes, and the
   * DB column is unbounded `text`, so the cap is pure presentation policy. Bouncing
   * a capture — losing the whole finding, and dumping the entire args schema at the
   * agent — because its provenance label ran long is the worst possible trade.
   */
  LABEL: 120,
  /** one-line titles / intents / one-sentence descriptions. */
  SHORT_TITLE: 1000,
  /** a short paragraph — a note, a summary, a topic description. */
  ANNOTATION: 2000,
  /** a situational brief / overlay — multi-paragraph missing context. */
  BRIEF: 16000,
  /** a stored content body — a memory fact, an issue body. */
  CONTENT: 16000,
  /** a long-form body — a work-item comment / thread post. */
  BODY: 32000,
} as const;

export interface TextOpts {
  /** Minimum length (default 1 for hardText; omitted entirely for softText). */
  min?: number;
}

/**
 * A HARD-capped string: rejects input over `maxChars`. `min` defaults to 1 (a
 * non-empty requirement). For fields with a real downstream length constraint.
 */
export function hardText(maxChars: number, opts: TextOpts = {}) {
  return z.string().min(opts.min ?? 1).max(maxChars);
}

/**
 * A SOFT-capped string: NEVER rejects on length. Advertises a plain string
 * (with `min` only when a non-empty requirement is wanted); the handler clamps the
 * accepted value to `maxChars` via `clampText(value, maxChars)`. The default
 * `.describe()` records the cap; chain your own `.describe(...)` to override it.
 */
export function softText(maxChars: number, opts: TextOpts = {}) {
  const base = opts.min != null ? z.string().min(opts.min) : z.string();
  return base.describe(`Free text — auto-truncated to ${maxChars} chars if longer.`);
}

/**
 * Clamp a `softText` value to its cap (handler-side truncation). Passes through
 * `undefined`/`null` and any string already within the cap; slices an over-length
 * string to `maxChars`. Generic so it preserves the optional/nullable type.
 */
export function clampText<T extends string | undefined | null>(value: T, maxChars: number): T {
  if (typeof value === 'string' && value.length > maxChars) {
    return value.slice(0, maxChars) as T;
  }
  return value;
}
