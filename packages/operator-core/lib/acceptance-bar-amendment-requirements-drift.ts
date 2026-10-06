/**
 * EI-24816459669484550: does an acceptance-rubric amendment leave the subject plan's
 * `## Requirements` block disagreeing with the rubric?
 *
 * WHY. Once a plan's acceptance rubric is seeded, the rubric criterion is the canonical BAR
 * text (`acceptance-bar-seed.ts` header; the amendment refreshes execution projections "from the
 * canonical rubric, never from its old Requirements seed"). Nothing re-renders the plan's R-N
 * block after an amendment, so the plan and the rubric hold two hand-maintained copies of one
 * truth (R-N condition -> criterion `model`, R-N falsifier -> criterion `driftMarkers`) with no
 * reconciler. Measured twice on enterprise-data-sources-2026-10-01 (R-13): the plan's falsifier
 * was edited, the amendment patched `model` only, the rubric kept the superseded falsifier in
 * `driftMarkers`, and only an outside reviewer caught it.
 *
 * WHAT. A pure comparison of the amended criteria against the plan's parsed Requirements,
 * surfaced on the amendment preview (dry run) as an ADVISORY. It never refuses: the rubric is
 * canonical, so a plan block that lags is legitimate. The point is that the author sees the
 * divergence before applying, instead of an outside reviewer finding it after.
 *
 * `driftMarkers` is compared only for explicit three-section (```requirement JSON) R-N blocks.
 * A legacy prose R-N has no falsifier of its own: its seeded `driftMarkers` is a generated
 * sentence, so comparing it would report drift that does not exist.
 */
import type { ParsedRequirementBar } from './acceptance-bar-seed';

export type RequirementsDriftField = 'model' | 'driftMarkers';

export interface RequirementsDriftEntry {
  barKey: string;
  /** True when this amendment changes the BAR; false means the drift predates this amendment. */
  changedByAmendment: boolean;
  /** `missing-from-plan`: the rubric carries a BAR the plan's Requirements block does not. */
  kind: 'missing-from-plan' | 'text-differs';
  /** Which criterion fields disagree with the plan (empty for `missing-from-plan`). */
  fields: RequirementsDriftField[];
}

export interface RequirementsDrift {
  /** True when every surviving amended BAR agrees with the plan's Requirements block. */
  inSync: boolean;
  entries: RequirementsDriftEntry[];
  /** What to do about the drift; null when in sync. */
  action: string | null;
}

/** Whitespace-insensitive, since the canonical writer trims and collapses BAR text. */
const comparable = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const barNumber = (barKey: string): number => {
  const match = /^R-(\d+)$/.exec(barKey);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

export function diffAmendedCriteriaAgainstRequirements(input: {
  requirementBars: readonly ParsedRequirementBar[];
  nextCriteria: ReadonlyArray<Record<string, unknown>>;
  changedBars: Iterable<string>;
  removedBars?: Iterable<string>;
}): RequirementsDrift {
  const planByBar = new Map(input.requirementBars.map((bar) => [bar.barKey, bar]));
  const changed = new Set(input.changedBars);
  const removed = new Set(input.removedBars ?? []);
  const entries: RequirementsDriftEntry[] = [];

  for (const criterion of input.nextCriteria) {
    const barKey = typeof criterion.barKey === 'string' ? criterion.barKey.trim() : '';
    // Non-BAR criteria (no barKey) are not projected from the Requirements block.
    if (!barKey || removed.has(barKey)) continue;
    const changedByAmendment = changed.has(barKey);
    const plan = planByBar.get(barKey);
    if (!plan) {
      entries.push({ barKey, changedByAmendment, kind: 'missing-from-plan', fields: [] });
      continue;
    }
    const fields: RequirementsDriftField[] = [];
    if (comparable(criterion.model) !== comparable(plan.model)) fields.push('model');
    if (plan.criterion && comparable(criterion.driftMarkers) !== comparable(plan.criterion.driftMarkers)) {
      fields.push('driftMarkers');
    }
    if (fields.length) entries.push({ barKey, changedByAmendment, kind: 'text-differs', fields });
  }

  entries.sort((a, b) => barNumber(a.barKey) - barNumber(b.barKey) || a.barKey.localeCompare(b.barKey));
  if (!entries.length) return { inSync: true, entries, action: null };

  const named = entries
    .map((entry) => (entry.kind === 'missing-from-plan' ? `${entry.barKey} (missing from plan)` : `${entry.barKey} (${entry.fields.join(', ')})`))
    .join('; ');
  return {
    inSync: false,
    entries,
    action:
      `The plan's ## Requirements block disagrees with the amended rubric on ${named}. The rubric is ` +
      'canonical after seeding and nothing re-renders the plan block, so this drift persists unless you ' +
      'fix it: update the plan R-N text to match (plans:set-content), or make the amendment match the ' +
      'plan (patch both `model` and `driftMarkers`), before vetting.',
  };
}
