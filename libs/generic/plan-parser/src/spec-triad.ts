/**
 * The SPEC TRIAD — requirements / design / tasks, detected inside a plan.
 *
 * Kiro's convention is three files per feature (`requirements.md`, `design.md`,
 * `tasks.md`). We do NOT add a second directory convention competing with
 * plans: the same discipline is expressed as STRUCTURE INSIDE a plan —
 *
 *   - `## Requirements` — a non-empty section
 *   - `## Design`       — a non-empty section
 *   - tasks             — the plan's own `P-NNN` items
 *
 * This module is the pure DETECTOR only. It answers "does this plan carry the
 * triad?" and nothing else — it has no opinion on which plans the triad is
 * REQUIRED of, and no side effects. The policy (which plans are in scope, what
 * happens when one is not) lives in operator-core, deliberately, because it is
 * domain-shaped and this package is generic-first.
 *
 * ## Why the "non-empty" test is stricter than `section exists`
 *
 * A heading with nothing under it is the fake-compliance shape: it satisfies a
 * naive `content.includes('## Requirements')` while carrying no requirements at
 * all, and a gate that can be passed by typing a heading is not a gate. So a leg
 * counts as PRESENT only when its section body carries at least
 * {@link SPEC_TRIAD_MIN_BODY_CHARS} characters of real content and is not one of
 * the {@link SPEC_TRIAD_PLACEHOLDERS}. Both bounds are exported so a caller (and
 * the tests) pin the exact threshold rather than rediscovering it.
 *
 * Heading matching is PREFIX-based on the heading text, not equality on a
 * slug: `## Requirements`, `## Requirements (v2)` and `## Design Decisions` all
 * count. That is deliberate — a plan that wrote the section under a slightly
 * different title has done the work, and failing it on the title would make the
 * detector an authoring-style gate instead of a content one.
 */

import { splitPlanIntoParts, type PlanPart } from './parts';

export type SpecTriadLegName = 'requirements' | 'design' | 'tasks';

export const SPEC_TRIAD_LEGS: readonly SpecTriadLegName[] = ['requirements', 'design', 'tasks'];

/**
 * Minimum characters of real body content for a `## Requirements` / `## Design`
 * section to count as written. One short sentence clears it; a heading, a
 * bullet with three words, or `TBD` does not.
 */
export const SPEC_TRIAD_MIN_BODY_CHARS = 40;

/**
 * Bodies that are literally a promise to write the section later. Compared
 * against the body normalized to lowercase alphanumerics — so `TBD`, `_TBD_`,
 * `- TODO -` and `T.B.D.` all collapse to the same token.
 */
export const SPEC_TRIAD_PLACEHOLDERS: readonly string[] = [
  'tbd',
  'tba',
  'tbc',
  'todo',
  'na',
  'none',
  'nothingyet',
  'comingsoon',
  'fillmein',
  'writeme',
  'placeholder',
];

const H2 = /^##\s+(.+?)\s*$/;
const REQUIREMENTS_HEADING = /^requirements?\b/i;
const DESIGN_HEADING = /^design\b/i;

export interface SpecTriadLeg {
  name: SpecTriadLegName;
  present: boolean;
  /** Why this leg does NOT count. `null` when it is present. */
  why: string | null;
}

export interface SpecTriadVerdict {
  /** Every leg present. */
  complete: boolean;
  /** The legs that are NOT present, in {@link SPEC_TRIAD_LEGS} order. */
  missing: SpecTriadLegName[];
  legs: SpecTriadLeg[];
}

/** The heading text of a `## ` section part, or null if the part is not one. */
function sectionHeading(part: PlanPart): string | null {
  if (part.kind !== 'section') return null;
  const first = part.text.split('\n', 1)[0] ?? '';
  return H2.exec(first)?.[1] ?? null;
}

/**
 * The section's body: its source minus the heading line, minus any nested
 * heading lines (a section that contains only sub-headings carries no content).
 */
function sectionBody(part: PlanPart): string {
  const lines = part.text.split('\n').slice(1);
  return lines
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join('\n')
    .trim();
}

function normalizeForPlaceholder(body: string): string {
  return body.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface SectionVerdict {
  present: boolean;
  why: string | null;
}

function judgeSection(parts: PlanPart[], match: RegExp, label: string): SectionVerdict {
  const candidates = parts.filter((p) => {
    const h = sectionHeading(p);
    return h !== null && match.test(h.trim());
  });

  if (candidates.length === 0) {
    return { present: false, why: `no \`## ${label}\` section` };
  }

  let bestWhy = `\`## ${label}\` section is empty`;
  for (const part of candidates) {
    const body = sectionBody(part);
    if (body.length === 0) continue;

    const normalized = normalizeForPlaceholder(body);
    if (normalized.length === 0) {
      bestWhy = `\`## ${label}\` section has no textual content`;
      continue;
    }
    if (SPEC_TRIAD_PLACEHOLDERS.includes(normalized)) {
      bestWhy = `\`## ${label}\` section is a placeholder (${JSON.stringify(body.slice(0, 40))})`;
      continue;
    }
    if (body.length < SPEC_TRIAD_MIN_BODY_CHARS) {
      bestWhy =
        `\`## ${label}\` section has ${body.length} chars of body, ` +
        `below the ${SPEC_TRIAD_MIN_BODY_CHARS}-char floor`;
      continue;
    }
    return { present: true, why: null };
  }

  return { present: false, why: bestWhy };
}

export interface EvaluateSpecTriadOptions {
  /**
   * Task count, when the caller already knows it (e.g. from the PG-canonical
   * structured item index, so a plan that carries one is not re-parsed). Omit
   * and the `P-NNN` items are counted from `content`.
   */
  itemCount?: number;
}

/**
 * Evaluate the spec triad over a plan's markdown. Pure — no I/O, no policy.
 */
export function evaluateSpecTriad(
  content: string,
  opts: EvaluateSpecTriadOptions = {},
): SpecTriadVerdict {
  const parts = splitPlanIntoParts(content);

  const requirements = judgeSection(parts, REQUIREMENTS_HEADING, 'Requirements');
  const design = judgeSection(parts, DESIGN_HEADING, 'Design');

  const itemCount = opts.itemCount ?? parts.filter((p) => p.kind === 'item').length;
  const tasks: SectionVerdict =
    itemCount > 0
      ? { present: true, why: null }
      : { present: false, why: 'the plan has no `P-NNN` items' };

  const legs: SpecTriadLeg[] = [
    { name: 'requirements', ...requirements },
    { name: 'design', ...design },
    { name: 'tasks', ...tasks },
  ];

  const missing = legs.filter((l) => !l.present).map((l) => l.name);
  return { complete: missing.length === 0, missing, legs };
}

/** One-line human summary of what a plan still owes the triad. */
export function describeSpecTriadGap(verdict: SpecTriadVerdict): string {
  if (verdict.complete) return 'spec triad complete (requirements + design + tasks)';
  return verdict.legs
    .filter((l) => !l.present)
    .map((l) => l.why ?? `${l.name} missing`)
    .join('; ');
}
