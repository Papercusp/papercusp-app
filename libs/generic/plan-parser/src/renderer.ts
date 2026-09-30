/**
 * renderPlanMarkdown — render the QUERYABLE structure of a plan back to markdown.
 *
 * Plan: plans-pg-canonical-migration-2026-06-03 (Stage 3 — normalize, D-006).
 *
 * The structured sections (frontmatter + `## Now` + items + decisions) become a
 * derived index in PG columns; this renderer turns that structure back into
 * markdown. It is the INVERSE of `parsePlan` over the queryable sections — NOT a
 * byte-for-byte reproduction of free prose (the prose body stays canonical in
 * `content`; this renderer never reproduces it).
 *
 * The correctness gate is the round-trip property
 *   parse(render(parse(x))) ≡ parse(x)   (structurally — frontmatter / now /
 *   items / decisions; NOT prose, NOT byte fidelity)
 * proved by renderer.test.ts over every real plan + fast-check generators.
 *
 * Pure, zero I/O — same tier as the parser.
 */

import {
  type ParsedPlan,
  type PlanItem,
  type PlanDecision,
  type PlanNowBlock,
  type PlanFrontmatter,
  DEFAULT_IMPORTANCE,
  NOTE_SUFFIX_RE,
} from './parser';
import { DEFAULT_AUTHORITY } from './risk-model';

/** Render the frontmatter block from its parsed raw key/values. Arrays emit as
 *  flow-style `[a, b, c]`; scalars as `key: value`. Order follows `raw`'s keys
 *  (insertion order) — the parser is order-insensitive, so any order round-trips. */
function renderFrontmatter(fm: PlanFrontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm.raw)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Render the `## Now` block. `now.raw` is the verbatim section body — emitting it
 * directly is the faithful round-trip (the Now block is a structured section, not
 * free prose), and it preserves non-standard layouts (e.g. `**Status:**` /
 * `**Shipped:**`) that the `**State:**`/`**Next:**` split alone would lose. The
 * derived `now_state` / `now_next` columns capture the queryable views.
 */
function renderNow(now: PlanNowBlock): string {
  return `## Now\n\n${now.raw}`;
}

/**
 * Render one item line in the exact shape `parseItemLine` consumes:
 *   `- **P-NNN** \`status\` text [blocked-by: …] [importance: …]`
 * The parser strips `blocked-by:` + `importance:` from the text but KEEPS
 * inline `D-NNN` decision refs, so `item.text` already carries the refs and we
 * re-append only the stripped keywords (importance only when non-default).
 */
function renderItem(item: PlanItem): string {
  // EI-20577635585381178: keywords MUST be emitted BEFORE any ` — note: …` suffix.
  // The parser keeps a set-status-injected note inside `item.text`, and
  // NOTE_SUFFIX_RE (`/\s*—\s*note:.*$/`) matches to END OF LINE. set-status replaces
  // an existing note with `rest.replace(NOTE_MARKER_RE, '')` before re-appending the
  // new one, so ANY keyword rendered after the note is swallowed by that strip —
  // silently destroying `blocked-by:` edges (and importance/risk/authority) on the
  // next status write. Measured: plan release-build-vm-dev-parity-audit-2026-08-13
  // item P-006 lost `blocked-by: P-002, P-001` this way and was re-advertised READY,
  // stalling WI-38602 for 43+ consecutive wakes.
  //
  // The parser is order-agnostic for these keywords (each is matched by a bounded
  // keyword regex, not to end-of-line), so emitting them before the note preserves
  // the round-trip property and makes the note strictly last.
  const noteMatch = NOTE_SUFFIX_RE.exec(item.text);
  const baseText = noteMatch ? item.text.slice(0, noteMatch.index) : item.text;
  const noteSuffix = noteMatch ? item.text.slice(noteMatch.index) : '';

  let keywords = '';
  if (item.blockedBy.length > 0) {
    keywords += ` blocked-by: ${item.blockedBy.join(', ')}`;
  }
  if (item.importance !== DEFAULT_IMPORTANCE) {
    keywords += ` importance: ${item.importance}`;
  }
  // Autonomy axes (queen-autonomy-policy B-01) — emit only when non-default so the
  // round-trip stays lean: a tier-less item and a `system`-authority item render
  // exactly as before. The parser strips `risk:`/`authority:` back out on re-parse.
  if (item.riskTier != null) {
    keywords += ` risk: ${item.riskTier}`;
  }
  if ((item.authority ?? DEFAULT_AUTHORITY) !== DEFAULT_AUTHORITY) {
    keywords += ` authority: ${item.authority}`;
  }
  return `- **${item.id}** \`${item.storedStatus}\` ${baseText}${keywords}${noteSuffix}`;
}

/** Render one decision: `### D-NNN — title` then its body verbatim (the body
 *  already contains any `Date:` / `P-NNN` ref lines the parser reads back). */
function renderDecision(d: PlanDecision): string {
  const head = d.title ? `### ${d.id} — ${d.title}` : `### ${d.id}`;
  return d.body ? `${head}\n\n${d.body}` : head;
}

/**
 * Render a plan's queryable structure to a parseable markdown document.
 *
 * Items are grouped under their `phase` heading (a `## <phase>` for items whose
 * phase matched `^Phase…`, or a single non-`Phase` `## Items` heading for the
 * phase-less ones — both re-parse to the same `item.phase`). Decisions go under
 * `## Decisions`. The free prose body is intentionally NOT reproduced.
 */
export function renderPlanMarkdown(parsed: ParsedPlan): string {
  const blocks: string[] = [];

  blocks.push(renderFrontmatter(parsed.frontmatter));

  if (parsed.frontmatter.title) {
    blocks.push(`# ${parsed.frontmatter.title}`);
  }

  if (parsed.now) {
    blocks.push(renderNow(parsed.now));
  }

  // Render items in DOCUMENT ORDER, emitting a heading only when the phase
  // CHANGES (so a phase that recurs non-contiguously keeps each item's original
  // order + phase association — grouping by phase would reorder them). A `## Phase…`
  // heading re-parses to that phase; any other `## ` heading re-parses to phase
  // === null, so phase-less runs get a synthetic non-"Phase" `## Items` heading.
  if (parsed.items.length > 0) {
    const lines: string[] = [];
    let prevPhase: string | null | undefined = undefined; // undefined = no heading emitted yet
    for (const item of parsed.items) {
      const phase = item.phase;
      if (phase !== prevPhase) {
        if (lines.length > 0) lines.push('');
        lines.push(phase ? `## ${phase}` : '## Items');
        lines.push('');
        prevPhase = phase;
      }
      lines.push(renderItem(item));
    }
    blocks.push(lines.join('\n'));
  }

  if (parsed.decisions.length > 0) {
    const decisions = parsed.decisions.map(renderDecision).join('\n\n');
    blocks.push(`## Decisions\n\n${decisions}`);
  }

  return blocks.join('\n\n') + '\n';
}
