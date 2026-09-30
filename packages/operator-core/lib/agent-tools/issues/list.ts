/**
 * issues:list — the READ side of the issue surface
 * (`harness_shared.engineer_issues`), plan sql-escape-tool-routing-2026-08-12
 * P-006.
 *
 * Until now only the WRITE side had a verb (`improvements:capture`) plus two
 * opinionated views (`improvements:digest` builds an ideation digest,
 * `improvements:triage` a triage queue). Neither is a plain list, so agents
 * hand-wrote SQL: classified over the 14-day corpus, GENUINE reads of this
 * relation are 686 calls across 83 AGENTS — the largest agent population in
 * the whole audit. (The item's headline "628 calls" was inflated by one
 * agent's 371-call `pg_stat_activity` probe that merely MENTIONS the table
 * inside a filter string; classifying first, rather than ranking by count,
 * is what separated 83 real readers from 8 perf investigators.)
 *
 * Measured predicate demand among those genuine reads:
 *   aggregate / GROUP BY   47 agents   <- the largest, hence `rollup`
 *   state                  35
 *   scope                  32
 *   kind                   21
 *   payload->observation   18
 *
 * REUSE: this adds no SQL. `listIssues` / `countIssues` / `countIssuesByState`
 * / `countObservationsByKind` already exist in issues-engineer.ts with a rich,
 * heavily-documented filter; the gap was purely that none of it was reachable
 * as a tool. `improvements:digest` could NOT absorb this — it takes only
 * { state, limit, harnessSlug }, with no scope, kind, or aggregate mode.
 *
 * TWO TRAPS THIS VIEW DOCUMENTS, both made unrepresentable here:
 *  1. `scope` on the VIEW is 'harness:<slug>' | 'operator', and has NO
 *     counterpart on the underlying work_items TABLE (which scopes by
 *     harness_slug + workspace_id). A predicate moved between the two matches
 *     ZERO rows instead of erroring. `scope` here accepts a bare slug and
 *     normalises it, so the prefix cannot be forgotten.
 *  2. `severity` is a REAL COLUMN on the view. Until migration 1096 the nested
 *     `payload->'_ei'->>'severity'` was NULL for EVERY row (measured: 0 via that
 *     path vs 34,566 via the column) — a confident wrong answer rather than an
 *     error. 1096 restored the `_ei` blob, so that path now resolves and agrees
 *     except on NULL-payload rows, where only the column reports its 'minor'
 *     default. Callers get the column, which is the one correct on every row.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  listIssues,
  countIssues,
  countIssuesByState,
  countObservationsByKind,
  ISSUE_SEVERITIES,
  ISSUE_STATES,
  type ListIssuesFilter,
} from '../../issues-engineer';
import {
  censusFromCounts,
  describeCensus,
  withShownCount,
  type PopulationCensus,
  type PopulationDenominator,
  type PopulationMeta,
} from '../../population-census';

const DEFAULT_LIMIT = 30;

/**
 * THE DISCRIMINATING FILTERS — the ones that select WITHIN a corpus rather than
 * choosing which corpus is read (P-021, silent-wrong-answers-2026-08-01).
 *
 * `scope`, `kinds` and `lane` say which population a call is ABOUT; these say
 * which part of it the caller wanted. A base rate has to strip exactly these
 * and no others, because the question a denominator answers is "is that many or
 * few FOR THIS CORPUS?" — and stripping `lane` would answer it against a
 * different corpus entirely: the observation lane outnumbers the work lane
 * ~8:1 here, so a work-lane count divided by an all-lane denominator reads as
 * an order-of-magnitude anomaly that is not one.
 */
const NARROWING_KEYS = ['state', 'severity', 'assignee', 'q', 'topic'] as const;

/**
 * Build the base-rate census for a filtered issue read.
 *
 * `counted` is exact here — a COUNT over the filter, never a page length. The
 * base rate is the only measurement that can degrade, so it degrades IN-BAND
 * (`not-measured`) rather than to a zero or a thrown error: "I could not size
 * the corpus" changes what a reader may conclude, while a missing denominator
 * just reads as a clean total.
 *
 * `countPopulation` is injected rather than called directly so the three
 * denominator outcomes — measured, bounded, unmeasurable — are reachable in a
 * test without a database, which is the only way the two degraded ones get
 * exercised at all.
 */
export async function issueBaseRateCensus(
  counted: number,
  opts: {
    narrowedBy: readonly string[];
    meta: PopulationMeta;
    countPopulation: () => Promise<number>;
  },
): Promise<PopulationCensus> {
  let denominator: PopulationDenominator;
  if (opts.narrowedBy.length === 0) {
    // Nothing was narrowed, so the filtered count IS the population — measured
    // by construction, and one query cheaper than proving it again.
    denominator = { status: 'measured', candidates: counted };
  } else {
    try {
      const candidates = await opts.countPopulation();
      denominator =
        candidates >= counted
          ? { status: 'measured', candidates }
          : {
              // Two COUNTs at two instants. A corpus that moved between them can
              // return a population SMALLER than the slice it contains, and
              // publishing that as a total would print a negative `withheld` —
              // the exact shape of confidently-wrong this guards against. The
              // larger of the two is a floor, so say floor.
              status: 'bounded',
              atLeast: counted,
              boundedBy:
                'a concurrent write moved the corpus between the population query ' +
                'and the filtered one, so this total is a lower bound',
            };
    } catch (err) {
      denominator = {
        status: 'not-measured',
        reason: `base-rate probe failed: ${err instanceof Error ? err.message : String(err)}`,
        measureWith: 'issues:list with only scope/kinds/lane set',
      };
    }
  }
  return censusFromCounts(counted, denominator, opts.meta);
}

/**
 * The view's scope is 'operator' or 'harness:<slug>'. Agents reach for the
 * bare harness slug (it is what every other tool takes), and a bare slug
 * silently matches nothing here — so normalise rather than refuse.
 */
export function normalizeScope(scope: string): string {
  const s = scope.trim();
  if (s === 'operator' || s.includes(':')) return s;
  return `harness:${s}`;
}

export default defineTool({
  name: 'issues:list',
  description:
    'List issue-family work items (bug/change) from harness_shared.engineer_issues: filter by state, scope, kind, severity, assignee, lane, or free text. `rollup:"state"|"observationKind"` returns counts instead of rows. `scope` accepts a bare harness slug and is normalised to the view\'s "harness:<slug>" form. Excludes `task` items unless you ask for them. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'Read filed issues/observations — what is open in a scope, how many by state, or find one by text — instead of hand-writing SELECT over harness_shared.engineer_issues.',
    notWhen:
      'To FILE one use improvements:capture. For what is CLAIMABLE right now use work_items:claimable (a status=open query is not claimability). For the deduped ideation digest use improvements:digest; for the triage queue use improvements:triage. For observations specifically, pass lane:"observation" here.',
    chaining:
      'rollup:"state" to size the backlog → rows with the interesting state → work_items:get for the full record, or improvements:resolve to close one.',
    // Response docs live in `returns` — description/when are prompt-weight
    // budgeted (the guard refused the P-002 edit on routines:list).
    returns: [
      '{ count, total, truncatedByLimit, issues } (or { rollup, counts, total } for rollup) — `issues` rows are { id, kind, scope, title, severity, state, assignee, createdAt, updatedAt, closedAt } plus `body` only when includeBody:true. (`lane` is a FILTER here, not a returned field.)',
      'For anything time-of-close read `closedAt`, not `updatedAt` — updatedAt moves on any write.',
      '`count` = rows returned; `total` = rows MATCHING the filter independent of `limit`; `truncatedByLimit` says whether they differ, so a capped list is never read as a total.',
      '`population` is the BASE RATE for `total` — the same corpus with state/severity/assignee/q/topic stripped, so you can tell whether the number is many or few. Read `candidatesStatus` before `candidates`: `not-measured` means the corpus could not be sized (never zero), `bounded` means it is a floor. `populationNote` states it in one sentence.',
      'rollup:"state" → { open, wip, done, … } counts. rollup:"observationKind" → counts by payload->observation->>kind. Both are computed over the whole filtered set, not the page.',
      'body is OMITTED by default: it is 76% of this read\'s bytes (measured 1607kB → 389kB with it dropped). Ask for it explicitly when you need it.',
      'Only bug|change are returned by default — `task` items are a work_item kind that the issues surface deliberately excludes; pass kinds to include them.',
      'severity is a real column here (critical|major|minor|nit) — read it. Migration 1096 restored the `_ei` blob on this view, so payload->\'_ei\'->>\'severity\' now resolves and agrees on all but NULL-payload rows, where only the column reports the \'minor\' default. Prefer the column: it is the one correct on every row.',
    ].join(' '),
    seeAlso: [
      'improvements:capture (file one)',
      'work_items:claimable (what is claimable NOW — not a status=open query)',
      'improvements:digest (deduped ideation digest)',
      'improvements:triage (the triage queue)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    state: z.enum(ISSUE_STATES as unknown as [string, ...string[]]).optional().describe('Lifecycle state.'),
    scope: z
      .string()
      .max(120)
      .optional()
      .describe('Issue scope — a bare harness slug ("papercusp") is normalised to "harness:papercusp"; "operator" is also valid.'),
    kinds: z
      .array(z.enum(['bug', 'change', 'task']))
      .min(1)
      .optional()
      .describe('Kinds to include. Default bug+change; pass explicitly to include `task`.'),
    severity: z.enum(ISSUE_SEVERITIES as unknown as [string, ...string[]]).optional(),
    assignee: z.string().max(120).optional().describe('Filter to one assignee ownerId.'),
    lane: z
      .string()
      .max(60)
      .optional()
      .describe('Row lane — lane:"observation" is the canonical way to select the observation population (prefer this over the topic form, which is lossy both ways).'),
    q: z.string().max(200).optional().describe('Case-insensitive substring matched against title + body.'),
    topic: z.string().max(120).optional().describe('Issues tagged with this topic.'),
    includeBody: z.boolean().optional().describe('Include the body column (omitted by default — it is 76% of the bytes).'),
    rollup: z
      .enum(['state', 'observationKind'])
      .optional()
      .describe('Return counts instead of rows, over the whole filtered set.'),
    limit: z.number().int().min(1).max(200).optional().describe(`Max rows (default ${DEFAULT_LIMIT}).`),
  }),
  result: z
    .object({
      count: z.number().int().nonnegative().optional(),
      total: z.number().int().nonnegative(),
      truncatedByLimit: z.boolean().optional(),
      issues: z.array(z.unknown()).optional(),
      rollup: z.enum(['state', 'observationKind']).optional(),
      counts: z.record(z.string(), z.number()).optional(),
      population: z.unknown().optional(),
      populationNote: z.string().optional(),
    })
    .passthrough(),
  async handler(args: {
    state?: string;
    scope?: string;
    kinds?: Array<'bug' | 'change' | 'task'>;
    severity?: string;
    assignee?: string;
    lane?: string;
    q?: string;
    topic?: string;
    includeBody?: boolean;
    rollup?: 'state' | 'observationKind';
    limit?: number;
  }) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const filter = {
      ...(args.state ? { state: args.state } : {}),
      ...(args.scope ? { scope: normalizeScope(args.scope) } : {}),
      ...(args.kinds ? { kinds: args.kinds } : {}),
      ...(args.severity ? { severity: args.severity } : {}),
      ...(args.assignee ? { assignee: args.assignee } : {}),
      ...(args.lane ? { lane: args.lane } : {}),
      ...(args.q ? { q: args.q } : {}),
      ...(args.topic ? { topic: args.topic } : {}),
    } as ListIssuesFilter;

    // The SAME read with the discriminating predicates stripped — the corpus
    // this call is a slice OF. Built from `args`, not by deleting keys from
    // `filter`, so a filter added later cannot silently join the denominator.
    const populationFilter = {
      ...(args.scope ? { scope: normalizeScope(args.scope) } : {}),
      ...(args.kinds ? { kinds: args.kinds } : {}),
      ...(args.lane ? { lane: args.lane } : {}),
    } as ListIssuesFilter;
    const narrowedBy = NARROWING_KEYS.filter((k) => args[k] != null);
    const meta: PopulationMeta = {
      population: 'issue-family rows',
      basis:
        `${(args.kinds ?? ['bug', 'change']).join('+')} rows in ` +
        `${args.scope ? normalizeScope(args.scope) : 'every scope'}` +
        `${args.lane ? ` on lane '${args.lane}'` : ''}`,
      withheldReason: `narrowed by ${narrowedBy.join(', ')}`,
      reveal: `re-run without ${narrowedBy.join('/')}`,
    };

    const censusFor = (counted: number): Promise<PopulationCensus> =>
      issueBaseRateCensus(counted, {
        narrowedBy,
        meta,
        countPopulation: () => countIssues(populationFilter),
      });

    if (args.rollup === 'state') {
      const counts = await countIssuesByState(filter);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const population = await censusFor(total);
      return {
        data: { rollup: 'state', counts, total, population, populationNote: describeCensus(population) },
      };
    }
    if (args.rollup === 'observationKind') {
      const counts = await countObservationsByKind(filter);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const population = await censusFor(total);
      return {
        data: {
          rollup: 'observationKind',
          counts,
          total,
          population,
          populationNote: describeCensus(population),
        },
      };
    }

    // `total` comes from countIssues over the SAME filter, never from the page
    // length — a count derived from a limited fetch restates `limit` as if it
    // were a measurement.
    const [rows, total] = await Promise.all([
      // WI-42508: this tool never returns the issue payload, so do not make
      // postgres-js parse it just to discard it while shaping the response.
      // `includeBody` remains an explicit caller choice and is independent.
      listIssues({
        ...filter,
        limit,
        includeBody: args.includeBody === true,
        includePayload: false,
      }),
      countIssues(filter),
    ]);

    // `shown` is the transport's verdict, `counted` the filter's. Keeping them
    // as separate fields is what stops a page length being read as a total —
    // the same distinction `truncatedByLimit` makes, carried in the shape the
    // census renders from so the sentence and the booleans cannot disagree.
    const population = withShownCount(await censusFor(total), rows.length, `limit ${limit}`);

    return {
      data: {
        count: rows.length,
        total,
        truncatedByLimit: total > rows.length,
        population,
        populationNote: describeCensus(population),
        issues: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          scope: r.scope,
          title: r.title,
          severity: r.severity,
          state: r.state,
          assignee: r.assignee ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          // Documented on EngineerIssue: read this, not updatedAt, for
          // time-of-close — updatedAt moves on any write.
          closedAt: r.closedAt,
          ...(args.includeBody === true ? { body: r.body } : {}),
        })),
      },
    };
  },
});
