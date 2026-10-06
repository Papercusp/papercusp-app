/**
 * Transactional Requirements → acceptance BAR seeding.
 *
 * `## Requirements` is the early human projection; after this write the active
 * acceptance-rubric criteria are canonical. The subject plan's existing
 * `### Bar-to-work map for this plan` table supplies the explicit many-to-many
 * R-N → P-NNN relation. No semantic inference and no second requirements store.
 */
import { createHash } from 'node:crypto';
import { parsePlan } from '@papercusp/plan-parser';
import {
  acceptanceRubricCriterionSchema,
  rubricTemplateDataAuthoringSchema,
  requirementSectionsSchema,
  type AcceptanceEvidencePlane,
} from './agent-tools/plans/rubric-template';
import { splitPlanSections } from './agent-tools/plans/plan-sections';
import {
  PLAN_ADVISORY_LOCK_NAMESPACE,
  planAdvisoryLockKey,
} from './agent-tools/plans/plan-lock-key';
import {
  setSpecClause,
  type SpecBehaviorClass,
  type SpecClauseSql,
  type SpecClauseWrite,
} from './agent-tools/plans/spec-clauses-store';
import type { PlanClassRubricRef } from './agent-tools/plans/spec-test-adequacy';
import { ensureExistingWorkItemSpecRevisionEdgesInTransaction } from './agent-tools/plans/spec-evidence-store';
import { hashPlanContent } from './agent-tools/plans/content-hash';
import {
  buildRubricPlanBody,
  computeAcceptanceBarSetHash,
  DEFAULT_RATING_SCALE,
  normalizeAcceptanceBarCriterion,
  type ProposeRubricCriterion,
} from './rubrics';
import { guardAcceptanceBarTemplateDataWrite } from './agent-tools/plans/rubric-loss-guard';
import { synchronizeAcceptanceBarRevision } from './acceptance-bar-amendment';
import { requirementSections } from './requirement-contract';
import {
  ACCEPTANCE_BAR_REQUIREMENT_BLOCK_TEMPLATE,
  acceptanceBarContractGaps,
  isExplicitlyManualCheck,
  type AcceptanceBarContractGap,
} from './acceptance-bar-contract-completeness';

export const ACCEPTANCE_BAR_CONTRACT_EPOCH = 1;
export const MAX_REQUIREMENT_BARS = 200;
export const MAX_BAR_PROJECTION_EDGES = 1_000;

export type AcceptanceBarCohort = 'post-epoch' | 'legacy-backfilled';

export type AcceptanceBarSeedCode =
  | 'bar_requirements_missing'
  | 'bar_requirement_parse_failed'
  | 'bar_key_duplicate'
  | 'bar_set_too_large'
  | 'bar_mapping_missing'
  | 'bar_mapping_duplicate'
  | 'bar_mapping_unknown'
  | 'bar_mapping_requirement_missing'
  | 'bar_mapping_invalid'
  | 'bar_mapping_dropped_only'
  | 'bar_evidence_plane_invalid'
  | 'bar_projection_set_too_large'
  | 'bar_rubric_conflict'
  | 'bar_rubric_busy'
  | 'bar_amendment_required'
  | 'bar_projection_conflict'
  | 'bar_seed_persistence_failed'
  // WI-10004146 / D-093: a federated receiver found no agreeing rubric yet; it wrote
  // nothing and waits for the other row's apply to re-run the receiver seed.
  | 'bar_receiver_rubric_pending'
  // review-system-rework-reduction P-003/P-029: an activation seed refuses a BAR whose
  // contract would force a later barHash-changing amendment (after proof is bound).
  | 'bar_contract_method_missing'
  | 'bar_contract_check_missing'
  | 'bar_contract_test_layers_missing'
  | 'bar_contract_check_layer_mismatch';

export interface AcceptanceBarSeedProblem {
  code: AcceptanceBarSeedCode;
  detail: string;
  barKey?: string;
  planItemId?: string;
  /** A seed refusal that activation can record as a pending repair without
   * mutating the invalid rubric or its projections.
   *
   * `legacy_criteria_unmapped` (EI-23376469015732685): the pinned rubric predates
   * BAR adoption, so none of its criteria carry a `barKey` and every one reads as
   * an "extra" against the Requirements set. That is the ordinary legacy-backfill
   * situation, not a malformed rubric — and making it FATAL deadlocked activation:
   * `ready` needs a recorded audit, the audit refused on this code, and every
   * other door (`rubrics:propose`, `migrate-acceptance-bars`) needs an output of
   * one of those two. Recording it as pending lets the audit persist while the
   * backfill is still owed. The ship floor is unaffected: `set-plan-status ->
   * shipped` independently refuses with `acceptance_bar_contract_not_ready`. */
  repairable?: 'invalid_template_data' | 'legacy_criteria_unmapped';
  rubricSlug?: string;
  /** Every contract-completeness gap of this BAR; `code` names only the first. */
  contractGaps?: AcceptanceBarContractGap[];
}

export interface ParsedRequirementBar {
  barKey: string;
  title: string;
  model: string;
  /** Present only for explicit three-section authoring; legacy prose stays legacy. */
  criterion?: ProposeRubricCriterion;
}

export interface ParsedBarMapping {
  barKey: string;
  planItemIds: string[];
  evidencePlane: AcceptanceEvidencePlane;
  evidencePlaneExplicit?: boolean;
}

export interface AcceptanceBarSeedBuildInput {
  planSlug: string;
  subjectHarnessSlug?: string;
  planContent: string;
  actorId: string;
  declaredAt: string;
  cohort: AcceptanceBarCohort;
  /** The exact plan class selected by spec-quality evaluation. Never infer it from prose. */
  classRef?: PlanClassRubricRef;
  /** Server-owned late-authoring provenance; independent of enforcement cohort. */
  backfilled?: boolean;
  /** Explicit R-N → existing criterion identity adoption, only before a BAR contract exists. */
  legacyCriterionMap?: Record<string, string>;
  adoptionEpoch: number;
  subjectPlanRevision: number;
  /** Locked subject state; only the already-pinned revision may reuse canonical BARs. */
  planStatus?: string | null;
  rubricSlug: string;
  rubricRevision: number;
  existingTemplateData?: unknown;
  /** Set ONLY by a caller that has already proven the subject write is BAR-neutral
   *  (identical acceptanceBarSourceFingerprint on both bodies). Such a caller is
   *  advancing the subjectPlanRevision pin alone, so the canonical BARs must be
   *  preserved verbatim: re-deriving them from the plan body would silently revert
   *  any amendment whose text is richer than the original seed. The caller still
   *  compares the returned barSetHash against the stored one, so preservation can
   *  only ever produce the unchanged set it is meant to (WI-10000058). */
  preserveExistingBars?: boolean;
  /**
   * The activation door's shift-left policy (review-system-rework-reduction P-003):
   * refuse any FRESHLY derived post-epoch BAR — no prior criterion, or its meaning
   * changed — whose METHOD, structured check or test layers are missing, or whose
   * check contradicts its layers. Opt-in, not a builder invariant: the legacy
   * migration and the BAR-neutral subject-pin sync must keep re-deriving whatever
   * the plan already holds, and preserved/legacy/unchanged BARs are never judged
   * (they are the start door's and the amendment's business, not a re-audit's).
   */
  requireContractCompleteness?: boolean;
}

export type AcceptanceBarSeedBuildResult =
  | {
      ok: true;
      rubricSlug: string;
      barSetHash: string;
      templateData: Record<string, unknown>;
      criteria: ProposeRubricCriterion[];
      projections: SpecClauseWrite[];
      mappings: ParsedBarMapping[];
    }
  | {
      ok: false;
      error: AcceptanceBarSeedCode;
      message: string;
      problems: AcceptanceBarSeedProblem[];
    };

function refusal(problems: AcceptanceBarSeedProblem[]): AcceptanceBarSeedBuildResult {
  const first = problems[0] ?? {
    code: 'bar_seed_persistence_failed' as const,
    detail: 'BAR seeding failed without a diagnostic',
  };
  return {
    ok: false,
    error: first.code,
    message: `${problems.length} BAR seed problem(s): ${problems.map((p) => p.detail).join('; ')}`,
    problems,
  };
}

function sectionBody(planContent: string, heading: string): string | null {
  return splitPlanSections(planContent).find(
    (section) => section.heading.trim().toLowerCase() === heading.toLowerCase(),
  )?.body ?? null;
}

/** Parse the explicit `**R-N — Title.** body` records. Any malformed R-looking
 * record is a refusal; a partial parse must never shrink the BAR denominator. */
export function parseRequirementBars(planContent: string):
  | { ok: true; bars: ParsedRequirementBar[] }
  | { ok: false; problems: AcceptanceBarSeedProblem[] } {
  const body = sectionBody(planContent, 'Requirements');
  if (body === null) {
    return { ok: false, problems: [{ code: 'bar_requirements_missing', detail: 'plan has no ## Requirements section' }] };
  }
  const lines = body.split('\n');
  const bars: ParsedRequirementBar[] = [];
  const problems: AcceptanceBarSeedProblem[] = [];
  let current: { barKey: string; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const outcome = current.lines.join('\n').trim();
    if (outcome.includes('```requirement')) {
      const fenced = /^```requirement\s*\n([\s\S]*?)\n```$/.exec(outcome);
      try {
        if (!fenced) throw new Error('use one requirement JSON block with no competing prose');
        const sections = requirementSectionsSchema.parse(JSON.parse(fenced[1]!));
        const criterion = normalizeAcceptanceBarCriterion({
          key: current.barKey.toLowerCase(), title: current.title, barKey: current.barKey, ...sections,
        });
        bars.push({ barKey: current.barKey, title: current.title, model: criterion.model!, criterion });
      } catch (error) {
        problems.push({ code: 'bar_requirement_parse_failed', barKey: current.barKey,
          detail: `${current.barKey}: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    if (!outcome) {
      problems.push({
        code: 'bar_requirement_parse_failed',
        barKey: current.barKey,
        detail: `${current.barKey} has a title but no outcome statement`,
      });
    } else {
      bars.push({
        barKey: current.barKey,
        title: current.title,
        // The heading is a human-readable label, not part of the observable
        // contract. Prefixing it made every plain-text BAR two sentences and
        // caused the generated AUTO-BAR clause to fail spec atomicity.
        model: outcome,
      });
    }
  };

  for (const line of lines) {
    const start = /^\*\*(R-\d+)\s+[—–-]\s+(.+?)\.\*\*\s*(.*)$/.exec(line);
    if (start) {
      flush();
      current = {
        barKey: start[1]!,
        title: start[2]!.trim(),
        lines: start[3]?.trim() ? [start[3].trim()] : [],
      };
      continue;
    }
    if (/^\*\*R-\d+\b/.test(line)) {
      flush();
      current = null;
      problems.push({
        code: 'bar_requirement_parse_failed',
        detail: `malformed requirement record: ${line.slice(0, 160)}`,
      });
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();

  if (bars.length === 0 && problems.length === 0) {
    problems.push({
      code: 'bar_requirement_parse_failed',
      detail: '## Requirements contains no `**R-N — Title.** outcome` records',
    });
  }
  if (bars.length > MAX_REQUIREMENT_BARS) {
    problems.push({
      code: 'bar_set_too_large',
      detail: `Requirements contains ${bars.length} bars; maximum is ${MAX_REQUIREMENT_BARS}`,
    });
  }
  const seen = new Set<string>();
  for (const bar of bars) {
    if (seen.has(bar.barKey)) {
      problems.push({ code: 'bar_key_duplicate', barKey: bar.barKey, detail: `duplicate requirement key ${bar.barKey}` });
    }
    seen.add(bar.barKey);
  }
  return problems.length ? { ok: false, problems } : { ok: true, bars };
}

function evidencePlaneOf(raw: string | undefined): AcceptanceEvidencePlane | null {
  const normalized = (raw ?? '').replace(/`/g, '').trim().toLowerCase();
  if (!normalized) return 'tree';
  return normalized === 'tree' || normalized === 'deployed' || normalized === 'live'
    ? normalized
    : null;
}

/**
 * A BAR whose proof is explicitly on a deployed/live plane is not automatically
 * an automated test obligation. Keep the neutral automated class when the BAR
 * declares test layers, but classify an otherwise manual delivery-plane BAR as
 * non-automated so the adequacy floor can correctly be `none`.
 */
export function acceptanceBarBehaviorClass(
  evidencePlane: AcceptanceEvidencePlane,
  requiredTestLayers?: readonly string[],
  check?: Parameters<typeof isExplicitlyManualCheck>[0],
): SpecBehaviorClass {
  // An explicitly manual review can concern a tree artifact too. Its plane
  // determines where to inspect it, not whether a mutation test is owed.
  if ((requiredTestLayers?.length ?? 0) === 0 && isExplicitlyManualCheck(check)) return 'non-automated';
  return evidencePlane === 'tree' || (requiredTestLayers?.length ?? 0) > 0
    ? 'happy-path'
    : 'non-automated';
}

/**
 * The clause behavior DERIVED from a BAR criterion.
 *
 * `model` is rubric prose and routinely opens by restating its own title, which
 * reads naturally in a rubric and is fatal in a spec clause: the projected
 * behavior becomes two sentences and fails spec-quality's
 * `atomic-observable-behavior`, which blocks plan-item promotion and shipping.
 *
 * Repairing the projected clause instead is not a fix. `preserveRefinements` in
 * acceptance-bar-amendment only protects a clause edit while the BAR's hash
 * material is unchanged (or only test layers moved), so the first amendment that
 * touches meaning silently re-derives the clause and discards the repair —
 * measured on ship-main-greening-program-2026-09-15, where clause revisions 3-12
 * held the atomic form and revision 13 reverted all six bars at once
 * (EI-23920059935763829). Strip the duplicated opening at the SOURCE of the
 * derivation so the repair cannot be lost, and every re-projection is atomic.
 */
export function acceptanceBarProjectedBehavior(
  criterion: { title?: string | null; model?: string | null },
): string {
  const model = String(criterion.model ?? '').trim();
  const title = String(criterion.title ?? '').trim().replace(/[.\s]+$/, '');
  if (!model || !title) return model;
  const prefix = `${title}.`;
  if (!model.startsWith(prefix)) return model;
  const rest = model.slice(prefix.length).replace(/^\s+/, '');
  // A model that is ONLY its own title carries no separate behavior to keep.
  return rest.length > 0 ? rest : model;
}

/** Parse the plan's existing design table. A third `evidence plane` column is
 * optional; omission is the conservative authoring default `tree`. */
export function parseBarMappings(planContent: string, requirementKeys: ReadonlySet<string>):
  | { ok: true; mappings: ParsedBarMapping[] }
  | { ok: false; problems: AcceptanceBarSeedProblem[] } {
  const design = sectionBody(planContent, 'Design');
  const problems: AcceptanceBarSeedProblem[] = [];
  if (design === null) {
    return { ok: false, problems: [{ code: 'bar_mapping_missing', detail: 'plan has no ## Design section containing a Bar-to-work map' }] };
  }
  const lines = design.split('\n');
  const start = lines.findIndex((line) => /^###\s+Bar-to-work map for this plan\s*$/i.test(line.trim()));
  if (start < 0) {
    return { ok: false, problems: [{ code: 'bar_mapping_missing', detail: '## Design has no `### Bar-to-work map for this plan` table' }] };
  }

  const parsedPlan = parsePlan(planContent);
  const statusByItem = new Map(parsedPlan.items.map((item) => [item.id, item.storedStatus]));
  const mappings: ParsedBarMapping[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^###\s+/.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || /^bar$/i.test(cells[0] ?? '') || /^[-:]+$/.test((cells[0] ?? '').replace(/\s/g, ''))) continue;
    const barKey = (cells[0] ?? '').replace(/`/g, '').trim();
    if (!/^R-\d+$/.test(barKey)) {
      const requirementKey = barKey.match(/^R-\d+\b/)?.[0];
      if (requirementKey) {
        problems.push({
          code: 'bar_mapping_invalid',
          barKey: requirementKey,
          detail: `Bar-to-work map first cell must be the bare ${requirementKey} key, not its title (received ${JSON.stringify(cells[0])})`,
        });
      }
      continue;
    }
    if (seen.has(barKey)) {
      problems.push({ code: 'bar_mapping_duplicate', barKey, detail: `Bar-to-work map has duplicate row ${barKey}` });
      continue;
    }
    seen.add(barKey);
    const itemCell = cells[1] ?? '';
    const itemIds = [...new Set(itemCell.match(/P-\d{3,}/g) ?? [])];
    const leftover = itemCell.replace(/`?P-\d{3,}`?/g, '').replace(/[\s,]+/g, '');
    if (itemIds.length === 0 || leftover) {
      problems.push({
        code: 'bar_mapping_invalid',
        barKey,
        detail: `${barKey} mapping must contain only one or more P-NNN ids (received ${JSON.stringify(itemCell)})`,
      });
      continue;
    }
    const evidencePlane = evidencePlaneOf(cells[2]);
    if (!evidencePlane) {
      problems.push({
        code: 'bar_evidence_plane_invalid',
        barKey,
        detail: `${barKey} evidence plane must be tree, deployed, or live (received ${JSON.stringify(cells[2])})`,
      });
      continue;
    }
    for (const planItemId of itemIds) {
      if (!statusByItem.has(planItemId)) {
        problems.push({
          code: 'bar_mapping_unknown',
          barKey,
          planItemId,
          detail: `${barKey} maps to absent plan item ${planItemId}`,
        });
      }
    }
    const live = itemIds.filter((itemId) => statusByItem.get(itemId) !== 'dropped');
    if (live.length === 0) {
      problems.push({
        code: 'bar_mapping_dropped_only',
        barKey,
        detail: `${barKey} maps only to dropped plan items`,
      });
    }
    mappings.push({ barKey, planItemIds: itemIds, evidencePlane,
      ...(cells[2]?.replace(/`/g, '').trim() ? { evidencePlaneExplicit: true } : {}) });
  }

  for (const barKey of requirementKeys) {
    if (!seen.has(barKey)) {
      problems.push({ code: 'bar_mapping_missing', barKey, detail: `${barKey} has no Bar-to-work map row` });
    }
  }
  for (const mapping of mappings) {
    if (!requirementKeys.has(mapping.barKey)) {
      problems.push({
        code: 'bar_mapping_requirement_missing',
        barKey: mapping.barKey,
        detail: `Bar-to-work map contains ${mapping.barKey}, which has no Requirements record`,
      });
    }
  }
  const edgeCount = mappings.reduce((count, mapping) => count + mapping.planItemIds.length, 0);
  if (edgeCount > MAX_BAR_PROJECTION_EDGES) {
    problems.push({
      code: 'bar_projection_set_too_large',
      detail: `Bar-to-work map contains ${edgeCount} edges; maximum is ${MAX_BAR_PROJECTION_EDGES}`,
    });
  }
  return problems.length ? { ok: false, problems } : { ok: true, mappings };
}

/** The mandatory-outcome pass vocabulary is {healthy, pass}, and BOTH are legitimate:
 *  acceptance rubrics are overwhelmingly on healthy/degraded/broken/unknown, but a
 *  pass/partial/fail/unknown rubric is equally valid. So DERIVE which token this
 *  rubric's scale actually uses rather than hardcoding one — these scales must never
 *  be normalised into each other. Hardcoding made rubric-template validation reject
 *  every rebuilt seed on a pass-scale rubric ("mandatory outcome pass rating 'healthy'
 *  is not present in the rubric ratingScale"), which silently returned false out of
 *  synchronizeAcceptanceBarSubjectRevision and left the subject-revision pin stale
 *  until ship refused with bar_snapshot_rubric_revision_mismatch (WI-10000058). */
function barPassRatings(ratingScale: readonly string[] | undefined): string[] {
  const matched = (ratingScale ?? DEFAULT_RATING_SCALE)
    .filter((rating) => ['healthy', 'pass'].includes(rating.trim().toLowerCase()));
  return matched.length > 0 ? [...matched] : ['healthy'];
}

function seededCriterion(
  bar: ParsedRequirementBar,
  mapping: ParsedBarMapping,
  input: Pick<AcceptanceBarSeedBuildInput, 'actorId' | 'declaredAt' | 'cohort' | 'backfilled'>,
  ratingScale?: readonly string[],
): ProposeRubricCriterion {
  const criterion = normalizeAcceptanceBarCriterion({
    key: bar.barKey.toLowerCase(),
    title: bar.title,
    model: bar.model,
    driftMarkers:
      `${bar.barKey} is falsified when the required outcome is absent, contradicted, or cannot be ` +
      `evidenced on the ${mapping.evidencePlane} plane.`,
    barKey: bar.barKey,
    role: 'outcome',
    mandatory: true,
    requiredScope: [mapping.evidencePlane],
    evidencePlane: mapping.evidencePlane,
    passRatings: barPassRatings(ratingScale),
    // Unified input already names the exact promise, falsifier and method.
    // Never concatenate its title or manufacture an alternative promise.
    ...(bar.criterion ?? {}),
    barProvenance: {
      lifecycle: input.cohort === 'post-epoch' && !input.backfilled ? 'pre-implementation' : 'legacy-backfilled',
      declaredAt: input.declaredAt,
      declaredBy: input.actorId,
    },
  });
  return criterion;
}

function methodProjection(existing: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    'method', 'replication', 'instrumentKey', 'window', 'criterionClass', 'check', 'ratingScale',
  ];
  return Object.fromEntries(fields.filter((field) => existing[field] !== undefined).map((field) => [field, existing[field]]));
}

/** Pure complete-set builder. Existing METHOD fields survive only when the BAR
 * hash is unchanged; a post-start meaning change is routed to amendment. */
/**
 * The BAR-source precondition every acceptance-bar write path validates, as a
 * PURE function: `## Requirements` bars, then the `## Design` Bar-to-work map
 * that must cover them. This is the `bar_requirements_*` / `bar_mapping_*` /
 * `bar_evidence_plane_invalid` family's single authoring site.
 *
 * It is exported so a PREVIEW (`plans:audit { dryRun:true }`) can report exactly
 * what the writer would refuse without performing — or locking for — any write.
 * Callers must gate it on the same condition the writer does: a plan whose
 * `acceptance_bar_epoch` is NULL is not under the BAR contract and requires no
 * Bar-to-work map at all (measured 2026-09-20: 1916 of 2044 plans). Running this
 * unconditionally would false-refuse the large majority of plans — the mirror of
 * the false-pass it exists to fix.
 */
export function validateAcceptanceBarSource(planContent: string):
  | { ok: true; bars: ParsedRequirementBar[]; mappings: ParsedBarMapping[] }
  | { ok: false; problems: AcceptanceBarSeedProblem[] } {
  const requirements = parseRequirementBars(planContent);
  if (!requirements.ok) return { ok: false, problems: requirements.problems };
  const mappings = parseBarMappings(
    planContent,
    new Set(requirements.bars.map((bar) => bar.barKey)),
  );
  if (!mappings.ok) return { ok: false, problems: mappings.problems };
  return { ok: true, bars: requirements.bars, mappings: mappings.mappings };
}

const SEED_CODE_BY_CONTRACT_GAP: Record<AcceptanceBarContractGap, AcceptanceBarSeedCode> = {
  method_missing: 'bar_contract_method_missing',
  check_missing: 'bar_contract_check_missing',
  test_layers_missing: 'bar_contract_test_layers_missing',
  check_layer_mismatch: 'bar_contract_check_layer_mismatch',
  // The finding's detail names the unrecordable layer and the recorded vocabulary (WI-10006536).
  test_layer_unrecordable: 'bar_contract_check_layer_mismatch',
};

/**
 * The activation-seed contract-completeness verdict over PARSED source bars — the
 * single computation both the writer (for its fresh bars) and the `plans:audit
 * { dryRun:true }` preview call, so the preview cannot pass what the writer refuses.
 *
 * A fresh BAR's METHOD/check/layers come only from its ```requirement block (the
 * seeded criterion spreads exactly that over neutral defaults), so judging the parsed
 * source is judging what the writer would persist. One problem per BAR: `code` is the
 * first gap, `contractGaps` all of them, and a prose record gets the conversion
 * template once rather than once per BAR.
 */
export function acceptanceBarSourceContractProblems(
  bars: readonly ParsedRequirementBar[],
  mappings: readonly ParsedBarMapping[],
): AcceptanceBarSeedProblem[] {
  const planeByBar = new Map(mappings.map((mapping) => [mapping.barKey, mapping.evidencePlane]));
  const problems: AcceptanceBarSeedProblem[] = [];
  let templateShown = false;
  for (const bar of bars) {
    const criterion = bar.criterion;
    const evidencePlane = criterion?.evidencePlane ?? planeByBar.get(bar.barKey) ?? 'tree';
    const layers = criterion?.requiredTestLayers;
    // A structured tests check owes automated proof even on a live/deployed plane,
    // whose generated clause class is otherwise non-automated. Match the projection
    // so activation cannot accept a contract that amendment would refuse.
    const gaps = acceptanceBarContractGaps({
      role: criterion?.role ?? 'outcome',
      method: criterion?.method,
      check: criterion?.check,
      requiredTestLayers: layers,
      automatedProofRequired:
        criterion?.check?.kind === 'tests' ||
        acceptanceBarBehaviorClass(evidencePlane, layers, criterion?.check) !== 'non-automated',
    });
    if (gaps.length === 0) continue;
    let repair: string;
    if (criterion) {
      repair = `Fix these fields in ${bar.barKey}'s \`\`\`requirement block, then re-run the activation audit.`;
    } else if (!templateShown) {
      templateShown = true;
      repair =
        `${bar.barKey} is authored as prose, which cannot carry a METHOD, check or test layers. Rewrite it as a ` +
        `\`\`\`requirement block, then re-run the activation audit: ${ACCEPTANCE_BAR_REQUIREMENT_BLOCK_TEMPLATE}`;
    } else {
      repair = `${bar.barKey} is authored as prose; rewrite it as a \`\`\`requirement block (template above).`;
    }
    problems.push({
      code: SEED_CODE_BY_CONTRACT_GAP[gaps[0]!.gap],
      barKey: bar.barKey,
      contractGaps: gaps.map((finding) => finding.gap),
      detail: `${bar.barKey}: ${gaps.map((finding) => finding.detail).join('; ')}. ${repair}`,
    });
  }
  return problems;
}

export interface AcceptanceBarProjectionIdentity {
  spec_id: string;
  source_bar_key: string | null;
  lifecycle_status: SpecClauseWrite['lifecycleStatus'];
}

/**
 * Return generated projection identities that still compete with the exact
 * current Requirements map.
 *
 * A generated identity whose CURRENT revision is explicitly superseded and no
 * longer carries a source BAR pin is history, not a live projection. Reviewed
 * remaps use exactly that shape before creating the replacement mapping. Keep
 * every other off-map generated identity fail-loud: draft/active/accepted rows,
 * and even superseded rows that retain a source pin, can still affect lifecycle
 * readers and therefore remain real collisions.
 */
export function unexpectedAcceptanceBarProjectionIds(
  expectedProjectionIds: ReadonlySet<string>,
  identities: readonly AcceptanceBarProjectionIdentity[],
): string[] {
  return identities
    .filter((row) =>
      !(row.lifecycle_status === 'superseded' && row.source_bar_key === null) &&
      !expectedProjectionIds.has(row.spec_id),
    )
    .map((row) => row.spec_id);
}

export function acceptanceBarProjectionConflictDetail(unexpected: readonly string[]): string {
  return `stored BAR projection(s) are outside the exact current map: ${unexpected.join(', ')}. ` +
    `To clear an intentionally removed mapping, use plans:set-specs on each current clause with ` +
    `lifecycleStatus:'superseded' and sourceBar:null, then rerun the activation audit. ` +
    `lifecycleStatus:'retired' with a retained sourceBar pin still counts as a live conflict.`;
}

export function buildAcceptanceBarSeed(input: AcceptanceBarSeedBuildInput): AcceptanceBarSeedBuildResult {
  const source = validateAcceptanceBarSource(input.planContent);
  if (!source.ok) return refusal(source.problems);
  const requirements = { ok: true as const, bars: source.bars };
  const mappings = { ok: true as const, mappings: source.mappings };
  const mappingByKey = new Map(mappings.mappings.map((mapping) => [mapping.barKey, mapping]));
  const conflicts = requirements.bars.filter((bar) => {
    const mapping = mappingByKey.get(bar.barKey)!;
    return mapping.evidencePlaneExplicit && bar.criterion?.evidencePlane &&
      mapping.evidencePlane !== bar.criterion.evidencePlane;
  });
  if (conflicts.length) return refusal(conflicts.map((bar) => ({ code: 'bar_evidence_plane_invalid',
    barKey: bar.barKey, detail: `${bar.barKey} has conflicting Acceptance and map evidence planes` })));

  const existingParsed = input.existingTemplateData === undefined
    ? null
    : rubricTemplateDataAuthoringSchema.safeParse(input.existingTemplateData);
  if (existingParsed && !existingParsed.success) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: 'the active acceptance rubric has invalid template_data',
      repairable: 'invalid_template_data',
      rubricSlug: input.rubricSlug,
    }]);
  }
  const existing = existingParsed?.success ? existingParsed.data : null;
  // The contract can already be binding while its subject is still draft:
  // activation seeds it before the plan advances, and a reviewed amendment can
  // pin that draft's next revision. Match the contract pin, not the plan status,
  // exactly as the write guard does when deciding whether BAR meaning is protected.
  const preserveCanonicalBars = input.planStatus != null &&
    existing?.barContract != null &&
    existing.barContract.adoptionEpoch === input.adoptionEpoch &&
    existing.barContract.cohort === input.cohort &&
    // Either the pin already names this exact revision, or the caller has proven the
    // write BAR-neutral and is advancing the pin alone. Without the second case a pin
    // repair re-derives criteria from the plan body and reverts amended BAR text.
    (existing.barContract.subjectPlanRevision === input.subjectPlanRevision ||
      input.preserveExistingBars === true);
  if (existing && (existing.kind !== 'acceptance' || existing.subjectPlan !== input.planSlug)) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `rubric '${input.rubricSlug}' is not the acceptance rubric for '${input.planSlug}'`,
    }]);
  }
  const legacyMap = input.legacyCriterionMap;
  if (legacyMap && (!input.backfilled || !existing || existing.barContract ||
      Object.keys(legacyMap).length !== requirements.bars.length ||
      new Set(Object.values(legacyMap)).size !== existing.criteria.length ||
      existing.criteria.length !== requirements.bars.length ||
      requirements.bars.some((bar) => !existing.criteria.some((criterion) =>
        criterion.key === legacyMap[bar.barKey] && criterion.role !== 'disclosure' && criterion.model?.trim())))) {
    return refusal([{ code: 'bar_rubric_conflict',
      detail: 'legacyCriterionMap must bijectively map every Requirements BAR to every existing outcome criterion, only during first backfill' }]);
  }
  const existingByBar = new Map(
    (existing?.criteria ?? [])
      .filter((criterion) => criterion.barKey)
      .map((criterion) => [criterion.barKey!, criterion] as const),
  );
  const extras = (existing?.criteria ?? []).filter(
    (criterion) => (!criterion.barKey || !mappingByKey.has(criterion.barKey)) &&
      !Object.values(legacyMap ?? {}).includes(criterion.key),
  );
  if (extras.length > 0) {
    // EI-23376468: distinguish a LEGACY rubric from a genuinely conflicting one.
    // Every extra lacking a `barKey` entirely means the rubric simply predates BAR
    // adoption — the backfill situation, recordable as pending. An extra that DOES
    // carry a barKey which the Requirements map does not know is a real conflict
    // (a renamed/removed requirement, or the wrong rubric pinned), and stays fatal:
    // softening that case would let activation record an audit over a rubric whose
    // bars disagree with the plan, which is the thing this check exists to catch.
    const everyExtraIsLegacy = extras.every((criterion) => !criterion.barKey);
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: everyExtraIsLegacy
        ? `active rubric predates BAR adoption — no criterion carries a barKey, so a legacy backfill is owed for: ${extras.map((c) => c.key).join(', ')}`
        : `active rubric contains criterion(s) outside the current Requirements set: ${extras.map((c) => c.key).join(', ')}`,
      ...(everyExtraIsLegacy
        ? { repairable: 'legacy_criteria_unmapped' as const, rubricSlug: input.rubricSlug }
        : {}),
    }]);
  }

  // BARs whose criterion is derived from the plan body in THIS build, as opposed to
  // preserved, legacy-adopted or unchanged-meaning ones. Only these are judged for
  // contract completeness: an unchanged BAR was already judged when it was fresh.
  const freshBarKeys = new Set<string>();
  const criteria = requirements.bars.map((bar) => {
    const seeded = seededCriterion(bar, mappingByKey.get(bar.barKey)!, input, existing?.ratingScale);
    const legacy = legacyMap && existing?.criteria.find((criterion) => criterion.key === legacyMap[bar.barKey]);
    if (legacy) {
      // Keep the graded identity, full outcome, falsifier and METHOD intact.
      // Adoption adds structural BAR pins; it must not weaken an older rubric
      // whose outcome text is more precise than the original Requirements seed.
      return normalizeAcceptanceBarCriterion({ ...legacy,
        barKey: bar.barKey, role: 'outcome', mandatory: true,
        requiredScope: seeded.requiredScope, evidencePlane: seeded.evidencePlane,
        passRatings: legacy.passRatings ?? barPassRatings(legacy.ratingScale ?? existing!.ratingScale),
        barProvenance: seeded.barProvenance,
      });
    }
    const prior = existingByBar.get(bar.barKey);
    // Once an amendment pins this exact plan revision, the criterion is
    // authoritative. Re-auditing must not replace its approved falsifier/plane
    // with the original human seed. A changed plan revision still takes the
    // normal meaning-change guard below the builder.
    if (preserveCanonicalBars && prior) return { ...prior } as ProposeRubricCriterion;
    if (!prior || prior.barHash !== seeded.barHash) {
      freshBarKeys.add(bar.barKey);
      return seeded;
    }
    return {
      ...seeded,
      ...methodProjection(prior as unknown as Record<string, unknown>),
      ...methodProjection((bar.criterion ?? {}) as Record<string, unknown>),
      barProvenance: prior.barProvenance ?? seeded.barProvenance,
    } as ProposeRubricCriterion;
  });
  // P-003/P-029: shift the METHOD/check/layer contract left to activation, where the
  // repair is a text edit of a draft instead of a barHash-changing amendment that
  // discards bound proof. Legacy-backfilled BARs describe work that already exists.
  if (input.requireContractCompleteness && input.cohort === 'post-epoch' && !input.backfilled) {
    const contractProblems = acceptanceBarSourceContractProblems(
      requirements.bars.filter((bar) => freshBarKeys.has(bar.barKey)),
      mappings.mappings,
    );
    if (contractProblems.length > 0) return refusal(contractProblems);
  }
  const barSetHash = computeAcceptanceBarSetHash(criteria);
  const parsedPlan = parsePlan(input.planContent);
  const classRef = input.classRef ?? existing?.classRef;
  const templateCandidate = {
    ...(existing ?? {}),
    kind: 'acceptance' as const,
    subjectPlan: input.planSlug,
    ...(input.subjectHarnessSlug ? { subjectHarnessSlug: input.subjectHarnessSlug } : {}),
    ...(classRef ? { classRef } : {}),
    characteristic: existing?.characteristic ?? 'plan-acceptance',
    criteria,
    ratingScale: existing?.ratingScale ?? [...DEFAULT_RATING_SCALE],
    description: existing?.description ?? `Predeclared acceptance BARs for ${input.planSlug}.`,
    proposedBy: existing?.proposedBy ?? input.actorId,
    barSetHash,
    barContract: preserveCanonicalBars ? existing!.barContract : {
      schemaVersion: 1 as const,
      adoptionEpoch: input.adoptionEpoch,
      cohort: input.cohort,
      subjectPlanRevision: input.subjectPlanRevision,
      seededAt: input.declaredAt,
      seededBy: input.actorId,
    },
  };
  const templateData = rubricTemplateDataAuthoringSchema.safeParse(templateCandidate);
  if (!templateData.success) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `seeded rubric is invalid: ${templateData.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    }]);
  }

  const projections: SpecClauseWrite[] = [];
  for (const criterion of criteria) {
    const mapping = mappingByKey.get(criterion.barKey!)!;
    const evidencePlane = criterion.evidencePlane ?? mapping.evidencePlane;
    for (const planItemId of mapping.planItemIds) {
      projections.push({
        planSlug: input.planSlug,
        specId: `AUTO-BAR-${criterion.barKey}-${planItemId}`,
        expectedRevision: 0,
        planItemId,
        behavior: acceptanceBarProjectedBehavior(criterion),
        behaviorClass: acceptanceBarBehaviorClass(evidencePlane, criterion.requiredTestLayers, criterion.check),
        requiredEvidence: [evidencePlane],
        ...(criterion.requiredTestLayers ? { requiredTestLayers: criterion.requiredTestLayers } : {}),
        lifecycleStatus: 'draft',
        falsifier: { observation: criterion.driftMarkers ?? '' },
        acceptanceRef: `${input.rubricSlug}@${input.rubricRevision}:${criterion.barKey}`,
        sourceBar: {
          barKey: criterion.barKey!,
          barHash: criterion.barHash!,
          barSetHash,
          rubricSlug: input.rubricSlug,
          rubricRevision: input.rubricRevision,
          evidencePlane,
        },
        actorId: input.actorId,
      });
    }
  }
  // Compile-time/runtime backstop: every generated criterion is valid independently,
  // not only because the containing document happened to parse.
  for (const criterion of criteria) acceptanceRubricCriterionSchema.parse(criterion);

  return {
    ok: true,
    rubricSlug: input.rubricSlug,
    barSetHash,
    templateData: templateData.data as Record<string, unknown>,
    criteria,
    projections,
    mappings: mappings.mappings,
  };
}

export function acceptanceBarRubricSlug(planSlug: string): string {
  return `acceptance-${planSlug}`;
}

interface RubricRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  content: string;
  content_hash: string;
  version: number | string;
  title: string | null;
  template: string | null;
  template_slug: string | null;
  archived: boolean;
  template_data: unknown;
}

/**
 * The live-rubric discovery query intentionally excludes historical rows. When
 * the deterministic slug is already occupied, however, the locked row may be
 * that subject's superseded acceptance rubric rather than an unrelated plan.
 * Classify the exact row from its persisted identity and validated metadata so a
 * historical acceptance contract can be re-audited without weakening the slug
 * collision guard for ordinary, instance, archived, or unrelated rows.
 */
function isHistoricalAcceptanceRubric(row: RubricRow, subjectPlan: string): boolean {
  if (row.template !== 'rubric' || row.template_slug !== null || row.archived) return false;
  const parsed = rubricTemplateDataAuthoringSchema.safeParse(row.template_data);
  return parsed.success && parsed.data.kind === 'acceptance' && parsed.data.subjectPlan === subjectPlan;
}

export interface TransactionalAcceptanceBarSeedInput {
  executor: SpecClauseSql;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planContent: string;
  planTitle: string | null;
  planStatus: string | null;
  planVersion: number;
  adoptionEpoch: number;
  cohort: AcceptanceBarCohort;
  /** Carry the evaluated plan class into a newly generated acceptance rubric. */
  classRef?: PlanClassRubricRef;
  /** Only the canonical migration adapter sets this from its classified action. */
  backfilled?: boolean;
  legacyCriterionMap?: Record<string, string>;
  actorId: string;
  now: Date;
  /** Validate and describe the same canonical write without mutating any rows. */
  dryRun?: boolean;
  /** Activation-door policy; see {@link AcceptanceBarSeedBuildInput.requireContractCompleteness}. */
  requireContractCompleteness?: boolean;
  /**
   * WI-10004146 / D-093 — federated-receiver mode. The rubric row federates but the
   * plan's acceptance_bar_* columns and its spec clauses are machine-local, so a
   * receiver re-derives them here. It must never author or revise the rubric: it
   * proceeds only when a discovered active rubric already equals the rebuilt one,
   * and otherwise refuses `bar_receiver_rubric_pending` before any write.
   * Call it through `seedAcceptanceBarsOnFederatedApply` (acceptance-bar-receiver-seed.ts):
   * that supplies the rubric's own barContract pins, which the receiver's local plan
   * version and trigger-stamped epoch/cohort cannot.
   */
  receiverOnly?: boolean;
}

export interface TransactionalAcceptanceBarSeedSuccess {
  ok: true;
  rubricSlug: string;
  rubricRevision: number;
  barSetHash: string;
  bars: number;
  projectionEdges: number;
  /** Canonical clause identities for test/evidence binding; BAR keys alone are not spec IDs. */
  projections: Array<{ barKey: string; planItemId: string; specId: string }>;
  rubricChanged: boolean;
  preview?: { priorRubricRevision: number; nextRubricRevision: number; priorBarSetHash: string | null;
    nextBarSetHash: string; mappings: ParsedBarMapping[]; changes: import('./acceptance-bar-contract-snapshot').AcceptanceBarContractDiff['changes'];
    cohort: AcceptanceBarCohort; provenance: 'pre-implementation' | 'legacy-backfilled'; invalidatesPriorProof: boolean };
}

export type TransactionalAcceptanceBarSeedResult =
  | TransactionalAcceptanceBarSeedSuccess
  | Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;

export class AcceptanceBarSeedAbort extends Error {
  constructor(readonly result: Exclude<TransactionalAcceptanceBarSeedResult, { ok: true }>) {
    super(result.message);
    this.name = 'AcceptanceBarSeedAbort';
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Run inside the subject activation-audit transaction. Any late projection
 * refusal throws AcceptanceBarSeedAbort so earlier rubric/clause writes roll back. */
export async function seedAcceptanceBarsInTransaction(
  input: TransactionalAcceptanceBarSeedInput,
): Promise<TransactionalAcceptanceBarSeedResult> {
  const sql = input.executor;
  const rubrics = await sql<RubricRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version, title,
           template, template_slug, archived, template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND template = 'rubric'
       AND template_slug IS NULL
       AND archived = false
       AND status IN ('active', 'ready')
       AND template_data->>'kind' = 'acceptance'
       AND template_data->>'subjectPlan' = ${input.planSlug}
       AND (template_data->>'subjectHarnessSlug' = ${input.harnessSlug}
         OR (template_data->>'subjectHarnessSlug' IS NULL AND (
           SELECT count(*) = 1 AND bool_and(subject.harness_slug = ${input.harnessSlug})
             FROM harness_shared.harness_plans AS subject
            WHERE subject.workspace_id = ${input.workspaceId}
              AND subject.plan_slug = ${input.planSlug}
         )))
     ORDER BY updated_at DESC NULLS LAST, plan_slug ASC
     LIMIT 2`;
  if (rubrics.length > 1) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `subject plan has ${rubrics.length} active acceptance rubrics; exactly one is required`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }
  const discovered = rubrics[0];
  const rubricSlug = discovered?.plan_slug ?? acceptanceBarRubricSlug(input.planSlug);
  const rubricHarness = discovered?.harness_slug ?? input.harnessSlug;
  const rubricLockKey = planAdvisoryLockKey(input.workspaceId, rubricHarness, rubricSlug);
  const lock = await sql<Array<{ ok: boolean }>>`
    SELECT pg_try_advisory_xact_lock(
      hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}), hashtext(${rubricLockKey})
    ) AS ok`;
  if (!lock[0]?.ok) {
    return refusal([{
      code: 'bar_rubric_busy',
      detail: `acceptance rubric '${rubricSlug}' is being edited; activation seed refused without writing`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }

  const lockedRows = await sql<RubricRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version, title,
           template, template_slug, archived, template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${rubricHarness}
       AND plan_slug = ${rubricSlug}
     FOR UPDATE`;
  const existing = lockedRows[0] ?? null;
  const existingIsHistoricalAcceptance = existing !== null && isHistoricalAcceptanceRubric(existing, input.planSlug);
  if (existing && (!discovered || existing.plan_slug !== discovered.plan_slug) && !existingIsHistoricalAcceptance) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `deterministic rubric slug '${rubricSlug}' collides with an existing non-acceptance plan`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }

  const existingRevision = existing ? Number(existing.version) : 0;
  const provisionalRevision = existingRevision + 1;
  const existingTemplate = existing
    ? rubricTemplateDataAuthoringSchema.safeParse(existing.template_data)
    : null;
  const seedInstant =
    existingTemplate?.success &&
    existingTemplate.data.barContract?.subjectPlanRevision === input.planVersion &&
    existingTemplate.data.barContract.cohort === input.cohort
      ? existingTemplate.data.barContract.seededAt
      : input.now.toISOString();
  let built = buildAcceptanceBarSeed({
    planSlug: input.planSlug,
    subjectHarnessSlug: input.harnessSlug,
    planContent: input.planContent,
    actorId: input.actorId,
    declaredAt: seedInstant,
    cohort: input.cohort,
    classRef: input.classRef,
    backfilled: input.backfilled,
    legacyCriterionMap: input.legacyCriterionMap,
    adoptionEpoch: input.adoptionEpoch,
    subjectPlanRevision: input.planVersion,
    planStatus: input.planStatus,
    rubricSlug,
    rubricRevision: provisionalRevision,
    ...(existing ? { existingTemplateData: existing.template_data } : {}),
    requireContractCompleteness: input.requireContractCompleteness,
  });
  if (!built.ok) return built;

  // P-004/D-009: this activation seeder is a direct SQL writer, so it must
  // cross the same started-BAR guard as withPlanLock. A post-start meaning
  // change is an amendment, never a migration/seed overwrite; provenance is
  // canonicalized from the locked subject-plan state before any SQL write.
  if (existingTemplate?.success && existingTemplate.data.barContract) {
    let guarded: ReturnType<typeof guardAcceptanceBarTemplateDataWrite>;
    try {
      guarded = guardAcceptanceBarTemplateDataWrite({
        slug: rubricSlug,
        storedTemplateData: existing.template_data,
        nextTemplateData: built.templateData,
        subjectPlan: {
          status: input.planStatus,
          revision: input.planVersion,
          adoptionEpoch: input.adoptionEpoch,
          cohort: input.cohort,
        },
        actorId: input.actorId,
      });
    } catch (error) {
      // A receiver whose local plan changed BAR meaning against the federated rubric
      // is waiting for the author's amendment to arrive; that is a deferral, not an error.
      if (!input.receiverOnly) throw error;
      return refusal([{
        code: 'bar_receiver_rubric_pending',
        detail: `federated rubric '${rubricSlug}' does not match the local plan (${
          error instanceof Error ? error.message : String(error)
        }); receiver seed deferred without writing`,
      }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
    }
    built = {
      ...built,
      templateData: guarded.data,
      criteria: (guarded.data.criteria as ProposeRubricCriterion[]),
      barSetHash: String(guarded.data.barSetHash ?? built.barSetHash),
    };
  }

  const sameBarMeaning = existingTemplate?.success
    ? existingTemplate.data.criteria.every((criterion) => {
        const next = built.ok ? built.criteria.find((item) => item.barKey === criterion.barKey) : null;
        return Boolean(next && next.barHash === criterion.barHash);
      })
    : false;
  const adoptingLegacy = input.backfilled && input.legacyCriterionMap &&
    existingTemplate?.success && !existingTemplate.data.barContract;
  if (existing && input.planStatus !== 'draft' && !sameBarMeaning && !adoptingLegacy) {
    return refusal([{
      code: 'bar_amendment_required',
      detail: `Requirements changed BAR meaning after plan status '${input.planStatus ?? 'unknown'}'; use the amendment transaction`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }

  const rubricChanged = !existing || stableJson(existing.template_data) !== stableJson(built.templateData);
  // WI-10004146 / D-093: a receiver never authors or revises the federated rubric.
  // Rubric absent (the plan arrived first) or not yet agreeing with the local plan
  // (a newer revision of either is still in flight): write nothing. The other row's
  // apply re-runs this seed, so the two arrival orders converge on one rubric row.
  if (input.receiverOnly && (!discovered || rubricChanged)) {
    return refusal([{
      code: 'bar_receiver_rubric_pending',
      detail: !discovered
        ? `no federated acceptance rubric for '${input.planSlug}' yet; receiver seed deferred without writing`
        : `federated rubric '${rubricSlug}' does not match the local plan; receiver seed deferred without writing`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }
  const rubricRevision = rubricChanged ? provisionalRevision : existingRevision;
  if (!rubricChanged && rubricRevision !== provisionalRevision) {
    built = buildAcceptanceBarSeed({
      planSlug: input.planSlug,
      subjectHarnessSlug: input.harnessSlug,
      planContent: input.planContent,
      actorId: input.actorId,
      declaredAt:
        existingTemplate?.success && existingTemplate.data.barContract
          ? existingTemplate.data.barContract.seededAt
          : input.now.toISOString(),
      cohort: input.cohort,
      classRef: input.classRef,
      adoptionEpoch: input.adoptionEpoch,
      subjectPlanRevision: input.planVersion,
      planStatus: input.planStatus,
      rubricSlug,
      rubricRevision,
      existingTemplateData: existing!.template_data,
      requireContractCompleteness: input.requireContractCompleteness,
    });
    if (!built.ok) return built;
  }

  const date = input.now.toISOString().slice(0, 10);
  const title = existing?.title ?? `Acceptance BAR — ${input.planTitle ?? input.planSlug}`;
  const body = existing?.content ?? buildRubricPlanBody({
    slug: rubricSlug,
    title,
    planStatus: 'active',
    owner: input.actorId,
    date,
    description: `Predeclared acceptance BARs seeded from ${input.planSlug}.`,
  });
  if (rubricChanged && !input.dryRun) {
    const templateJson = JSON.stringify(built.templateData);
    const bodyHash = hashPlanContent(body);
    await sql`
      INSERT INTO harness_shared.harness_plans (
        workspace_id, harness_slug, plan_slug, content, content_hash, version,
        title, status, created, updated, owner, template, template_data,
        items, decisions, now_state, now_next, origin
      ) VALUES (
        ${input.workspaceId}, ${rubricHarness}, ${rubricSlug}, ${body}, ${bodyHash}, ${rubricRevision},
        ${title}, 'active', ${date}, ${date}, ${input.actorId}, 'rubric', ${templateJson}::text::jsonb,
        '[]'::jsonb, '[]'::jsonb, 'Acceptance BAR rubric', 'Fill METHOD/checks against as-built work before grading', 'local'
      )
      ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
        template_data = EXCLUDED.template_data,
        version = EXCLUDED.version,
        updated_at = now(),
        origin = 'local'`;

    const snapshot = `${body}${body.endsWith('\n') ? '\n' : '\n\n'}## Structured rubric data (\`template_data\`)\n\n~~~json\n${JSON.stringify(built.templateData, null, 2)}\n~~~\n`;
    await sql`
      INSERT INTO harness_shared.plan_revisions (
        workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, rationale,
        author_kind, author_id, session_id, session_kind, created_at
      )
      SELECT ${input.workspaceId}, ${rubricHarness}, ${rubricSlug}, COALESCE(MAX(seq), 0) + 1,
             ${bodyHash}, ${snapshot}, 'activation BAR seed',
             'agent', ${input.actorId}, null, null, ${input.now.getTime()}
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${rubricHarness}
         AND plan_slug = ${rubricSlug}`;
  }

  const identities = await sql<Array<{
    spec_id: string;
    current_revision: number | string;
    source_bar_key: string | null;
    plan_item_id: string;
    lifecycle_status: SpecClauseWrite['lifecycleStatus'];
    exemption: SpecClauseWrite['exemption'];
  }>>`
    SELECT c.spec_id, c.current_revision, r.source_bar_key, r.plan_item_id,
           r.lifecycle_status, r.exemption
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
       AND r.revision = c.current_revision
     WHERE c.workspace_id = ${input.workspaceId}
       AND c.harness_slug = ${input.harnessSlug}
       AND c.plan_slug = ${input.planSlug}
       -- The seeder owns only the COMPLETE deterministic ID grammar emitted by
       -- buildAcceptanceBarSeed (R-N from parseRequirementBars, P-NNN+ items).
       -- A suffixed atomic clause is additive even if it starts with AUTO-BAR-.
       -- A prefix census mistakes that authored clause for a removed map edge.
       -- Keep exact generated identities in the census even when out of map.
       -- The pure classifier below distinguishes a deliberately retired
       -- (superseded + unpinned) identity from a still-live collision.
       -- Reviewed plan-specific clauses may carry the same sourceBar pin so their proof
       -- stays tied to the governing requirement; they are additive contracts,
       -- not stale seed projections to replace or reject on a re-audit.
       AND c.spec_id ~ '^AUTO-BAR-R-[0-9]+-P-[0-9]{3,}$'
     ORDER BY c.spec_id
     LIMIT ${MAX_BAR_PROJECTION_EDGES + 1}`;
  if (identities.length > MAX_BAR_PROJECTION_EDGES) {
    throw new AcceptanceBarSeedAbort(refusal([{
      code: 'bar_projection_set_too_large',
      detail: `existing projection identity read exceeded ${MAX_BAR_PROJECTION_EDGES}; refusing a truncated comparison`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>);
  }
  const expectedProjectionIds = new Set(built.projections.map((projection) => projection.specId));
  const unexpected = unexpectedAcceptanceBarProjectionIds(expectedProjectionIds, identities);
  if (unexpected.length > 0) {
    throw new AcceptanceBarSeedAbort(refusal([{
      code: 'bar_projection_conflict',
      detail: acceptanceBarProjectionConflictDetail(unexpected),
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>);
  }
  const identityBySpec = new Map(identities.map((row) => [row.spec_id, row]));
  if (input.dryRun) {
    const { diffAcceptanceBarContractSnapshots } = await import('./acceptance-bar-contract-snapshot');
    const view = (criteria: ProposeRubricCriterion[], prior = false) => ({
      contentHash: hashPlanContent(stableJson(criteria)),
      plan: { cohort: input.cohort, adoptionEpoch: input.adoptionEpoch },
      bars: criteria.map((criterion) => ({
        barKey: criterion.barKey ?? criterion.key, criterionKey: criterion.key, barHash: criterion.barHash ?? null,
        model: criterion.model ?? '', method: criterion.method ?? '', falsifier: criterion.driftMarkers ?? '',
        check: criterion.check ?? null, requirement: requirementSections(criterion),
        role: criterion.role ?? null, mandatory: criterion.mandatory ?? null,
        requiredScope: criterion.requiredScope ?? [], evidencePlane: criterion.evidencePlane ?? null,
        passRatings: criterion.passRatings ?? [], coversBarKeys: criterion.coversBarKeys ?? [],
        provenance: criterion.barProvenance ?? null,
        mappings: prior ? identities.filter((row) => row.source_bar_key === criterion.barKey)
          .map((row) => ({ specId: row.spec_id, planItemId: row.plan_item_id }))
          : built.ok ? built.projections.filter((projection) => projection.sourceBar?.barKey === criterion.barKey)
            .map((projection) => ({ specId: projection.specId, planItemId: projection.planItemId })) : [],
      })),
    });
    return { ok: true, rubricSlug, rubricRevision, barSetHash: built.barSetHash,
      bars: built.criteria.length, projectionEdges: built.projections.length,
      projections: built.projections.map(({ specId, planItemId, sourceBar }) => ({
        barKey: sourceBar!.barKey, planItemId, specId,
      })), rubricChanged,
      preview: { priorRubricRevision: existingRevision, nextRubricRevision: rubricRevision,
        priorBarSetHash: existingTemplate?.success ? existingTemplate.data.barSetHash ?? null : null,
        nextBarSetHash: built.barSetHash, mappings: built.mappings,
        changes: diffAcceptanceBarContractSnapshots(
          existingTemplate?.success ? view(existingTemplate.data.criteria, true) : null, view(built.criteria), 'seed').changes,
        cohort: input.cohort, provenance: input.backfilled || input.cohort === 'legacy-backfilled' ? 'legacy-backfilled' : 'pre-implementation',
        invalidatesPriorProof: Boolean(existing && rubricChanged) },
    };
  }
  for (const projection of built.projections) {
    const prior = identityBySpec.get(projection.specId);
    // Existing projections may have been reviewed into narrower atomic clauses.
    // synchronizeAcceptanceBarRevision below advances their provenance while
    // preserving that authored behavior when the BAR hash is unchanged. Replaying
    // the broad seed here would silently undo the review and fail spec quality.
    if (prior) continue;
    const result = await setSpecClause(
      {
        ...projection,
        expectedRevision: 0,
      },
      { executor: sql, workspaceId: input.workspaceId, harnessSlug: input.harnessSlug },
    );
    if (!['created', 'revised', 'unchanged'].includes(result.status)) {
      throw new AcceptanceBarSeedAbort(refusal([{
        code: 'bar_projection_conflict',
        detail: `projection '${projection.specId}' refused with ${result.status}`,
      }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>);
    }
  }

  await sql`
    UPDATE harness_shared.harness_plans
       SET acceptance_bar_set_hash = ${built.barSetHash},
           acceptance_bar_rubric_slug = ${rubricSlug},
           acceptance_bar_rubric_revision = ${rubricRevision},
           acceptance_bar_seeded_at = ${input.now},
           acceptance_bar_seeded_by = ${input.actorId},
           -- WI-10004146: the rubric pin governs here; a receiver re-stamps this after.
           acceptance_bar_verified_revision = NULL
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND plan_slug = ${input.planSlug}`;

  // A BAR-neutral plan edit can advance the rubric revision without changing
  // any requirement hash. Refresh every sourceBar-pinned clause—not only the
  // deterministic AUTO-BAR rows—inside this transaction so accepted additive
  // contracts keep their authored behavior/lifecycle while their provenance
  // moves to the current rubric revision. The complete subject pin is written
  // first because synchronizeAcceptanceBarRevision enforces its all-or-none DB
  // constraint while updating the revision/hash subset.
  await synchronizeAcceptanceBarRevision(sql, {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    rubricSlug,
    rubricRevision,
    templateData: built.templateData,
    previousTemplateData: existing?.template_data,
    actorId: input.actorId,
  });

  // Activation can run after promotion, including after every mapped plan item
  // is already terminal. Reconcile every now-current clause revision onto all
  // existing execution records from the canonical provenance legs, in this same
  // transaction, without minting or replacing a work-item.
  await ensureExistingWorkItemSpecRevisionEdgesInTransaction(
    {
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      planSlug: input.planSlug,
      planItemIds: built.projections.map((projection) => projection.planItemId),
      actorId: input.actorId,
    },
    sql,
  );

  return {
    ok: true,
    rubricSlug,
    rubricRevision,
    barSetHash: built.barSetHash,
    bars: built.criteria.length,
    projectionEdges: built.projections.length,
    projections: built.projections.map(({ specId, planItemId, sourceBar }) => ({
      barKey: sourceBar!.barKey, planItemId, specId,
    })),
    rubricChanged,
  };
}

/** Stable helper used by tests/readiness code when only a projection fingerprint
 * is needed without importing the rubric writer. */
export function acceptanceBarSeedFingerprint(result: TransactionalAcceptanceBarSeedSuccess): string {
  return createHash('sha256')
    .update(`${result.rubricSlug}\0${result.rubricRevision}\0${result.barSetHash}\0${result.projectionEdges}`)
    .digest('hex');
}
