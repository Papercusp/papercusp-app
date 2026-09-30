/**
 * D-004's pair KIND, computed deterministically from metadata alone.
 *
 * Plan: guidance-overlap-contradiction-scan-2026-08-08 (P-004).
 *
 * ## Why kind exists
 *
 * D-004 measured that every pair above the calibrated thresholds is genuine
 * overlap, but that the pairs are not the same KIND of finding:
 *
 *   1. `sibling-surface`  two adjacent tools / role prompts whose corresponding
 *                         sections read alike. EXPECTED — sibling verbs should.
 *                         High volume; this kind dominates the count.
 *   2. `rehomed-copy`     one passage living in several files. The drift hazard
 *                         this workstream exists for: identical today, and
 *                         nothing keeps them so. Lower volume, highest value.
 *   3. `cross-kind`       a tool's guidance overlapping a prose doc or a
 *                         persona. Rarest and most dangerous, because the two
 *                         surfaces are read by different audiences at different
 *                         times, so a contradiction can persist indefinitely
 *                         without anyone ever seeing both.
 *
 * Kind 1 is roughly an order of magnitude more common than kind 3, so a report
 * sorted by SIMILARITY puts the 0.997 sibling-`Chaining` pairs on top and the
 * cross-kind findings hundreds of rows down. Anyone reading the top of that
 * report concludes the corpus's problem is boilerplate in tool guidance — true,
 * uninteresting, and it never reaches the two surfaces that actually disagree.
 * So the report buckets BY KIND, never by similarity.
 *
 * ## Why this lives in the host and not in `libs/generic/overlap-clusters`
 *
 * Generic-first governs domain-FREE algorithms. This classifier is the opposite:
 * every rule in it is a statement about papercusp's own slug namespaces
 * (`tool-guidance/`, `prompts/`, `blueprints/`) and about the `page › section`
 * title convention that `syncDocSourceSections` writes. There is no domain-free
 * core to extract — a generic "classify a pair" seam would be a parameter bag
 * with one implementation, which is a worse surface than a named host function.
 */

import type { DocSectionRef } from './doc-section-overlap';

/** The surface a section lives on, derived from its source key + slug prefix. */
export type SurfaceClass = 'tool-guidance' | 'prompt' | 'blueprint' | 'doc';

/** D-004's three kinds. */
export type OverlapPairKind = 'rehomed-copy' | 'sibling-surface' | 'cross-kind';

/**
 * WHICH signal decided the kind. Reported alongside the kind so a consumer can
 * tell a positively-identified copy from a residual bucket assignment, and so a
 * later change to the rules is auditable against real findings.
 */
export type PairKindBasis = 'identical-title' | 'surface-mismatch' | 'same-surface';

export interface PairKindVerdict {
  kind: OverlapPairKind;
  basis: PairKindBasis;
  surfaceA: SurfaceClass;
  surfaceB: SurfaceClass;
  /**
   * True when this verdict rests on a POSITIVE identification (the two sections
   * carry the identical title) rather than on the absence of a stronger signal.
   *
   * ⚠ Read this before quoting a bucket as a population. `rehomed-copy` is
   * precise but its recall is INCOMPLETE, and the shortfall lands in the other
   * two buckets — see `classifyOverlapPair`'s measured counterexample.
   */
  confident: boolean;
}

/** The title separator `syncDocSourceSections` writes between page and heading. */
const TITLE_SEP = '›'; // ›

/**
 * A section's surface. Order matters only in that the prefixes are disjoint;
 * anything unrecognised is prose (`doc`), which is the correct default — the
 * engineering corpus is entirely prose docs and carries no slug prefix.
 */
export function surfaceClassOf(ref: DocSectionRef): SurfaceClass {
  const slug = ref.slug ?? '';
  if (slug.startsWith('tool-guidance/')) return 'tool-guidance';
  if (slug.startsWith('prompts/')) return 'prompt';
  if (slug.startsWith('blueprints/')) return 'blueprint';
  return 'doc';
}

/** Trim + collapse internal whitespace, so a re-wrap cannot defeat title equality. */
function normaliseTitle(title: string): string {
  return (title ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * The leaf heading — the part after the last `›`. A page preamble (empty anchor)
 * has no separator, so its leaf is the whole page title.
 */
export function leafTitleOf(title: string): string {
  const norm = normaliseTitle(title);
  const idx = norm.lastIndexOf(TITLE_SEP);
  return idx === -1 ? norm : norm.slice(idx + 1).trim();
}

/**
 * Classify one overlapping pair. Ordered rules, first match wins.
 *
 * ## The rules
 *
 * 1. IDENTICAL TITLE -> `rehomed-copy`. Both sections carry the same
 *    `page › heading` string, which in this corpus means the same authored block
 *    living in two homes. Measured: `prompts/operator.persona.engineer-mode`
 *    and `prompts/papercup.persona.engineer-mode` both title
 *    "Audience mode: Engineer > Audience mode: Engineer" at cosine 1.0000.
 * 2. SURFACES DIFFER -> `cross-kind`.
 * 3. OTHERWISE -> `sibling-surface`.
 *
 * ## The measured limit — rule 1 is PRECISE but its recall is INCOMPLETE
 *
 * Title equality catches a copy that kept its title and misses one that was
 * re-titled. Measured 2026-08-08 against the live corpus, on the very pair D-004
 * cites as its flagship kind-2 example:
 *
 *   blueprints/base/prompts/papercup  -> "Papercup (canonical persona re-homed)"
 *   prompts/papercup.persona          -> "Papercup persona - the fast front-end"
 *
 * Both are the papercup persona; the blueprint home was deliberately RE-TITLED
 * to record that it is a re-home, which is exactly the edit that defeats the
 * test for it. That pair therefore falls to rule 2 and reports as `cross-kind`.
 *
 * This is stated rather than papered over because the direction of the error
 * matters: the shortfall moves findings OUT of the highest-actionability bucket
 * and INTO the other two, so `cross-kind` and `sibling-surface` are supersets
 * that contain some re-homed copies, and `rehomed-copy` is a floor on how many
 * exist, never a count of them. `confident` marks which verdicts carry the
 * positive identification. A metadata-only classifier cannot close this gap —
 * the two titles share no token that a rule could key on — so closing it would
 * need content comparison, which is P-005's business and not this function's.
 */
export function classifyOverlapPair(
  a: { ref: DocSectionRef; title: string },
  b: { ref: DocSectionRef; title: string },
): PairKindVerdict {
  const surfaceA = surfaceClassOf(a.ref);
  const surfaceB = surfaceClassOf(b.ref);

  const titleA = normaliseTitle(a.title);
  const titleB = normaliseTitle(b.title);

  // Rule 1. Both titles must be NON-EMPTY: two untitled sections are not
  // evidence of a shared origin, and `title` is NOT NULL DEFAULT '' in
  // doc_sections, so empty-equals-empty is reachable and would otherwise
  // manufacture a confident `rehomed-copy` out of two blanks.
  if (titleA.length > 0 && titleA === titleB) {
    return { kind: 'rehomed-copy', basis: 'identical-title', surfaceA, surfaceB, confident: true };
  }

  if (surfaceA !== surfaceB) {
    return { kind: 'cross-kind', basis: 'surface-mismatch', surfaceA, surfaceB, confident: false };
  }

  return { kind: 'sibling-surface', basis: 'same-surface', surfaceA, surfaceB, confident: false };
}

/** Every kind, in report order: rarest and most actionable FIRST. */
export const PAIR_KINDS_IN_REPORT_ORDER: readonly OverlapPairKind[] = [
  'rehomed-copy',
  'cross-kind',
  'sibling-surface',
] as const;

/**
 * Bucket findings by kind, in report order.
 *
 * Returns EVERY kind, including empty ones. An absent bucket and an empty
 * bucket read identically to a caller that iterates what it is given, and this
 * plan's D-001 rule is that a zero must be visible as a zero against a stated
 * denominator — a `cross-kind: 0` line is a finding; a missing `cross-kind` line
 * is an ambiguity.
 */
export function bucketByKind<T extends { kind: OverlapPairKind }>(
  items: readonly T[],
): Array<{ kind: OverlapPairKind; items: T[]; count: number }> {
  return PAIR_KINDS_IN_REPORT_ORDER.map((kind) => {
    const bucket = items.filter((item) => item.kind === kind);
    return { kind, items: bucket, count: bucket.length };
  });
}
