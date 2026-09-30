/**
 * filing-class-aggregation.ts — per-surface CLASS aggregation over the ungraded
 * filing population (agent-review-filing-rail-and-class-aggregation-2026-09-05, P-002).
 *
 * WHY THIS MODULE EXISTS. Every agent files tool-contract defects one INSTANCE at a
 * time, and nothing on the rail aggregates them by surface. So a surface with a
 * systematically confusing argument contract produces a slow drip of individually
 * low-value filings, each costing a separate triage decision and none of them big
 * enough to route to a fix. Measured on the live table 2026-09-05 (EI-22431283677392642,
 * re-measured on this plan's lane): of 911 ungraded `origin='agent-review'` filings, 215
 * carry a structured `toolFailure` report — and those 215 concentrate hard, with 24
 * surfaces holding three or more each (`coord:send` 17, `work_items:complete` 16,
 * `work_items:checkpoint` 14, `loop:checkpoint` 13, …). Two `coord:send` members read:
 *
 *   "coord:send rejected a structured body because summary is required for single-message
 *    form, while the injected wire instructions describe body as the minimum"
 *   "coord:send rejected a valid-looking reply because summary is mandatory when items is
 *    omitted; the initial error was a schema mismatch"
 *
 * Two agents, one defect, filed independently — because neither could see the other.
 * Telling agents to "file the class instead" cannot work: the information needed to write
 * a class report exists only in aggregate, and no agent is ever holding the aggregate.
 * The aggregation therefore has to happen ON THE RAIL, which is what this module is.
 *
 * TWO RULES THIS MODULE IS BUILT AROUND, both of them D-001 on that plan:
 *
 *  1. AGGREGATION IS ADDITIVE. A class is a NEW object that CITES its members by id.
 *     Nothing here mutates, merges, closes or de-duplicates a member row, and
 *     {@link buildFilingClassItemDraft} can only emit a non-destructive `relates` edge —
 *     the type admits no other rel. The filing population is also the GRADING and
 *     ATTRIBUTION substrate: collapsing members destroys the per-filer grade signal and
 *     is irreversible.
 *  2. GROUPING IS A FIELD READ, NOT A HEURISTIC. The class key is the `toolName` the
 *     structured report already carries. Fuzzy title/prose clustering is deliberately
 *     absent: its false merges are unfalsifiable after the fact.
 *
 * POPULATION. The member read mirrors `ungraded-scope.ts#classifyUngraded`'s `actionable`
 * bucket — ungraded, artifact still open, at/after the row's own PER-ORIGIN epoch floor,
 * shadow variants excluded — and takes the policy as an argument rather than re-deriving
 * a floor. Origin is a FILTER here, never a hard-coded literal: a producer added to the
 * policy later is aggregated by default, the same promise `ungraded-scope.ts` makes about
 * the population definition itself.
 */

import type { Sql } from 'postgres';

import { SHADOW_VARIANT_ORIGIN } from './shadow-variant-origin';
import { DEFAULT_UNGRADED_EPOCH_POLICY, type UngradedEpochPolicy } from './ungraded-scope';

/**
 * How many independent filings make a CLASS.
 *
 * Three, from the measured distribution: at the observed shape a floor of 3 promotes 24
 * surfaces covering roughly half the structured corpus, while 2 would promote the long
 * tail of coincidental pairs and 5 would drop real classes (`capability:launch-agent`,
 * `docs:search`, `facts:assert` all sit at exactly 3). Callers may override; the constant
 * exists so the default is stated in one place instead of re-chosen per surface.
 */
export const FILING_CLASS_MIN_MEMBERS = 3;

/**
 * How many member ids one class cites before the list is bounded. A class row that cannot
 * name its members is not additive in any useful sense (D-001), so this is deliberately
 * far above the observed head (17) — it exists only so a pathological surface cannot
 * serialize an unbounded array, and it reports itself when it bites.
 */
export const FILING_CLASS_MEMBER_ID_CAP = 500;

/** One structured `toolFailure` filing, reduced to the fields the class decision needs. */
export interface FilingClassMemberLike {
  /** The work-item id carrying the filing (`EI-…`) — what a class row CITES. */
  workItemId: string;
  /** Producer origin of the routed idea (`agent-review`, `su-ideate`, …). */
  origin: string;
  /** The surface named by the structured report. THE class key; never inferred from prose. */
  toolName: string;
  errorCode?: string | null;
  status?: string | null;
  fieldPath?: string | null;
  routedAtMs: number;
  /**
   * Lifecycle state of the work-item carrying the filing.
   *
   * NOT the same axis as the ledger's TERMINALITY, and the difference is load-bearing.
   * `classifyUngraded` reads `scout_routed_ideas.outcome`, which lags the work-item:
   * measured 2026-09-05, 15 of the 17 `coord:send` members were `dropped` work-items
   * whose ledger outcome was still `pending` (a single bulk drop at 04:05:07Z that the
   * outcome-backfill sweep had not yet reflected). Ranking a class blind to that routes
   * triage at a defect class whose filings are already dead — so the count is carried
   * per state and {@link FilingClass.openMemberCount} is the actionable number.
   */
  memberState?: string | null;
}

/** Work-item states that mean the filing is no longer live work. */
export const TERMINAL_MEMBER_STATES: ReadonlySet<string> = new Set([
  'done',
  'dropped',
  'resolved',
  'closed',
]);

/** PURE: is this member still live work? An unknown/absent state counts as open. */
export function isOpenMemberState(state: string | null | undefined): boolean {
  return !(typeof state === 'string' && TERMINAL_MEMBER_STATES.has(state));
}

/** One defect class: a surface, its member count, and the members it cites. */
export interface FilingClass {
  toolName: string;
  /** Members in this class — the TRUE count, never bounded by the id cap below. */
  memberCount: number;
  /** The cited member ids, oldest first. Bounded by {@link FILING_CLASS_MEMBER_ID_CAP}. */
  memberIds: string[];
  /** True when `memberIds` is a bounded prefix of `memberCount` members. */
  memberIdsTruncated: boolean;
  /**
   * Members whose work-item is still live. THE ACTIONABLE NUMBER — `memberCount` counts
   * the historical class, this counts what triage can still act on. A class with a large
   * `memberCount` and `openMemberCount: 0` is a class that already closed itself.
   */
  openMemberCount: number;
  /** The live members' ids, a subset of `memberIds` in the same order. */
  openMemberIds: string[];
  /** Member counts per work-item state, so the split is never invisible. */
  byState: Record<string, number>;
  /** Member counts per producer origin, so a class is never rendered origin-blind. */
  byOrigin: Record<string, number>;
  /** Distinct error codes observed across members, most frequent first. */
  errorCodes: string[];
  /** Distinct argument/field paths observed across members, most frequent first. */
  fieldPaths: string[];
  firstRoutedAtMs: number;
  lastRoutedAtMs: number;
}

/**
 * A labelled census. Like `UngradedBreakdown`, every field names its own population, so a
 * caller cannot render a bare "class count" without saying what it counted.
 */
export interface FilingClassCensus {
  /** Surfaces at or above `minMembers`, most members first (ties broken by name). */
  classes: FilingClass[];
  /** The threshold this census was taken at — a class list is uninterpretable without it. */
  minMembers: number;
  /** Structured filings seen, across every surface (classed and not). */
  totalMembers: number;
  /** Distinct surfaces seen, across every count. */
  distinctSurfaces: number;
  /** Surfaces that reached the threshold. `classes.length` may be smaller under `limit`. */
  classedSurfaces: number;
  /** Members belonging to a classed surface — the aggregation's actual reach. */
  classedMembers: number;
  /** Classed members whose work-item is still live — what triage can actually act on. */
  classedOpenMembers: number;
  /** Members on a surface below the threshold. `classedMembers + unclassedMembers === totalMembers`. */
  unclassedMembers: number;
  /** True when `limit` cut the class list; `classedSurfaces` still reports the whole set. */
  classesTruncated: boolean;
}

const bumpCount = (into: Record<string, number>, key: string | null | undefined): void => {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return;
  into[k] = (into[k] ?? 0) + 1;
};

/** Distinct keys of a count map, most frequent first, ties broken lexically. */
const rankedKeys = (counts: Record<string, number>): string[] =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

/**
 * PURE: fold structured filings into per-surface classes.
 *
 * Split from the query so the whole aggregation is unit-testable with no PG — the same
 * split `ungraded-scope.ts#summarizeUngraded` makes, and for the same reason.
 *
 * Members are grouped on `toolName` EXACTLY (after trimming); a filing with no tool name
 * is not a structured report and is excluded from `totalMembers` rather than being folded
 * into a spurious "" surface.
 */
export function summarizeFilingClasses(
  members: readonly FilingClassMemberLike[],
  opts: { minMembers?: number; limit?: number; memberIdCap?: number } = {},
): FilingClassCensus {
  const minMembers = Math.max(1, Math.trunc(opts.minMembers ?? FILING_CLASS_MIN_MEMBERS));
  const memberIdCap = Math.max(1, Math.trunc(opts.memberIdCap ?? FILING_CLASS_MEMBER_ID_CAP));

  interface Acc {
    toolName: string;
    memberIds: string[];
    openMemberIds: string[];
    memberCount: number;
    openMemberCount: number;
    byOrigin: Record<string, number>;
    byState: Record<string, number>;
    errorCodes: Record<string, number>;
    fieldPaths: Record<string, number>;
    firstRoutedAtMs: number;
    lastRoutedAtMs: number;
  }
  const bySurface = new Map<string, Acc>();
  let totalMembers = 0;

  for (const m of members) {
    const toolName = typeof m.toolName === 'string' ? m.toolName.trim() : '';
    if (!toolName) continue; // not a structured report — never a "" surface
    totalMembers += 1;
    let acc = bySurface.get(toolName);
    if (!acc) {
      acc = {
        toolName,
        memberIds: [],
        openMemberIds: [],
        memberCount: 0,
        openMemberCount: 0,
        byOrigin: {},
        byState: {},
        errorCodes: {},
        fieldPaths: {},
        firstRoutedAtMs: m.routedAtMs,
        lastRoutedAtMs: m.routedAtMs,
      };
      bySurface.set(toolName, acc);
    }
    acc.memberCount += 1;
    if (acc.memberIds.length < memberIdCap) acc.memberIds.push(m.workItemId);
    if (isOpenMemberState(m.memberState)) {
      acc.openMemberCount += 1;
      if (acc.openMemberIds.length < memberIdCap) acc.openMemberIds.push(m.workItemId);
    }
    bumpCount(acc.byOrigin, m.origin);
    bumpCount(acc.byState, m.memberState ?? 'unknown');
    bumpCount(acc.errorCodes, m.errorCode);
    bumpCount(acc.fieldPaths, m.fieldPath);
    if (Number.isFinite(m.routedAtMs)) {
      if (m.routedAtMs < acc.firstRoutedAtMs) acc.firstRoutedAtMs = m.routedAtMs;
      if (m.routedAtMs > acc.lastRoutedAtMs) acc.lastRoutedAtMs = m.routedAtMs;
    }
  }

  const all = [...bySurface.values()];
  const classed = all.filter((a) => a.memberCount >= minMembers);
  classed.sort((a, b) => b.memberCount - a.memberCount || a.toolName.localeCompare(b.toolName));
  const classedMembers = classed.reduce((sum, a) => sum + a.memberCount, 0);
  const classedOpenMembers = classed.reduce((sum, a) => sum + a.openMemberCount, 0);
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.trunc(opts.limit) : undefined;
  const shown = limit === undefined ? classed : classed.slice(0, limit);

  return {
    classes: shown.map((a) => ({
      toolName: a.toolName,
      memberCount: a.memberCount,
      memberIds: a.memberIds,
      memberIdsTruncated: a.memberIds.length < a.memberCount,
      openMemberCount: a.openMemberCount,
      openMemberIds: a.openMemberIds,
      byOrigin: a.byOrigin,
      byState: a.byState,
      errorCodes: rankedKeys(a.errorCodes),
      fieldPaths: rankedKeys(a.fieldPaths),
      firstRoutedAtMs: a.firstRoutedAtMs,
      lastRoutedAtMs: a.lastRoutedAtMs,
    })),
    minMembers,
    totalMembers,
    distinctSurfaces: all.length,
    classedSurfaces: classed.length,
    classedMembers,
    classedOpenMembers,
    unclassedMembers: totalMembers - classedMembers,
    classesTruncated: shown.length < classed.length,
  };
}

interface MemberRow {
  work_item_id: string;
  origin: string;
  tool_name: string | null;
  error_code: string | null;
  status: string | null;
  field_path: string | null;
  member_state: string | null;
  routed_at: number | string | null;
}

/**
 * Read the structured `toolFailure` filings in the ACTIONABLE ungraded population.
 *
 * The WHERE clauses MIRROR `classifyUngraded`'s `actionable` bucket (ungraded, artifact
 * open, at/after this row's own producer floor) and resolve `epoch_ms` per row from the
 * policy jsonb exactly as `readUngradedBreakdown` does — so a policy that gains an origin
 * needs no change here, and the two reads cannot disagree about which rows are eligible.
 *
 * `origin` is an optional FILTER. Omitted, every non-shadow producer is aggregated.
 */
export async function readFilingClassMembers(
  sql: Sql,
  args: {
    workspaceId: string;
    harnessSlug?: string;
    origin?: string;
    policy?: UngradedEpochPolicy;
    /** Row cap on the underlying read; the census reports what it saw. */
    maxRows?: number;
  },
): Promise<FilingClassMemberLike[]> {
  const policy = args.policy ?? DEFAULT_UNGRADED_EPOCH_POLICY;
  const floors = JSON.stringify(policy.byOrigin);
  const fallback = policy.fallbackMs;
  const maxRows = Math.max(1, Math.trunc(args.maxRows ?? 5000));
  const harnessClause = args.harnessSlug ? sql`AND r.harness_slug = ${args.harnessSlug}` : sql``;
  const originClause = args.origin ? sql`AND r.origin = ${args.origin}` : sql``;

  const rows = await sql<MemberRow[]>`
    SELECT w.feature_id AS work_item_id,
           r.origin AS origin,
           w.payload -> 'toolFailureProbation' -> 'report' ->> 'toolName'   AS tool_name,
           w.payload -> 'toolFailureProbation' -> 'report' ->> 'errorCode'  AS error_code,
           w.payload -> 'toolFailureProbation' -> 'report' ->> 'status'     AS status,
           w.payload -> 'toolFailureProbation' -> 'report' ->> 'fieldPath'  AS field_path,
           w.status AS member_state,
           r.routed_at AS routed_at
      FROM harness_shared.scout_routed_ideas r
      JOIN harness_shared.work_items w
        ON w.feature_id = replace(r.routed_ref, 'wi:', '')
       AND w.harness_slug = r.harness_slug
     WHERE r.workspace_id = ${args.workspaceId}
       AND r.origin <> ${SHADOW_VARIANT_ORIGIN}
       ${harnessClause}
       ${originClause}
       AND r.human_grade IS NULL
       AND (r.outcome IS NULL OR r.outcome = 'pending')
       AND r.routed_at >= coalesce((${floors}::jsonb ->> r.origin)::bigint, ${fallback}::bigint)
       AND w.payload -> 'toolFailureProbation' -> 'report' ->> 'toolName' IS NOT NULL
     ORDER BY r.routed_at ASC
     LIMIT ${maxRows}`;

  return rows.map((row) => ({
    workItemId: row.work_item_id,
    origin: row.origin,
    toolName: row.tool_name ?? '',
    errorCode: row.error_code,
    status: row.status,
    fieldPath: row.field_path,
    memberState: row.member_state,
    routedAtMs: Number(row.routed_at ?? 0),
  }));
}

/** Read + fold in one call: the per-surface class census for a workspace. */
export async function readFilingClasses(
  sql: Sql,
  args: Parameters<typeof readFilingClassMembers>[1] & { minMembers?: number; limit?: number },
): Promise<FilingClassCensus> {
  const members = await readFilingClassMembers(sql, args);
  return summarizeFilingClasses(members, { minMembers: args.minMembers, limit: args.limit });
}

/**
 * The ONLY relationship a class row may write to a member.
 *
 * A literal union of one, on purpose (D-001). `duplicates` would license a de-duplicator
 * to close members; nothing in this module can express that, so a later edit that wants a
 * destructive edge has to change this type and trip the guard test that pins it.
 */
export type FilingClassMemberRel = 'relates';

/** The additive class item a caller may file: a NEW row that CITES its members. */
export interface FilingClassItemDraft {
  title: string;
  body: string;
  /** One non-destructive citation edge per cited member. */
  links: Array<{ rel: FilingClassMemberRel; targetId: string }>;
  /** Machine-readable class identity, so a second run recognises this row instead of re-filing. */
  payload: {
    filingClass: {
      toolName: string;
      memberCount: number;
      memberIds: string[];
      memberIdsTruncated: boolean;
      openMemberCount: number;
      openMemberIds: string[];
      byState: Record<string, number>;
      byOrigin: Record<string, number>;
      errorCodes: string[];
      fieldPaths: string[];
      minMembers: number;
      aggregatedAtMs: number;
    };
  };
}

/**
 * PURE: build the additive class item for one class.
 *
 * Emits citation edges and nothing else. There is deliberately no code path here that
 * closes, merges, re-parents or edits a member — the members are the grading and
 * attribution substrate, and this row is an addition to the queue, not a replacement of
 * thirteen rows in it.
 */
export function buildFilingClassItemDraft(
  cls: FilingClass,
  opts: { nowMs: number; minMembers?: number },
): FilingClassItemDraft {
  const minMembers = Math.max(1, Math.trunc(opts.minMembers ?? FILING_CLASS_MIN_MEMBERS));
  const origins = rankedKeys(cls.byOrigin);
  const codes = cls.errorCodes.length ? cls.errorCodes.join(', ') : 'none recorded';
  const fields = cls.fieldPaths.length ? cls.fieldPaths.join(', ') : 'none recorded';
  const citedNote = cls.memberIdsTruncated
    ? `${cls.memberIds.length} of ${cls.memberCount} member ids cited (list bounded)`
    : `all ${cls.memberCount} member ids cited`;

  const body = [
    `${cls.memberCount} independent ungraded filings name \`${cls.toolName}\` in their structured`,
    `\`toolFailure\` report. Each was filed separately by an agent that could not see the others,`,
    `so the defect class has been costing ${cls.memberCount} triage decisions instead of one.`,
    '',
    `- surface: \`${cls.toolName}\``,
    `- members: ${cls.memberCount} (${citedNote}); threshold for a class is ${minMembers}`,
    `- still live: ${cls.openMemberCount} of ${cls.memberCount} — member states: ${
      rankedKeys(cls.byState).map((s) => `${s} ${cls.byState[s]}`).join(', ') || 'unknown'
    }`,
    `- producers: ${origins.length ? origins.map((o) => `${o} ${cls.byOrigin[o]}`).join(', ') : 'unknown'}`,
    `- error codes observed: ${codes}`,
    `- field paths observed: ${fields}`,
    `- first filed: ${new Date(cls.firstRoutedAtMs).toISOString()}`,
    `- last filed: ${new Date(cls.lastRoutedAtMs).toISOString()}`,
    '',
    'Members (cited, NOT merged or closed — each stays independently findable, gradable and',
    'attributable to the agent that filed it; agent-review-filing-rail-and-class-aggregation-2026-09-05 D-001):',
    ...cls.memberIds.map((id) => `- ${id}`),
    ...(cls.memberIdsTruncated ? ['', `(+${cls.memberCount - cls.memberIds.length} further members not listed)`] : []),
  ].join('\n');

  return {
    title: `Tool-contract defect class: ${cls.memberCount} ungraded filings against \`${cls.toolName}\``,
    body,
    links: cls.memberIds.map((targetId) => ({ rel: 'relates' as const, targetId })),
    payload: {
      filingClass: {
        toolName: cls.toolName,
        memberCount: cls.memberCount,
        memberIds: cls.memberIds,
        memberIdsTruncated: cls.memberIdsTruncated,
        openMemberCount: cls.openMemberCount,
        openMemberIds: cls.openMemberIds,
        byState: cls.byState,
        byOrigin: cls.byOrigin,
        errorCodes: cls.errorCodes,
        fieldPaths: cls.fieldPaths,
        minMembers,
        aggregatedAtMs: opts.nowMs,
      },
    },
  };
}
