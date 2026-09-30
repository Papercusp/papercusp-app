/**
 * Caller-specified result projection — the reduction operators bash gets from
 * pipes, available on EVERY tool call (bash-substitution-reachable-ceiling-2026-08-01
 * P-020, decision D-041).
 *
 * WHY THIS EXISTS. Measured over the 7d corpus: capability:read costs 3,614 avg /
 * 3,015 median bytes against capability:bash's 1,526 / 885 — the tool for the
 * LARGEST substitution bucket is 3.4x more expensive than the bash it replaces.
 * That is not tool overhead. Bash lets the CALLER choose the projection per call
 * (`| grep x | head -20`); a tool returns whatever its author fixed in advance.
 * The tools already cheaper than bash (testing:run, build:typecheck,
 * capability:git) are exactly the ones that REDUCE rather than re-wrap. The axis
 * is WHO DECIDES THE PROJECTION — so we hand that decision back to the caller,
 * once, at the dispatch layer, instead of per-tool.
 *
 * D-053 sizes it: pipe-filter atoms are 25.2% of the corpus and appear in 88 of
 * 88 sessions, 84.4% of them behind a producer that has (or could have) a tool
 * form. That is 21.2 ceiling points — the largest single lever in the plan.
 *
 * ── THE TWO DOMAINS (D-041's tier 3 vs its line operators) ────────────────────
 * A materialized tool result is one of two things, and conflating them is how
 * you get fragments with no closing brace:
 *
 *   `pick` — STRUCTURED. Field/path selection over the PARSED JSON body. This is
 *            D-041 tier 3, and the only correct reduction for a JSON result:
 *            line-grepping a JSON *rendering* returns syntactically broken
 *            fragments. Fixes the fat structured tools (coord:orient 16,040 avg,
 *            work_items:get 7,704).
 *
 *   `pipe`  — TEXT. Line operators over the rendered text, applied in order, so
 *            the corpus's real shape (`grep | sort | uniq -c | head`) is
 *            expressible as one composition rather than a flat bag of params.
 *
 * `pick` runs FIRST (it defines what text there is to filter), then `pipe`.
 *
 * ── WHY THESE ARE IN-PROCESS AND NOT WRAPPED BINARIES ─────────────────────────
 * D-041 mandates wrapping native binaries rather than reimplementing them, in
 * preference order: (1) push the filter INTO the source, (2) native binary via
 * argv-exec where the source is a FILE OR STREAM, (3) in-process projection for
 * already-materialized STRUCTURED results.
 *
 * This stage is tier 3 by construction and NOT a violation of that order,
 * because of WHERE it sits: it runs on a result that is already a string in this
 * process's heap. Tier 2's entire benefit is that discarded bytes are never
 * generated or transported — that benefit is already spent by the time a result
 * reaches here. Forking grep to filter an in-memory string would mean writing
 * those bytes back out to a pipe to read them in again: strictly more work, for
 * a subprocess and a portability dependency we would then have to ship to macOS.
 * D-041 says as much for the simple operators — "why head/tail/count stay
 * IN-PROCESS: three lines each, unambiguous, portable by construction, and
 * forking to do `.slice(0,20)` is waste."
 *
 * Tiers 1 and 2 remain the right answer at the SOURCE, and are per-tool work:
 * logs:read already pushes `--grep` into journalctl (tier 1); capability:read
 * reading a file is where a native head/tail wrapper would belong (tier 2). This
 * stage does not replace either — it is the universal floor beneath both, for
 * every one of the ~550 tools that will never get bespoke filter params.
 *
 * ── REGEX FLAVOR IS DECLARED, NEVER ASSUMED ───────────────────────────────────
 * `grep` here is a JavaScript RegExp, not GNU ERE/BRE. Most patterns mean the
 * same thing in both, but not all — and D-041's stated worst case is a stage
 * whose semantics silently diverge from the bash it replaces. So:
 *   - the applied flavor is REPORTED in `_meta.resultProjection.regexFlavor`,
 *     the same way logs:read reports `journalAvailable:false` rather than
 *     pretending;
 *   - POSIX bracket expressions (`[[:digit:]]`) are REJECTED at parse time. In
 *     JS that is a character class of `[`,`:`,`d`,`i`,`g`,`t` — it matches, it
 *     returns rows, and every row is wrong. A loud refusal is the only safe
 *     handling of a construct that is silently valid-but-different;
 *   - `fixed: true` (grep -F) is flavor-independent and is what an automated
 *     rewrite (P-022) should prefer whenever the corpus pattern is a literal.
 * P-021's output-diff replay is the gate that decides which corpus patterns may
 * be auto-substituted through this stage; this file's job is to make the flavor
 * legible to that harness rather than to guess on its behalf.
 */

/** One line-oriented stage. Applied in array order — the pipeline IS the composition. */
export type ProjectionStage =
  | {
      /** Filter lines by pattern (grep). */
      op: 'grep';
      pattern: string;
      /** grep -F: `pattern` is a literal substring, not a regex. Flavor-independent. */
      fixed?: boolean;
      /** grep -i */
      ignoreCase?: boolean;
      /** grep -v */
      invert?: boolean;
      /** grep -B: lines of leading context. */
      before?: number;
      /** grep -A: lines of trailing context. */
      after?: number;
      /** grep -C: symmetric context; sets both `before` and `after` when they are absent. */
      context?: number;
    }
  /** head -n */
  | { op: 'head'; n: number }
  /** tail -n */
  | { op: 'tail'; n: number }
  | {
      /** sort. Codepoint order (NOT locale-dependent) so a result is reproducible on any host. */
      op: 'sort';
      /** sort -n */
      numeric?: boolean;
      /** sort -r */
      reverse?: boolean;
      /** sort -u */
      unique?: boolean;
    }
  /** uniq — collapses ADJACENT duplicates only, exactly like the binary. */
  | { op: 'uniq'; count?: boolean }
  | {
      /** cut -f */
      op: 'cut';
      /** 1-indexed field numbers, like cut(1). */
      fields: number[];
      /** cut -d (default TAB, like cut(1)). */
      delimiter?: string;
      /** cut -s: drop lines with no delimiter (default passes them through whole, like cut(1)). */
      onlyDelimited?: boolean;
    }
  /** wc -l — replaces the body with the line count. */
  | { op: 'count' };

/** The `projection` argument accepted on ANY tool call at the dispatch layer. */
export interface ProjectionSpec {
  /**
   * Structured field selection over the parsed JSON body, applied BEFORE `pipe`.
   * Paths are dot/bracket notation with `[]` to map over an array:
   *   `results[].id` · `summary.counts` · `items[].payload.title`
   * A path that matches nothing is reported in `notes`, never silently dropped.
   * A single projection accepts at most 32 paths; split larger selections across
   * calls rather than sending an over-sized `pick` list.
   */
  pick?: string[];
  /** Line operators, applied in order to the rendered text. */
  pipe?: ProjectionStage[];
}

/** What the projection actually did — echoed to the caller so a result is reproducible. */
export interface ProjectionReport {
  applied: boolean;
  /** The normalized spec, as applied. */
  spec: ProjectionSpec;
  linesIn: number;
  linesOut: number;
  charsIn: number;
  charsOut: number;
  /** Present when a regex `grep` ran — never implied, always stated. */
  regexFlavor?: 'js-regexp';
  /**
   * Anything that did NOT apply and why (a `pick` on a non-JSON body, a path
   * that matched nothing). Fail-open is only honest if it is also loud.
   */
  notes: string[];
}

export const PROJECTION_ARG = 'projection' as const;
