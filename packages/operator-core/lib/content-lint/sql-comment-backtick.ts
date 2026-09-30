/**
 * Comment-backtick detector (EI-7661 / EI-19317789732905891 / EI-19415157731625374
 * / EI-21219437374882016).
 *
 * ⚠ THE PREDICATE IS NOT HERE. It lives in `scripts/lib/sql-comment-backtick-scan.mjs`
 * — plain `.mjs` so the PreToolUse edit-time hook, which runs under bare `node` and
 * cannot import a `.ts` at all, executes the IDENTICAL check. This module is the
 * TypeScript wrapper: the registry `ContentDetector` and the deterministic autofix.
 *
 * Until 2026-09-05 this file carried its own hand-copied duplicate of that predicate
 * — every regex, every branch — even though the `.mjs` header states in terms that it
 * is "THE ONE IMPLEMENTATION" and that consumers must not re-implement the heuristic.
 * The two happened to still agree, which is exactly what makes that shape dangerous:
 * a duplicate that has not drifted YET reads as a non-problem right up until someone
 * widens one side. Widening one side is what this file's own change set did, so the
 * duplicate was collapsed into the import the `.d.mts` seam was built for (the same
 * seam `identity-leak.ts` already uses). D-003.
 *
 * ── What it detects, in one line ───────────────────────────────────────────────
 * A markdown-style backtick-quoted identifier inside a COMMENT that sits inside a
 * TEMPLATE LITERAL. That backtick terminates the template early. Two hosts:
 *
 *   `sql`      — a `--` comment inside a SQL template. Can fail SILENTLY: inside a
 *                postgres-js tagged template the remainder still parses, so the file
 *                RUNS with the query truncated mid-comment (this is how the mig-504
 *                LWW apply-guard vanished on 2026-07-05). `ts-parse` is blind to it.
 *   `template` — a `//` comment inside any other template: a worker/script SOURCE
 *                body such as `const WORKER_SRC = \`(() => {`, whose generated JS
 *                legitimately carries `//` comments. This host is LOUD (it breaks the
 *                parse), so `ts-parse` and `esbuild-transform` do contain it — but
 *                they report the parser's first confusion, which is why this detector
 *                is ordered BEFORE both: containment was never the gap, DIAGNOSIS was.
 *
 * The full rationale — why this is a line scanner and not an AST walk, why the >=2
 * rule, and why the `template` host needs the tokenizer for one narrow question the
 * mis-parse cannot corrupt — is in the `.mjs`. Read it there rather than here, so
 * there is one copy of the reasoning as well as one copy of the code.
 */

export {
  findSqlCommentBacktick,
  sqlCommentBacktickScopeMatches,
  templateInteriorLines,
} from '../../../../scripts/lib/sql-comment-backtick-scan.mjs';
export type { SqlCommentBacktickHit } from '../../../../scripts/lib/sql-comment-backtick-scan.mjs';

import { findSqlCommentBacktick } from '../../../../scripts/lib/sql-comment-backtick-scan.mjs';

/** Bound on repair passes (one per offending line). A file needing more than this is not
 *  a stray typo — let the LLM fixer look at it rather than spinning. */
const MAX_AUTOFIX_PASSES = 200;

/**
 * Deterministic repair for this class.
 *
 * WHY THIS EXISTS, given the registry entry long said "No autoFix" (EI-19493869861442174).
 * That note gave two reasons and both have since been answered:
 *
 *   1. "rephrasing is an authoring choice" — but `detect`'s own message already MAKES that
 *      choice, and when this class actually fired on 2026-08-04 the LLM fixer independently
 *      produced precisely this transformation. The freedom was notional; the cost of
 *      deferring it was ~76min of a fleet-wide :3170 outage plus a peer's work stranded in
 *      quarantine.
 *   2. "the file may be mid-edit" — handled STRUCTURALLY one layer up: the git-sync guard's
 *      write is CAS-guarded (content-guard.ts), re-reading immediately before writing and
 *      writing only when the file still equals the baseline it detected on.
 *
 * SAFE BY CONSTRUCTION, so this can only shorten an outage, never cause one: the guard runs
 * this ONLY on a file that already FAILED `detect`, re-runs `detect` on the result, and keeps
 * the repair only if it fully clears the error — otherwise the file quarantines to the LLM
 * fixer exactly as before.
 *
 * ── The repair differs by HOST, and using the wrong one would be a real edit ──
 *   `sql`      → swap the backticks for straight double quotes, the remedy `detect`
 *                already prescribes. A double quote inside a SQL comment is inert.
 *   `template` → ESCAPE them (`` \` ``). The comment is generated SOURCE, so its text is
 *                the author's prose about code; requoting it would silently rewrite the
 *                emitted program's comment, whereas escaping restores the parse and
 *                preserves the author's intent exactly. It is also already the house
 *                convention in the file this class last broke — `run-script.ts` uses
 *                `` \` `` at eight other sites inside the same WORKER_SRC template.
 *
 * The HEURISTIC is not reimplemented here (D-003): each offending line is located by calling
 * `findSqlCommentBacktick` itself and rewriting from the `col` it reports, which is documented
 * as the first unescaped backtick INSIDE the comment — so everything from there to end of line
 * is comment text and safe to rewrite. An ESCAPED backtick is left alone: it never terminated
 * the template, so touching it would be an edit the defect does not justify.
 *
 * `fileName` is threaded through because the `template` host needs it: `.tsx` lexes
 * differently from `.ts`, so it selects the script kind the tokenizer uses. It is optional
 * only for callers that predate the second host; omitting it degrades the `template` host
 * to its `.ts` reading rather than failing.
 *
 * Pure + idempotent, per the autoFix contract.
 */
export function autoFixSqlCommentBacktick(text: string, fileName = ''): { fixed: string; changed: boolean } {
  const lines = text.split('\n');
  let changed = false;

  for (let pass = 0; pass < MAX_AUTOFIX_PASSES; pass++) {
    const hit = findSqlCommentBacktick(fileName, lines.join('\n'));
    if (!hit) break;

    const idx = hit.line - 1;
    const line = lines[idx];
    if (line === undefined) break;

    const from = hit.col - 1;
    let rebuilt = line.slice(0, from);
    for (let j = from; j < line.length; j++) {
      const ch = line[j];
      const unescapedBacktick = ch === '`' && line[j - 1] !== '\\';
      if (!unescapedBacktick) rebuilt += ch;
      else rebuilt += hit.host === 'template' ? '\\`' : '"';
    }

    // No progress ⇒ this line is not something we can mechanically resolve. Bail out
    // WITHOUT partial edits so the whole file reaches the LLM fixer in its original state.
    if (rebuilt === line) return { fixed: text, changed: false };

    lines[idx] = rebuilt;
    changed = true;
  }

  return changed ? { fixed: lines.join('\n'), changed: true } : { fixed: text, changed: false };
}
