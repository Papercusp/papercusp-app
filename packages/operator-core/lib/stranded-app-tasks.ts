/**
 * Stranded app-task guard — plan app-agent-tasks-durable-execution-2026-10-06 P-005.
 *
 * THE INCIDENT IT GUARDS. 129 `email-draft-proposal` work-items sat `open`, never
 * claimed, for 2–5 weeks (2026-08-29..09-15). An app trigger binding minted them
 * directly into the `email` harness; no executor existed for that kind there, and
 * nothing anywhere noticed. The only claimability detector that existed — the daily
 * `system:unclaimed-work-digest` — digests ONE configured harness (`papercusp`), so
 * a whole other harness filling up with dead tasks was invisible to it.
 *
 * WHAT IT FLAGS. An APP-CREATED work-item — minted by a trigger binding (its payload
 * carries `triggerRef`) or the root work-item of a blueprint operation
 * (`blueprint_operation_invocations.target_kind = 'work-item'`) — that is still
 * `open`, has NEVER been claimed (`first_claimed_at IS NULL`, no `taken_by`), and
 * is older than a bound. Rows are grouped per (workspace, harness, item_kind):
 * "this kind has no executor in this harness" is one condition, not N.
 *
 * HOW IT FLAGS. One condition-upsert work-item per group, keyed
 * `app-task-no-executor:<workspace>/<harness>/<kind>`, filed in the routine's own
 * (operator-home) harness so the flag itself cannot strand in a harness nobody
 * watches. Re-firing refreshes the same row. Condition-upsert filings never settle
 * themselves, so this guard owns the other half: when a group clears, its
 * still-unclaimed flag is dropped with the reason. A flag somebody claimed is left
 * alone — the claimant owns its close.
 *
 * REUSE. Runs inside the existing `system:unclaimed-work-digest` routine (the one
 * claimability detector that already ticks) instead of minting a new routine; the
 * digest was extended rather than forked. See that action for the wiring.
 */
import { getOrgPg } from '@papercusp/db-org';

export const STRANDED_APP_TASK_CONDITION_PREFIX = 'app-task-no-executor';
export const STRANDED_APP_TASK_ACTOR = 'system:stranded-app-task-guard';
/** An app task an executor would pick up in minutes; six hours untouched is a dead lane. */
export const DEFAULT_STRANDED_APP_TASK_BOUND_HOURS = 6;
const SAMPLE_IDS = 5;

export interface StrandedAppTaskGroup {
  workspaceId: string;
  harnessSlug: string;
  itemKind: string;
  count: number;
  oldestId: string;
  /** ISO-8601 creation time of the oldest stranded row. */
  oldestCreatedAt: string;
  sampleIds: string[];
  /** How many rows came from a trigger binding vs a blueprint operation root. */
  fromTrigger: number;
  fromOperation: number;
}

export interface StrandedAppTaskFlag {
  conditionKey: string;
  id: string;
  harnessSlug: string;
}

export interface StrandedAppTaskGuardDeps {
  fetchGroups(): Promise<StrandedAppTaskGroup[]>;
  upsertFlag(conditionKey: string, filing: { title: string; summary: string }): Promise<{ id: string; created: boolean }>;
  /** Open, unclaimed flags this guard previously filed for the workspace. */
  listOpenFlags(): Promise<StrandedAppTaskFlag[]>;
  settleFlag(flag: StrandedAppTaskFlag, reason: string): Promise<void>;
}

export interface StrandedAppTaskGuardResult {
  groups: number;
  strandedTasks: number;
  flagged: Array<{ conditionKey: string; id: string; created: boolean; count: number }>;
  settled: string[];
  errors: Array<{ conditionKey: string; error: string }>;
}

export function strandedAppTaskConditionKey(g: Pick<StrandedAppTaskGroup, 'workspaceId' | 'harnessSlug' | 'itemKind'>): string {
  return `${STRANDED_APP_TASK_CONDITION_PREFIX}:${g.workspaceId}/${g.harnessSlug}/${g.itemKind}`;
}

function hoursSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3_600_000);
}

/** The flag's title + summary. Pure. Names the evidence and the two honest dispositions. */
export function composeStrandedAppTaskFiling(
  group: StrandedAppTaskGroup,
  opts: { boundHours: number; now?: Date },
): { title: string; summary: string } {
  const now = opts.now ?? new Date();
  const age = hoursSince(group.oldestCreatedAt, now);
  const ageText = age >= 48 ? `${Math.round(age / 24)}d` : `${Math.round(age)}h`;
  const origin = [
    group.fromTrigger > 0 ? `${group.fromTrigger} from a trigger binding` : null,
    group.fromOperation > 0 ? `${group.fromOperation} from a blueprint operation` : null,
  ].filter(Boolean).join(', ');
  const title =
    `${group.count} app-created '${group.itemKind}' task(s) in harness '${group.harnessSlug}' ` +
    `have no executor — never claimed, oldest ${ageText}`;
  const summary = [
    `Stranded app tasks (bound: never claimed for more than ${opts.boundHours}h).`,
    `Harness \`${group.harnessSlug}\`, kind \`${group.itemKind}\`: ${group.count} open row(s) (${origin}).`,
    `Oldest: ${group.oldestId}, created ${group.oldestCreatedAt}. Sample: ${group.sampleIds.join(', ')}.`,
    `Nothing in this harness claims this kind. Either give it an executor (declare the task as a ` +
      `blueprint operation with a worker role, per plan app-agent-tasks-durable-execution-2026-10-06), ` +
      `or disposition the rows (drop them with a reason) if they are no longer wanted. Executing ` +
      `long-stale rows can produce stale output.`,
    `List: work_items:list { harness: "${group.harnessSlug}", kind: "${group.itemKind}", state: "open" }.`,
    `This flag is refreshed by the daily unclaimed-work digest and dropped automatically once ` +
      `no stranded row remains, unless someone has claimed it.`,
  ].join('\n\n');
  return { title, summary };
}

/** One sweep: flag every stranded group, settle every flag whose group cleared. */
export async function runStrandedAppTaskGuard(
  deps: StrandedAppTaskGuardDeps,
  opts: { boundHours: number; now?: Date },
): Promise<StrandedAppTaskGuardResult> {
  const groups = await deps.fetchGroups();
  const result: StrandedAppTaskGuardResult = {
    groups: groups.length,
    strandedTasks: groups.reduce((n, g) => n + g.count, 0),
    flagged: [],
    settled: [],
    errors: [],
  };
  const live = new Set<string>();
  for (const group of groups) {
    const conditionKey = strandedAppTaskConditionKey(group);
    live.add(conditionKey);
    try {
      const res = await deps.upsertFlag(conditionKey, composeStrandedAppTaskFiling(group, opts));
      result.flagged.push({ conditionKey, id: res.id, created: res.created, count: group.count });
    } catch (e) {
      result.errors.push({ conditionKey, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Settle only after every upsert, and only flags whose key is no longer live.
  for (const flag of await deps.listOpenFlags()) {
    if (live.has(flag.conditionKey)) continue;
    try {
      await deps.settleFlag(
        flag,
        `condition cleared: no app-created task of this kind is stranded any more (${STRANDED_APP_TASK_ACTOR})`,
      );
      result.settled.push(flag.id);
    } catch (e) {
      result.errors.push({ conditionKey: flag.conditionKey, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

interface GroupRow {
  harness_slug: string;
  item_kind: string;
  n: string | number;
  oldest_id: string;
  oldest_created_ms: string | number;
  sample_ids: string[];
  from_trigger: string | number;
  from_operation: string | number;
}

/** Production read of the stranded set for one workspace. */
export async function fetchStrandedAppTaskGroups(opts: {
  workspaceId: string;
  boundHours: number;
  now?: Date;
}): Promise<StrandedAppTaskGroup[]> {
  const { sql } = getOrgPg();
  const cutoffMs = (opts.now ?? new Date()).getTime() - opts.boundHours * 3_600_000;
  const rows = await sql<GroupRow[]>`
    WITH candidates AS (
      SELECT w.harness_slug, w.item_kind, w.feature_id, w.created_ts,
             (w.payload ? 'triggerRef') AS from_trigger,
             EXISTS (
               SELECT 1 FROM harness_shared.blueprint_operation_invocations i
                WHERE i.workspace_id = w.workspace_id
                  AND i.target_kind = 'work-item'
                  AND i.target_ref = w.feature_id
             ) AS from_operation
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${opts.workspaceId}
         AND w.status = 'open'
         AND w.lane IS DISTINCT FROM 'observation'
         AND w.first_claimed_at IS NULL
         AND w.taken_by IS NULL
         AND w.condition_key IS NULL
         AND w.created_ts < ${cutoffMs}
    )
    SELECT harness_slug, item_kind,
           count(*) AS n,
           (array_agg(feature_id ORDER BY created_ts ASC))[1] AS oldest_id,
           min(created_ts) AS oldest_created_ms,
           (array_agg(feature_id ORDER BY created_ts ASC))[1:${SAMPLE_IDS}] AS sample_ids,
           count(*) FILTER (WHERE from_trigger) AS from_trigger,
           count(*) FILTER (WHERE from_operation) AS from_operation
      FROM candidates
     WHERE from_trigger OR from_operation
     GROUP BY harness_slug, item_kind
     ORDER BY harness_slug, item_kind`;
  return rows.map((r) => ({
    workspaceId: opts.workspaceId,
    harnessSlug: r.harness_slug,
    itemKind: r.item_kind,
    count: Number(r.n),
    oldestId: r.oldest_id,
    oldestCreatedAt: new Date(Number(r.oldest_created_ms)).toISOString(),
    sampleIds: r.sample_ids,
    fromTrigger: Number(r.from_trigger),
    fromOperation: Number(r.from_operation),
  }));
}

/** Production deps for one workspace; flags are filed in `flagHarness` (the routine's home). */
export function productionStrandedAppTaskGuardDeps(opts: {
  workspaceId: string;
  flagHarness: string;
  boundHours: number;
}): StrandedAppTaskGuardDeps {
  return {
    fetchGroups: () => fetchStrandedAppTaskGroups(opts),
    upsertFlag: async (conditionKey, filing) => {
      const { upsertConditionWorkItem } = await import('./coord/condition-upsert');
      const res = await upsertConditionWorkItem(conditionKey, {
        kind: 'task',
        title: filing.title,
        summary: filing.summary,
        severity: 'major',
        createdBy: STRANDED_APP_TASK_ACTOR,
        harness: opts.flagHarness,
        workspaceId: opts.workspaceId,
      } as never);
      return { id: String(res.id), created: res.created };
    },
    listOpenFlags: async () => {
      const { sql } = getOrgPg();
      const { ANY_FAMILY_TERMINAL_STATES } = await import('./work-item-dispatch-states');
      const rows = await sql<{ feature_id: string; condition_key: string; harness_slug: string }[]>`
        SELECT feature_id, condition_key, harness_slug
          FROM harness_shared.work_items
         WHERE workspace_id = ${opts.workspaceId}
           AND condition_key LIKE ${`${STRANDED_APP_TASK_CONDITION_PREFIX}:${opts.workspaceId}/%`}
           AND taken_by IS NULL
           AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))`;
      return rows.map((r) => ({ conditionKey: r.condition_key, id: r.feature_id, harnessSlug: r.harness_slug }));
    },
    settleFlag: async (flag, reason) => {
      const { setWorkItemState } = await import('./work-items');
      await setWorkItemState(flag.id, 'dropped', {
        harness: flag.harnessSlug,
        by: STRANDED_APP_TASK_ACTOR,
        completionRef: reason,
      });
    },
  };
}
