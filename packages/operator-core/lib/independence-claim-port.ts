/**
 * Claim-time independence advisory.
 *
 * `payload.requiresIndependenceFrom` is an explicit, item-scoped marker.  It
 * does not change claim eligibility: the claim is already committed before
 * this port runs, and a lookup failure must never release or reject it.
 *
 * The marker is intentionally narrower than a plan-wide implementer lookup.
 * A grading/audit item can be independent of one particular work-item or
 * decision while still legitimately belonging to the same plan as its author.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { areAcceptanceLineageRelated } from './acceptance-author-identity';
import { parseWorkedByHistory } from './work-item-prior-work';
import { resolveConcreteWorkspaceId } from './workspace-registry';

export type IndependenceSubjectKind = 'work-item' | 'decision' | 'plan' | 'path';

export interface IndependenceMarker {
  workItems: string[];
  decisions: string[];
  plans: string[];
  paths: string[];
}

export interface IndependenceSubject {
  kind: IndependenceSubjectKind;
  ref: string;
  planSlug?: string;
  decisionId?: string;
}

export interface IndependenceContributor {
  subject: IndependenceSubject;
  contributorId: string;
  evidence: 'taken_by' | 'terminal_owner' | 'last_released_by' | 'worked_by_history';
}

export interface IndependenceLookupRow {
  subject_kind: IndependenceSubjectKind;
  subject_ref: string;
  taken_by: string | null;
  terminal_owner: string | null;
  last_released_by: string | null;
  worked_by_history: unknown;
}

export interface FoldedIndependenceContributors {
  contributors: IndependenceContributor[];
  unresolvedSubjects: IndependenceSubject[];
}

export interface ClaimTimeIndependenceAdvisory {
  requiresIndependenceFrom: IndependenceMarker;
  independenceWarning?: string;
}

export interface IndependenceClaimSubject {
  id?: string | null;
  payload?: unknown;
  harness?: string | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: readonly string[] | null;
}

export type IndependenceSubjectLookup = (
  subjects: readonly IndependenceSubject[],
  opts: { workspaceId: string; harness?: string | null },
) => Promise<IndependenceLookupRow[]>;

const MAX_SUBJECTS = 16;
const MAX_LOOKUP_ROWS = 64;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isWorkItemRef(value: string): boolean {
  return /^(?:WI|EI)-[A-Za-z0-9][A-Za-z0-9._:-]*$/i.test(value);
}

function isDecisionRef(value: string): boolean {
  return /(?:^|[#/:])D-[A-Za-z0-9][A-Za-z0-9._:-]*$/i.test(value);
}

function isPlanRef(value: string): boolean {
  return /^plan:[^/\s][^\s]*$/i.test(value);
}

function isPathRef(value: string): boolean {
  return /^path:[^/\s][^\s]*$/i.test(value);
}

function addRef(
  target: string[],
  value: unknown,
  kind: IndependenceSubjectKind,
): boolean {
  const ref = clean(value);
  if (!ref) return false;
  const valid =
    kind === 'work-item'
      ? isWorkItemRef(ref)
      : kind === 'decision'
        ? isDecisionRef(ref)
        : kind === 'plan'
          ? isPlanRef(ref)
          : isPathRef(ref);
  if (!valid) return false;
  if (!target.includes(ref)) target.push(ref);
  return true;
}

function addSubjectEntry(marker: IndependenceMarker, value: unknown): boolean {
  const entry = recordOf(value);
  if (!entry) {
    const ref = clean(value);
    if (!ref) return false;
    if (isWorkItemRef(ref)) return addRef(marker.workItems, ref, 'work-item');
    if (isDecisionRef(ref)) return addRef(marker.decisions, ref, 'decision');
    if (isPlanRef(ref)) return addRef(marker.plans, ref, 'plan');
    if (isPathRef(ref)) return addRef(marker.paths, ref, 'path');
    return false;
  }

  const kindValue = clean(entry.kind ?? entry.type);
  const ref = clean(entry.ref ?? entry.id ?? entry.value);
  if (!kindValue || !ref) return false;
  if (kindValue === 'work-item' || kindValue === 'workItem' || kindValue === 'work-item-id') {
    return addRef(marker.workItems, ref, 'work-item');
  }
  if (kindValue === 'decision' || kindValue === 'decision-ref') {
    const planSlug = clean(entry.planSlug ?? entry.plan ?? entry.plan_ref);
    const decisionId = clean(entry.decisionId ?? entry.decision_id ?? ref);
    return addRef(marker.decisions, planSlug && decisionId ? `${planSlug}#${decisionId}` : ref, 'decision');
  }
  if (kindValue === 'plan') return addRef(marker.plans, ref.startsWith('plan:') ? ref : `plan:${ref}`, 'plan');
  if (kindValue === 'path') return addRef(marker.paths, ref.startsWith('path:') ? ref : `path:${ref}`, 'path');
  return false;
}

function addField(
  marker: IndependenceMarker,
  value: unknown,
  kind: IndependenceSubjectKind,
): boolean {
  if (Array.isArray(value)) {
    let valid = true;
    for (const entry of value) {
      const entryRecord = recordOf(entry);
      if (entryRecord && kind === 'decision') {
        const planSlug = clean(entryRecord.planSlug ?? entryRecord.plan ?? entryRecord.plan_ref);
        const decisionId = clean(entryRecord.decisionId ?? entryRecord.decision_id ?? entryRecord.ref ?? entryRecord.id);
        if (!planSlug || !decisionId || !addRef(marker.decisions, `${planSlug}#${decisionId}`, 'decision')) valid = false;
      } else if (kind === 'plan' || kind === 'path') {
        const ref = clean(entry);
        const prefix = kind === 'plan' ? 'plan:' : 'path:';
        if (!ref || !addRef(
          kind === 'plan' ? marker.plans : marker.paths,
          ref.startsWith(prefix) ? ref : `${prefix}${ref}`,
          kind,
        )) {
          valid = false;
        }
      } else if (!addRef(
        kind === 'work-item'
          ? marker.workItems
          : kind === 'decision'
            ? marker.decisions
            : kind === 'plan'
              ? marker.plans
              : marker.paths,
        entry,
        kind,
      )) {
        valid = false;
      }
    }
    return valid;
  }
  if (value == null) return true;
  return addSubjectEntry(marker, value);
}

function totalSubjects(marker: IndependenceMarker): number {
  return marker.workItems.length + marker.decisions.length + marker.plans.length + marker.paths.length;
}

/**
 * Normalize the accepted marker spellings into one bounded, deterministic
 * shape. Invalid/missing subjects return null rather than a partial marker:
 * a partial marker would make an independence population look smaller than
 * the item explicitly declared.
 */
export function parseIndependenceMarker(raw: unknown): IndependenceMarker | null {
  if (raw == null || raw === false || raw === true) return null;

  const marker: IndependenceMarker = { workItems: [], decisions: [], plans: [], paths: [] };
  let valid = true;

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!addSubjectEntry(marker, entry)) valid = false;
    }
  } else {
    const source = recordOf(raw);
    if (!source) return null;
    const fields: Array<[string[], unknown, IndependenceSubjectKind]> = [
      [marker.workItems, source.workItems ?? source.workItemIds ?? source.workItemRefs, 'work-item'],
      [marker.decisions, source.decisions ?? source.decisionRefs, 'decision'],
      [marker.plans, source.plans ?? source.planRefs, 'plan'],
      [marker.paths, source.paths ?? source.pathRefs, 'path'],
    ];
    for (const [target, value, kind] of fields) {
      if (value == null) continue;
      if (!addField(marker, value, kind)) valid = false;
      // Keep the tuple's target referenced so a future refactor cannot
      // accidentally stop the field from being considered by this parser.
      void target;
    }
    if (source.subjects != null) {
      if (!Array.isArray(source.subjects)) valid = false;
      else {
        for (const entry of source.subjects) {
          if (!addSubjectEntry(marker, entry)) valid = false;
        }
      }
    }
  }

  return valid && totalSubjects(marker) > 0 && totalSubjects(marker) <= MAX_SUBJECTS ? marker : null;
}

/** Parse the item payload's explicit independence marker. */
export function parseRequiresIndependenceFrom(payload: unknown): IndependenceMarker | null {
  const source = recordOf(payload);
  return parseIndependenceMarker(source?.requiresIndependenceFrom);
}

function parseDecisionRef(ref: string): Pick<IndependenceSubject, 'planSlug' | 'decisionId'> {
  const hash = ref.lastIndexOf('#');
  if (hash > 0 && ref.slice(hash + 1).toUpperCase().startsWith('D-')) {
    return { planSlug: ref.slice(0, hash), decisionId: ref.slice(hash + 1) };
  }
  return { decisionId: ref };
}

/**
 * Fold the normalized marker into exact subject keys used by the lookup.
 * `D-NNN` without a plan remains visible in the marker but cannot be queried
 * safely, so the lookup will report it as unresolved instead of broadening to
 * every plan containing that decision number.
 */
export function foldIndependenceSubjects(marker: IndependenceMarker): IndependenceSubject[] {
  const out: IndependenceSubject[] = [];
  for (const ref of marker.workItems) out.push({ kind: 'work-item', ref });
  for (const ref of marker.decisions) {
    const parsed = parseDecisionRef(ref);
    out.push({ kind: 'decision', ref, ...parsed });
  }
  for (const ref of marker.plans) out.push({ kind: 'plan', ref: ref.slice('plan:'.length) });
  for (const ref of marker.paths) out.push({ kind: 'path', ref: ref.slice('path:'.length) });
  return out;
}

function subjectKey(subject: Pick<IndependenceSubject, 'kind' | 'ref'>): string {
  return `${subject.kind}:${subject.ref}`;
}

function contributorRows(
  row: IndependenceLookupRow,
  currentClaimant?: string | null,
): Array<Pick<IndependenceContributor, 'contributorId' | 'evidence'>> {
  const out: Array<Pick<IndependenceContributor, 'contributorId' | 'evidence'>> = [];
  const claimant = clean(currentClaimant);
  for (const [value, evidence] of [
    [row.taken_by, 'taken_by'],
    [row.terminal_owner, 'terminal_owner'],
    [row.last_released_by, 'last_released_by'],
  ] as const) {
    const contributorId = clean(value);
    // `taken_by` is rewritten by the claim itself before this post-claim read.
    // The other columns are historical provenance and must remain visible.
    if (contributorId && !(evidence === 'taken_by' && contributorId === claimant)) {
      out.push({ contributorId, evidence });
    }
  }
  const history = parseWorkedByHistory(row.worked_by_history);
  // Migration 806 appends the current claimant to the history during claim.
  // Remove only that newest append, not every occurrence: a claimant who
  // worked the subject before still represents a real conflict.
  if (claimant && history.at(-1) === claimant) history.pop();
  for (const contributorId of history) {
    out.push({ contributorId, evidence: 'worked_by_history' });
  }
  return out;
}

/** Pure contributor fold; the current claimant is removed from post-claim row history. */
export function foldIndependenceContributors(
  subjects: readonly IndependenceSubject[],
  rows: readonly IndependenceLookupRow[],
  currentClaimant?: string | null,
): FoldedIndependenceContributors {
  const byKey = new Map(subjects.map((subject) => [subjectKey(subject), subject]));
  const resolved = new Set<string>();
  const seen = new Set<string>();
  const contributors: IndependenceContributor[] = [];
  const claimant = clean(currentClaimant);

  for (const row of rows) {
    const subject = byKey.get(`${row.subject_kind}:${row.subject_ref}`);
    if (!subject) continue;
    resolved.add(subjectKey(subject));
    for (const entry of contributorRows(row, claimant)) {
      const key = `${subjectKey(subject)}:${entry.contributorId}:${entry.evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contributors.push({ subject, ...entry });
    }
  }

  return {
    contributors,
    unresolvedSubjects: subjects.filter((subject) => !resolved.has(subjectKey(subject))),
  };
}

function renderSubject(subject: IndependenceSubject): string {
  return subject.kind === 'work-item'
    ? subject.ref
    : subject.kind === 'decision'
      ? `decision ${subject.ref}`
      : subject.kind === 'plan'
        ? `plan ${subject.ref}`
        : `path ${subject.ref}`;
}

/** Pure warning renderer used by the scheduler and its focused tests. */
export function renderIndependenceWarning(
  claimant: string,
  conflicts: readonly IndependenceContributor[],
): string | null {
  const current = clean(claimant);
  if (!current || conflicts.length === 0) return null;
  const details = [...new Map(
    conflicts.map((conflict) => [
      `${renderSubject(conflict.subject)}:${conflict.contributorId}`,
      `${renderSubject(conflict.subject)} (${conflict.contributorId})`,
    ]),
  ).values()].join(', ');
  return (
    `⚠ INDEPENDENCE CONFLICT: this item explicitly requires independence from ${details}. ` +
    `The current claimant ${current} is in the recorded contributor lineage for that subject. ` +
    `This is advisory only: the claim is already committed and was not rejected or released; ` +
    `verify the subject's contributor history before grading, auditing, or signing. [EI-22344661292350991]`
  );
}

function rowFor(
  subject_kind: IndependenceSubjectKind,
  subject_ref: string,
  row?: Partial<IndependenceLookupRow> | null,
): IndependenceLookupRow {
  return {
    subject_kind,
    subject_ref,
    taken_by: row?.taken_by ?? null,
    terminal_owner: row?.terminal_owner ?? null,
    last_released_by: row?.last_released_by ?? null,
    worked_by_history: row?.worked_by_history ?? null,
  };
}

async function defaultLookup(
  subjects: readonly IndependenceSubject[],
  opts: { workspaceId: string; harness?: string | null },
): Promise<IndependenceLookupRow[]> {
  const { sql } = getOrgPg();
  const rows: IndependenceLookupRow[] = [];
  const harness = clean(opts.harness);
  const workItems = subjects.filter((subject) => subject.kind === 'work-item');
  if (workItems.length > 0) {
    const refs = workItems.map((subject) => subject.ref);
    const found = await sql<IndependenceLookupRow[]>`
      WITH requested(ref) AS (
        SELECT value
          FROM jsonb_array_elements_text(${JSON.stringify(refs)}::text::jsonb)
      )
      SELECT 'work-item'::text AS subject_kind,
             requested.ref AS subject_ref,
             w.taken_by,
             w.terminal_owner,
             w.last_released_by,
             w.worked_by_history
        FROM requested
        JOIN harness_shared.work_items w
          ON w.workspace_id = ${opts.workspaceId}
         AND (${harness}::text IS NULL OR w.harness_slug = ${harness})
         AND w.feature_id = requested.ref
        LIMIT ${MAX_LOOKUP_ROWS}`;
    rows.push(...found);
  }

  const plans = subjects.filter((subject) => subject.kind === 'plan');
  if (plans.length > 0) {
    const refs = plans.map((subject) => subject.ref);
    const found = await sql<IndependenceLookupRow[]>`
      WITH requested(ref) AS (
        SELECT value
          FROM jsonb_array_elements_text(${JSON.stringify(refs)}::text::jsonb)
      )
      SELECT 'plan'::text AS subject_kind,
             requested.ref AS subject_ref,
             w.taken_by,
             w.terminal_owner,
             w.last_released_by,
             w.worked_by_history
        FROM requested
        JOIN harness_shared.work_items w
          ON w.workspace_id = ${opts.workspaceId}
         AND (${harness}::text IS NULL OR w.harness_slug = ${harness})
         AND w.source_plan_slug = requested.ref
        LIMIT ${MAX_LOOKUP_ROWS}`;
    rows.push(...found);
  }

  const decisions = subjects.filter((subject) => subject.kind === 'decision' && subject.planSlug);
  if (decisions.length > 0) {
    const refs = decisions.map((subject) => ({
      subjectRef: subject.ref,
      planSlug: subject.planSlug,
      decisionId: subject.decisionId,
    }));
    const found = await sql<IndependenceLookupRow[]>`
      WITH requested(subject_ref, plan_slug, decision_id) AS (
        SELECT value->>'subjectRef', value->>'planSlug', value->>'decisionId'
          FROM jsonb_array_elements(${JSON.stringify(refs)}::text::jsonb)
      )
      SELECT 'decision'::text AS subject_kind,
             requested.subject_ref,
             w.taken_by,
             w.terminal_owner,
             w.last_released_by,
             w.worked_by_history
        FROM requested
        JOIN harness_shared.plan_decisions d
          ON d.workspace_id = ${opts.workspaceId}
         AND (${harness}::text IS NULL OR d.harness_slug = ${harness})
         AND d.plan_slug = requested.plan_slug
         AND d.decision_id = requested.decision_id
        LEFT JOIN harness_shared.work_items w
          ON w.workspace_id = d.workspace_id
         AND (${harness}::text IS NULL OR w.harness_slug = ${harness})
         AND w.source_plan_slug = d.plan_slug
         AND (
           cardinality(COALESCE(d.item_refs, ARRAY[]::text[])) = 0
           OR w.source_plan_item_ids && d.item_refs
         )
      LIMIT ${MAX_LOOKUP_ROWS}`;
    rows.push(...found);
  }

  return rows.map((row) => rowFor(row.subject_kind, row.subject_ref, row));
}

/**
 * Resolve the marker's exact subject population and compare it with the
 * claimant's identity lineage. Every read is presentation-only and fail-soft.
 */
export async function getClaimTimeIndependenceAdvisory(ref: {
  workItem: IndependenceClaimSubject;
  claimant: string;
  workspaceId?: string | null;
  lookup?: IndependenceSubjectLookup;
  lineageRelated?: typeof areAcceptanceLineageRelated;
}): Promise<ClaimTimeIndependenceAdvisory | null> {
  const marker = parseRequiresIndependenceFrom(ref.workItem.payload);
  if (!marker) return null;
  const subjects = foldIndependenceSubjects(marker);
  if (subjects.length === 0 || subjects.some((subject) => subject.kind === 'path')) return null;
  const claimant = clean(ref.claimant);
  if (!claimant) return null;

  try {
    const workspaceId = resolveConcreteWorkspaceId(ref.workspaceId);
    const rows = await (ref.lookup ?? defaultLookup)(subjects, {
      workspaceId,
      harness: clean(ref.workItem.harness),
    });
    const folded = foldIndependenceContributors(subjects, rows, claimant);
    if (folded.unresolvedSubjects.length > 0) return null;

    const lineageRelated = ref.lineageRelated ?? areAcceptanceLineageRelated;
    const conflicts: IndependenceContributor[] = [];
    for (const contributor of folded.contributors) {
      if (contributor.contributorId === claimant) {
        conflicts.push(contributor);
        continue;
      }
      let related = false;
      try {
        related = await lineageRelated(claimant, contributor.contributorId, { workspaceId });
      } catch {
        return null;
      }
      if (related) conflicts.push(contributor);
    }

    const warning = renderIndependenceWarning(claimant, conflicts);
    return {
      requiresIndependenceFrom: marker,
      ...(warning ? { independenceWarning: warning } : {}),
    };
  } catch {
    return null;
  }
}

/** Compatibility alias for callers/tests that name the operation after its marker. */
export const getClaimTimeRequiresIndependence = getClaimTimeIndependenceAdvisory;
