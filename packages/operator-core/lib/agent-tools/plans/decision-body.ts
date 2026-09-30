/**
 * decision-body.ts — PURE helpers for allocating a `D-NNN` id and splicing a
 * decision block into a plan body.
 *
 * Extracted from `add-decision.ts` (the `plans:add-decision` TOOL module) so a
 * library caller — `lib/rubrics.ts` records the ship verdict as a decision — can
 * reuse them WITHOUT importing the tool module. That import was a strand: the
 * tool module reads `VALID_PLAN_SLUG` from `./source` at module scope (a zod
 * schema), so every plans test that mocks `./source` with a bare factory
 * (`vi.mock('./source', () => ({ getPlanRow: vi.fn() }))`) and transitively
 * reaches rubrics.ts collapsed at collection with
 * `No "VALID_PLAN_SLUG" export is defined on the "./source" mock` — five files
 * at once on 2026-09-05 (arm-schedule, run-now, list.delta, shape-clip,
 * launch.goal-stamp). This module imports ONLY the pure parser, so it is safe
 * under every such mock and safe for any lib-tier caller.
 */
import { parsePlan, maskFences, normalizeDecisionBodyHeadings } from './parser';

function formatPadded(n: number): string {
  return n.toString().padStart(3, '0');
}

// Matches the `## Decisions` heading (optionally numbered, "## 5. Decisions")
// but NOT a suffixed variant like "## Decisions (settled)" — a different
// section that must never be scanned/absorbed. Kept in sync with
// `appendDecisionToBody`'s heading match via `findDecisionsSectionBody`.
const DECISIONS_HEADING_RE = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Decisions\s*$/m;

/**
 * Locate the `## Decisions` section's body text (fence-masked, so a
 * `D-NNN`-looking token inside a worked-example fence is excluded) — the
 * text between the heading and the next `## ` heading, or EOF. Returns
 * null when the doc has no (unsuffixed) Decisions section.
 */
function findDecisionsSectionBody(maskedBody: string): string | null {
  const headingMatch = DECISIONS_HEADING_RE.exec(maskedBody);
  if (!headingMatch) return null;
  const after = headingMatch.index + headingMatch[0].length;
  const restAfter = maskedBody.slice(after);
  const nextHeadingMatch = /^##\s/m.exec(restAfter);
  return nextHeadingMatch ? restAfter.slice(0, nextHeadingMatch.index) : restAfter;
}

/**
 * A `D-NNN` token in the Decisions section counts toward id allocation only
 * when it is DECLARATION-SHAPED: the first thing on its line (after an
 * optional blockquote marker and list bullet), written either as a markdown
 * heading (`#### D-014 — ...`) or wrapped in emphasis (`- **D-014** ...` —
 * the informal legacy bullet EI-15651 exists for).
 *
 * Anything else is a REFERENCE, not a declaration. That distinction is the
 * whole fix for EI-19989843927675996: a decision BODY that cites another
 * plan's ruling — `defers to D-054` — used to be scanned as if it declared
 * D-054 here, so the next allocation jumped to D-055 and the plan read as
 * though ~50 decisions were missing. Cross-plan citation is not an edge case
 * but the documented good practice (CLAUDE.md tells agents to name a ruling
 * as `<planSlug>#D-NNN`), and the inflation it caused was permanent and
 * monotonic.
 *
 * Requiring emphasis-or-heading rather than merely line-initial position is
 * measured, not guessed: across all 679 papercusp plans, informal
 * declarations appear ONLY as `**D-NNN**` (365 lines / 105 plans) or as
 * headings (4,631 lines / 586 plans) — a bare line-initial `D-NNN` occurs
 * zero times, while 7,917 mid-line reference tokens do. So the tighter shape
 * excludes no real declaration and admits no bullet-list citation
 * (`- Supersedes D-054.`), which the looser line-initial rule would have.
 *
 * Slug-qualified citations (`unified-agent-state-plane-2026-07-27#D-087`)
 * fall out for free: both branches require `D-` immediately after the
 * heading marker or emphasis delimiter, so a qualified token never matches
 * however it is positioned.
 */
const DECLARED_DECISION_TOKEN_RE =
  /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+\.)[ \t]+)?(?:#{1,6}[ \t]+D-(\d{3,})\b|(?:\*\*|__)D-(\d{3,})(?:\*\*|__))/gm;

/**
 * Allocate the next D-NNN.
 *
 * Considers BOTH real parsed (structured `### D-NNN`) decisions AND any
 * DECLARATION-SHAPED `D-NNN` token elsewhere in the `## Decisions` section
 * body — e.g. an informal legacy-style `- **D-001** ...` prose bullet, which
 * the structured parser does not recognise as a decision at all (EI-15651).
 * Without the latter, a plan hand-authored with informal decision bullets
 * makes the allocator start counting from 1 again, minting a `### D-001`
 * that collides VISUALLY with the pre-existing informal `**D-001**` bullet
 * in the rendered document, even though the store treats them as unrelated.
 *
 * References to D-NNN inside prose/example fences OUTSIDE the Decisions
 * section must not bump the allocator either — hence scoping the scan to the
 * section body (fence-masked within it too).
 */
export function allocateNextDecisionId(body: string): string {
  const parsed = parsePlan(body);
  let max = 0;
  for (const d of parsed.decisions) {
    const m = /^D-(\d+)$/.exec(d.id);
    if (m) {
      const n = parseInt(m[1] ?? '0', 10);
      if (n > max) max = n;
    }
  }
  const sectionBody = findDecisionsSectionBody(maskFences(body));
  if (sectionBody) {
    for (const m of sectionBody.matchAll(DECLARED_DECISION_TOKEN_RE)) {
      const n = parseInt(m[1] ?? m[2] ?? '0', 10);
      if (n > max) max = n;
    }
  }
  return `D-${formatPadded(max + 1)}`;
}

/**
 * Normalise an `affects` slug list: drop the home plan's own slug (a
 * decision can't cross-reference its own home) and de-duplicate so a
 * caller passing the same slug twice doesn't propagate twice.
 */
export function normalizeAffects(
  affects: string[] | undefined,
  homeSlug: string,
): string[] {
  return [...new Set((affects ?? []).filter((s) => s !== homeSlug))];
}

export function appendDecisionToBody(
  body: string,
  decisionId: string,
  title: string,
  decisionBody: string,
  date: string,
  refs: string[],
  affects: string[] = [],
): string {
  const refsLine =
    refs.length > 0 ? `\nRelated: ${refs.join(', ')}` : '';
  const affectsLine = affects.length > 0 ? `Affects: ${[...new Set(affects)].join(', ')}\n` : '';
  // Demote `#`/`##` headings in the body so they cannot break out of the
  // `## Decisions` section and shred the decision (EI-18804290731494084).
  // Enforced HERE, at authorship, rather than documented as a convention:
  // the failure is silent, so the only tier that works is a structural one.
  const { body: safeBody } = normalizeDecisionBodyHeadings(decisionBody.trim());
  const block =
    `\n### ${decisionId} — ${title.trim()}\n` +
    `Date: ${date}\n` +
    affectsLine +
    `${safeBody}${refsLine}\n`;

  // Find the `## Decisions` section — allowing a numbered prefix
  // ("## 5. Decisions") and trailing whitespace ONLY. A heading with a
  // suffix like "## Decisions (settled)" is a DIFFERENT section and
  // must never absorb new decisions (EI-141 / audit P-041).
  // Locate against the fence-masked body so a `## Decisions` heading
  // inside a worked-example fence is skipped; splice the real body by
  // index (maskFences preserves length, so indices are interchangeable).
  const masked = maskFences(body);
  const headingMatch = DECISIONS_HEADING_RE.exec(masked);
  // Collapse any run of trailing newlines to exactly one before gluing
  // the block on (whose leading \n supplies the single separating blank
  // line) — a splice point that already sat on a blank line otherwise
  // stacks doubles (EI-141 / audit P-041).
  const oneTrailingNL = (s: string) =>
    s.endsWith('\n') ? s.replace(/\n+$/, '\n') : s + '\n';
  if (headingMatch) {
    // Find the start of the next `## ` heading after this one, or end of file.
    const after = headingMatch.index + headingMatch[0].length;
    const restAfter = masked.slice(after);
    const nextHeadingRe = /^##\s/m;
    const nextHeadingMatch = nextHeadingRe.exec(restAfter);
    if (nextHeadingMatch) {
      const insertAt = after + nextHeadingMatch.index;
      return oneTrailingNL(body.slice(0, insertAt)) + block + '\n' + body.slice(insertAt);
    }
    // No subsequent heading — append at file end.
    return oneTrailingNL(body) + block;
  }
  // No Decisions section — append one at file end.
  return oneTrailingNL(body) + `\n## Decisions\n${block}`;
}
