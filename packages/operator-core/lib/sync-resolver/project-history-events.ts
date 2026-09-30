/**
 * projectHistoryEvents — the LIVE half of the History tab (plan
 * project-history-tab-desktop-and-portal-2026-09-16, P-009 / D-002).
 *
 * The History tab has two views over the same surface:
 *   - `?view=archive` — the generated ProjectHistoryView document (P-001/P-002).
 *   - `?view=live`    — a reverse-chronological per-harness activity timeline,
 *                       which is what this module feeds.
 *
 * It is a UNION of the timestamped lifecycle columns that already exist, not a
 * new event log: nothing here writes, and no new table is introduced. That is
 * deliberate — the events are DERIVED from the same rows the rest of the
 * operator already treats as canonical, so the timeline cannot drift from the
 * work-items and plans it describes.
 *
 * Sources (all in harness_shared):
 *   work_items         -> created / claimed / state-changed / checkpoint / completed
 *   plan_items         -> plan-item status flips
 *   harness_plan_parts -> plan decisions (kind = 'decision')
 *
 * TIMESTAMP NORMALISATION: the backing columns are deliberately mixed types —
 * `work_items.created_ts` / `closed_ts` and `harness_plan_parts.created_at` /
 * `updated_at` are **bigint epoch-ms**, while `work_items.first_claimed_at` /
 * `state_changed_at` / `last_progress_at` and `plan_items.updated_at` are
 * **timestamptz**. Every branch below normalises to epoch-ms bigint so a single
 * ORDER BY is meaningful across sources. Getting this wrong does not error — it
 * silently interleaves 1970 with today — so the conversion lives in exactly one
 * place per branch and is asserted by the unit test.
 *
 * OBSERVATION LANE IS EXCLUDED. A raw predicate over `work_items` is mostly
 * `lane = 'observation'` (turn-end agent reflections, never triaged work); the
 * work_items:* tools all default to excluding them and raw SQL has no such
 * default. A project history timeline wants WORK, so the exclusion is explicit.
 */

import { z } from 'zod';
import type { OrgSql } from '../work-items';

export const PROJECT_HISTORY_EVENTS_QUERY_NAME = 'projectHistoryEvents.byHarness';

/** Tables whose writes must invalidate this query (see ./table-to-query-names). */
export const PROJECT_HISTORY_EVENTS_BACKING_TABLES = [
  'harness_shared.work_items',
  'harness_shared.plan_items',
  'harness_shared.harness_plan_parts',
] as const;

export const PROJECT_HISTORY_EVENT_KINDS = [
  'work-item.created',
  'work-item.claimed',
  'work-item.state-changed',
  'work-item.checkpoint',
  'work-item.completed',
  'plan-item.status',
  'plan.decision',
] as const;

export type ProjectHistoryEventKind = (typeof PROJECT_HISTORY_EVENT_KINDS)[number];

export type ProjectHistorySubjectKind = 'work-item' | 'plan-item' | 'plan-decision';

/**
 * The CONSUMER CONTRACT. P-010's `ActivityTimelineView` renders exactly these
 * fields and P-011 pages with them; treat a field rename here as a breaking
 * change to both.
 */
export interface ProjectHistoryEventRow {
  /** Stable identity: `${kind}:${subjectId}:${tsMs}`. Safe as a React key and
   *  as a dedupe key when a live SSE page overlaps an already-rendered one. */
  eventId: string;
  kind: ProjectHistoryEventKind;
  /** Epoch milliseconds, normalised across the mixed backing column types. */
  tsMs: number;
  /** Who caused it, where the row records that. Null is honest, not empty. */
  actor: string | null;
  subjectKind: ProjectHistorySubjectKind;
  /** `WI-123` | `<plan-slug>#P-004` | `<plan-slug>#<part-key>`. */
  subjectId: string;
  title: string;
  /** Status AT THE TIME the row was last written — for a state-changed or
   *  status-flip event this is the destination state. */
  status: string | null;
  planSlug: string | null;
  harnessSlug: string;
}

export const projectHistoryEventsArgsSchema = z.object({
  harnessSlug: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  /** Inclusive LOWER bound (epoch ms). The live-tail filter: "what happened
   *  since I last rendered". */
  sinceMs: z.number().int().nonnegative().optional(),
  /** Exclusive UPPER bound (epoch ms) — the backwards pager. Pass the last
   *  rendered row's `tsMs`, with `beforeEventId` as the tiebreak. */
  beforeMs: z.number().int().nonnegative().optional(),
  /** Tiebreak for `beforeMs`: several events legitimately share a millisecond,
   *  so a bare timestamp cursor silently drops rows at a page boundary. */
  beforeEventId: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export type ProjectHistoryEventsArgs = z.infer<typeof projectHistoryEventsArgsSchema>;

interface ProjectHistoryEventDbRow {
  kind: string;
  ts_ms: string | number | null;
  actor: string | null;
  subject_kind: string;
  subject_id: string;
  title: string | null;
  status: string | null;
  plan_slug: string | null;
  harness_slug: string;
}

function toMs(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
}

export function buildEventId(kind: string, subjectId: string, tsMs: number): string {
  return `${kind}:${subjectId}:${tsMs}`;
}

function mapRow(row: ProjectHistoryEventDbRow): ProjectHistoryEventRow {
  const tsMs = toMs(row.ts_ms);
  return {
    eventId: buildEventId(row.kind, row.subject_id, tsMs),
    kind: row.kind as ProjectHistoryEventKind,
    tsMs,
    actor: row.actor ?? null,
    subjectKind: row.subject_kind as ProjectHistorySubjectKind,
    subjectId: row.subject_id,
    title: row.title ?? row.subject_id,
    status: row.status ?? null,
    planSlug: row.plan_slug ?? null,
    harnessSlug: row.harness_slug,
  };
}

/**
 * Read one reverse-chronological page.
 *
 * Ordering is `(tsMs, eventId) DESC` and the cursor is the same tuple, so a
 * page boundary that lands inside a group of same-millisecond events neither
 * repeats nor drops one.
 */
export async function readProjectHistoryEvents(
  sql: OrgSql,
  args: ProjectHistoryEventsArgs,
): Promise<ProjectHistoryEventRow[]> {
  const wsWorkItems = args.workspaceId
    ? sql`wi.workspace_id = ${args.workspaceId}`
    : sql`TRUE`;
  const wsPlanItems = args.workspaceId
    ? sql`pi.workspace_id = ${args.workspaceId}`
    : sql`TRUE`;
  const wsPlanParts = args.workspaceId
    ? sql`pp.workspace_id = ${args.workspaceId}`
    : sql`TRUE`;

  const rows = await sql<ProjectHistoryEventDbRow[]>`
    WITH work_item_events AS (
      SELECT k.kind,
             k.ts_ms,
             k.actor,
             'work-item'::text AS subject_kind,
             wi.feature_id     AS subject_id,
             wi.title,
             wi.status,
             wi.source_plan_slug AS plan_slug,
             wi.harness_slug
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL (
          VALUES
            ('work-item.created'::text,
             wi.created_ts,
             NULL::text),
            ('work-item.claimed'::text,
             (extract(epoch FROM wi.first_claimed_at) * 1000)::bigint,
             wi.taken_by),
            ('work-item.state-changed'::text,
             (extract(epoch FROM wi.state_changed_at) * 1000)::bigint,
             wi.taken_by),
            ('work-item.checkpoint'::text,
             (extract(epoch FROM wi.last_progress_at) * 1000)::bigint,
             wi.taken_by),
            ('work-item.completed'::text,
             wi.closed_ts,
             coalesce(wi.terminal_owner, wi.taken_by))
        ) AS k(kind, ts_ms, actor)
       WHERE wi.harness_slug = ${args.harnessSlug}
         AND ${wsWorkItems}
         AND wi.lane IS DISTINCT FROM 'observation'
         AND k.ts_ms IS NOT NULL
         AND k.ts_ms > 0
    ),
    plan_item_events AS (
      SELECT 'plan-item.status'::text AS kind,
             (extract(epoch FROM pi.updated_at) * 1000)::bigint AS ts_ms,
             NULL::text AS actor,
             'plan-item'::text AS subject_kind,
             pi.plan_slug || '#' || pi.item_id AS subject_id,
             pi.item_text AS title,
             pi.status,
             pi.plan_slug,
             pi.harness_slug
        FROM harness_shared.plan_items pi
       WHERE pi.harness_slug = ${args.harnessSlug}
         AND ${wsPlanItems}
         AND pi.updated_at IS NOT NULL
    ),
    plan_decision_events AS (
      SELECT 'plan.decision'::text AS kind,
             coalesce(pp.updated_at, pp.created_at) AS ts_ms,
             pp.author AS actor,
             'plan-decision'::text AS subject_kind,
             pp.plan_slug || '#' || pp.part_key AS subject_id,
             pp.body AS title,
             NULL::text AS status,
             pp.plan_slug,
             pp.harness_slug
        FROM harness_shared.harness_plan_parts pp
       WHERE pp.harness_slug = ${args.harnessSlug}
         AND ${wsPlanParts}
         AND pp.kind = 'decision'
         AND pp.tombstone IS NOT TRUE
         AND coalesce(pp.updated_at, pp.created_at) IS NOT NULL
    ),
    merged AS (
      SELECT * FROM work_item_events
      UNION ALL
      SELECT * FROM plan_item_events
      UNION ALL
      SELECT * FROM plan_decision_events
    ),
    keyed AS (
      SELECT m.*,
             m.kind || ':' || m.subject_id || ':' || m.ts_ms::text AS event_id
        FROM merged m
    )
    SELECT kind, ts_ms, actor, subject_kind, subject_id, title, status, plan_slug, harness_slug
      FROM keyed
     WHERE ${args.sinceMs === undefined ? sql`TRUE` : sql`ts_ms >= ${args.sinceMs}`}
       AND ${
         args.beforeMs === undefined
           ? sql`TRUE`
           : args.beforeEventId === undefined
             ? sql`ts_ms < ${args.beforeMs}`
             : sql`(ts_ms, event_id) < (${args.beforeMs}::bigint, ${args.beforeEventId}::text)`
       }
     ORDER BY ts_ms DESC, event_id DESC
     LIMIT ${args.limit}`;

  return rows.map(mapRow);
}

/** The dispatcher entry's resolve(). Returns the flat row array the v2
 *  registry contract requires. */
export async function resolveProjectHistoryEvents(rawArgs: unknown): Promise<unknown[]> {
  const args = projectHistoryEventsArgsSchema.parse(rawArgs);
  const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../workspace-registry'),
  ]);
  const scoped: ProjectHistoryEventsArgs = args.workspaceId
    ? args
    : { ...args, workspaceId: activeWorkspaceId() };
  return (await readProjectHistoryEvents(getOrgPg().sql, scoped)) as unknown[];
}
