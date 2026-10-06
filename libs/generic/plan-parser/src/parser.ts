/**
 * Pure plan-document parser.
 *
 * file bytes → { frontmatter, now, items, decisions, ... }
 *
 * Conventions per
 *   apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md (§3).
 *
 * Hard rules the parser enforces:
 *   - Tolerant heading match: strips leading `N. ` / `N.M ` before
 *     comparing to canonical names (## Now, ## Decisions). So
 *     `## 7. Decisions` matches.
 *   - Separator-agnostic: `blocked-by:` is a keyword, `P-NNN`/`D-NNN`
 *     are token patterns. Display glyphs (·, →, —) are never required.
 *   - Computed effectiveStatus is OUT OF SCOPE here — see resolver.ts.
 *     The parser surfaces only `storedStatus`.
 *   - Legacy detection is "missing or malformed frontmatter, or no
 *     slug field." Legacy files still parse to a result with isLegacy
 *     = true; callers (list/get) decide whether to surface them.
 */

import {
  type RiskTier,
  RISK_TIERS,
  type Authority,
  AUTHORITY_LEVELS,
  DEFAULT_AUTHORITY,
} from './risk-model';

/**
 * The plan-lifecycle vocabulary.
 *
 * `awaiting-acceptance` (P-004) is the state between "implementation landed"
 * and "shipped": every item is terminal, but the code-truth audit and the
 * independent acceptance grading have not been done. Before it existed a
 * drained plan had nowhere truthful to sit and stayed at `ready`/`active`,
 * which is why 227 live plans read as live work with nothing left to do.
 *
 * It is written by a rule off the author's own last terminal item flip, and
 * NEVER advanced to `shipped` by anything automatic — the ship gate's audit
 * and independent grading cannot be derived from item statuses, and inventing
 * them is precisely the evidence-forgery this vocabulary exists to prevent.
 *
 * `active` is LEGACY and survives only on existing rows: `set-plan-status.ts`
 * omits it from `SETTABLE` and maps it to `ready`. It is still accepted as a
 * SOURCE of the drained transition, and never written.
 */
export const PLAN_STATUSES = [
  'draft',
  'ready',
  'active',
  'awaiting-acceptance',
  'shipped',
  'superseded',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * True when the plan's implementation is complete but acceptance has not been
 * concluded. Deliberately NOT folded into {@link isTerminalPlanStatus}: a plan
 * awaiting grading is not finished, and treating it as terminal would let it
 * skip the very gate the status exists to route it into.
 */
export function isAwaitingAcceptanceStatus(status: string | null | undefined): boolean {
  return status === 'awaiting-acceptance';
}

/**
 * Terminal plan-lifecycle statuses — the plan is finished, not in flight.
 *
 * Lives here, beside {@link PLAN_STATUSES}, because it is pure status grammar
 * with no I/O: the operator's `plan-start-state.ts` re-exports it (that module
 * imports `@papercusp/db-org`, so consumers that must stay dependency-free —
 * e.g. the `coord.plans` sync projection — could not reach the predicate there
 * without dragging Postgres across their boundary).
 */
export const TERMINAL_PLAN_STATUSES = ['shipped', 'superseded'] as const;

/** True when the plan's lifecycle status is terminal (shipped/superseded). */
export function isTerminalPlanStatus(status: string | null | undefined): boolean {
  return status === 'shipped' || status === 'superseded';
}

/**
 * Statuses a plan can hold while it is still in flight — i.e. not terminal.
 *
 * DERIVED from {@link PLAN_STATUSES} minus {@link TERMINAL_PLAN_STATUSES}
 * rather than re-listed, so a new status cannot be silently omitted from one
 * of the two halves. Hand-typed duplicates of this vocabulary are exactly how
 * it drifted before: `set-frontmatter.ts` carried its own copy of the five
 * values and had to be found by grep.
 *
 * Declared AFTER {@link TERMINAL_PLAN_STATUSES} on purpose — it reads that
 * binding at module-evaluation time, so hoisting it above would throw a
 * temporal-dead-zone `ReferenceError` on import.
 */
export const NON_TERMINAL_PLAN_STATUSES: readonly PlanStatus[] = PLAN_STATUSES.filter(
  (s) => !(TERMINAL_PLAN_STATUSES as readonly string[]).includes(s),
);

export const ITEM_STATUSES = [
  'todo',
  'wip',
  'blocked',
  'needs-human',
  'done',
  'dropped',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Item statuses that represent finished work. */
export const TERMINAL_ITEM_STATUSES = ['done', 'dropped'] as const;

/** True when an item is already finished. */
export function isTerminalItemStatus(status: string | null | undefined): boolean {
  return status === 'done' || status === 'dropped';
}

/** The status-only view needed to compare a plan's child graph across a write. */
export interface PlanItemStatusSnapshot {
  id: string;
  status: string | null | undefined;
}

export interface TerminalPlanChildMutation {
  itemId: string;
  kind: 'added' | 'reopened';
  from: string | null;
  to: string;
}

/**
 * Find only child mutations that introduce live work under a finished plan.
 *
 * Existing live children may still advance, and finished children may still be
 * reclassified. This catches a newly added live child or a finished child
 * reopened while its parent remains shipped/superseded.
 */
export function findTerminalPlanChildMutations(
  parentStatus: string | null | undefined,
  currentItems: readonly PlanItemStatusSnapshot[],
  proposedItems: readonly PlanItemStatusSnapshot[],
): TerminalPlanChildMutation[] {
  if (!isTerminalPlanStatus(parentStatus)) return [];

  const priorById = new Map(currentItems.map((item) => [item.id, item.status]));
  const changes: TerminalPlanChildMutation[] = [];
  for (const proposed of proposedItems) {
    const existed = priorById.has(proposed.id);
    const priorStatus = priorById.get(proposed.id);
    if (isTerminalItemStatus(proposed.status) || (existed && !isTerminalItemStatus(priorStatus))) continue;
    changes.push({
      itemId: proposed.id,
      kind: existed ? 'reopened' : 'added',
      from: priorStatus ?? null,
      to: proposed.status ?? '',
    });
  }
  return changes;
}

/**
 * Per-item importance — a 4th axis orthogonal to status. Ordered most →
 * least important; the array index doubles as the sort rank. For a ToDo
 * it answers "which to pick up next"; for a needs-human item it answers
 * "how urgently a human should act." Distinct from the operator's
 * capability `tier` (risk-of-the-action). See
 * planning-attention-importance-2026-05-31.
 */
export const IMPORTANCE_LEVELS = ['urgent', 'high', 'normal', 'low'] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];
/** Default when an item line carries no `importance:` keyword. */
export const DEFAULT_IMPORTANCE: Importance = 'normal';

export interface PlanFrontmatter {
  title?: string;
  slug?: string;
  status?: PlanStatus;
  created?: string;
  updated?: string;
  owner?: string;
  /** Free-text grouping label tying related plans into one initiative
   *  (shared-hive-collaboration P-015). One metadata field — explicitly NOT a
   *  branch/worktree/PR hierarchy (D-002). Surfaced as a plans-list filter facet. */
  initiative?: string;
  /** Template TYPE this plan conforms to (plan-templates-and-rubric-v2 P-004/P-005) —
   *  names a code-registry zod schema (e.g. `rubric`). Derived into the `template`
   *  column (mirrors `initiative`); the per-plan structured instance data lives in
   *  the `template_data` jsonb (plans:set-template-data), never in frontmatter. */
  template?: string;
  supersedes?: string[];
  supersededBy?: string;
  raw: Record<string, string | string[]>;
}

export interface PlanNowBlock {
  state: string;
  next: string;
  raw: string;
  lineNumber: number;
}

export interface PlanItem {
  id: string;
  text: string;
  storedStatus: ItemStatus;
  /** Per-item importance — defaults to `normal` when the line carries no
   *  `importance:` keyword. Parsed glyph-agnostically like `blocked-by:`. */
  importance: Importance;
  /** Per-item autonomy risk tier (queen-autonomy-policy B-01 / P-010) — the
   *  graded scale the autonomy gate consumes, kept DISTINCT from `importance`
   *  (the ranker's axis, P-014). `null` when the line carries no `risk:` keyword.
   *  Optional on the type so external item literals stay valid; the parser always
   *  populates it (null when absent). See `./risk-model`. */
  riskTier?: RiskTier | null;
  /** Per-item decision authority (P-011) — `owner` always gates regardless of the
   *  computed risk. Defaults to `system` when the line carries no `authority:`
   *  keyword. Optional on the type (parser always populates). See `./risk-model`. */
  authority?: Authority;
  blockedBy: string[];
  decisionRefs: string[];
  phase: string | null;
  lineNumber: number;
  rawLine: string;
}

export interface PlanDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
  /** Other plan slugs this decision explicitly governs via canonical
   * `Affects:` metadata. Optional for compatibility with older derived rows;
   * `parsePlan` always populates it. */
  affects?: string[];
  lineNumber: number;
}

/**
 * WHY `isLegacy` fired (`null` when it didn't) — EI-18793956567250851.
 * `legacy_plan` alone reads as "unsupported, give up"; this names the actual
 * condition so a caller (and the `legacy_plan` error responses that key off
 * it) can point at a concrete repair instead of a dead end.
 *
 * `frontmatter_displaced` is the sharpest case: a well-formed `---`-delimited
 * block (with both `slug` and `status`) exists somewhere in the file, just not
 * at position 0 — the file is mechanically repairable (move the block to the
 * top), not genuinely legacy/unstructured.
 */
export type LegacyReason =
  | 'no_frontmatter'
  | 'frontmatter_displaced'
  | 'missing_slug'
  | 'missing_status'
  | 'invalid_status';

export interface ParsedPlan {
  slug: string;
  filePath: string;
  filename: string;
  frontmatter: PlanFrontmatter;
  now: PlanNowBlock | null;
  items: PlanItem[];
  decisions: PlanDecision[];
  prose: string;
  /** Full original markdown source — what `parsePlan` was handed. The
   *  admin UI's PlanEditor renders this so the canonical bytes stay the
   *  visible truth (D-001 of plans-admin-ui-2026-05-20). */
  raw: string;
  isLegacy: boolean;
  legacyReason: LegacyReason | null;
  parseWarnings: string[];
  /**
   * Non-blocking parse observations (EI-18804290731494084).
   *
   * ⚠ Deliberately SEPARATE from `parseWarnings`, and the distinction is
   * load-bearing: the operator's lint maps every `parseWarnings` entry to a
   * level:'error' finding (`parse_warning`), and `plans:edit` /
   * `plans:set-content` reject on any error — so anything pushed to
   * `parseWarnings` makes the plan UNWRITABLE. A notice is for something a
   * reader should know but that must never wedge a write.
   */
  parseNotices: string[];
}

const PNN = /^P-\d{3,}$/;
const DNN = /^D-\d{3,}$/;
const PNN_INLINE = /\bP-\d{3,}\b/g;

/**
 * An item only owns a decision when the author marks the token as a
 * reference. A bare `D-NNN` in item prose is often a citation to a different
 * record (for example, the source work-item's triage decision), and treating
 * it as local structure creates a dangling ref or an accidental collision with
 * a decision allocated later. Keep the accepted forms deliberately explicit:
 * the arrow/ASCII arrow used by the plan format, plus labelled `see`,
 * `decision`, and `ref` forms. The optional dash is the separator in the
 * existing `- see D-NNN` spelling.
 */
const DECISION_REF_RE =
  /(?:→|->|(?:[-–—·]\s*)?(?:see|decisions?|refs?|references?)\s*:?)\s*(D-\d{3,})\b/gi;

function extractDecisionRefs(text: string): string[] {
  return Array.from(
    new Set(
      Array.from(text.matchAll(DECISION_REF_RE), (match) => (match[1] ?? '').toUpperCase()).filter(Boolean),
    ),
  );
}

/**
 * The marker the operator's `plans:set-status` injects for a caller-supplied
 * `note` (EI-384) — ` — note: <free text>` appended to an item line, replacing
 * any note it previously injected rather than stacking. Exported so a note's
 * free PROSE can be excluded from structured-reference extraction below
 * (EI-522): a note that happens to mention another plan's `D-NNN` decision id
 * in prose (e.g. "back-refs added to other-plan D-025") must not be parsed as
 * a LOCAL decision reference — that produced spurious `unknown_decision_ref`
 * lint warnings, or silently-wrong resolution when the token collided with a
 * real local decision id. The operator's own note-injection code
 * (plans/set-status.ts) matches this exact pattern; kept here as the single
 * source of truth so parser and injector can never drift apart.
 */
export const NOTE_SUFFIX_RE = /\s*—\s*note:.*$/;

const HEADING_NUM_PREFIX = /^\d+(?:\.\d+)?\.\s+/;

function normalizeHeading(text: string): string {
  return text.replace(HEADING_NUM_PREFIX, '').trim();
}

function splitFrontmatter(source: string): { fm: string | null; body: string } {
  if (!source.startsWith('---')) {
    return { fm: null, body: source };
  }
  const close = source.indexOf('\n---', 3);
  if (close === -1) {
    return { fm: null, body: source };
  }
  const fm = source.slice(3, close).replace(/^\n/, '');
  const afterClose = source.indexOf('\n', close + 4);
  const body = afterClose === -1 ? '' : source.slice(afterClose + 1);
  return { fm, body };
}

/**
 * EI-18793956567250851: when `splitFrontmatter` finds nothing at position 0,
 * check whether a genuine frontmatter block simply ended up further down the
 * file (e.g. an agent prepended a `## Now` block ABOVE the existing `---`
 * block instead of below it) — as opposed to the file never having had one at
 * all. Scans every `---`-delimited span in the raw source (not just the
 * first) and accepts the first one that parses with both `slug` and `status`
 * — that pair is exactly `isLegacy`'s own trigger condition, so a match here
 * really is a repairable displacement, not a coincidental `---` (a markdown
 * horizontal rule, or a decision-body dash) reads as a false positive.
 */
function findDisplacedFrontmatter(
  source: string,
): { lineNumber: number; endLineNumber: number } | null {
  const lines = source.split('\n');
  const dashLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') dashLines.push(i);
  }
  for (let i = 0; i + 1 < dashLines.length; i++) {
    const start = dashLines[i] as number;
    const end = dashLines[i + 1] as number;
    const block = lines.slice(start + 1, end).join('\n');
    const { result, ok } = parseFrontmatter(block);
    if (ok && result.slug && result.status) {
      return { lineNumber: start + 1, endLineNumber: end + 1 };
    }
  }
  return null;
}

/**
 * Minimal YAML subset parser for plan frontmatter.
 *
 * Supports:
 *   key: scalar string
 *   key: [a, b, c]      (flow-style arrays)
 *   # comments
 *
 * Deliberately tiny — plan frontmatter is flat and short. No nested
 * maps, no block-style arrays, no anchors, no multi-line strings.
 * If a plan ever needs more, the lint rule will fail loudly.
 */
function parseFrontmatter(fm: string | null): {
  result: PlanFrontmatter;
  warnings: string[];
  ok: boolean;
} {
  const warnings: string[] = [];
  const raw: Record<string, string | string[]> = {};

  if (fm === null) {
    return {
      result: { raw },
      warnings,
      ok: false,
    };
  }

  const lines = fm.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      warnings.push(`Unparseable frontmatter line: ${trimmed}`);
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    if (!key) {
      warnings.push(`Missing key in frontmatter line: ${trimmed}`);
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (!inner) {
        raw[key] = [];
      } else {
        raw[key] = inner.split(',').map((v) => stripQuotes(v.trim())).filter(Boolean);
      }
      continue;
    }

    value = stripQuotes(value);
    raw[key] = value;
  }

  const out: PlanFrontmatter = { raw };
  if (typeof raw.title === 'string') out.title = raw.title;
  if (typeof raw.slug === 'string') out.slug = raw.slug;
  if (typeof raw.status === 'string') {
    if ((PLAN_STATUSES as readonly string[]).includes(raw.status)) {
      out.status = raw.status as PlanStatus;
    } else {
      warnings.push(`Unknown plan status: ${raw.status}`);
    }
  }
  if (typeof raw.created === 'string') out.created = raw.created;
  if (typeof raw.updated === 'string') out.updated = raw.updated;
  if (typeof raw.owner === 'string') out.owner = raw.owner;
  if (typeof raw.initiative === 'string') out.initiative = raw.initiative;
  if (typeof raw.template === 'string') out.template = raw.template;
  if (Array.isArray(raw.supersedes)) out.supersedes = raw.supersedes;
  if (typeof raw['superseded-by'] === 'string') out.supersededBy = raw['superseded-by'];
  if (typeof raw.supersededBy === 'string' && !out.supersededBy) {
    out.supersededBy = raw.supersededBy;
  }

  return { result: out, warnings, ok: true };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

interface RawSection {
  heading: string;
  normalizedHeading: string;
  level: number;
  startLine: number;
  body: string[];
}

function splitSections(body: string): RawSection[] {
  const lines = body.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Track fenced code blocks (``` or ~~~) so headings inside them
    // aren't treated as section breaks and items inside them aren't
    // parsed as real items.
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      continue;
    }
    if (inFence) {
      if (current) current.body.push(line);
      continue;
    }
    // Only split on level-1 or level-2 headings. Level-3+ stays as
    // body content so `### D-NNN` lives inside its parent `## Decisions`
    // section.
    const m = /^(#{1,2})\s+(.*)$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      const heading = (m[2] ?? '').trim();
      current = {
        heading,
        normalizedHeading: normalizeHeading(heading),
        level: (m[1] ?? '').length,
        startLine: i + 1,
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function parseNow(section: RawSection): PlanNowBlock | null {
  const raw = section.body.join('\n').trim();
  if (!raw) return null;
  // Both captures stop at the *other* marker (or EOF) so the State / Next
  // blocks are anchored independently of their order — an author who writes
  // `**Next:**` before `**State:**` still gets each block parsed cleanly
  // instead of Next greedily swallowing the trailing State line.
  const stateMatch = /\*\*State:\*\*\s*([\s\S]*?)(?=\n\s*\*\*Next:\*\*|$)/i.exec(raw);
  const nextMatch = /\*\*Next:\*\*\s*([\s\S]*?)(?=\n\s*\*\*State:\*\*|$)/i.exec(raw);
  return {
    state: stateMatch ? (stateMatch[1] ?? '').trim() : '',
    next: nextMatch ? (nextMatch[1] ?? '').trim() : '',
    raw,
    lineNumber: section.startLine,
  };
}

const ITEM_LINE_RE =
  /^[-*]\s+\*\*\s*(P-\d{3,})\s*\*\*\s+`([a-z-]+)`\s+(.*)$/;

/**
 * Is this line a HANGING-INDENT CONTINUATION of the item bullet above it?
 *
 * Wrapping a long item under a hanging indent is the normal way an author
 * writes one, and every physical line after the first used to be dropped on
 * the floor — the item was stored as its first line only, ending mid-clause
 * (EI-19403572587513008: 23 live items across 3 plans, the worst of them
 * promoted to a work-item whose entire brief was `**Cut queries-per-screen.**
 * Coarser reads for above-the-fold data, defer`). Nothing errored and the
 * plan's `content` still rendered correctly, so the failure presented to the
 * claiming agent as "this plan item is vague", never as "this is truncated".
 *
 * Deliberately CONSERVATIVE: a line only continues the item when it is
 * indented, non-blank, and is not itself the start of another block. Stopping
 * early merely preserves the old behavior for that line, whereas folding a
 * block element in would corrupt the item — so every ambiguous shape stops.
 */
function isItemContinuation(line: string): boolean {
  if (!/^[ \t]/.test(line)) return false; // must be indented under the bullet
  const t = line.trim();
  if (t === '') return false; // a blank line ends the item
  if (/^(?:[-*+]|\d+[.)])\s/.test(t)) return false; // a new / nested list bullet
  if (/^#{1,6}\s/.test(t)) return false; // a heading
  if (/^(?:```|~~~)/.test(t)) return false; // a fence
  if (/^[|>]/.test(t)) return false; // a table row or blockquote
  return true;
}

/**
 * Surface hard-wrapped text that was split between two lowercase letters.
 *
 * This is deliberately a NOTICE rather than a warning: the parser can still
 * recover a useful plan from the bytes, and routing the signal through
 * `parseWarnings` would make every subsequent structured write fail. Fenced
 * examples are masked first so a worked example containing a wrapped sentence
 * does not make the surrounding plan look malformed.
 */
function addMidWordLineBreakNotice(body: string, notices: string[]): void {
  const masked = maskFences(body);
  const lines = new Set<number>();
  // Line numbers are counted forward from the previous match. Re-splitting the prefix per match
  // was quadratic in the body, and a fresh joiner folding many versions of a 180 KB plan paid
  // for it on every one (9.3% of the serve process's CPU in P-007 run #7's tail).
  let line = 1;
  let counted = 0;
  for (const match of masked.matchAll(/[a-z]\n[a-z]/g)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    for (let nl = masked.indexOf('\n', counted); nl !== -1 && nl < index; nl = masked.indexOf('\n', nl + 1)) line++;
    counted = index;
    lines.add(line);
  }
  if (lines.size === 0) return;

  const sorted = [...lines].sort((a, b) => a - b);
  const shown = sorted.slice(0, 8).join(', ');
  const suffix = sorted.length > 8 ? `, … +${sorted.length - 8} more` : '';
  notices.push(
    `Mid-word hard line break(s) at body line(s) ${shown}${suffix}: a lowercase letter is ` +
      `immediately followed by a newline and lowercase letter. Wrapped prose or item text may ` +
      `have been split before it reached the plan parser.`,
  );
}

/**
 * A structured item marker that survived on a non-item line is almost always
 * a wrapper-detached suffix. In the observed failure, the first physical line
 * parsed as an item and the next unindented line carried `blocked-by: P-006`;
 * the dependency therefore disappeared from the graph while lint remained
 * clean. Keep this check scoped to Phase sections, where these markers have
 * structured meaning and ordinary prose is not expected to mention them.
 */
function addOrphanItemMarkerWarnings(
  sections: RawSection[],
  parsedItemLines: ReadonlySet<number>,
  warnings: string[],
): void {
  for (const section of sections) {
    if (section.level !== 2 || !/^Phase\b/i.test(section.normalizedHeading)) continue;

    let inFence = false;
    for (let i = 0; i < section.body.length; i++) {
      const line = section.body[i] ?? '';
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const lineNumber = section.startLine + i + 1;
      if (parsedItemLines.has(lineNumber)) continue;

      const markers = Array.from(line.matchAll(/\b(blocked-by|importance)\s*:/gi)).map(
        (match) => (match[1] ?? '').toLowerCase(),
      );
      const uniqueMarkers = [...new Set(markers)];
      if (uniqueMarkers.length === 0) continue;

      const markerText = uniqueMarkers.map((marker) => `${marker}:`).join(' and ');
      warnings.push(
        `Orphan item marker(s) ${markerText} at body line ${lineNumber} are outside a canonical ` +
          `item line (${line.trim().slice(0, 160)}). The parser cannot attach these markers to ` +
          `an item; restore the wrapped text to the preceding item or rewrite the item with ` +
          `plans:set-content.`,
      );
    }
  }
}

function parseItemLine(
  line: string,
  lineNumber: number,
  phase: string | null,
  /** The FIRST PHYSICAL source line, when `line` is a folded logical line.
   *  `rawLine` must stay physical: `detectUnparsedItemLines` (lint.ts,
   *  item-parse-feedback.ts) matches it against the source's own lines to find
   *  item-shaped lines that did NOT parse, so handing it a folded line would
   *  report every wrapped item as unparsed. */
  rawLine: string = line,
): PlanItem | null {
  const m = ITEM_LINE_RE.exec(line);
  if (!m) return null;
  const id = m[1] ?? '';
  const statusTok = m[2] ?? '';
  const rest = m[3] ?? '';
  if (!(ITEM_STATUSES as readonly string[]).includes(statusTok)) {
    return null;
  }

  let text = rest;
  const blockedBy: string[] = [];
  // Repeated clauses can exist in legacy plan text when an older structured
  // writer removed only the first occurrence. Merge their refs conservatively:
  // dropping a later prerequisite can admit dependent work prematurely.
  // A word boundary alone also matches the tail of hyphenated prose such as
  // `OWNER-AUTHORITY:`. Require the marker to start outside a word or hyphen
  // so ordinary compound words stay in the item's visible text.
  const blockedByRe = /(?<![\w-])blocked-by\s*:\s*((?:P-\d{3,}(?:\s*,\s*)?)+)/gi;
  for (const bbMatch of text.matchAll(blockedByRe)) {
    for (const ref of (bbMatch[1] ?? '').match(PNN_INLINE) ?? []) {
      if (!blockedBy.includes(ref)) blockedBy.push(ref);
    }
  }
  text = text.replace(blockedByRe, '').trim();

  // `importance:` keyword — parsed glyph-agnostically like blocked-by,
  // then stripped from the visible text. An unknown value degrades to
  // `normal` here WITHOUT a parseWarning (those become lint *errors* —
  // lint.ts:149); plans:lint instead emits a soft `unknown_importance`
  // warning by re-scanning the raw line.
  let importance: Importance = DEFAULT_IMPORTANCE;
  const importanceRe = /(?<![\w-])importance\s*:\s*([a-z]+)\b/i;
  const impMatch = importanceRe.exec(text);
  if (impMatch) {
    const tok = (impMatch[1] ?? '').toLowerCase();
    if ((IMPORTANCE_LEVELS as readonly string[]).includes(tok)) {
      importance = tok as Importance;
    }
    text = (text.slice(0, impMatch.index) + text.slice(impMatch.index + impMatch[0].length)).trim();
  }

  // `risk:` keyword — the autonomy risk tier (queen-autonomy-policy B-01), parsed
  // glyph-agnostically like `importance:` and stripped from the visible text. An
  // unknown value degrades to `null` (no tier) WITHOUT a parseWarning, mirroring
  // the importance handling.
  let riskTier: RiskTier | null = null;
  const riskRe = /(?<![\w-])risk\s*:\s*([a-z]+)\b/i;
  const riskMatch = riskRe.exec(text);
  if (riskMatch) {
    const tok = (riskMatch[1] ?? '').toLowerCase();
    if ((RISK_TIERS as readonly string[]).includes(tok)) {
      riskTier = tok as RiskTier;
    }
    text = (text.slice(0, riskMatch.index) + text.slice(riskMatch.index + riskMatch[0].length)).trim();
  }

  // `authority:` keyword — decision authority (P-011), defaults to `system`. An
  // unknown value degrades to the default WITHOUT a parseWarning.
  let authority: Authority = DEFAULT_AUTHORITY;
  const authorityRe = /(?<![\w-])authority\s*:\s*([a-z]+)\b/i;
  const authMatch = authorityRe.exec(text);
  if (authMatch) {
    const tok = (authMatch[1] ?? '').toLowerCase();
    if ((AUTHORITY_LEVELS as readonly string[]).includes(tok)) {
      authority = tok as Authority;
    }
    text = (text.slice(0, authMatch.index) + text.slice(authMatch.index + authMatch[0].length)).trim();
  }

  // EI-522: strip a set-status-injected note's free prose before scanning for
  // structured D-NNN refs — only `text` (returned to callers/display)
  // includes the note; the ref set must not.
  const textForDecisionRefs = text.replace(NOTE_SUFFIX_RE, '');
  const decisionRefs = extractDecisionRefs(textForDecisionRefs);

  text = text.replace(/[·→—]+\s*$/g, '').trim();
  text = text.replace(/\s+→\s+(?=D-\d)/g, ' ').replace(/\s+·\s+/g, ' ').trim();

  return {
    id,
    text,
    storedStatus: statusTok as ItemStatus,
    importance,
    riskTier,
    authority,
    blockedBy,
    decisionRefs,
    phase,
    lineNumber,
    rawLine,
  };
}

/**
 * A decision DECLARATION head inside `## Decisions`.
 *
 * The id must be followed by whitespace, a separator, or end-of-line
 * (EI-18804290731494084). The previous `\b` boundary also matched an id
 * GLUED to prose — `### D-045's framing was incomplete` parsed as a second
 * declaration of D-045, producing a phantom decision, a duplicate-id lint
 * ERROR, and (because lint errors reject every write) a permanently
 * un-editable plan.
 *
 * ⚠ This match deliberately does NOT require the canonical `— ` separator.
 * Measured across the whole plan corpus (528 plans / 3,921 decision heads):
 * 3,767 use a separator but **148 are real decisions written `### D-NNN
 * Title`**, in consistent D-001…D-013 runs across entire plans. Requiring a
 * separator would silently reclassify all 148 as body and destroy them.
 * There is no lexical difference between a real `### D-004 P-011 and P-012
 * remain owned by …` and a prose `### D-053 held, and is now pinned …`, so
 * the second half of the fix is sequence-aware, not lexical — see the
 * already-declared check in `parseDecisionsSection`.
 */
const DECISION_HEAD_RE = /^###\s+(D-\d{3,})(?=\s|[-–—:]|$)\s*(?:[-–—]\s*)?(.*)$/;

function parseDecisionsSection(section: RawSection, notices: string[]): PlanDecision[] {
  const decisions: PlanDecision[] = [];
  const declared = new Set<string>();
  let current: PlanDecision | null = null;
  let bodyBuf: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyBuf.join('\n').trim();
      const refs = new Set(current.body.match(PNN_INLINE) ?? []);
      current.itemRefs = Array.from(refs);
      const dateLine = current.body.match(/^Date:\s*([\d-]+)/im);
      if (dateLine) current.date = dateLine[1] ?? null;
      const affectsLine = current.body.match(/^Affects:\s*(.*)$/im);
      current.affects = affectsLine
        ? Array.from(
            new Set(
              (affectsLine[1] ?? '')
                .split(',')
                .map((slug) => slug.trim())
                .filter(Boolean),
            ),
          )
        : [];
      decisions.push(current);
    }
    current = null;
    bodyBuf = [];
  };

  let inFence = false;
  for (let i = 0; i < section.body.length; i++) {
    const line = section.body[i] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) bodyBuf.push(line);
      continue;
    }
    if (inFence) {
      if (current) bodyBuf.push(line);
      continue;
    }
    const m = DECISION_HEAD_RE.exec(line);
    const id = m ? (m[1] ?? '') : '';
    // A decision id is unique by definition (lint enforces it), so a heading
    // bearing an id ALREADY declared in this section structurally cannot be a
    // second declaration — it is prose inside the current decision's body
    // (`### D-053 held, and is now pinned by tests at three levels`). Treating
    // it as a declaration is what minted phantom decisions and duplicate-id
    // errors. This is a NOTICE, never a parse warning: a warning becomes a lint
    // error, which is precisely the wedge this fix exists to remove.
    if (m && declared.has(id)) {
      notices.push(
        `Decision heading at line ${section.startLine + i + 1} re-uses already-declared decision id ${id} — ` +
          `read as body of ${current?.id ?? '(no open decision)'}, not a second declaration.`,
      );
      if (current) bodyBuf.push(line);
      continue;
    }
    if (m) {
      flush();
      declared.add(id);
      current = {
        id,
        title: (m[2] ?? '').trim(),
        body: '',
        date: null,
        itemRefs: [],
        affects: [],
        lineNumber: section.startLine + i + 1,
      };
    } else if (current) {
      bodyBuf.push(line);
    }
  }
  flush();
  return decisions;
}

export interface ParseOptions {
  filePath?: string;
}

export function parsePlan(source: string, opts: ParseOptions = {}): ParsedPlan {
  const filePath = opts.filePath ?? '<inline>';
  const filename = filePath.split('/').pop() ?? filePath;
  const slug = filename.replace(/\.mdx?$/, '');

  const { fm, body } = splitFrontmatter(source);
  const { result: frontmatter, warnings, ok: fmOk } = parseFrontmatter(fm);
  const notices: string[] = [];
  addMidWordLineBreakNotice(body, notices);

  const isLegacy = !fmOk || !frontmatter.slug || !frontmatter.status;

  // EI-18793956567250851: name WHY, so a `legacy_plan` refusal downstream can
  // point at a concrete repair instead of reading as "unsupported, give up".
  let legacyReason: LegacyReason | null = null;
  if (isLegacy) {
    if (!fmOk) {
      const displaced = findDisplacedFrontmatter(source);
      if (displaced) {
        legacyReason = 'frontmatter_displaced';
        notices.push(
          `Legacy plan: a well-formed frontmatter block (with both slug + status) was found at ` +
            `line ${displaced.lineNumber}-${displaced.endLineNumber}, but frontmatter must be at the ` +
            `very top of the file (position 0) to parse — everything needed is present, just too late. ` +
            `Repair: move that '---'-delimited block to line 1 (plans:set-content / plans:set-content-chunk), ` +
            `then re-check isLegacy.`,
        );
      } else {
        legacyReason = 'no_frontmatter';
      }
    } else if (!frontmatter.slug) {
      legacyReason = 'missing_slug';
    } else if (!frontmatter.status) {
      legacyReason = frontmatter.raw.status !== undefined ? 'invalid_status' : 'missing_status';
    }
  }

  const sections = splitSections(body);

  let now: PlanNowBlock | null = null;
  const items: PlanItem[] = [];
  let decisions: PlanDecision[] = [];

  let currentPhase: string | null = null;
  const parsedItemLines = new Set<number>();

  for (const section of sections) {
    const norm = section.normalizedHeading;

    if (section.level === 2 && /^Now$/i.test(norm) && !now) {
      now = parseNow(section);
      continue;
    }

    if (section.level === 2 && /^Decisions$/i.test(norm)) {
      decisions = parseDecisionsSection(section, notices);
      continue;
    }

    if (section.level === 2 && /^Phase\b/i.test(norm)) {
      currentPhase = norm;
    } else if (section.level === 2) {
      currentPhase = null;
    }

    let inFence = false;
    for (let i = 0; i < section.body.length; i++) {
      const line = section.body[i] ?? '';
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      // Fold hanging-indent continuation lines into ONE logical line before
      // parsing, joined with a space rather than a newline: the renderer emits
      // an item as a single `- **P-NNN** \`status\` text` line, so a newline
      // here would break round-trip. Parsing the folded line (not just
      // concatenating text afterwards) is what lets `blocked-by:`/`importance:`
      // /`risk:`/`authority:` keywords be honoured wherever they wrapped to.
      let logical = line;
      let consumed = 0;
      if (ITEM_LINE_RE.test(line)) {
        for (let j = i + 1; j < section.body.length; j++) {
          if (!isItemContinuation(section.body[j] ?? '')) break;
          logical += ' ' + (section.body[j] ?? '').trim();
          consumed++;
        }
      }
      const item = parseItemLine(logical, section.startLine + i + 1, currentPhase, line);
      if (item) {
        items.push(item);
        parsedItemLines.add(section.startLine + i + 1);
        for (let j = 1; j <= consumed; j++) {
          parsedItemLines.add(section.startLine + i + j + 1);
        }
        i += consumed;
      }
    }
  }

  addOrphanItemMarkerWarnings(sections, parsedItemLines, warnings);

  const idSeen = new Set<string>();
  for (const it of items) {
    if (idSeen.has(it.id)) {
      warnings.push(`Duplicate item id: ${it.id} at line ${it.lineNumber}`);
    }
    idSeen.add(it.id);
    if (!PNN.test(it.id)) {
      warnings.push(`Malformed item id: ${it.id}`);
    }
  }
  const decSeen = new Set<string>();
  for (const d of decisions) {
    if (decSeen.has(d.id)) {
      warnings.push(`Duplicate decision id: ${d.id} at line ${d.lineNumber}`);
    }
    decSeen.add(d.id);
    if (!DNN.test(d.id)) {
      warnings.push(`Malformed decision id: ${d.id}`);
    }
  }

  return {
    slug,
    filePath,
    filename,
    frontmatter,
    now,
    items,
    decisions,
    prose: body,
    raw: source,
    isLegacy,
    legacyReason,
    parseWarnings: warnings,
    parseNotices: notices,
  };
}

/**
 * Return a copy of `body` with every character inside a fenced code
 * block (``` / ~~~ fences and the fence lines themselves) replaced by
 * a space. Newlines and total length are preserved byte-for-byte, so a
 * regex match index computed against the masked string applies
 * unchanged to the original.
 *
 * The write mutators (set-status, set-now, add-decision, add-item)
 * locate their target heading/item by running a regex over the masked
 * body, then splice the *real* body at the resulting index — so a
 * `## Now` or `- **P-001**` line inside a worked-example fence is never
 * mistaken for the real structural element. This matches the parser,
 * which already ignores fenced regions.
 */
/**
 * Demote headings in a DECISION BODY so none of them can break the plan's
 * section structure (EI-18804290731494084).
 *
 * `splitSections` splits on every `#` / `##` heading outside a fence, so a
 * decision body containing one ENDS the `## Decisions` section: the decision's
 * body is truncated at that line and the remainder is promoted to top-level
 * plan sections. Observed live on unified-agent-state-plane-2026-07-27 — D-057
 * and D-083 were each cut to their first paragraph and 32 orphaned `##`
 * sections appeared after `## Decisions`. Nothing is lost from the file; the
 * STRUCTURE is what is destroyed, which is why it is silent.
 *
 * The fix belongs at the point of authorship (a structural tier, not a
 * documented convention): every heading is shifted by the same delta so the
 * shallowest becomes `####`, preserving relative structure.
 *
 * ⚠ The target is level 4, NOT 3, and the extra level is the whole point. At
 * `###` a body heading is still AT THE DECLARATION LEVEL, so a body containing
 * `### D-001 mentioned in prose` mints a phantom D-001 — a property test caught
 * exactly this, with an id not yet declared, which no amount of parser
 * cleverness can distinguish from a real head. Demoting one level further makes
 * the invariant total and checkable: **a normalized decision body contains no
 * heading at level ≤ 3**, therefore it can be neither a section break nor a
 * decision declaration. The parser-side rules stay as defence in depth for
 * bodies written through the raw `plans:edit` / `plans:set-content` paths, which
 * this normalizer never sees.
 *
 * Fenced regions are left alone: a worked example containing `## Now` is
 * content, not a heading.
 */
export function normalizeDecisionBodyHeadings(body: string): { body: string; normalized: number } {
  const lines = body.split('\n');
  const headingAt = new Map<number, { hashes: string; rest: string }>();
  let inFence = false;
  let minLevel = Infinity;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})(\s+.*)$/.exec(line);
    if (!m) continue;
    const hashes = m[1] ?? '';
    headingAt.set(i, { hashes, rest: m[2] ?? '' });
    minLevel = Math.min(minLevel, hashes.length);
  }

  if (minLevel >= 4 || headingAt.size === 0) return { body, normalized: 0 };

  const delta = 4 - minLevel;
  let normalized = 0;
  for (const [i, h] of headingAt) {
    // Clamp at h6 — markdown has no deeper heading. A body nested that far is
    // pathological, and flattening the last level is far better than emitting
    // `#######`, which renders as literal text.
    const level = Math.min(6, h.hashes.length + delta);
    lines[i] = '#'.repeat(level) + h.rest;
    normalized++;
  }
  return { body: lines.join('\n'), normalized };
}

export function maskFences(body: string): string {
  const lines = body.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const isFenceLine = /^\s*(?:```|~~~)/.test(line);
    if (isFenceLine) {
      inFence = !inFence;
      lines[i] = ' '.repeat(line.length);
      continue;
    }
    if (inFence) {
      lines[i] = ' '.repeat(line.length);
    }
  }
  return lines.join('\n');
}
