/**
 * plan-template-serialize — turn a LIVE plan into a shareable plan TEMPLATE
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-006).
 *
 * A plan in this system is two things fused into one markdown document: a REUSABLE
 * SHAPE (the goal, the item DAG, the decisions, the schedule) and a RUN LOG (which
 * items are done, who claimed them, which work-items they minted, which shas the
 * audit cited). Publishing the second half is worse than useless — it hands the
 * installer someone else's completed work as if it were their own to-do list, and it
 * leaks this workspace's identifiers into a public listing. So the export STRIPS the
 * run log and keeps the shape.
 *
 * WHY THIS IS PART-SURGERY, NOT A RE-RENDER (D-004)
 * ------------------------------------------------
 * `renderPlanMarkdown` would be the obvious tool and is the wrong one: it is
 * explicitly "NOT a byte-for-byte reproduction of free prose" and "never reproduces"
 * the prose body. A plan's prose IS most of its transferable value — the Background,
 * the survey of alternatives, the why-not notes. Re-rendering would ship an installer
 * a skeleton with the reasoning deleted.
 *
 * So the transform runs over `splitPlanIntoParts` (plan-parser/parts.ts), the
 * package's own byte-faithful decomposition: parts cover 100% of the source as
 * contiguous line ranges and `joinPartsIntoPlan` reconstructs it exactly. Every part
 * is therefore KEPT VERBATIM unless a rule below names it — the safe default for a
 * sanitizer is "pass through", but the safe default for a LEAK is "strip", so the
 * strip rules are keyed on part KIND (mechanical, total) rather than on pattern
 * matching over the whole document (best-effort, silently incomplete).
 *
 * WHAT IS NOT STRIPPED HERE, BECAUSE IT WAS NEVER IN THE CONTENT
 * --------------------------------------------------------------
 * P-006 names "audit citations" among the live state to strip. They are not in the
 * plan markdown at all — `plans:audit` writes them to `harness_shared.plan_audits`
 * (migration 832), a separate table keyed by plan+item. Exporting `content` therefore
 * carries none of them, and a "strip the citations" pass over the markdown would be
 * dead code that reads as a guarantee. Same for claims/assignees: a claim is a
 * work_items row, not a line in the plan. What the markdown DOES carry — and what
 * this file removes — is item statuses, `— note:` suffixes injected by
 * `plans:set-status` (which routinely name work-items, agents and file paths), the
 * `## Now` run-state block, and the identity frontmatter.
 *
 * Pure and I/O-free: the caller supplies the markdown and receives markdown back.
 */
import {
  parsePlan,
  splitPlanIntoParts,
  joinPartsIntoPlan,
  NOTE_SUFFIX_RE,
  type PlanPart,
} from '@papercusp/plan-parser';
import type { RubricRequirement } from './types';

/**
 * The item line's status token, in the exact shape `parseItemLine` consumes:
 * `- **P-NNN** \`status\` text`. Anchored to the FIRST line of an `item:` part —
 * which `splitPlanIntoParts` has already proved is an item line — so this never has
 * to decide *whether* a line is an item, only where its status token sits.
 */
const ITEM_STATUS_RE = /^(\s*[-*]\s+\*\*\s*P-\d{3,}\s*\*\*\s+`)([a-z-]+)(`)/;

/**
 * Workspace-local identifiers that must not travel: work-item / issue / feature ids.
 * These appear inside item text (`— note: converted → WI-40349`) and occasionally in
 * prose. They are meaningless in another workspace and are the main identity leak.
 */
const WORK_ITEM_REF_RE = /\b(?:WI|EI|F)-\d{3,}\b/g;

/** The `## Now` section's part key, as `splitPlanIntoParts` slugs it. */
const NOW_SECTION_KEY = 'section:now';

/** Frontmatter keys a template KEEPS. Everything else is run identity (created,
 *  updated, owner, supersedes, superseded_by) or workspace grouping (initiative)
 *  and is dropped. `template` is kept because it names a code-registry schema the
 *  installing workspace has too (e.g. 'rubric'), not a local id. */
const KEPT_FRONTMATTER_KEYS = new Set(['title', 'slug', 'status', 'template']);

/** A plan-class acceptance rubric — the ratified, first-party set every plan grades
 *  against (`plan-class-feature-ship`, `-bugfix`, `-migration`, `-investigation`).
 *  These are BUNDLED, so a derived requirement on one normally resolves as already
 *  provided; it is declared anyway because "already satisfied" is the resolver's
 *  answer to give, not the publisher's to assume. */
const PLAN_CLASS_RE = /\bplan-class-[a-z0-9][a-z0-9-]*\b/g;

/** An explicit `rubricRef: '<ref>'` / `rubricRef:"<ref>"` mention in the plan body —
 *  the shape the acceptance-rubric ritual is written in throughout this codebase. */
const RUBRIC_REF_RE = /\brubricRef\s*:\s*['"`]([A-Za-z0-9._/-]{1,200})['"`]/g;

/** Mirrors the worker's REQUIRES_RUBRICS_MAX_ENTRIES (listings.ts) — a declaration
 *  that would 400 at publish is worse derived than not derived. */
const MAX_REQUIRED_RUBRICS = 200;

export interface SanitizePlanOptions {
  /**
   * The slug the exported template declares. Defaults to the source plan's own slug.
   * Supply one when the source slug is date-stamped (`…-2026-08-21`) and the template
   * should not be.
   */
  templateSlug?: string;
  /** Override the exported title (else the plan's frontmatter title, else the slug). */
  title?: string;
  /** Override the derived description (else the first prose paragraph after the H1). */
  description?: string;
  /**
   * Rubric requirements to declare INSTEAD of the derived set. An empty array means
   * "declare none" — distinct from omitting the option, which means "derive".
   */
  requiresRubrics?: RubricRequirement[];
}

export interface PlanTemplateExport {
  /** The sanitized markdown — what gets written as `plan.md` in the published dir. */
  markdown: string;
  /** The slug the sanitized frontmatter declares. */
  templateSlug: string;
  title: string;
  /** One-line storefront description. */
  description: string;
  itemCount: number;
  decisionCount: number;
  /** The rubric dependency declaration (worker migration 015 `requires_rubrics`). */
  requiresRubrics: RubricRequirement[];
  /**
   * What the sanitizer actually removed. Reported rather than assumed so a publisher
   * can SEE that the run log was stripped — a sanitizer whose output nobody inspects
   * is a sanitizer nobody notices has stopped working.
   */
  stripped: {
    /** Items whose status was not already `todo`. */
    itemStatuses: number;
    /** `— note: …` suffixes removed from item lines. */
    notes: number;
    /** WI-/EI-/F- identifier occurrences removed. */
    workItemRefs: number;
    /** Whether a `## Now` block was present and dropped. */
    nowBlock: boolean;
    /** Frontmatter keys dropped (created/updated/owner/…). */
    frontmatterKeys: string[];
  };
}

export type SanitizePlanResult = PlanTemplateExport | { error: string; status: number };

/** Count of matches, without the caller having to care about regex lastIndex state. */
function countMatches(text: string, re: RegExp): number {
  const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
  return m ? m.length : 0;
}

/** Strip every workspace-local work-item id, collapsing the whitespace it leaves. */
function stripWorkItemRefs(text: string): string {
  return text
    .replace(WORK_ITEM_REF_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:)])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+$/gm, '');
}

/**
 * Rewrite ONE `item:` part: status → `todo`, note suffix removed, work-item ids
 * stripped. Only the part's FIRST line carries the status token; continuation lines
 * (hanging indent) are still scrubbed for ids, since a note can wrap.
 */
function sanitizeItemPart(part: PlanPart): {
  text: string;
  statusChanged: boolean;
  noteRemoved: boolean;
  refsRemoved: number;
} {
  const lines = part.text.split('\n');
  const first = lines[0] ?? '';

  // Counted on the ORIGINAL text, before the note suffix is cut. Most work-item ids
  // live INSIDE that note, so counting afterwards reports 0 removed on the very
  // items where the most identity was removed — a strip that happened and did not
  // show up in its own report is worse than no report.
  const refsRemoved = countMatches(part.text, WORK_ITEM_REF_RE);

  let statusChanged = false;
  let head = first.replace(ITEM_STATUS_RE, (_all, pre: string, status: string, post: string) => {
    if (status !== 'todo') statusChanged = true;
    return `${pre}todo${post}`;
  });

  // The note suffix runs to end of line by construction (NOTE_SUFFIX_RE), so this
  // also removes anything set-status appended after it.
  const noteRemoved = NOTE_SUFFIX_RE.test(head);
  head = head.replace(NOTE_SUFFIX_RE, '');

  const scrubbed = [head, ...lines.slice(1)].map(stripWorkItemRefs);

  return {
    text: scrubbed.join('\n').replace(/\s+$/, ''),
    statusChanged,
    noteRemoved,
    refsRemoved,
  };
}

/** Rebuild the frontmatter block, keeping only the template-safe keys and forcing
 *  `status: draft` (an installed template is never live work). Returns the rendered
 *  block plus the keys it dropped. */
function sanitizeFrontmatter(
  raw: Record<string, string | string[]>,
  templateSlug: string,
  title: string,
): { text: string; droppedKeys: string[] } {
  const dropped: string[] = [];
  const kept: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!KEPT_FRONTMATTER_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    if (key === 'slug' || key === 'status' || key === 'title') continue; // emitted explicitly
    kept.push([key, Array.isArray(value) ? `[${value.join(', ')}]` : value]);
  }
  const lines = ['---', `title: ${title}`, `slug: ${templateSlug}`, 'status: draft'];
  for (const [k, v] of kept) lines.push(`${k}: ${v}`);
  lines.push('---');
  return { text: lines.join('\n'), droppedKeys: dropped.sort() };
}

/**
 * Derive the rubric requirements a plan declares.
 *
 * Two sources, both textual because that is where they actually live: the
 * `plan-class-*` acceptance CLASS the plan's ritual names, and any explicit
 * `rubricRef: '<ref>'` the body mentions. A ref containing the SOURCE plan's slug is
 * excluded — that is the plan's own per-plan acceptance rubric, authored against
 * as-built reality after implementation, and it is meaningless to an installer who
 * has not built anything yet.
 */
/**
 * Does `rubricRef` name THIS plan — i.e. is it the plan's own per-plan acceptance
 * rubric rather than a shareable one?
 *
 * Boundary-aware on purpose. A bare `rubricRef.includes(slug)` looks right and is
 * wrong in a way that fails silently and asymmetrically: a short slug is a substring
 * of unrelated refs (slug `x` "matches" `plan-class-bugfix`), so the plan's real
 * dependencies vanish from the declaration and the install gate has nothing to check.
 * The convention this is actually detecting is a ref that embeds the slug as a
 * hyphen/slash-delimited component (`acceptance-<slug>`, `<slug>-acceptance`).
 */
function refNamesPlan(rubricRef: string, slug: string): boolean {
  if (!slug) return false;
  if (rubricRef === slug) return true;
  const boundary = '[-_/.]';
  return new RegExp(`(^|${boundary})${escapeRegex(slug)}($|${boundary})`).test(rubricRef);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deriveRequiredRubrics(content: string, sourceSlug: string): RubricRequirement[] {
  const refs = new Set<string>();

  for (const m of content.matchAll(PLAN_CLASS_RE)) refs.add(m[0]);
  for (const m of content.matchAll(RUBRIC_REF_RE)) {
    const ref = (m[1] ?? '').trim();
    if (ref) refs.add(ref);
  }

  const slug = sourceSlug.trim();
  const out: RubricRequirement[] = [];
  for (const rubricRef of [...refs].sort()) {
    if (refNamesPlan(rubricRef, slug)) continue; // this plan's own acceptance rubric
    if (rubricRef.startsWith('<') || rubricRef.includes('$')) continue; // a placeholder, not a ref
    out.push({ rubricRef });
    if (out.length >= MAX_REQUIRED_RUBRICS) break;
  }
  return out;
}

/** First non-empty prose paragraph of the preamble (after the `# H1`), flattened to
 *  one line — the storefront card's description when the publisher supplies none. */
function deriveDescription(preamble: string | undefined): string {
  if (!preamble) return '';
  const lines = preamble.split('\n');
  const buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#')) continue;
    if (!t) {
      if (buf.length > 0) break;
      continue;
    }
    buf.push(t);
  }
  return stripWorkItemRefs(buf.join(' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Sanitize a live plan's markdown into a shareable template.
 *
 * Returns a structured error (never throws) for a plan the parser cannot read as a
 * plan — a legacy/frontmatter-less document has no reliable item structure, so
 * exporting it would ship a document whose statuses were never reset.
 */
export function sanitizePlanForTemplate(
  content: string,
  opts: SanitizePlanOptions = {},
): SanitizePlanResult {
  const source = typeof content === 'string' ? content : '';
  if (source.trim() === '') return { error: 'plan content is empty', status: 422 };

  const parsed = parsePlan(source);
  if (parsed.isLegacy) {
    return {
      error: `plan is not parseable as a structured plan (${parsed.legacyReason ?? 'legacy'}) — item statuses could not be reset, so it cannot be exported safely`,
      status: 422,
    };
  }

  const sourceSlug = parsed.frontmatter.slug ?? '';
  const templateSlug = (opts.templateSlug ?? sourceSlug).trim();
  if (!templateSlug) return { error: 'templateSlug required (the plan declares no slug)', status: 400 };

  const parts = splitPlanIntoParts(source);
  const out: PlanPart[] = [];
  let itemStatuses = 0;
  let notes = 0;
  let workItemRefs = 0;
  let nowBlock = false;
  let droppedKeys: string[] = [];

  const title = (opts.title ?? parsed.frontmatter.title ?? templateSlug).trim();

  for (const part of parts) {
    // The `## Now` block is pure run state (**State:** / **Next:**) — the single
    // most misleading thing to ship, because it reads as instructions.
    if (part.kind === 'section' && part.key === NOW_SECTION_KEY) {
      nowBlock = true;
      continue;
    }
    if (part.kind === 'frontmatter') {
      const fm = sanitizeFrontmatter(parsed.frontmatter.raw, templateSlug, title);
      droppedKeys = fm.droppedKeys;
      out.push({ ...part, text: fm.text });
      continue;
    }
    if (part.kind === 'item') {
      const r = sanitizeItemPart(part);
      if (r.statusChanged) itemStatuses += 1;
      if (r.noteRemoved) notes += 1;
      workItemRefs += r.refsRemoved;
      out.push({ ...part, text: r.text });
      continue;
    }
    // Prose, preamble and decisions travel verbatim apart from the id scrub — they
    // are the transferable half and the reason a re-render was rejected (D-004).
    const before = countMatches(part.text, WORK_ITEM_REF_RE);
    workItemRefs += before;
    out.push({ ...part, text: before > 0 ? stripWorkItemRefs(part.text) : part.text });
  }

  const markdown = `${joinPartsIntoPlan(out).replace(/\s+$/, '')}\n`;
  const preamble = out.find((p) => p.kind === 'preamble')?.text;

  return {
    markdown,
    templateSlug,
    title,
    description: (opts.description ?? deriveDescription(preamble)).trim(),
    itemCount: parsed.items.length,
    decisionCount: parsed.decisions.length,
    requiresRubrics: opts.requiresRubrics ?? deriveRequiredRubrics(source, sourceSlug),
    stripped: { itemStatuses, notes, workItemRefs, nowBlock, frontmatterKeys: droppedKeys },
  };
}
