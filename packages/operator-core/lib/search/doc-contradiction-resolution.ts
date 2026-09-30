/**
 * P-005: the autonomous-resolution three-way seam over the contradiction leg.
 *
 * Plan: guidance-overlap-contradiction-scan-2026-08-08 (P-005).
 *
 * The contradiction leg (P-004) ends at a report. This module is what ACTS on
 * it — with no review step and no advisory report, per the item's spec. Its
 * whole output is work items: an authored-vs-authored contradiction auto-files
 * a DEDUPED work item that another agent claims through the ordinary backlog;
 * everything else is a counted disposition, never a filing.
 *
 * ## The three-way seam
 *
 * Every contradiction is routed on the AUTHORSHIP of its two sources:
 *
 *   - `authored-authored`  -> file a work item (the only leg that acts today);
 *   - `authored-learned`   -> INERT: counted, never filed. Workstream B's
 *   - `learned-learned`    -> learned layer does not exist yet, and C must not
 *                             block on B — so the legs exist, route, and count,
 *                             but their action is deliberately not built until
 *                             there is a learned source to act on.
 *
 * A source key the authorship resolver does not recognise is `unknown` and is
 * NEVER filed: auto-filing from an unclassified population is exactly the
 * "treating a bucket as a population" D-011 forbids. The unknown count is in
 * the census, so a new source key silently entering the corpus is visible as a
 * number, not as surprise work items.
 *
 * ## The operative precondition (D-001 / D-011)
 *
 * A report whose `inconclusive` is non-null files NOTHING. The contradiction
 * leg has five inconclusive states (flag off, no credential, zero eligible,
 * all-errors, no candidates) and every one of them yields an empty-or-partial
 * verdict list for a reason that is not "the corpus is clean" — so the whole
 * resolution run refuses, names the reason, and counts zero dispositions. The
 * refusal is a field on the result, not an exception: to a scheduled sweep
 * (P-006) an inconclusive scan is a normal, reportable outcome.
 *
 * ## Dedupe
 *
 * The dedupe key is the ORDER-INDEPENDENT pair of section ids. A non-terminal
 * work item already carrying that key suppresses re-filing (disposition
 * `duplicate`); a TERMINAL one does not — if a later conclusive scan still
 * finds the same contradiction after the fix landed, that is a fresh finding
 * and it files again. Filing-time admission is left at the default (admitted):
 * the population is bounded by construction — only judged, conclusive
 * contradictions reach this module, and the dedupe key caps each pair at one
 * open item.
 *
 * ## Why the fix shape is keyed on (kind, confident), not kind alone
 *
 * D-004: a `rehomed-copy` wants "make one canonical and point the others at
 * it"; the other kinds want the opposed clause reworded. D-011: the kind
 * classifier's `rehomed-copy` recall is incomplete and `confident` marks which
 * verdicts rest on a positive identification — so only a CONFIDENT
 * `rehomed-copy` earns the canonicalisation prescription; a residual verdict
 * gets the contradiction-shaped fix plus an honest note that the kind is a
 * residual assignment.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { DocSectionRef } from './doc-section-overlap';
import { DOC_OVERLAP_SOURCES } from './doc-section-overlap';
import type { KindedFinding } from './doc-contradiction-scan';
import type { ContradictionFinding, ContradictionReport } from './doc-contradiction-judge';
import type { OverlapPairKind, PairKindBasis } from './doc-section-pair-kind';

/** Who wrote a corpus source: a human/agent author, or workstream B's learned layer. */
export type SourceAuthorship = 'authored' | 'learned';

/**
 * Resolve a source key's authorship. `null` means UNKNOWN — the caller counts
 * it and refuses to file, it never defaults into either leg.
 */
export type AuthorshipResolver = (sourceKey: string) => SourceAuthorship | null;

/** The three-way seam, plus the fail-safe bucket for unrecognised sources. */
export type SeamLeg = 'authored-authored' | 'authored-learned' | 'learned-learned';

/** What happened to one contradiction finding. Exactly one per finding. */
export type ResolutionDispositionKind =
  | 'filed'
  | 'duplicate'
  | 'inert-learned-leg'
  | 'unknown-authorship'
  | 'file-error';

export interface ResolutionDisposition {
  /** Encoded section ids of the pair, as reported by the contradiction leg. */
  a: string;
  b: string;
  disposition: ResolutionDispositionKind;
  /** The seam leg, when authorship resolved for both sides; null when unknown. */
  seam: SeamLeg | null;
  /** The filed (or pre-existing duplicate) work-item id, when there is one. */
  workItemId: string | null;
  /** One sentence saying why, for the dispositions that need one. */
  note: string | null;
}

/**
 * D-010 discipline: every number here partitions `contradictionsIn` — the
 * buckets sum to the population, so a zero is visible against its denominator.
 */
export interface ResolutionCensus {
  /** Contradictions handed in by the report. The population. */
  contradictionsIn: number;
  filed: number;
  duplicates: number;
  inertLearnedLeg: number;
  unknownAuthorship: number;
  fileErrors: number;
}

export interface ResolutionReport {
  dispositions: ResolutionDisposition[];
  census: ResolutionCensus;
  /**
   * Non-null when the run REFUSED — the input report was inconclusive, so
   * nothing was filed and nothing was counted. Carries the upstream reason.
   */
  refused: string | null;
}

/** The spec handed to the filer for one authored-vs-authored contradiction. */
export interface ContradictionWorkItemSpec {
  title: string;
  body: string;
  /** Order-independent pair key; the filer persists it for later dedupe reads. */
  dedupeKey: string;
  /** Structured provenance the filer should persist alongside the dedupe key. */
  finding: {
    a: string;
    b: string;
    similarity: number;
    reason: string;
    kind: OverlapPairKind;
    basis: PairKindBasis | null;
    confident: boolean;
  };
}

/**
 * The filing seam, injected like the judge is: the core stays pure and the
 * contract testable. `findExisting` answers over NON-TERMINAL items only.
 */
export interface ContradictionWorkItemFiler {
  findExisting(dedupeKey: string): Promise<{ id: string } | null>;
  file(spec: ContradictionWorkItemSpec): Promise<{ id: string }>;
}

/**
 * The order-independent dedupe key for a pair. Section ids are already stable
 * (`sourceKey::slug::anchor`), so sorting the two makes (a,b) and (b,a) one key.
 */
export function contradictionDedupeKey(a: string, b: string): string {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `doc-contradiction::${lo}::${hi}`;
}

/**
 * Default authorship resolver: the corpus roots D-002 pinned are authored;
 * anything else is unknown. Workstream B extends this when its learned layer
 * registers real source keys — until then nothing classifies as `learned`,
 * which is correct: the inert legs guard a future population, not a current one.
 */
export function authorshipOfDocSource(sourceKey: string): SourceAuthorship | null {
  return (DOC_OVERLAP_SOURCES as readonly string[]).includes(sourceKey) ? 'authored' : null;
}

function seamOf(a: SourceAuthorship, b: SourceAuthorship): SeamLeg {
  if (a === 'authored' && b === 'authored') return 'authored-authored';
  if (a === 'learned' && b === 'learned') return 'learned-learned';
  return 'authored-learned';
}

function refLabel(ref: DocSectionRef): string {
  return `${ref.sourceKey}/${ref.slug}${ref.anchor ? `#${ref.anchor}` : ''}`;
}

/** The kind-shaped fix prescription — see the module doc for why `confident` gates it. */
export function fixShapeFor(kind: OverlapPairKind, confident: boolean): string {
  if (kind === 'rehomed-copy' && confident) {
    return (
      'Fix shape (rehomed copy, positively identified): make ONE home canonical and point ' +
      'the other at it, so nothing keeps two copies aligned by hand.'
    );
  }
  const residual = confident
    ? ''
    : ' The kind is a residual assignment (no positive identification), so it may be a re-titled copy — check before rewording.';
  return (
    'Fix shape: the two passages instruct opposite actions — align them by rewording the ' +
    'opposed clause (or deleting the wrong one), then re-verify the pair reads consistently.' +
    residual
  );
}

function buildSpec(
  finding: ContradictionFinding,
  kinded: KindedFinding | undefined,
  refs: { refA: DocSectionRef; refB: DocSectionRef },
): ContradictionWorkItemSpec {
  const kind = kinded?.kind ?? finding.kind;
  const basis = kinded?.basis ?? null;
  const confident = kinded?.confident ?? false;
  const labelA = refLabel(refs.refA);
  const labelB = refLabel(refs.refB);
  const body = [
    `The guidance contradiction scan (plan guidance-overlap-contradiction-scan-2026-08-08, P-005) ` +
      `judged these two passages as instructing OPPOSITE actions in the same situation:`,
    '',
    `- A: ${labelA}`,
    `- B: ${labelB}`,
    `- similarity: ${finding.similarity.toFixed(4)}`,
    `- judge's reason: ${finding.reason || '(none given)'}`,
    `- pair kind: ${kind} (basis: ${basis ?? 'unknown'}, confident: ${confident})`,
    '',
    fixShapeFor(kind, confident),
  ].join('\n');
  return {
    title: `Guidance contradiction: ${labelA} vs ${labelB}`,
    body,
    dedupeKey: contradictionDedupeKey(finding.a, finding.b),
    finding: {
      a: finding.a,
      b: finding.b,
      similarity: finding.similarity,
      reason: finding.reason,
      kind,
      basis,
      confident,
    },
  };
}

export interface ResolveContradictionsOptions {
  /** The kinded findings the leg attributed — the source of `confident`/refs. */
  kinded: readonly KindedFinding[];
  /** The contradiction leg's report. `inconclusive !== null` refuses the run. */
  report: ContradictionReport;
  filer: ContradictionWorkItemFiler;
  /** Defaults to {@link authorshipOfDocSource}. */
  authorshipOf?: AuthorshipResolver;
}

function emptyCensus(contradictionsIn: number): ResolutionCensus {
  return {
    contradictionsIn,
    filed: 0,
    duplicates: 0,
    inertLearnedLeg: 0,
    unknownAuthorship: 0,
    fileErrors: 0,
  };
}

/**
 * Route every contradiction in a CONCLUSIVE report through the seam, filing a
 * deduped work item for each authored-vs-authored pair.
 *
 * Sequential on purpose: filings are rare by construction and a serial loop
 * makes the dedupe read-then-file window as small as it can be without a
 * transactional filer.
 */
export async function resolveContradictions(
  opts: ResolveContradictionsOptions,
): Promise<ResolutionReport> {
  const authorshipOf = opts.authorshipOf ?? authorshipOfDocSource;
  const contradictions = opts.report.contradictions;

  if (opts.report.inconclusive !== null) {
    return {
      dispositions: [],
      census: emptyCensus(contradictions.length),
      refused:
        `the contradiction report is INCONCLUSIVE (${opts.report.inconclusive}) — ` +
        `nothing was filed: an inconclusive report is not evidence about the corpus (D-001/D-011)`,
    };
  }

  const kindedByPair = new Map<string, KindedFinding>();
  for (const k of opts.kinded) {
    kindedByPair.set(contradictionDedupeKey(k.a, k.b), k);
  }

  const census = emptyCensus(contradictions.length);
  const dispositions: ResolutionDisposition[] = [];

  for (const finding of contradictions) {
    const pairKey = contradictionDedupeKey(finding.a, finding.b);
    const kinded = kindedByPair.get(pairKey);
    // The contradiction leg derives its candidates FROM the kinded findings, so
    // a miss here means the caller passed mismatched inputs; the refs are then
    // unavailable and authorship cannot be resolved — count it, do not guess.
    if (!kinded) {
      census.unknownAuthorship += 1;
      dispositions.push({
        a: finding.a,
        b: finding.b,
        disposition: 'unknown-authorship',
        seam: null,
        workItemId: null,
        note: 'pair missing from the kinded findings — refs unavailable, authorship unresolvable',
      });
      continue;
    }

    const authorshipA = authorshipOf(kinded.refA.sourceKey);
    const authorshipB = authorshipOf(kinded.refB.sourceKey);
    if (authorshipA === null || authorshipB === null) {
      census.unknownAuthorship += 1;
      const unknownKey = authorshipA === null ? kinded.refA.sourceKey : kinded.refB.sourceKey;
      dispositions.push({
        a: finding.a,
        b: finding.b,
        disposition: 'unknown-authorship',
        seam: null,
        workItemId: null,
        note: `source key '${unknownKey}' has no registered authorship — not filed`,
      });
      continue;
    }

    const seam = seamOf(authorshipA, authorshipB);
    if (seam !== 'authored-authored') {
      census.inertLearnedLeg += 1;
      dispositions.push({
        a: finding.a,
        b: finding.b,
        disposition: 'inert-learned-leg',
        seam,
        workItemId: null,
        note: `the ${seam} leg ships INERT until workstream B's learned layer exists — counted, not filed`,
      });
      continue;
    }

    const spec = buildSpec(finding, kinded, { refA: kinded.refA, refB: kinded.refB });
    try {
      const existing = await opts.filer.findExisting(spec.dedupeKey);
      if (existing) {
        census.duplicates += 1;
        dispositions.push({
          a: finding.a,
          b: finding.b,
          disposition: 'duplicate',
          seam,
          workItemId: existing.id,
          note: `a non-terminal work item already tracks this pair`,
        });
        continue;
      }
      const filed = await opts.filer.file(spec);
      census.filed += 1;
      dispositions.push({
        a: finding.a,
        b: finding.b,
        disposition: 'filed',
        seam,
        workItemId: filed.id,
        note: null,
      });
    } catch (err) {
      census.fileErrors += 1;
      dispositions.push({
        a: finding.a,
        b: finding.b,
        disposition: 'file-error',
        seam,
        workItemId: null,
        note: `filing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { dispositions, census, refused: null };
}

/**
 * Render the report so it cannot be quoted without its denominator (D-001's
 * describe discipline, inherited).
 */
export function describeResolutionReport(report: ResolutionReport): string {
  const c = report.census;
  if (report.refused) {
    return (
      `resolution seam: REFUSED — ${report.refused}. ` +
      `${c.contradictionsIn} contradiction(s) were present and none was filed.`
    );
  }
  return (
    `resolution seam: ${c.filed} work item(s) filed from ${c.contradictionsIn} contradiction(s) ` +
    `(${c.duplicates} already tracked, ${c.inertLearnedLeg} on inert learned legs, ` +
    `${c.unknownAuthorship} unknown authorship, ${c.fileErrors} filing error(s)). ` +
    `Buckets partition the population: a zero here is a measured zero.`
  );
}

/**
 * The live filer: files through `createIssue` (the canonical issue-family
 * writer — audit rows, topics, fan-out) and dedupes over the base
 * `harness_shared.work_items` table by the payload's dedupe key.
 *
 * Kind `change` (a guidance edit, not broken code), severity `minor`, scoped to
 * the harness whose corpus this is. The payload carries the structured finding
 * so the claiming agent inherits the evidence, not just prose.
 */
export function createIssueContradictionFiler(opts?: {
  harness?: string;
  createdBy?: string;
}): ContradictionWorkItemFiler {
  const harness = opts?.harness ?? 'papercusp';
  const createdBy = opts?.createdBy ?? 'doc-contradiction-resolution';
  return {
    async findExisting(dedupeKey: string): Promise<{ id: string } | null> {
      const { TERMINAL_WORK_ITEM_STATES } = await import('../work-items');
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ feature_id: string }>>`
        SELECT feature_id
          FROM harness_shared.work_items
         WHERE harness_slug = ${harness}
           AND payload->>'dedupeKey' = ${dedupeKey}
           AND NOT (status = ANY(${TERMINAL_WORK_ITEM_STATES as string[]}::text[]))
         LIMIT 1`;
      return rows.length > 0 ? { id: rows[0].feature_id } : null;
    },
    async file(spec: ContradictionWorkItemSpec): Promise<{ id: string }> {
      const { createIssue } = await import('../issues-engineer');
      const issue = await createIssue({
        title: spec.title,
        body: spec.body,
        kind: 'change',
        severity: 'minor',
        scope: `harness:${harness}`,
        createdBy,
        // The population is bounded by judged, conclusive contradictions plus the
        // open-item dedupe above, so this is the deliberate admission bypass the
        // module contract already promises — now explicit at the INSERT boundary.
        admission: 'auto',
        admittedBy: 'bypass:bounded-doc-contradiction-dedupe',
        payload: {
          dedupeKey: spec.dedupeKey,
          contradiction: spec.finding,
          plan: 'guidance-overlap-contradiction-scan-2026-08-08#P-005',
        },
      });
      return { id: issue.id };
    },
  };
}
