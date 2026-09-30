/**
 * Zero-free named-query dispatcher — papercusp-dogfood-v5 P-022.
 *
 * Replaces the @rocicorp/zero-coupled resolver at apps/operator/lib/
 * zero-harness-resolver.ts incrementally. The legacy resolver looks
 * each name up in `@papercusp/zero-harness`'s registry, compiles a ZQL
 * expression to SQL via `zeroPostgresJS`, runs it. This module does
 * the same thing the dumb way: a switch-on-name table where each
 * entry runs hand-written SQL (or calls into an existing data-access
 * helper) and returns a flat row array.
 *
 * Migration strategy:
 *
 *   1. Each query name moves here one-at-a-time, in a separate
 *      commit. Adding an entry is purely additive — until callers
 *      switch to call `resolveNamedQueryV2`, the legacy resolver
 *      still serves the query.
 *
 *   2. Once all 51 live queryNames (audit run 2026-05-24) are
 *      represented here, the route handlers at
 *      apps/operator/lib/endpoint-route/routes/zero-harness/
 *      rest-query{,-batch}.ts switch from `resolveNamedQuery`
 *      to `resolveNamedQueryV2`. After verification, the legacy
 *      resolver + the @rocicorp/zero dep go.
 *
 *   3. The 1107-line @papercusp/zero-harness queries.ts stays as a
 *      structural reference (table → fields map is still useful)
 *      until P-067 — at which point both go together.
 *
 * Why hand-written instead of generic SQL compilation: we tried the
 * generic path with Zero; it works, but it pins us to the @rocicorp/zero
 * dep. The hand-written approach is ~30 LOC per query, totals ~1500
 * LOC for all 51 — equivalent in size to the queries.ts it replaces
 * minus the Zero runtime. Each entry is verifiable in isolation; no
 * runtime compilation, no Zero-specific schema duplication.
 *
 * Args validation: each registry entry brings its own zod schema (or
 * inline check). Names that take no args (e.g. some `*.recent` queries)
 * pass `args: {}`.
 *
 * Return shape: flat row array. Matches the contract `resolveNamedQuery`
 * already exposes. Some entries unwrap `{rows: [...]}` envelopes from
 * the underlying data helpers (e.g. listToasts → {toasts}); the unwrap
 * happens here so callers don't notice.
 */

import { z } from 'zod';
import { createResolver, type QueryRegistry } from '@papercusp/sync/server';
// Flat-row sync reads carry page metadata (e.g. the true total) on row[0]._meta;
// attachListMeta is the one place that convention lives. See ./list-meta.
import { attachListMeta } from './list-meta';
// WI-6382: degraded-snapshot provenance. A `learning.*` catch must never return
// a bare empty — that made a broken substrate byte-identical to an idle healthy
// one and left every panel's error branch unreachable for the data-layer class.
import { classifyReadFailure, degraded } from './degraded-snapshot';
import { createReadDeadline } from './read-deadline';
import { createCompanionListQueryPair, readCompanionSummary } from './bounded-list-read';
import {
  WORK_ITEMS_CURSOR_PAGE_LIMIT,
  WORK_ITEMS_FAIR_STATE_LIMIT,
  buildWorkItemsPredicate,
  normalizeWorkItemsListArgs,
  readWorkItemsPageFromStore,
  readWorkItemsSummaryFromStore,
  workItemsSummarySelection,
  type WorkItemsListWireArgs,
} from './work-items-list-query';
import {
  AGENT_RUNS_PAGE_LIMIT,
  agentRunsSummarySelection,
  buildAgentRunsPredicate,
  normalizeAgentRunsListArgs,
  readAgentRunsPageFromStore,
  readAgentRunsSummaryFromStore,
  type AgentRunsListWireArgs,
} from './agent-runs-list-query';
// P-009 — the live (`?view=live`) half of the History tab. Derived from the
// existing lifecycle columns; see ./project-history-events for why there is no
// new event table and how the mixed bigint/timestamptz columns are normalised.
import {
  PROJECT_HISTORY_EVENTS_QUERY_NAME,
  projectHistoryEventsArgsSchema,
  resolveProjectHistoryEvents,
} from './project-history-events';
import {
  SCORECARD_HISTORY_DEFAULT_PAGE,
  SCORECARD_HISTORY_PAGE_LIMIT,
  buildScorecardHistoryPredicate,
  normalizeScorecardHistoryArgs,
  readScorecardHistoryPage,
  readScorecardHistorySummary,
  type ScorecardHistoryWireArgs,
} from './scorecard-history-list-query';
import {
  ADV_SESSIONS_DEFAULT_PAGE,
  ADV_SESSIONS_PAGE_LIMIT,
  advSessionsSummarySelection,
  buildAdvSessionsPredicate,
  normalizeAdvSessionsListArgs,
  readAdvSessionsPageFromStore,
  readAdvSessionsSummaryFromStore,
  type AdvSessionsListWireArgs,
} from './adv-sessions-list-query';
import {
  DESIGN_FEATURES_DEFAULT_PAGE,
  DESIGN_FEATURES_PAGE_LIMIT,
  DESIGN_FEATURE_STATUSES,
  buildDesignFeaturesPredicate,
  designFeaturesSummarySelection,
  normalizeDesignFeaturesListArgs,
  readDesignFeaturesPageFromStore,
  readDesignFeaturesSummaryFromStore,
  type DesignFeaturesListWireArgs,
} from './design-features-list-query';
import {
  LEARNING_OBSERVATIONS_PAGE_LIMIT,
  buildLearningObservationsPredicate,
  isDefaultLearningObservationsPage,
  learningObservationsSummarySelection,
  normalizeLearningObservationsArgs,
  pageLearningObservationsSnapshot,
  readLearningObservationsPageFromStore,
  readLearningObservationsSummaryFromStore,
  type LearningObservationRow,
  type LearningObservationsWireArgs,
} from './learning-observations-read';
import type { LearningImprovementsArgs } from '../harness/improvements/learning-digest-snapshot';
import type { RetainFeedQueryArgs } from './learning-retain-types';

/**
 * Shared deadline for the fan-outs bounded IN PLACE (WI-39825). 6s — the budget
 * the extracted `*-read.ts` modules carry, measured against real :3170 latency
 * (p90 599ms) and deliberately under the sync layer's ~10s
 * `RESOLVER_READ_TIMEOUT_MS`, which a bound has to beat to be worth anything.
 *
 * These sites are bounded HERE rather than extracted because every leg
 * PROPAGATES a lapse — there is no per-leg degradation policy to falsify, so the
 * only behaviour added is `createReadDeadline`'s own, which
 * `read-deadline.test.ts` already guards with two permanent controls. A site with
 * a SUPPLEMENTARY leg is the opposite case and must be extracted to be
 * guardable: see `adv-roster-read.ts`'s header for why (a resolver's only input
 * is its wire args, so the budget knob cannot live on it).
 */
const RESOLVER_FANOUT_BUDGET_MS = 6_000;
import { projectAuthoredFields } from '../agent-tools/coordination/message-fields';
// GOAL mode's two client reads (goal-mode-2026-08-07 P-017). They live in their
// own module rather than inline here because both carry a counting rule the SQL
// alone does not state: a project can serve several goals, so per-goal spend
// figures deliberately DO NOT SUM and the list returns a distinct-project
// portfolio total instead. See ./goals.
import { resolveGoalDetail, resolveGoalsList } from './goals';
import {
  resolveWorkItemPriorAttempts,
  workItemPriorAttemptsArgsSchema,
  type WorkItemPriorAttemptsArgs,
} from './work-item-prior-attempts';
import {
  resolveWorkItemBehaviorContract,
  workItemBehaviorContractArgsSchema,
  type WorkItemBehaviorContractArgs,
} from './work-item-behavior-contract';
import { resolvePlanSpecCoverage, planSpecCoverageArgsSchema, type PlanSpecCoverageArgs } from './plan-spec-coverage';
import { resolvePlanProvenance, planProvenanceArgsSchema, type PlanProvenanceArgs } from '../plan-provenance-read';
import {
  resolvePlanAcceptanceGateVerdict,
  planAcceptanceGateArgsSchema,
  type PlanAcceptanceGateArgs,
} from './plan-acceptance-gate-verdict';
import {
  resolveWorkItemSpecAdequacy,
  workItemSpecAdequacyArgsSchema,
  type WorkItemSpecAdequacyArgs,
} from './work-item-spec-adequacy';
import { trackDetached } from '../detached-imports';

// CLAMP, don't REJECT (clamp-not-reject, plan coordination-unification-data-sync-hardening
// P-001 / D-002): a client-sent pagination `limit` must never make the resolver throw on
// a client/server version skew (a newer UI bundle asking for more than an older deployed
// resolver allowed → the panel-breaking "Too big" error workItems.byHarness had). A bare
// Zod `.max()` REJECTS; these CLAMP via `.transform()` (the framework parses argsSchema and
// passes the transformed value to resolve — query-registry.ts:57-58 — so args.limit is
// already bounded in the body). `clampedLimit` has a default; `clampedLimitOpt` stays
// optional (absent → undefined, the body's own `?? N` applies).
const clampedLimit = (cap: number, def: number) =>
  z
    .number()
    .int()
    .positive()
    .default(def)
    .transform((v) => Math.min(v, cap));
const clampedLimitOpt = (cap: number) =>
  z
    .number()
    .int()
    .positive()
    .transform((v) => Math.min(v, cap))
    .optional();

const workItemsListFiltersSchema = z.object({
  id: z.string().max(500).optional(),
  title: z.string().max(500).optional(),
  kinds: z.array(z.string().max(80)).max(100).optional(),
  states: z.array(z.string().max(80)).max(100).optional(),
  stages: z.array(z.string().max(160)).max(100).optional(),
  assignees: z.array(z.string().max(300)).max(500).optional(),
  severities: z.array(z.string().max(80)).max(100).optional(),
  plans: z.array(z.string().max(300)).max(500).optional(),
  priorityMin: z.number().finite().optional(),
  priorityMax: z.number().finite().optional(),
  rankMin: z.number().finite().optional(),
  rankMax: z.number().finite().optional(),
});

const workItemsListArgsSchema = z.object({
  harnessSlug: z.string().max(200).optional(),
  harnessSlugs: z.array(z.string().min(1).max(200)).max(500).optional(),
  kind: z.string().max(80).optional(),
  state: z.string().max(80).optional(),
  q: z.string().max(500).optional(),
  filters: workItemsListFiltersSchema.optional(),
  cursor: z.string().max(2_000).nullable().optional(),
  limit: clampedLimit(WORK_ITEMS_CURSOR_PAGE_LIMIT, WORK_ITEMS_CURSOR_PAGE_LIMIT),
  states: z.array(z.string().max(40)).max(20).optional(),
  perState: clampedLimitOpt(WORK_ITEMS_FAIR_STATE_LIMIT),
});

const agentRunsListArgsSchema = z.object({
  harnessSlug: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  runningOnly: z.boolean().optional(),
  featureId: z.string().trim().max(300).optional(),
  cursor: z.string().max(2_000).nullable().optional(),
  limit: clampedLimit(AGENT_RUNS_PAGE_LIMIT, AGENT_RUNS_PAGE_LIMIT),
});

const scorecardHistoryArgsSchema = z.object({
  rubricRef: z.string().trim().min(1).max(300),
  cursor: z.string().max(2_000).nullable().optional(),
  limit: clampedLimit(SCORECARD_HISTORY_PAGE_LIMIT, SCORECARD_HISTORY_DEFAULT_PAGE),
});

const advSessionsListArgsSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200).optional(),
  harnessSlugs: z.array(z.string().trim().min(1).max(300)).max(500).optional(),
  planSlugs: z.array(z.string().trim().min(1).max(500)).max(500).optional(),
  cursor: z.string().max(2_000).nullable().optional(),
  limit: clampedLimit(ADV_SESSIONS_PAGE_LIMIT, ADV_SESSIONS_DEFAULT_PAGE),
});

const designFeaturesListArgsSchema = z.object({
  harnessSlug: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200).default('default'),
  q: z.string().max(500).optional(),
  statuses: z.array(z.enum(DESIGN_FEATURE_STATUSES)).max(3).optional(),
  cursor: z.string().max(2_000).nullable().optional(),
  limit: clampedLimit(DESIGN_FEATURES_PAGE_LIMIT, DESIGN_FEATURES_DEFAULT_PAGE),
});

const learningObservationsFiltersSchema = z.object({
  scopes: z.array(z.string().max(300)).max(500).optional(),
  sourceRoles: z.array(z.string().max(160)).max(200).optional(),
  confidences: z.array(z.string().max(80)).max(100).optional(),
  kinds: z.array(z.string().max(80)).max(100).optional(),
  plans: z.array(z.string().max(300)).max(500).optional(),
});

const learningObservationsArgsSchema = z.object({
  state: z.enum(['open', 'resolved', 'closed']).optional(),
  q: z.string().max(500).optional(),
  filters: learningObservationsFiltersSchema.optional(),
  cursor: z.string().max(2_000).nullable().optional(),
  limit: clampedLimit(LEARNING_OBSERVATIONS_PAGE_LIMIT, LEARNING_OBSERVATIONS_PAGE_LIMIT),
});

/**
 * A calendar view has no useful reason to request more than three years at once.
 * Keep this finite at the resolver boundary: `expandOccurrences` is bounded by
 * its result limit, but a pathological window can still make the recurrence
 * library walk years of dates before it reaches that limit.
 */
export const MAX_SCHEDULED_OCCURRENCES_WINDOW_MS = 3 * 365 * 24 * 60 * 60 * 1000;

const scheduledOccurrencesTimestamp = z.number().int().safe().positive();
const scheduledOccurrencesArgsSchema = z
  .object({
    rangeStartMs: scheduledOccurrencesTimestamp,
    rangeEndMs: scheduledOccurrencesTimestamp,
    harnessSlug: z.string().max(200).optional(),
  })
  .superRefine(({ rangeStartMs, rangeEndMs }, ctx) => {
    if (rangeEndMs < rangeStartMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rangeEndMs'],
        message: 'rangeEndMs must be greater than or equal to rangeStartMs',
      });
      return;
    }
    if (rangeEndMs - rangeStartMs > MAX_SCHEDULED_OCCURRENCES_WINDOW_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rangeEndMs'],
        message: 'scheduled occurrence windows may not exceed three years',
      });
    }
  });

// ─── conversations.agentMessage* (conversations-agent-messages-2026-07-27) ───

/**
 * The `coord_event_log.surface` values that carry agent-to-agent conversation.
 * `plan-events` is deliberately absent: a plan lifecycle beat is telemetry about
 * a plan, not a message between agents.
 */
const CURATED_COORD_SURFACES = ['messages', 'escalations', 'handoffs'] as const;

/**
 * Envelope kinds that can ROOT a curated conversation.
 *
 * Excluded on purpose, and this list is the whole difference between a readable
 * pane and a firehose: `notify` (5,012/week — subscription fan-out, not a
 * message anyone wrote), `plan_event`, `subscribe`/`unsubscribe`. `ack` is
 * excluded too but for the opposite reason — an ack is never a root, it renders
 * as a REPLY under the message it acknowledges.
 */
const CURATED_COORD_ROOT_KINDS = [
  'message',
  'escalation',
  'escalation_resolved',
  'handoff',
  'handoff_accepted',
  'contract',
] as const;

/**
 * Two machine-traffic exclusions that decide whether this pane is a
 * conversation view or a telemetry firehose. Measured over the 51,462 curated
 * roots on 2026-07-27: only 7,452 (14.5%) are messages an agent actually wrote
 * to another agent. Both exclusions are applied together, opt out with
 * `includeMachine`.
 *
 * 1. `auto:true` — 31,159 rows (60.5%). The authoritative machine-authored
 *    stamp, the SAME one coord:inbox's default read filters on
 *    (agent-tools/coordination/tools/inbox.ts). These are lifecycle
 *    projections an agent's tooling emitted on its behalf — `now working on:`
 *    intent declares (12,238), completion broadcasts (7,437), claim notices —
 *    not prose anyone composed. They are also newest-biased (an intent fires on
 *    every wake), so unfiltered they dominate the top of the pane.
 *
 * 2. Named machine actors — ~12,850 rows. `service-health`, `rate-governor`,
 *    `green-checkpoint`, `git-sync-*`, `claim-discipline-watch`,
 *    `compaction-watchdog`, `coord-probe-canary-*` and friends write plain
 *    un-stamped messages, so exclusion (1) does not reach them.
 *
 * The (2) predicate is deliberately a MACHINE test rather than an agent
 * whitelist, so it fails OPEN: an unrecognised sender stays VISIBLE. That
 * direction is chosen on purpose — the bug this whole plan exists to fix was
 * the owner UNDER-seeing their agents ("I only see 51 chat messages"), so a
 * wrong guess must cost noise, never a hidden conversation.
 *
 * The structural rule: every agent session id carries a high-entropy hex run
 * (`su-40f20db0-…`, the legacy `s-1784004323664-25c58084`, a bare UUID) while
 * every service slug is words-joined-by-hyphens. So "contains 8+ consecutive
 * hex chars" separates them without enumerating service names — which a
 * blacklist would need, and would silently re-pollute the pane the next time
 * someone adds a watchdog.
 *
 * NOT joined against `coord_presence`: that registry is TTL-reaped, so only
 * 7.9% of genuine historical senders still have a row. Presence answers who is
 * live NOW; only the append-only log answers who ever spoke.
 */
export const AGENT_SESSION_ID_HEX_RUN = '[0-9a-f]{8}';

/** The subset of a coord envelope's jsonb body these resolvers read. */
interface CoordEnvelopeBody {
  kind?: unknown;
  from?: unknown;
  to?: unknown;
  summary?: unknown;
  body?: unknown;
  plan_slug?: unknown;
  lifecycle?: unknown;
  audience?: unknown;
  /** Kind-specific extras — carries the authored message fields (P-033). */
  extra?: unknown;
}

const asStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const asStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Escape LIKE metacharacters so agent-message search stays a literal substring. */
const likeContainsPattern = (query: string): string => `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * Flatten a `coord_event_log` row into the flat `AgentMessageRow` wire shape the
 * Conversations surfaces consume (apps/operator-vite/src/components/
 * conversations/unified-conversations.ts). The jsonb envelope stays server-side:
 * shipping raw `body` would make every client re-derive these fields and drift.
 */
export function toAgentMessageRow(
  row: Record<string, unknown>,
  // WI-7240: `includeAuthored` defaults to TRUE so the detail path — and any
  // future caller — keeps the complete row. Note a bare `.map(toAgentMessageRow)`
  // hands the ARRAY INDEX in as `opts`; reading `opts?.includeAuthored` off a
  // number yields undefined, so that mistake degrades to the full row (the safe
  // direction) rather than silently dropping a field.
  opts?: { includeAuthored?: boolean; includeBody?: boolean },
): Record<string, unknown> {
  const body = (row.body ?? {}) as CoordEnvelopeBody;
  const to = asStrArray(body.to);
  // P-033 (e): this projection is a WHITELIST, so the authored message fields — which
  // ride the ENVELOPE (the send path flattens them onto it) — were dropped before the
  // pui pane ever saw them. `body.body` here is the FLATTENED text, so the pane could
  // not have re-derived them either. Projected server-side for the reason stated above:
  // a client that unpacks the envelope itself is a second place D-064's split can drift.
  //
  // ⚠ Pass the envelope (`body`), NOT `body.extra` — see projectAuthoredFields. This
  // read `body.extra` until 2026-08-02 and so never surfaced a single authored field.
  //
  // WI-7240: computed only when the caller wants it. This mapper is SHARED by
  // `conversations.agentMessageList` and `.agentMessageDetail`, so the P-033 fix
  // above — which targeted the DETAIL views — put the block on the LIST too, where
  // it was 188,386 B (43.90%) that nothing reads: BOTH `<AuthoredFields>` render
  // sites (AdvConversationsTab.tsx:2406, ConversationsTab.tsx:687) take their row
  // from the DETAIL query. Parameterised rather than forked so the two shapes
  // cannot drift apart.
  const authored = opts?.includeAuthored === false ? undefined : projectAuthoredFields(body);
  return {
    msg_id: row.msg_id as string,
    kind: asStr(body.kind) ?? '',
    from: asStr(body.from) ?? '',
    to,
    summary: asStr(body.summary),
    ...(opts?.includeBody === false ? {} : { body: asStr(body.body) }),
    ...(authored ? { authored } : {}),
    harness_slug: (row.harness_slug as string | null) ?? null,
    plan_slug: asStr(body.plan_slug),
    lifecycle: asStr(body.lifecycle),
    audience: asStrArray(body.audience),
    broadcast: to.includes('*'),
    reply_count: Number(row.reply_count ?? 0),
    ts: new Date(row.ts as string).toISOString(),
    last_reply_ts: row.last_reply_ts ? new Date(row.last_reply_ts as string).toISOString() : null,
  };
}

// Coerce any top-level BigInt field on each row to a Number so the rows survive the
// rest-query serializer (a plain JSON.stringify, which THROWS on a BigInt → a 500
// whenever the resolver returns rows). A bigserial({ mode: 'bigint' }) PK (user_actions.id
// and ~34 other tables) is the common source; ids are well within 2^53. This mirrors the
// explicit `typeof v === 'bigint' ? Number(v)` convention in harness-core / agent-chats-data
// / projects-data. Returns the original row object untouched when it has no BigInt (no
// allocation on the hot path). Exported for the unit guard. (data-sync-push-completion
// D-010: found live on :3170 verifying the P-006 userActions.recent resolver — byHarness/
// byKind shared the latent 500, masked by the sparse user_actions table.)
export function jsonSafeRows(rows: unknown[]): unknown[] {
  return rows.map((r) => {
    if (!r || typeof r !== 'object') return r;
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (typeof v === 'bigint') (out ??= { ...(r as Record<string, unknown>) })[k] = Number(v);
    }
    return out ?? r;
  });
}

// ─── Registry types ─────────────────────────────────────────────────

export interface QueryEntry<TArgs = unknown> {
  /** Optional zod schema for arg validation. Omitted entries accept any. */
  argsSchema?: z.ZodSchema<TArgs>;
  /** Resolver: takes validated args, returns flat row array. */
  resolve: (args: TArgs) => Promise<unknown[]>;
  /**
   * The `<schema>.<table>` relations whose WRITES should make this query refetch — so the
   * resolver → table → invalidation chain is checkable end to end instead of by convention
   * (EI-19304902443341820).
   *
   * WHY THIS EXISTS. `__tests__/cache-tag-trigger-coverage.integration.test.ts` guards
   * TABLE_TO_QUERY_NAMES against the PG triggers with exact set-equality — strong, but it can only
   * see tables ALREADY in the map. A resolver reading a table in NEITHER `TABLE_TO_QUERY_NAMES` nor
   * `OPERATOR_STATE_SYNC_NAMES` was invisible to it and to every other check. The only thing
   * standing in the way was a doc comment, and a comment is not a guard.
   *
   * `accounts.pool` (added 2026-06-15) read `harness_shared.operator_account_pool` and was never
   * mapped, so NOT ONE invalidation ever fired from a pool write — for the query whose entire
   * purpose is showing continuously-updating account usage. Nothing failed; the tab quietly
   * refreshed on remount only, for ~7 weeks, until the owner noticed stale numbers (WI-6796).
   *
   * It had FOUR `notifySyncInvalidate('accounts.pool')` action callsites the whole time (register /
   * remove / reset-rate / probe-capacity). That is precisely why a NAME-level guard cannot catch
   * this class, and why the TABLE direction is what has to be declared: the query had a push path —
   * just not from the writer that actually moves its data.
   *
   * WHAT TO LIST: the relations this query's DATA comes from, not every table its helpers touch.
   * Workspace/tenant-scoping joins (`pot_members`, `projects`) are not backing tables — a write
   * there should not refetch the panel. The test to apply: "if a row changed here, should this
   * panel visibly update?"
   *
   * Checked by `__tests__/resolver-backing-table-coverage.test.ts`: every listed table must map to
   * THIS query name in one of the two invalidation maps, or carry a documented PUSH_EXEMPT reason.
   * Not mechanically derivable from the resolver body — resolvers call helper functions rather than
   * raw SQL, and walking the imports over-reports badly (measured: it attributes `pot_members` to
   * nearly every query, purely from scoping code).
   *
   * Omit ONLY if the name is in that guard's shrink-only UNDECLARED_BASELINE. New entries must
   * declare — the baseline is closed to additions.
   */
  backingTables?: readonly string[];
}

// Dispatch + NAME_NOT_FOUND now come from the shared lib
// (@papercusp/sync/server). Re-exported so existing importers of
// `@/lib/sync-resolver` (the rest-query routes, tests) are unchanged.
export { NAME_NOT_FOUND, type NameNotFound } from '@papercusp/sync/server';

// ─── Migrated queries ───────────────────────────────────────────────
//
// Each entry below corresponds to one of the 51 live queryNames
// audited 2026-05-24. As each lands, the corresponding ZQL entry in
// libs/zero-harness/src/queries.ts becomes dead code (to be deleted
// at the P-022 cutover).

/** WI-7232 — the DETAIL half: one feature, every field the detail card reads.
 *  Carries `summary` (and status / designSpecId / discardedDesignWork), which
 *  the list above no longer ships. Bridged to the same backing tables as
 *  `designFeatures.byHarness` so an open detail card live-refreshes on the very
 *  writes that move its list row. */
async function resolveDesignFeatureDetail(args: {
  harnessSlug: string;
  workspaceId: string;
  featureId: string;
}): Promise<unknown[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { harnessSlug, workspaceId, featureId } = args;
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT
      feature_id, title, summary, status, needs_design,
      design_status, design_spec_id, discarded_design_work, updated_ts
    FROM harness_shared.harness_features_consolidated
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${featureId}
    LIMIT 1
  `;
  return rows.map((r) => ({
    featureId: r.feature_id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    needsDesign: r.needs_design,
    designStatus: r.design_status,
    designSpecId: r.design_spec_id,
    discardedDesignWork: r.discarded_design_work,
    updatedTs: r.updated_ts == null ? null : Number(r.updated_ts),
  })) as unknown[];
}

async function resolveDesignSketches(args: {
  harnessSlug: string;
  featureId: string;
  workspaceId: string;
}): Promise<unknown[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { harnessSlug, featureId, workspaceId } = args;
  const { sql } = getOrgPg();
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return await tx`
      SELECT id, payload, metadata, created_ts
        FROM harness_shared.harness_design_artifacts
       WHERE harness_slug = ${harnessSlug}
         AND feature_id   = ${featureId}
         AND kind         = 'sketch'
       ORDER BY created_ts DESC
       LIMIT 100
    `;
  });
  return rows.map((r) => ({
    id: r.id,
    label: (r.payload as { label?: string } | null)?.label ?? null,
    png: (r.payload as { png?: string } | null)?.png ?? null,
    createdTs: r.created_ts == null ? null : Number(r.created_ts),
    metadata: r.metadata ?? {},
  })) as unknown[];
}

async function resolveDesignRegressions(): Promise<unknown[]> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  const roots = {
    baseline: 'lostpixel-baseline',
    current: 'lostpixel-current',
    diff: 'lostpixel-diff',
  } as const;
  type Bucket = keyof typeof roots;
  async function listDir(absDir: string) {
    try {
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      const out = new Map<string, { mtime: number; size: number }>();
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.png')) continue;
        const stat = await fs.stat(join(absDir, e.name));
        out.set(e.name, { mtime: stat.mtimeMs, size: stat.size });
      }
      return out;
    } catch {
      return new Map<string, { mtime: number; size: number }>();
    }
  }
  const cwd = process.cwd();
  const buckets: Record<Bucket, Awaited<ReturnType<typeof listDir>>> = {
    baseline: await listDir(join(cwd, roots.baseline)),
    current: await listDir(join(cwd, roots.current)),
    diff: await listDir(join(cwd, roots.diff)),
  };
  const allNames = new Set<string>();
  for (const m of Object.values(buckets)) for (const n of m.keys()) allNames.add(n);
  const items = [...allNames].sort().map((name) => {
    const b = buckets.baseline.get(name);
    const c = buckets.current.get(name);
    const d = buckets.diff.get(name);
    return {
      name,
      hasBaseline: !!b,
      hasCurrent: !!c,
      hasDiff: !!d,
      baselineMtime: b?.mtime ?? null,
      currentMtime: c?.mtime ?? null,
      diffMtime: d?.mtime ?? null,
      baselineSize: b?.size ?? null,
      currentSize: c?.size ?? null,
      diffSize: d?.size ?? null,
      hasRegression: !!d && d.size > 200,
    };
  });
  return [
    {
      counts: {
        baseline: buckets.baseline.size,
        current: buckets.current.size,
        diff: buckets.diff.size,
        regressions: items.filter((i) => i.hasRegression).length,
      },
      items,
    },
  ];
}

/**
 * The report-only design evidence report, for the design review UI.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * Reads the artifact `npm run design:evidence-report` writes, the same one CI
 * uploads. Deliberately a FILE read and not a Postgres read: this report is the
 * output of a comparison RUN, not durable operator state, and every consumer —
 * a CI artifact download, this pane — should be looking at the same bytes.
 *
 * `present: false` rather than an empty report when the file is absent, so the
 * pane can say "not run here yet" instead of rendering a confident zero. An
 * empty report and a missing report mean opposite things and must not share a
 * rendering.
 */
async function resolveDesignEvidence(): Promise<unknown[]> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  const reportPath = join(process.cwd(), 'design-evidence-report', 'report.json');
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    const stat = await fs.stat(reportPath);
    const report = JSON.parse(raw) as Record<string, unknown>;
    return [{ present: true, generatedMtime: stat.mtimeMs, reportPath, report }];
  } catch {
    return [{ present: false, generatedMtime: null, reportPath, report: null }];
  }
}

async function resolveDesignMemos(args: { status?: string }): Promise<unknown[]> {
  const { promises: fs } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const dir = resolve(process.cwd(), 'apps/operator-docs/src/content/docs/design');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const file of entries) {
    if (!file.endsWith('.mdx')) continue;
    const slug = file.slice(0, -4);
    const raw = await fs.readFile(join(dir, file), 'utf-8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? '';
    const title =
      /^title:\s*(.+)$/m
        .exec(frontmatter)?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, '') || slug;
    const status =
      /^status:\s*(.+)$/m
        .exec(frontmatter)?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, '') || 'open';
    if (args.status && args.status !== 'any' && status !== args.status) continue;
    out.push({ slug, title, status, source: join(dir, file) });
  }
  return out;
}

async function resolveDesignRegistry(args: { ecosystem?: string; query?: string }): Promise<unknown[]> {
  const { makeReactTailwindRegistry } = await import('../design-adapter-react-tailwind/registry');
  const ecosystem = args.ecosystem || 'react-tailwind';
  if (ecosystem !== 'react-tailwind') return [];
  const query = (args.query || '').trim().toLowerCase();
  const registry = makeReactTailwindRegistry({
    sourcePaths: ['apps/operator/app/harness', 'libs/generic/papergrid/grid-core/src'],
  });
  const entries = await registry.listPrimitives();
  if (!query) return entries as unknown[];
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.summary,
      ...(entry.inputs ?? []).map((input) => `${input.name} ${input.type}`),
      ...(entry.variants ?? []),
      ...(entry.states ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }) as unknown[];
}

async function resolveDesignTokens(args: { category?: string }): Promise<unknown[]> {
  const { promises: fs } = await import('node:fs');
  const { resolve } = await import('node:path');
  const doc = JSON.parse(await fs.readFile(resolve(process.cwd(), 'design/tokens/base.json'), 'utf-8')) as unknown;
  const out: Array<{ id: string; type: string; value: unknown; description: string | null; group: string | null }> = [];
  function walk(node: unknown, prefix: string[]): void {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith('$')) continue;
      if (value && typeof value === 'object' && '$type' in value && '$value' in value) {
        const leaf = value as { $type: string; $value: unknown; $description?: string };
        out.push({
          id: [...prefix, key].join('.'),
          type: leaf.$type,
          value: leaf.$value,
          description: leaf.$description ?? null,
          group: prefix.join('.') || null,
        });
      } else {
        walk(value, [...prefix, key]);
      }
    }
  }
  walk(doc, []);
  const category = args.category?.toLowerCase();
  return category
    ? out.filter((token) => token.id.toLowerCase().startsWith(`${category}.`) || token.type === category)
    : out;
}

/**
 * Resolve a shared hive's member-harness SLUGS for the cross-member browse reads
 * (WI-259 P-006, D-010). The member set is the hive home plus every locally-
 * registered harness whose `hive_slug` points at the home (joining a hive
 * registers each member harness with that stamp — discovery/join-pot). Mirrors
 * the `learning.improvements` hive-scope resolution; returns BARE slugs (strips the
 * `harness:` scope prefix `hiveMemberHarnessScopes` adds) for a `WHERE harness_slug
 * IN (...)` content read. Best-effort: a registry read failure degrades to just
 * `[potHomeSlug]` (the rollup still shows the home's own content) rather than
 * throwing — a federation read must never 500 the tab.
 */
async function resolveHiveMemberSlugs(potHomeSlug: string, workspaceId?: string): Promise<string[]> {
  try {
    const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    const slugs = hiveMemberHarnessScopes(reg.projects, potHomeSlug).map((s) => s.replace(/^harness:/, ''));
    // hiveMemberHarnessScopes always includes the home, so this is non-empty; guard anyway.
    return slugs.length > 0 ? slugs : [potHomeSlug];
  } catch (err) {
    console.warn('[sync-resolver] hive member-slug resolution failed:', err instanceof Error ? err.message : err);
    return [potHomeSlug];
  }
}

/**
 * The store seams behind the Retain view, wired once (WI-39900).
 *
 * `learning.retainFeed` (rows) and `learning.retainCounts` (tab badges) are two
 * queries over the SAME six stores. They were one query until the counts were
 * split off the ledger's critical path, and the reason they are wired here
 * rather than inline in each resolver is that a drifted copy of `listMemories`
 * is a silent correctness bug: the badge would count a different corpus than
 * the rows it sits above.
 */
async function retainStoreDeps(
  sql: import('postgres').Sql,
  workspaceId: string,
  hive: string | undefined,
): Promise<import('./learning-retain-read').RetainFeedDeps> {
  const { currentMemoryBackendChoice } = await import('../memory/backend-selection');
  // Only these two active choices enumerate the canonical Postgres rows.
  // A custom/future backend keeps the pluggable `backend.list()` contract — a
  // raw canonical query must never silently substitute a different corpus.
  const canonicalBacked = ['mem0', 'hybrid-pg'].includes(currentMemoryBackendChoice());
  let memoryScopesOnce: Promise<string[]> | null = null;
  const resolveMemoryScopes = (): Promise<string[]> =>
    (memoryScopesOnce ??= (async () => {
      if (hive) return [`hive:${hive}`];
      const { listPots } = await import('../agent-tools/pot/_resolve');
      return (await listPots(workspaceId)).map((p) => `hive:${p.slug}`);
    })());

  const listMemories = async () => {
    const { getMemoryBackend } = await import('../memory/backend');
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) throw new Error(avail.reason);
    const scopes = await resolveMemoryScopes();
    if (scopes.length === 0) return [];
    return backend.list({ scope: scopes.length === 1 ? scopes[0]! : scopes });
  };

  return {
    // WI-39535: the hive's shared-memory pool as a ledger kind. Scope
    // resolution mirrors learning.hive (learning-hive-read): `hive:<slug>` for
    // a selected pot, every pot's pool under the All-Pots lens (ListOptions.scope
    // takes the array in one call). An unavailable backend throws → the leg
    // degrades VISIBLY (degraded: ['memory']), never silently.
    listMemories,
    ...(canonicalBacked
      ? {
          listMemoriesPage: async (opts) => {
            const { listCanonicalRetainMemoriesPage } = await import('./learning-retain-read');
            return listCanonicalRetainMemoriesPage(sql, await resolveMemoryScopes(), opts);
          },
          countMemories: async () => {
            const { countCanonicalRetainMemories } = await import('./learning-retain-read');
            return countCanonicalRetainMemories(sql, await resolveMemoryScopes());
          },
          summarizeMemories: async (predicate) => {
            const { summarizeCanonicalRetainMemories } = await import('./learning-retain-read');
            return summarizeCanonicalRetainMemories(sql, await resolveMemoryScopes(), predicate);
          },
        }
      : {}),
    listRubrics: async () => {
      const { listRubrics } = await import('../rubrics');
      return (await listRubrics()).map((r) => ({
        slug: r.rubricId,
        title: r.title,
        status: r.status,
        updatedAt: r.updatedAt,
      }));
    },
    listRecipesPage: async ({ window, limit, predicate }) => {
      const { listRecipesActivityPage } = await import('../code-recipes-store');
      if (predicate && (predicate.args.filters.statuses.length > 0 || predicate.args.filters.lenses.length > 0)) {
        return [];
      }
      return listRecipesActivityPage(sql, {
        limit,
        before: window ? { ts: window.beforeTs, includeTies: window.includeTies, idAfter: window.tieIdAfter } : null,
        ...(predicate?.args.q ? { q: predicate.args.q } : {}),
        ...(predicate?.args.filters.title ? { title: predicate.args.filters.title } : {}),
      });
    },
    countRecipes: async () => {
      const { countRecipes } = await import('../code-recipes-store');
      return countRecipes(sql, { includeTrivial: false });
    },
    summarizeRecipes: async (predicate) => {
      const { summarizeRecipesActivity } = await import('../code-recipes-store');
      return summarizeRecipesActivity(sql, {
        includeTrivial: false,
        q: predicate.args.q,
        title: predicate.args.filters.title,
        matchImpossible: predicate.args.filters.statuses.length > 0 || predicate.args.filters.lenses.length > 0,
      });
    },
    listRunbooksPage: async ({ window, limit, predicate }) => {
      const { readInsightDocsPage } = await import('./learning-retain-read');
      const { DOCS_CONTENT_ROOT } = await import('../agent-tools/docs/_repo-paths');
      if (predicate && (predicate.args.filters.statuses.length > 0 || predicate.args.filters.lenses.length > 0)) {
        return [];
      }
      return readInsightDocsPage(`${DOCS_CONTENT_ROOT}/agent-insights`, {
        window,
        limit,
        ...(predicate ? { predicate } : {}),
      });
    },
    countRunbooks: async () => {
      const { countInsightDocs } = await import('./learning-retain-read');
      const { DOCS_CONTENT_ROOT } = await import('../agent-tools/docs/_repo-paths');
      return countInsightDocs(`${DOCS_CONTENT_ROOT}/agent-insights`);
    },
    summarizeRunbooks: async (predicate) => {
      const { countInsightDocs, summarizeInsightDocs } = await import('./learning-retain-read');
      const { DOCS_CONTENT_ROOT } = await import('../agent-tools/docs/_repo-paths');
      if (predicate.args.filters.statuses.length > 0 || predicate.args.filters.lenses.length > 0) {
        return {
          total: await countInsightDocs(`${DOCS_CONTENT_ROOT}/agent-insights`),
          matched: 0,
        };
      }
      return summarizeInsightDocs(`${DOCS_CONTENT_ROOT}/agent-insights`, predicate);
    },
  };
}

/** The P-040 hive lens for the Retain reads: member-harness scopes for the wi
 *  leg, bare slugs for the plans leg. Degrades to workspace-wide, never throws. */
async function retainHiveScopes(hive: string | undefined, label: string): Promise<readonly string[] | undefined> {
  if (!hive) return undefined;
  try {
    const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../harness-registry');
    const reg = await loadHarnessRegistry();
    return hiveMemberHarnessScopes(reg.projects, hive);
  } catch (err) {
    console.warn(`[${label}] hive scope resolution failed:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

const workItemsListQueryPair = createCompanionListQueryPair({
  domain: 'workItems',
  rowsQueryName: 'workItems.byHarness',
  argsSchema: workItemsListArgsSchema,
  backingTables: ['harness_shared.work_items', 'harness_shared.spawned_agents'] as const,
  normalizeArgs: (args: WorkItemsListWireArgs) => normalizeWorkItemsListArgs(args),
  buildPredicate: buildWorkItemsPredicate,
  readPage: async ({ predicate }) => {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
    return readWorkItemsPageFromStore(getOrgPg().sql, activeWorkspaceId(), predicate);
  },
  readSummaryAggregateRows: async ({ predicate }) => {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
    return readWorkItemsSummaryFromStore(getOrgPg().sql, activeWorkspaceId(), predicate);
  },
  summarySelection: workItemsSummarySelection,
});

const agentRunsListQueryPair = createCompanionListQueryPair({
  domain: 'agentRunsConsolidated',
  rowsQueryName: 'agentRunsConsolidated.bySlug',
  argsSchema: agentRunsListArgsSchema,
  backingTables: ['harness_shared.agent_runs_consolidated', 'harness_shared.spawned_agents'] as const,
  normalizeArgs: (args: AgentRunsListWireArgs) => normalizeAgentRunsListArgs(args),
  buildPredicate: buildAgentRunsPredicate,
  readPage: async ({ predicate }) => {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
    const args = predicate.args.workspaceId
      ? predicate
      : buildAgentRunsPredicate({ ...predicate.args, workspaceId: activeWorkspaceId() });
    return readAgentRunsPageFromStore(getOrgPg().sql, args);
  },
  readSummaryAggregateRows: async ({ predicate }) => {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
    const args = predicate.args.workspaceId
      ? predicate
      : buildAgentRunsPredicate({ ...predicate.args, workspaceId: activeWorkspaceId() });
    return readAgentRunsSummaryFromStore(getOrgPg().sql, args);
  },
  summarySelection: agentRunsSummarySelection,
});

const scorecardHistoryQueryPair = createCompanionListQueryPair({
  domain: 'scorecards',
  rowsQueryName: 'scorecards.list',
  argsSchema: scorecardHistoryArgsSchema,
  backingTables: ['harness_shared.work_items', 'harness_shared.coord_links', 'harness_shared.harness_plans'] as const,
  normalizeArgs: (args: ScorecardHistoryWireArgs) => normalizeScorecardHistoryArgs(args),
  buildPredicate: buildScorecardHistoryPredicate,
  readPage: async ({ predicate }) => {
    const { listScorecardPage } = await import('../scorecards');
    return readScorecardHistoryPage(predicate, { listPage: listScorecardPage });
  },
  readSummaryAggregateRows: async ({ predicate }) => {
    const { scorecardTotalCountsByRubric } = await import('../scorecards');
    return readScorecardHistorySummary(predicate, {
      countByRubric: scorecardTotalCountsByRubric,
    });
  },
});

const advSessionsListQueryPair = createCompanionListQueryPair({
  domain: 'advSessions',
  rowsQueryName: 'advSessions.list',
  argsSchema: advSessionsListArgsSchema,
  backingTables: ['harness_shared.adv_sessions', 'harness_shared.harness_plans'] as const,
  normalizeArgs: (args: AdvSessionsListWireArgs) => normalizeAdvSessionsListArgs(args),
  buildPredicate: buildAdvSessionsPredicate,
  readPage: async ({ predicate }) => {
    const [{ getOrgPg }, { activeWorkspaceId }, { getOmpSessionRowSummary }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
      import('../omp-sessions'),
    ]);
    const scoped = predicate.args.workspaceId
      ? predicate
      : buildAdvSessionsPredicate({
          ...predicate.args,
          workspaceId: activeWorkspaceId(),
        });
    const page = await readAdvSessionsPageFromStore(getOrgPg().sql, scoped);
    const rows = page.rows.map((row) => ({
      ...row,
      summary: row.mode === 'omp' && row.ompThreadId ? getOmpSessionRowSummary({ id: row.ompThreadId }) : null,
    }));
    return { ...page, rows };
  },
  readSummaryAggregateRows: async ({ predicate }) => {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
    const scoped = predicate.args.workspaceId
      ? predicate
      : buildAdvSessionsPredicate({
          ...predicate.args,
          workspaceId: activeWorkspaceId(),
        });
    return readAdvSessionsSummaryFromStore(getOrgPg().sql, scoped);
  },
  summarySelection: advSessionsSummarySelection,
});

const designFeaturesListQueryPair = createCompanionListQueryPair({
  domain: 'designFeatures',
  rowsQueryName: 'designFeatures.byHarness',
  argsSchema: designFeaturesListArgsSchema,
  backingTables: ['harness_shared.work_items', 'harness_shared.harness_features_consolidated'] as const,
  normalizeArgs: (args: DesignFeaturesListWireArgs) => normalizeDesignFeaturesListArgs(args),
  buildPredicate: buildDesignFeaturesPredicate,
  readPage: async ({ predicate }) => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return readDesignFeaturesPageFromStore(getOrgPg().sql, predicate);
  },
  readSummaryAggregateRows: async ({ predicate }) => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return readDesignFeaturesSummaryFromStore(getOrgPg().sql, predicate);
  },
  summarySelection: designFeaturesSummarySelection,
});

const learningObservationsQueryPair = createCompanionListQueryPair({
  domain: 'learning.observations',
  rowsQueryName: 'learning.observations',
  argsSchema: learningObservationsArgsSchema,
  backingTables: ['harness_shared.work_items'] as const,
  normalizeArgs: (args: LearningObservationsWireArgs) => normalizeLearningObservationsArgs(args),
  buildPredicate: buildLearningObservationsPredicate,
  readPage: async ({ args, predicate }) => {
    if (isDefaultLearningObservationsPage(args)) {
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      const snapshot = await readDerivedSnapshotRows('learning.observations');
      return pageLearningObservationsSnapshot(snapshot as LearningObservationRow[], predicate);
    }
    const [{ getOrgPg }, { activeWorkspaceId }, { resolveIssuesScopeWorkspace }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
      import('../issues-engineer'),
    ]);
    return readLearningObservationsPageFromStore(
      getOrgPg().sql,
      resolveIssuesScopeWorkspace(activeWorkspaceId()),
      predicate,
    );
  },
  readSummaryAggregateRows: async ({ predicate }) => {
    const [{ getOrgPg }, { activeWorkspaceId }, { resolveIssuesScopeWorkspace }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
      import('../issues-engineer'),
    ]);
    return readLearningObservationsSummaryFromStore(
      getOrgPg().sql,
      resolveIssuesScopeWorkspace(activeWorkspaceId()),
      predicate,
    );
  },
  summarySelection: learningObservationsSummarySelection,
});

const retainFeedArgsSchema = z
  .object({
    tab: z.enum(['all', 'memories', 'plans', 'wi', 'rubrics', 'runbooks', 'recipes']).optional(),
    filter: z.enum(['all', 'shipped', 'inflight']).optional(),
    cursor: z.string().max(600).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    hive: z.string().max(120).optional(),
    q: z.string().max(500).optional(),
    filters: z
      .object({
        title: z.string().max(500).optional(),
        statuses: z.array(z.string().min(1).max(120)).max(100).optional(),
        lenses: z.array(z.string().min(1).max(160)).max(100).optional(),
      })
      .optional(),
  })
  .optional();

const REGISTRY: Record<string, QueryEntry<unknown>> = {
  // identities.surface — P-011's one bounded, flat-row settings read over the
  // existing identity source catalog, launch receipt, control activation, and
  // append-only transition ledger. Provider bindings remain an explicit M3 state.
  'identities.surface': {
    backingTables: [
      'harness_shared.adv_sessions',
      'harness_shared.session_briefs',
      'harness_shared.session_identity_activation_events',
    ],
    argsSchema: z.object({
      ownerId: z.string().trim().min(1).max(200).optional(),
      after: z.string().trim().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).optional(),
    resolve: async (rawArgs) => {
      const [{ activeWorkspaceId }, { readIdentitySurface }] = await Promise.all([
        import('../workspace-registry'),
        import('../identity-management'),
      ]);
      return [await readIdentitySurface({
        workspaceId: activeWorkspaceId(),
        ownerId: (rawArgs as { ownerId?: string } | undefined)?.ownerId ?? null,
        ...((rawArgs as { after?: string } | undefined)?.after
          ? { after: (rawArgs as { after: string }).after } : {}),
        ...((rawArgs as { limit?: number } | undefined)?.limit
          ? { limit: (rawArgs as { limit: number }).limit } : {}),
      })];
    },
  },
  // workspaceHosts.control — the provider-neutral BYOC control plane. One flat
  // projection carries connection catalogs plus each host's latest durable
  // operation, resource identities, attestation/drift/tunnel/cost signals, and
  // recent redacted diagnostics. The five low-volume tables are bridged from
  // their PG triggers; workspace_host_logs is deliberately producer-pushed once
  // per append batch (see the PUSH_EXEMPT rationale in the coverage guard).
  'workspaceHosts.control': {
    backingTables: [
      'harness_shared.workspace_host_connections',
      'harness_shared.workspace_hosts',
      'harness_shared.workspace_host_operations',
      'harness_shared.workspace_host_resources',
      'harness_shared.workspace_host_events',
      'harness_shared.workspace_host_logs',
    ],
    resolve: async () => {
      const [{ activeWorkspaceId }, { readWorkspaceHostControl }] = await Promise.all([
        import('../workspace-registry'),
        import('../workspace-host/observability-store'),
      ]);
      return readWorkspaceHostControl(activeWorkspaceId());
    },
  },

  // storage.usage — live storage usage by category for Settings → Storage
  // (storage-settings-page-2026-06-15 P-003). Reuses the audit introspection
  // (pg table sizes + age distribution + on-disk du). No args.
  /**
   * testing.coverage — the `/admin/testing` Coverage panel
   * (deterministic-coverage-census-2026-08-17 P-005).
   *
   * ONE ROW, and that is the design rather than a shortcut. The panel needs the census
   * VERDICT (aggregates, fidelity markers, the not-measured hoist), not a page of
   * surfaces, and the aggregates are computed in SQL across the whole population while
   * the row list is capped. Shipping flat surface rows and letting the client total them
   * would compute every percentage over one PAGE — silently, and always flatteringly.
   *
   * So this delegates to `readCoverage`, the same function the `testing:coverage` tool
   * and both state cells resolve through. Surfaces project it; none re-derive it.
   */
  'testing.coverage': {
    // The three BASE tables the census writes. `testing_surface_depth` is deliberately NOT
    // listed: it is a VIEW (relkind 'v'), so it holds no rows of its own to change and can
    // carry no trigger — declaring it would name a relation no writer can ever invalidate.
    // All three are PUSH_EXEMPT in resolver-backing-table-coverage.test.ts, with the push
    // coming from the producers instead (see the exemption's reason + re-arm condition).
    backingTables: [
      'harness_shared.testing_surfaces',
      'harness_shared.coverage_evidence',
      'harness_shared.census_provider_registrations',
    ],
    argsSchema: z.object({
      harness: z.string().trim().min(1).max(120).optional(),
      rung: z.enum(['l1', 'l2', 'l3', 'l4']).optional(),
      kind: z.string().trim().min(1).max(80).optional(),
      gapsOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    resolve: async (rawArgs) => {
      const args = rawArgs as {
        harness?: string;
        rung?: 'l1' | 'l2' | 'l3' | 'l4';
        kind?: string;
        gapsOnly?: boolean;
        limit?: number;
      };
      const { readCoverage } = await import('../agent-tools/testing/coverage');
      return [await readCoverage(args)];
    },
  },

  'storage.usage': {
    // PRECOMPUTED (precompute-derived-sync-reads-2026-07-19 P-003). This used to
    // call computeStorageUsage() inline: a recursive disk walk + PG catalog sizing
    // measured at 20.0s on a user-facing read. It is now produced by the
    // `system:precompute-derived-reads` routine; this is a plain snapshot SELECT.
    resolve: async () => {
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      return readDerivedSnapshotRows('storage.usage');
    },
  },

  // hive.beaconConsent — the pot bar's beacon-toggle owner-consent read (WI-4137 /
  // P-010; consumer is PotBeaconToggle since 2026-07-27, previously the deleted
  // HiveHeaderStrip). The query is deliberately keyed by the Hive home slug: a
  // pot_settings write on one Hive must not refetch every open toggle — and the
  // toggle now renders on EVERY pot-scoped tab, so that scoping matters more than
  // it did. The accessor keeps the default-deny behavior (missing or failed
  // settings read => false).
  'hive.beaconConsent': {
    argsSchema: z.object({ potId: z.string().trim().min(1).max(120) }),
    resolve: async (rawArgs) => {
      const args = rawArgs as { potId: string };
      const [{ activeWorkspaceId }, { getBeaconPublishConsent }] = await Promise.all([
        import('../workspace-registry'),
        import('../beacon-consent'),
      ]);
      const potId = args.potId.trim();
      const consent = await getBeaconPublishConsent(activeWorkspaceId(), potId).catch(() => false);
      return [{ potId, consent }];
    },
  },

  // savedPrompts.byScope — the Quick Panel prompts outline
  // (quick-panel-saved-prompts-2026-07-13 P-003). One flat row array per scope
  // (workspace-global when `harness` is absent); the client builds the
  // Workflowy tree via saved-prompts-tree.ts. Writes land through the
  // /agent-mcp/saved-prompts routes, which fire notifySyncInvalidate — and the
  // migration-598 change-notify trigger full-busts via the table bridge as a
  // backstop for direct-PG writers.
  'savedPrompts.byScope': {
    argsSchema: z.object({ harness: z.string().trim().min(1).max(120).optional() }),
    resolve: async (rawArgs) => {
      const args = rawArgs as { harness?: string };
      const [{ activeWorkspaceId }, { listSavedPrompts }, { getOrgPg }] = await Promise.all([
        import('../workspace-registry'),
        import('../saved-prompts-store'),
        import('@papercusp/db-org'),
      ]);
      const scope = args.harness
        ? ({ kind: 'harness', slug: args.harness } as const)
        : ({ kind: 'workspace' } as const);
      const rows = await listSavedPrompts(getOrgPg().sql, activeWorkspaceId(), scope);
      return rows as unknown as Record<string, unknown>[];
    },
  },

  // weather.current — local weather for the operator dashboard
  // (platform-ops-batch-2026-07-09 P-003). Live third-party fetch (not a DB
  // read), keyed by WEATHER_API_KEY (apps/operator/.env.local, gitignored —
  // never hardcoded / never committed). A missing/failing key surfaces as a
  // thrown error (the useSyncQuery caller renders its own not-configured
  // state), not a silently-zeroed widget.
  'weather.current': {
    argsSchema: z.object({
      lat: z.number(),
      lon: z.number(),
    }),
    resolve: async (args) => {
      const { fetchCurrentWeather } = await import('../weather/fetch-weather');
      const { lat, lon } = args as { lat: number; lon: number };
      const weather = await fetchCurrentWeather({ lat, lon });
      return [weather];
    },
  },

  // fleet.status — fleet-at-a-glance dashboard rows (platform-ops-batch-2026-07-09
  // P-004, WI-3518): live members, current claim (intent + plan), last activity.
  // Reuses the SAME presence-snapshot assembly coord:presence/coord:inbox share
  // (presence-v2-2026-06-14) — never a parallel roster query — scoped to the
  // whole workspace (an ops dashboard wants every fleet, not one hive's).
  'fleet.status': {
    resolve: async () => {
      const { resolvePresenceScope, assemblePresenceSnapshot } =
        await import('../agent-tools/coordination/presence-snapshot');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const resolved = await resolvePresenceScope(
        { workspaceId: activeWorkspaceId(), harnessSlug: null },
        { scope: 'workspace' },
      );
      const snapshot = await assemblePresenceSnapshot(resolved, {});
      return snapshot.active.map((row) => ({
        ownerId: row.ownerId,
        label: row.ownerLabel ?? row.ownerId,
        role: row.agentRole ?? null,
        intent: row.intent ?? null,
        planSlug: row.currentPlanSlug ?? null,
        potSlug: row.potSlug ?? null,
        fleetSlug: row.fleetSlug ?? null,
        fleetRole: row.fleetRole ?? null,
        sessionState: row.sessionState ?? null,
        lastActiveSecAgo: row.lastActiveSecAgo ?? null,
      })) as unknown[];
    },
  },

  // rubrics.* / scorecards.* — Rubrics tab reads (rubrics-tab-scorecard-ui-2026-07-09
  // P-001..P-003): the rubric list + per-rubric grading rollup, the raw scorecard
  // history (ratings included — the click-into-detail view reads the SAME rows), and
  // the per-criterion trend. Pure reads over the existing rubric/scorecard stores
  // (lib/rubrics.ts / lib/scorecards.ts) — the same functions rubrics:list /
  // scorecards:list / rubrics:trend serve agents; never a parallel query.
  'rubrics.list': {
    // PRECOMPUTED (owner-reported slow Rubrics tab, 2026-07-19). This used to run an
    // N+1 over-fetch inline — a per-rubric listScorecards({ limit: 500 }) (≈13 rubrics
    // × up to 500 full scorecard rows) + a JS score10 projection — measured ~0.7s on a
    // user-facing read on a LOCAL desktop app. It is now produced by the
    // `system:precompute-derived-reads` routine (see derived-reads/producers.ts, where
    // the identical aggregation lives); this is a plain snapshot SELECT. The per-rubric
    // DETAIL reads (scorecards.list / rubrics.trend) stay live.
    resolve: async () => {
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      return readDerivedSnapshotRows('rubrics.list');
    },
  },
  'scorecards.list': scorecardHistoryQueryPair.rowsEntry as QueryEntry<unknown>,
  'scorecards.summary': scorecardHistoryQueryPair.summaryEntry as QueryEntry<unknown>,
  'rubrics.trend': {
    backingTables: ['harness_shared.work_items', 'harness_shared.coord_links', 'harness_shared.harness_plans'],
    argsSchema: z.object({ rubricRef: z.string().min(1) }),
    resolve: async (args) => {
      const { scorecardTrend } = await import('../scorecards');
      const { rubricRef } = args as { rubricRef: string };
      // Definition-aware detail read (learning-rubric-definition-display-2026-08-24
      // D-001): scorecardTrend already resolves the full rubric once for its scale and
      // history boundary, so this opt-in returns that same object without a second read.
      return [await scorecardTrend({ rubricRef, includeDefinition: true })] as unknown[];
    },
  },

  // toastLog.recent — first migration. Mirrors the original ZQL:
  //   zql.toastLog.orderBy('createdAt', 'desc').limit(limit)
  // The flat-row return matches what useSyncQuery's SSEAdapter
  // expects in `data`.
  'toastLog.recent': {
    argsSchema: z.object({
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { listToasts } = await import('../toast-log-data');
      const { limit } = args as { limit: number };
      const { toasts } = await listToasts({ limit });
      return toasts;
    },
  },

  // design.* — Design tab reads. These are query data and therefore ride
  // @papercusp/sync; byte/image fetches and sketch writes stay on explicit
  // HTTP endpoints.
  // P-011: a server-filtered immutable-birth keyset page plus an independent
  // exact all/pending/accepted/ignored companion summary. The list projection
  // stays at the three WI-7232 fields; detail remains on-demand below.
  'designFeatures.byHarness': designFeaturesListQueryPair.rowsEntry as QueryEntry<unknown>,
  'designFeatures.summary': designFeaturesListQueryPair.summaryEntry as QueryEntry<unknown>,
  // WI-7232: the on-demand single-feature read carrying `summary` (and the other
  // detail-card-only fields) dropped from the list above.
  //
  // The design-state columns (needs_design / design_status / design_spec_id /
  // discarded_design_work) live on work_items post-374 and reach this read through
  // the harness_features_consolidated compat VIEW — so work_items is the real
  // invalidation producer and the view is listed alongside it, matching how the
  // byHarness sibling is bridged in table-to-query-names.ts.
  'designFeatures.detail': {
    backingTables: ['harness_shared.work_items', 'harness_shared.harness_features_consolidated'],
    argsSchema: z.object({
      harnessSlug: z.string().min(1),
      featureId: z.string().min(1),
      workspaceId: z.string().default('default'),
    }),
    resolve: async (args) =>
      resolveDesignFeatureDetail(args as { harnessSlug: string; workspaceId: string; featureId: string }),
  },
  'designSketches.byFeature': {
    argsSchema: z.object({
      harnessSlug: z.string().min(1),
      featureId: z.string().min(1),
      workspaceId: z.string().default('default'),
    }),
    resolve: async (args) =>
      resolveDesignSketches(args as { harnessSlug: string; featureId: string; workspaceId: string }),
  },
  'designRegressions.list': {
    resolve: async () => resolveDesignRegressions(),
  },
  'designEvidence.report': {
    // File-backed CI/run artifact (resolveDesignEvidence above), deliberately no
    // Postgres dependency and therefore no table-driven push invalidation.
    backingTables: [] as const,
    resolve: async () => resolveDesignEvidence(),
  },
  'designMemos.list': {
    argsSchema: z.object({ status: z.string().optional() }).optional(),
    resolve: async (args) => resolveDesignMemos((args ?? {}) as { status?: string }),
  },
  'designRegistry.search': {
    argsSchema: z.object({
      ecosystem: z.string().default('react-tailwind'),
      query: z.string().optional(),
    }),
    resolve: async (args) => resolveDesignRegistry(args as { ecosystem?: string; query?: string }),
  },
  'designTokens.list': {
    argsSchema: z.object({ category: z.string().optional() }).optional(),
    resolve: async (args) => resolveDesignTokens((args ?? {}) as { category?: string }),
  },

  // ── GOAL mode (goal-mode-2026-08-07 P-017) ──────────────────────────
  //
  // The first goal-shaped reads in the registry: before these, the goals table
  // had a schema, write tools and an MCP resource, but no path a client could
  // subscribe to at all. Every Phase 4 surface — the rail Goal tab, the HUD
  // goals tab, the goal detail view — reads from exactly these two.
  //
  // BOTH return a SINGLE row wrapping an object, not a row-per-goal. The list's
  // portfolio totals are computed server-side over DISTINCT pots precisely
  // so a client never re-sums the goals itself (a shared pot's spend counts
  // in full against each goal it serves, so the per-goal figures do not add up
  // — D-021). Emitting them as sibling rows would put the wrong arithmetic back
  // within easy reach of every consumer. Same shape as automation.catalog.
  //
  // All four backing tables genuinely move these reads: `goals` is the record,
  // `goal_pots` changes both the pot count and the spend denominator,
  // `work_items` carries the open/needs-human counters through its goal_id
  // stamp, and `agent_usage_samples` is what the spend meters sum.
  'goals.list': {
    backingTables: [
      'harness_shared.goals',
      'harness_shared.goal_pots',
      'harness_shared.work_items',
      'harness_shared.agent_usage_samples',
    ],
    // Plain object, NOT `.default({})`: every field already carries its own
    // default, so `{}` parses to a complete args object anyway, and the wrapper
    // only costs an overload mismatch against the registry's arg type. Same
    // shape as designFeatures.detail above.
    argsSchema: z.object({
      workspaceId: z.string().default('default'),
      status: z.string().nullish(),
      limit: clampedLimit(500, 100),
      harnessSlugs: z.array(z.string().min(1)).max(500).optional(),
    }),
    resolve: async (args) => [
      await resolveGoalsList(
        args as {
          workspaceId: string;
          status?: string | null;
          limit?: number;
          harnessSlugs?: string[];
        },
      ),
    ],
  },
  'goals.detail': {
    backingTables: [
      'harness_shared.goals',
      'harness_shared.goal_pots',
      'harness_shared.work_items',
      'harness_shared.agent_usage_samples',
      // P-019/D-010: the plans rail joins harness_plans for each derived plan's
      // title + status. Without this a plan renamed or archived after the panel
      // opened keeps rendering its old label — the row list is invalidated by
      // work_items above, but the JOINED columns come from here.
      'harness_shared.harness_plans',
      // P-018/D-007: the goal↔agent pairing lives in `agent_modes.subject`, so
      // an agent started on (or stopped off) this goal must repaint the popup's
      // conversation affordance.
      'harness_shared.agent_modes',
    ],
    argsSchema: z.object({
      workspaceId: z.string().default('default'),
      goalId: z.string().min(1),
      activityLimit: clampedLimit(200, 40),
    }),
    resolve: async (args) => [
      await resolveGoalDetail(args as { workspaceId: string; goalId: string; activityLimit?: number }),
    ],
  },

  // ── Batch 2: drizzle-backed simple selects (audit/scan/state) ────────
  //
  // Each entry queries the canonical drizzle-typed table and emits
  // camelCase rows. Mirrors the ZQL `where`/`orderBy`/`limit` chain
  // shape — drizzle's column map handles the snake_case → camelCase
  // conversion, matching what the legacy Zero resolver produced.

  // auditLog.operatorDecisions — workspace+actor-filtered audit log.
  //   zql.auditLog.where(workspaceId).where(actor='system:operator')
  //              .orderBy('ts', 'desc').limit(limit)
  'auditLog.operatorDecisions': {
    argsSchema: z.object({
      workspaceId: z.string(),
      limit: clampedLimit(500, 20),
    }),
    resolve: async (args) => {
      const { workspaceId, limit } = args as { workspaceId: string; limit: number };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.auditLogInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.actor, 'system:operator')))
        .orderBy(desc(t.ts))
        .limit(limit)) as unknown[];
    },
  },

  // operatorBudget.byWorkspace — single-row-per-workspace budget state.
  //   zql.operatorBudget.where(workspaceId).limit(1)
  // Per the ZQL comment: limit(1) instead of .one() — feedback_zero_one_shape_mismatch.
  'operatorBudget.byWorkspace': {
    // `workspaceId` is OPTIONAL. The operator Settings page reads this beside
    // operatorConfig/Preferences/StandingApprovals.byWorkspace, none of which
    // take args — they scope by the request's x-papercusp-workspace ALS — and
    // a REQUIRED id here 500'd that page on every load (zod invalid_type,
    // EI-22469131771258095) while OperatorPanel, which passes it explicitly,
    // worked. Absent ⇒ the request's workspace, the same resolution every
    // other `activeWorkspaceId()` reader in this registry uses.
    argsSchema: z.object({ workspaceId: z.string().optional() }).optional(),
    resolve: async (args) => {
      const explicit = (args as { workspaceId?: string } | undefined)?.workspaceId;
      const [{ getOrgPg, generated }, { activeWorkspaceId }] = await Promise.all([
        import('@papercusp/db-org'),
        import('../workspace-registry'),
      ]);
      const workspaceId = explicit ?? activeWorkspaceId();
      const { eq } = await import('drizzle-orm');
      const t = generated.operatorBudgetInHarnessShared;
      const { db } = getOrgPg();
      return (await db.select().from(t).where(eq(t.workspaceId, workspaceId)).limit(1)) as unknown[];
    },
  },

  // ── Batch 3: harnessXxx.byHarness family ─────────────────────────────
  //
  // All five follow the same pattern: filter by harness_slug, optional
  // orderBy on a per-table column. The original ZQL chain is mechanical;
  // each entry is ~15 LOC.

  // harnessTextArtifact.byHarness — text artifacts ordered by relative path.
  //   zql.harnessTextArtifacts.where('harnessSlug', s).orderBy('relPath', 'asc')
  // harnessProjects.lite — the workspace's harness registry list (the
  // /api/harness/projects/lite payload's `projects` rows; clients regroup
  // hives via the shared groupByHive). Invalidated from the registry write
  // seam in harness-registry.ts, so creates/deletes/renames from ANY
  // operator process live-update open lists (EI-206). Workspace scoping
  // rides the request's x-papercusp-workspace ALS, same as the route.
  'harnessProjects.lite': {
    argsSchema: z.object({ includeHiveHomes: z.boolean().optional() }).optional(),
    resolve: async (args) => {
      const { buildProjectsLitePayload } = await import('../harness/projects-lite');
      // Bypass the 1s TTL cache: an invalidation-triggered refetch must not
      // serve a payload built just BEFORE the write it's reacting to.
      const payload = await buildProjectsLitePayload({
        bypassCache: true,
        includeHiveHomes: (args as { includeHiveHomes?: boolean } | undefined)?.includeHiveHomes === true,
      });
      return payload.projects as unknown[];
    },
  },

  // harnessWorkspaces.byHarness — workspace memberships for the /adv Workspaces popover.
  // Registry writes invalidate via harness_shared.harness_registry.changed.
  'harnessWorkspaces.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { workspacesForHarness } = await import('../harness-membership');
      return (await workspacesForHarness(harnessSlug)).map((workspaceId) => ({ workspaceId }));
    },
  },

  // contributors.byHarness — Contributors tab rows, live via contributors and
  // tier-source table invalidations. Mirrors /harness/:slug/contributors.
  'contributors.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg } = await import('@papercusp/db-org');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { statsAggregateForStatus } = await import('../identity/binding-verifier-types');
      const ws = workspaceId ?? activeWorkspaceId();
      const { sql } = getOrgPg();
      const rows = await sql<
        {
          github_user_id: number;
          github_username: string;
          display_name: string | null;
          avatar_url: string | null;
          joined_at: Date | string;
          last_seen_at: Date | string | null;
          binding_status: string;
          binding_last_checked_at: Date | string | null;
          device_attestations: unknown;
          prs_merged: string | number | null;
          features_shipped: string | number | null;
          activity_events: string | number | null;
        }[]
      >`
        SELECT
          c.github_user_id,
          c.github_username,
          c.display_name,
          c.avatar_url,
          c.joined_at,
          c.last_seen_at,
          c.binding_status,
          c.binding_last_checked_at,
          c.device_attestations,
          (
            SELECT COUNT(*) FROM harness_shared.auto_review_audit a
            WHERE a.workspace_id = c.workspace_id
              AND a.harness_slug = c.harness_slug
              AND a.author_github_id = c.github_user_id
              AND a.action IN ('auto_merge', 'manual_merge')
          ) AS prs_merged,
          (
            SELECT COUNT(*) FROM harness_shared.harness_features_consolidated f
            WHERE f.workspace_id = c.workspace_id
              AND f.harness_slug = c.harness_slug
              AND f.status = 'shipped'
              AND f.taken_by = c.github_user_id::text
          ) AS features_shipped,
          (
            SELECT COUNT(*) FROM harness_shared.contributor_usage_events e
            WHERE e.harness_slug = c.harness_slug
              AND e.github_user_id = c.github_user_id
          ) AS activity_events
        FROM harness_shared.contributors c
        WHERE c.workspace_id = ${ws}
          AND c.harness_slug = ${harnessSlug}
        ORDER BY c.joined_at DESC
      `;
      const toMs = (v: Date | string | null): number | null => {
        if (v === null) return null;
        if (v instanceof Date) return v.getTime();
        return new Date(v).getTime();
      };
      const toCount = (v: string | number | null | undefined): number => {
        if (v == null) return 0;
        const n = typeof v === 'string' ? Number(v) : v;
        return Number.isFinite(n) ? n : 0;
      };
      return rows.map((r) => {
        const aggregate = statsAggregateForStatus(r.binding_status as never);
        return {
          github_user_id: r.github_user_id,
          github_username: r.github_username,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
          joined_at: toMs(r.joined_at) ?? 0,
          last_seen_at: toMs(r.last_seen_at),
          binding_status: r.binding_status,
          binding_last_checked_at: toMs(r.binding_last_checked_at),
          device_count: Array.isArray(r.device_attestations) ? r.device_attestations.length : 0,
          prs_merged: aggregate ? toCount(r.prs_merged) : 0,
          features_shipped: aggregate ? toCount(r.features_shipped) : 0,
          activity_events: aggregate ? toCount(r.activity_events) : 0,
        };
      });
    },
  },

  // P-010: one server-filtered keyset page plus an independent exact companion
  // summary. OMP transcript summaries decorate returned rows but never decide
  // membership in the authoritative session-ledger population.
  'advSessions.list': advSessionsListQueryPair.rowsEntry as QueryEntry<unknown>,
  'advSessions.summary': advSessionsListQueryPair.summaryEntry as QueryEntry<unknown>,

  // agentDetail.byOwner — Tier-3 dossier detail for the selected Sessions agent.
  'agentDetail.byOwner': {
    argsSchema: z.object({ ownerId: z.string().min(1) }),
    resolve: async (args) => {
      const { ownerId } = args as { ownerId: string };
      const { getAgentDetail } = await import('../adv-agent-detail');
      return [await getAgentDetail(ownerId)];
    },
  },

  // agentOrders.byOwner — the ORDERS half of the session popup's two-panel
  // dossier (session-chat-popup-direction-d-2026-08-02 P-011): what the agent
  // was TOLD, as opposed to agentDetail.byOwner's what-it-is-DOING.
  //
  // Deliberately a SEPARATE named query rather than another leg on
  // agentDetail.byOwner: the orders gather runs buildCarryBrief (several
  // queries — directives, walls, checkpoints, cited-ref hydration), while the
  // Orders panel is independently toggleable. It now defaults OPEN
  // [owner 2026-08-03], so the popup does pay the gather on a normal open —
  // but a reader who CLOSES the panel must stop paying for it, and that is
  // what keeping this query separate buys. Folding it into agentDetail would
  // make the cost unconditional, and agentDetail is already read by the
  // footer's summary chip on every open.
  'agentOrders.byOwner': {
    // WI-6964. Traced from the gather chain, not guessed: getAgentOrders →
    // buildCarryBrief (work_items), buildControlAnchorState (session_briefs,
    // plan_item_claims), carry-note (carry_notes), modes/store (agent_modes,
    // agent_mode_changes). These are the tables whose change alters what the agent
    // was TOLD, which is this panel's whole subject.
    //
    // coord_presence is read by that chain but deliberately NOT listed: it is
    // rewritten on every heartbeat, so listing it would push this panel on a timer
    // rather than on a real orders change. Liveness reaches the UI through the
    // presence-backed queries instead. If the panel ever needs presence-driven
    // pushes, add it knowingly — this omission is a decision, not an oversight.
    //
    // WI-6974 — the other five are now DECLARED, and every one of them is
    // PUSH_EXEMPT with a PRODUCER-side push instead of a table-bridge entry
    // (lib/agent-orders-notify.ts; the derived-reads precedent in
    // resolver-backing-table-coverage.test.ts). This item was originally filed as
    // "wire them like work_items"; reading the WRITERS says that is wrong for all
    // five, and a point-in-time write-rate sample cannot see why:
    //
    //   plan_item_claims  renewOwnerActivityClaims rewrites last_activity_ts on
    //                     EVERY TURN of every claim-holding owner — a heartbeat, the
    //                     coord_presence shape above, not a lane change.
    //   carry_notes       every agent's loop:checkpoint (~26/hr fleet-wide, measured).
    //   session_briefs    the row moves on intent/current_files writes; only the
    //                     control_* columns are orders, and persistControlAnchor runs
    //                     on essentially every orient with an explicit no-op branch.
    //   agent_modes,      genuinely event-driven, but neither carries an owner-scoped
    //   agent_mode_changes key the bridge could scope by, so a trigger would full-bust
    //                     every open panel for a mode set on an unrelated agent.
    //
    // A row trigger fires on the write, never on its meaning — so wiring these would
    // trade WI-6974's defect (refreshes on remount only) for its mirror image, a panel
    // pushed on a timer, which is WORSE because it looks live. The producers know both
    // things the trigger cannot: WHETHER orders changed, and for WHICH owner.
    backingTables: [
      'harness_shared.work_items',
      'harness_shared.session_briefs',
      'harness_shared.plan_item_claims',
      'harness_shared.carry_notes',
      'harness_shared.agent_modes',
      'harness_shared.agent_mode_changes',
    ],
    argsSchema: z.object({ ownerId: z.string().min(1) }),
    resolve: async (args) => {
      const { ownerId } = args as { ownerId: string };
      const { getAgentOrders } = await import('../adv-agent-orders');
      return [await getAgentOrders(ownerId)];
    },
  },

  // agentLeaderBrief.byOwner — the FLEET-PEERS half of the session popup, for a
  // viewed agent that resolves as a fleet LEADER
  // (popup-agent-state-coverage-2026-08-18 P-002).
  //
  // Deliberately a THIRD named query beside agentDetail/agentOrders, for the
  // same reason those two are separate: the brief is an expensive fan-out
  // (roster, ~9 decorations, unowned criticals, lane health, capacity, spec
  // preview, invariants), and the overwhelming majority of popups are opened on
  // an agent that leads nothing. Folding it into agentDetail would make that
  // cost unconditional on every popup open AND on every footer summary-chip
  // read. Here a non-leader costs two cheap reads and returns a `skipped`
  // verdict — see adv-agent-leader-brief.ts for why the skip REASON is carried
  // rather than collapsed into a null brief.
  //
  // It calls buildLeaderBrief — the READ half of the `fleet:leader-brief` tool
  // itself, extracted for this purpose — never a reimplementation. A second
  // derivation would drift from what the leader is actually told, which would
  // make the pane worse than absent: confidently wrong about a fleet in
  // trouble. The two behaviours that are correct for an agent caller and wrong
  // for a viewer (claiming a vacant leader seat; resolving the fleet from the
  // CALLER's presence, which inside the operator process means the operator's
  // own launch fleet) are turned off through the caller bag, not by forking.
  'agentLeaderBrief.byOwner': {
    // coord_presence is the RIGHT push source here, and the opposite call from
    // the one agentOrders.byOwner makes about the same table. There, presence
    // was excluded because a heartbeat is not a change in what the agent was
    // TOLD, so listing it would push a panel on a timer. Here member LIVENESS
    // is the pane's whole subject: `dormant`, `spinning`, `throttled` and
    // `coordHook` are all derived from presence rows, so a presence write is a
    // real change in what the pane says. The 90s (name,args) dedupe bounds the
    // refetch rate, and the query only runs while a leader's popup is open.
    //
    // agent_fleets (the leadership registry) is NOT declared: it has no entry in
    // the invalidation map, and every write that moves leadership
    // (fleet:take-leadership / fleet:join) also writes the mover's presence
    // fleet_role, so the push above already covers the case. Declaring it would
    // buy a PUSH_EXEMPT row and no liveness.
    backingTables: ['harness_shared.coord_presence'],
    argsSchema: z.object({ ownerId: z.string().min(1) }),
    resolve: async (args) => {
      const { ownerId } = args as { ownerId: string };
      const { getAgentLeaderBrief } = await import('../adv-agent-leader-brief');
      return [await getAgentLeaderBrief(ownerId)];
    },
  },

  // advRoster.list — shared Sessions roster context, formerly a 4s
  // `/api/adv/roster` poll. Shape matches the route payload.
  'advRoster.list': {
    argsSchema: z
      .object({
        workspaceId: z.string().nullable().optional(),
        endedLimit: clampedLimit(200, 50).optional(),
      })
      .optional(),
    resolve: async (args) => {
      const { workspaceId = null, endedLimit = 50 } = (args ?? {}) as {
        workspaceId?: string | null;
        endedLimit?: number;
      };
      // BOUNDED + EXTRACTED (WI-39825). The four-leg fan-out, its shared read
      // deadline and the per-leg degradation policy now live in
      // `adv-roster-read.ts`. The move is what makes the deadline GUARDABLE: a
      // budget can only be proved to fire by moving it, and a resolver's only
      // input is its wire args — so the knob had to become a function parameter
      // rather than a client-visible field. That module's header carries the
      // full reasoning and the per-leg policy.
      const { readAdvRoster } = await import('./adv-roster-read');
      return [await readAdvRoster({ workspaceId, endedLimit })];
    },
  },

  // planSessions.list — every agent session attributed to ONE plan, for the
  // plan popup's Sessions tab (owner-plans-single-pane-2026-07-17 P-004).
  // Two legs (adv_sessions.plan_slug primary + a plan-item-claim supplement),
  // deduped to one row per agent identity. Invalidated by any adv_sessions
  // write (table-to-query-names) so a new/ended session refreshes it live.
  'planSessions.list': {
    argsSchema: z.object({
      planSlug: z.string().min(1),
      workspaceId: z.string().nullable().optional(),
      limit: clampedLimit(500, 200).optional(),
    }),
    resolve: async (args) => {
      const {
        planSlug,
        workspaceId = null,
        limit = 200,
      } = args as {
        planSlug: string;
        workspaceId?: string | null;
        limit?: number;
      };
      const { listPlanSessions } = await import('../adv-sessions');
      return (await listPlanSessions(planSlug, { workspaceId, limit })) as unknown[];
    },
  },

  // planWorkActivity.list — plan slug → last-WORK timestamp (epoch ms), the ⚒
  // half of the PlansPane dual-timestamp pair + the HUD plan cards
  // (plan-visibility-revamp-2026-08-23 P-001 / D-003). One aggregate row per
  // plan with >=1 attributed work-item; a plan absent from the result was
  // simply never worked (the pane renders the dim em-dash from the map miss).
  // Full-bust invalidated by any work_items write via table-to-query-names —
  // workspace-keyed, so no per-row scope can match. Semantics + the
  // observation-lane exclusion are documented in ./plan-work-activity.
  'planWorkActivity.list': {
    backingTables: ['harness_shared.work_items'],
    argsSchema: z
      .object({
        workspaceId: z.string().nullable().optional(),
      })
      .optional(),
    resolve: async (args) => {
      const { workspaceId = null } = (args ?? {}) as { workspaceId?: string | null };
      const { listPlanWorkActivity } = await import('./plan-work-activity');
      return (await listPlanWorkActivity({ workspaceId })) as unknown[];
    },
  },

  // planActivity.list — the PlanDashboard "Recent activity" feed: merged plan
  // EDITS (plan_revisions) + work-item PROGRESS rows (work_items by
  // source_plan_slug) for one plan, newest first
  // (plan-visibility-revamp-2026-08-23 P-004; the option-C dashboard consumes
  // it, P-003). Full-bust from both backing tables via table-to-query-names.
  'planActivity.list': {
    backingTables: ['harness_shared.plan_revisions', 'harness_shared.work_items'],
    argsSchema: z.object({
      planSlug: z.string().min(1),
      workspaceId: z.string().nullable().optional(),
      limit: clampedLimit(100, 30).optional(),
    }),
    resolve: async (args) => {
      const {
        planSlug,
        workspaceId = null,
        limit = 30,
      } = args as { planSlug: string; workspaceId?: string | null; limit?: number };
      const { listPlanActivity } = await import('./plan-activity-feed');
      return (await listPlanActivity({ planSlug, workspaceId, limit })) as unknown[];
    },
  },

  // hiveFromRepo.progress — REAL step transitions for the long create-from-URL
  // (hive-from-repo-hardening P-008). The composition records to the in-process
  // store + invalidates this name per step; the form subscribes with its
  // client-minted progressId BEFORE submitting. Transient UX rows, not state.
  'hiveFromRepo.progress': {
    argsSchema: z.object({ progressId: z.string().min(1).max(64) }),
    resolve: async (args) => {
      const { progressId } = args as { progressId: string };
      const { getFromRepoProgress } = await import('../harness/from-repo-progress');
      return getFromRepoProgress(progressId) as unknown[];
    },
  },

  'harnessTextArtifact.byHarness': {
    // EI-1763: workspaceId scopes the read to the caller's tenant. harness_slug is
    // per-workspace-unique (NOT global), and getOrgPg bypasses RLS, so a slug-only
    // read returns CROSS-WORKSPACE rows. Optional for a non-breaking rollout (a caller
    // that omits it keeps today's behavior); tighten to required once all clients pass it.
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessTextArtifactsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.relPath))) as unknown[];
    },
  },

  // harnessProjectFiles.byHarness — single-row-per-harness (SPEC.md etc bundle).
  //   zql.harnessProjectFiles.where('harnessSlug', s)  (no order)
  'harnessProjectFiles.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessProjectFilesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )) as unknown[];
    },
  },

  // adaptiveTelemetry.byHarness — the Harness Settings tier-dispatch history.
  // Empty is authoritative; writes push through the adaptive_telemetry table
  // bridge so the settings grid never needs an on-open REST snapshot.
  'adaptiveTelemetry.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, limit } = args as {
        harnessSlug: string;
        workspaceId?: string;
        limit: number;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.adaptiveTelemetryInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select({
          id: t.id,
          ts: t.ts,
          feature_id: t.featureId,
          requested_n: t.requestedN,
          actual_n: t.actualN,
          tier_label: t.tierLabel,
          available_at_decision: t.availableAtDecision,
          max_slots: t.maxSlots,
          outcome: t.outcome,
          outcome_ts: t.outcomeTs,
          duration_ms: t.durationMs,
          synthesized: t.synthesized,
          synthesis_error: t.synthesisError,
        })
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.ts))
        .limit(limit)) as unknown[];
    },
  },

  // discordConfig.byHarness — Discord guild config + live widget data per harness.
  // Reads from harnessProjectFiles (config.json) and fetches widget data server-side.
  // Empty is authoritative (a harness with no row or no discord config returns empty).
  // (all-active-surfaces-data-sync-migration-2026-07-11 P-009)
  'discordConfig.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as {
        harnessSlug: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessProjectFilesInHarnessShared;
      const { db } = getOrgPg();

      // Fetch the config.json from harnessProjectFiles
      const rows = await db
        .select({ config: t.config })
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        );

      // Parse discord config from the config.json
      const configJson = rows[0]?.config;
      if (!configJson) return [];

      try {
        const cfg = JSON.parse(configJson) as Record<string, unknown>;
        const discordCfg = cfg.discord as Record<string, unknown> | undefined;
        if (!discordCfg) return [];

        const guildId = typeof discordCfg.guildId === 'string' ? discordCfg.guildId.trim() : '';
        const inviteUrl = typeof discordCfg.inviteUrl === 'string' ? discordCfg.inviteUrl.trim() : '';
        if (!guildId) return [];

        // Return the discord config (no widget data — widget is fetched client-side on demand)
        return [{ guildId, inviteUrl }] as unknown[];
      } catch {
        return [];
      }
    },
  },

  // harnessSkills.byHarness — skills sorted by name.
  //   zql.harnessSkills.where('harnessSlug', s).orderBy('name', 'asc')
  'harnessSkills.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessSkillsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.name))) as unknown[];
    },
  },

  // harnessDecisions.byHarness — decisions in chronological order.
  //   zql.harnessDecisions.where('harnessSlug', s).orderBy('ts', 'asc')
  'harnessDecisions.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessDecisionsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.ts))) as unknown[];
    },
  },

  // ── Batch 4: lanes / escalations / checkpoints / git-log / feature PRs ─
  //
  // Each filter pattern slightly different; otherwise mechanical.

  // harnessLanes.byHarness — lanes filtered by harness+workspace+phase.
  //   zql.harnessLanes.where(harnessSlug).where(workspaceId).where(phase)
  //                   .orderBy('role', 'asc')
  'harnessLanes.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessLanesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId), eq(t.phase, phase)))
        .orderBy(asc(t.role))) as unknown[];
    },
  },

  // harnessLanes.snapshot — dashboard-shaped lane snapshot for /adv chrome.
  // Replaces the legacy `/api/harness/:slug/lanes` read without forcing clients
  // to know the filesystem lanes.json shape or effective-config max-worker rule.
  'harnessLanes.snapshot': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string().optional(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId?: string;
        phase: string;
      };
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { resolvePhasedProject, harnessDir } = await import('../harness-core');
      const { readEffectiveHarnessConfig } = await import('../harness-effective-config');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { phasePhaseLabel } = await import('../harness-phases');
      const project = await resolvePhasedProject(harnessSlug, phasePhaseLabel(phase));
      if (!project) return [];
      const p = join(harnessDir(project), 'lanes.json');
      const nowMs = Date.now();
      const lanes: Array<{
        pid: number;
        featureId: string;
        startedAt: number;
        elapsedSeconds: number;
        alive: boolean;
      }> = [];
      if (existsSync(p)) {
        try {
          const raw = JSON.parse(readFileSync(p, 'utf8')) as { lanes?: unknown[] };
          for (const l of raw.lanes ?? []) {
            if (!l || typeof l !== 'object') continue;
            const lane = l as { pid?: unknown; feature_id?: unknown; started_at?: unknown };
            if (typeof lane.pid !== 'number' || typeof lane.feature_id !== 'string') continue;
            let alive = false;
            try {
              process.kill(lane.pid, 0);
              alive = true;
            } catch {}
            const ts = typeof lane.started_at === 'number' ? lane.started_at * 1000 : nowMs;
            lanes.push({
              pid: lane.pid,
              featureId: lane.feature_id,
              startedAt: ts,
              elapsedSeconds: Math.max(0, Math.floor((nowMs - ts) / 1000)),
              alive,
            });
          }
        } catch {
          // Match the route's tolerant behavior: malformed lanes.json degrades to empty.
        }
      }
      let max = 1;
      try {
        const cfg = await readEffectiveHarnessConfig(project.slug, workspaceId ?? activeWorkspaceId(), project.path);
        const pw = cfg?.parallelWorkers as Record<string, unknown> | undefined;
        if (typeof pw?.max === 'number' && pw.max > 0) max = pw.max;
      } catch {}
      return [{ lanes, max }];
    },
  },

  // harnessEscalations.byHarness — single escalation row per phase.
  //   zql.harnessEscalations.where(harnessSlug).where(phase).limit(1)
  'harnessEscalations.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessEscalationsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .limit(1)) as unknown[];
    },
  },

  // harnessCheckpoints.byHarness — checkpoints ordered by waiting time.
  //   zql.harnessCheckpoints.where(harnessSlug).orderBy('waitingSinceMs', 'asc')
  'harnessCheckpoints.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessCheckpointsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.waitingSinceMs))) as unknown[];
    },
  },

  // featurePrs.byHarness — feature PRs ordered by feature id.
  //   zql.harnessFeaturePrs.where(harnessSlug).orderBy('featureId', 'asc')
  'featurePrs.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness). This
    // resolver was MISSED by su-d2230's "remediated to zero" pass because the
    // coverage guard's block body bled the NEXT resolver's doc-comment (which
    // mentioned workspaceId) into this block, masking it — fixed alongside this.
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturePrsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // ── Batch 5: status / tests / archives / hook-logs / health ─────────

  // harnessStatus.byHarness — single status row per (harness, workspace, phase).
  //   zql.harnessStatus.where(harnessSlug).where(workspaceId).where(phase).limit(1)
  'harnessStatus.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessStatusInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId), eq(t.phase, phase)))
        .limit(1)) as unknown[];
    },
  },

  // harnessStatus.snapshot RETIRED (whole-app-sync-payload-audit-2026-07-19 P-001):
  // a dead sync query — no useSyncQuery consumer anywhere in apps/ (HarnessTopBar's
  // doc comment was the only remaining reference). Its resolver called
  // getHarnessStatusFull, whose payload is a ~16MB features array; delivering that
  // through sync on every harness_status / work_items write was pure waste. The
  // underlying getHarnessStatusFull is retained for the HTTP status + device routes
  // (see P-008). Removed from TABLE_TO_QUERY_NAMES's three bridge entries in the same
  // change so the every-bridged-name-has-a-resolver invariant stays green.

  // harnessTests.byHarness — tests filtered by harness+phase, by name.
  //   zql.harnessTests.where(harnessSlug).where(phase).orderBy('name', 'asc')
  'harnessTests.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessTestsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(asc(t.name))) as unknown[];
    },
  },

  // harnessArchives.byHarness — archives by harness+phase, latest first.
  //   zql.harnessArchives.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessArchives.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessArchivesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessHookLogs.byHarness — most-recent 50 hook events per harness.
  //   zql.harnessHookLogs.where(harnessSlug).orderBy('ts', 'desc').limit(50)
  'harnessHookLogs.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessHookLogsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.ts))
        .limit(50)) as unknown[];
    },
  },

  // ── Batch 6: phases / smoke-test / brainstorm ─
  // (summary.byHarness retired — fs-watcher-retirement step 2; the
  //  harness_summaries mirror was a dead legacy path, dropped in migration 282.
  //  The live summary UI reads harness_text_artifacts, migration 035.)

  // harnessPhases.byHarness retired — fs-watcher-retirement step 5; the
  // harness_phases mirror was dropped (migration 285). HealthBadge reads
  // liveness from harnessLanes.byHarness; the /phases REST route recomputes
  // the rest on demand.

  // harnessSmokeTest.byHarness — single smoke-test row per harness.
  //   zql.harnessSmokeTest.where(harnessSlug).limit(1)
  'harnessSmokeTest.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessSmokeTestInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .limit(1)) as unknown[];
    },
  },

  // harnessBrainstorm.byHarness — brainstorm rows ordered by phase asc.
  //   zql.harnessBrainstorm.where(harnessSlug).orderBy('phase', 'asc')
  'harnessBrainstorm.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness) — also
    // masked from su-d2230's pass by the coverage-guard comment-bleed blind spot.
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessBrainstormInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.phase))) as unknown[];
    },
  },

  // ── Batch 7: pending-reviews / pending-issues / screenshots / branchActions / agent-chats ─

  // pendingReviews.byHarness — harness+workspace+phase; optional resolved filter.
  //   zql.pendingReviews.where(harnessSlug).where(workspaceId).where(phase)
  //                     [.where('resolved', false)]  // when !includeResolved
  //                     .orderBy('ts', 'desc')
  'pendingReviews.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
      includeResolved: z.boolean().default(false),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase, includeResolved } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
        includeResolved: boolean;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.pendingReviewsInHarnessShared;
      const { db } = getOrgPg();
      const baseConds = [eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId), eq(t.phase, phase)];
      const conds = includeResolved ? baseConds : [...baseConds, eq(t.resolved, false)];
      return (await db
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessPendingIssues.byHarness — harness+phase, newest first.
  //   zql.harnessPendingIssues.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessPendingIssues.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessPendingIssuesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessScreenshots.byHarness — harness+phase, newest first.
  //   zql.harnessScreenshots.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessScreenshots.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessScreenshotsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessBranchActions.byHarnessAndBranch retired — fs-watcher-retirement
  // step 4; the harness_branch_actions mirror was unconsumed (the
  // /branch/:branch/actions REST route recomputes on demand). Table dropped
  // in migration 283.

  // agentChats.byHarness — chats ordered by updatedAt desc, capped.
  //   zql.agentChatsConsolidated.where(harnessSlug).orderBy('updatedAt', 'desc').limit(limit)
  'agentChats.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      limit: clampedLimit(500, 50),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, limit, workspaceId } = args as {
        harnessSlug: string;
        limit: number;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.agentChatsConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.updatedAt))
        .limit(limit)) as unknown[];
    },
  },

  // ── Batch 8: featureNotes / featureDebugNotes / featureAudit / chunkPlans / delegates ─

  // featureNotes.byHarness — feature notes ordered by featureId asc.
  //   zql.harnessFeatureNotes.where(harnessSlug).orderBy('featureId', 'asc')
  'featureNotes.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeatureNotesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // featureDebugNotes.byHarness — debug notes ordered by featureId asc.
  //   zql.harnessFeatureDebugNotes.where(harnessSlug).orderBy('featureId', 'asc')
  'featureDebugNotes.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeatureDebugNotesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // featureAudit.byHarness — feature audit log, newest first, cap 2000.
  //   zql.featureAuditConsolidated.where(harnessSlug).orderBy('ts', 'desc').limit(2000)
  'featureAudit.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.featureAuditConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.ts))
        .limit(2000)) as unknown[];
    },
  },

  // featureTimeline.byFeature — synthesized feature event timeline.
  // The helper mirrors /harness/:slug/features/:id/timeline; sync delivery keeps
  // PlanDetail's feature slide-over off ad-hoc REST reads.
  'featureTimeline.byFeature': {
    argsSchema: z.object({ harnessSlug: z.string(), featureId: z.string() }),
    resolve: async (args) => {
      const { harnessSlug, featureId } = args as { harnessSlug: string; featureId: string };
      const { getFeatureTimeline } = await import('../endpoint-route/routes/harness/feature-views');
      const result = await getFeatureTimeline(harnessSlug, featureId);
      return result.ok ? result.events : [];
    },
  },

  // chunkPlans.byHarness — all chunk plans for a harness, ordered.
  //   zql.harnessChunkPlans.where(harnessSlug)
  //                        .orderBy('featureId', 'asc').orderBy('chunkIndex', 'asc')
  'chunkPlans.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessChunkPlansInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.featureId), asc(t.chunkIndex))) as unknown[];
    },
  },

  // chunkPlans.byFeature — chunk plans filtered by harness+feature.
  //   zql.harnessChunkPlans.where(harnessSlug).where(featureId)
  //                        .orderBy('chunkIndex', 'asc')
  'chunkPlans.byFeature': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness) — also
    // masked from su-d2230's pass by the coverage-guard comment-bleed blind spot.
    argsSchema: z.object({ harnessSlug: z.string(), featureId: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, featureId, workspaceId } = args as {
        harnessSlug: string;
        featureId: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessChunkPlansInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.featureId, featureId), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.featureId, featureId)),
        )
        .orderBy(asc(t.chunkIndex))) as unknown[];
    },
  },

  // (delegates.byWorkspace removed — collapse-delegate-into-workitems-2026-06-04:
  //  a delegate IS a work_item now; the operator panel reads delegated tasks via
  //  GET /api/agent-mcp/delegates, backed by delegated-tasks over work_items.)

  // ── Batch 9: plugins / projectSpec / org_* (first 2) ──────────────────

  // pluginConfigs.byHarness — plugin configs scoped to (harness, workspace).
  //   zql.pluginConfigs.where(harnessSlug).where(workspaceId)
  'pluginConfigs.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as {
        harnessSlug: string;
        workspaceId: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.pluginConfigsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId)))) as unknown[];
    },
  },

  // pluginEnables.byWorkspace — plugin-enable rows for a workspace.
  //   zql.pluginEnables.where(workspaceId).orderBy('updatedAt', 'desc')
  'pluginEnables.byWorkspace': {
    argsSchema: z.object({ workspaceId: z.string() }),
    resolve: async (args) => {
      const { workspaceId } = args as { workspaceId: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.pluginEnablesInHarnessShared;
      const { db } = getOrgPg();
      return (await db.select().from(t).where(eq(t.workspaceId, workspaceId)).orderBy(desc(t.updatedAt))) as unknown[];
    },
  },

  // projectSpecRevisions.byProject — spec revisions for one project, newest first.
  //   zql.projectSpecRevisions.where(projectId).orderBy('ts', 'desc').limit(limit)
  'projectSpecRevisions.byProject': {
    argsSchema: z.object({
      projectId: z.string(),
      // Generous bound — a local desktop app loads all of a project's revisions
      // in practice; the cap only exists so a runaway project can't blow the
      // live read. CLAMP (in the body), don't `.max()`-REJECT: a hard max turns a
      // client/server version skew into a panel-breaking error. When it IS capped
      // the carried total keeps the count honest.
      limit: z.number().int().positive().default(500),
    }),
    resolve: async (args) => {
      const { projectId, limit } = args as { projectId: string; limit: number };
      const lim = Math.min(limit, 500); // clamp server-side; never reject
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { count, desc, eq } = await import('drizzle-orm');
      const t = generated.projectSpecRevisionsInHarnessShared;
      const { db } = getOrgPg();
      // BOUNDED (WI-39825) via the shared rows+count fan-out, which also carries
      // the TRUE total on row[0]._meta (the flat-row sync contract has no
      // envelope) so the UI shows "N of TOTAL" instead of the capped length.
      // This site's hand-written version resolved a failed count to
      // `?? rows.length` — rendering a confident WRONG total equal to the window
      // size; the helper flags `totalUnavailable` instead. See its header.
      const { readBoundedList } = await import('./bounded-list-read');
      return (await readBoundedList({
        rows: db.select().from(t).where(eq(t.projectId, projectId)).orderBy(desc(t.ts)).limit(lim),
        count: db
          .select({ n: count() })
          .from(t)
          .where(eq(t.projectId, projectId))
          .then((r) => r[0]?.n ?? null),
        label: 'projectSpecRevisions.byProject',
      })) as unknown[];
    },
  },

  // proposalsShared.byHarness — proposals filtered by (harness, workspace, phase).
  //   zql.harnessProposalsShared.where(harnessSlug).where(workspaceId).where(phase)
  //                             .orderBy('ts', 'desc')
  'proposalsShared.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessProposalsSharedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId), eq(t.phase, phase)))
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // ── Batch 11 (final): the four *Consolidated cross-harness queries ──
  //
  // Each ZQL `featuresConsolidated` etc. maps to drizzle's
  // `harnessFeaturesConsolidatedInHarnessShared` (the table is
  // `harness_features_consolidated` etc — the prefix mismatch is
  // historical, drizzle's canonical name wins).

  // P-004: one normalized harness predicate backs the bounded keyset page and
  // the exact workItems.summary aggregate. The paired factory makes args,
  // backing tables, deadline behavior and invalidation ownership structural.
  'workItems.byHarness': workItemsListQueryPair.rowsEntry as QueryEntry<unknown>,
  'workItems.summary': workItemsListQueryPair.summaryEntry as QueryEntry<unknown>,

  // workItemAdmission.runs — P-005's owner-inspectable admission ledger.
  // One payload carries the bounded/filterable run rows plus the UNFILTERED
  // queue and census rollups, so selecting a run kind cannot hide a census-rise
  // alarm. No args is the canonical workspace-wide view; optional filters make
  // the route useful for a single harness without proliferating query names.
  //
  // Both tables are real producers: admission_runs moves the history/trend,
  // while work_items moves pending/unreviewed counts and the immutable
  // admitted_at → first_claimed_at latency distribution. The table bridge maps
  // both, and the two routine writers also push once after a successful tick.
  'workItemAdmission.runs': {
    argsSchema: z
      .object({
        harnessSlug: z.string().min(1).max(200).optional(),
        kind: z
          .enum(['census', 'promoter-tick', 'bulk-stage', 'delta-sweep', 'daily-digest', 'durable-park-audit'])
          .optional(),
        state: z.enum(['running', 'complete', 'failed', 'blocked']).optional(),
        // Clamp in the reader rather than rejecting a newer client's larger
        // window — the same client/server skew rule as workItems.byHarness.
        limit: z.number().int().positive().optional(),
      })
      .optional(),
    backingTables: ['harness_shared.admission_runs', 'harness_shared.work_items'],
    resolve: async (args) => {
      const [{ activeWorkspaceId }, { readWorkItemAdmissionSnapshot }] = await Promise.all([
        import('../workspace-registry'),
        import('../work-items-admission-promoter'),
      ]);
      const a = (args ?? {}) as {
        harnessSlug?: string;
        kind?: 'census' | 'promoter-tick' | 'bulk-stage' | 'delta-sweep' | 'daily-digest' | 'durable-park-audit';
        state?: 'running' | 'complete' | 'failed' | 'blocked';
        limit?: number;
      };
      return [
        await readWorkItemAdmissionSnapshot({
          workspaceId: activeWorkspaceId(),
          ...a,
        }),
      ];
    },
  } as QueryEntry<unknown>,

  // workScope.policy — the /admin/work-scope pane's read (WI-2145092, the D-003 residue of
  // workspace-work-scope-policy-2026-09-04). ONE row: the same status lens the
  // `workspace.workScope` cell answers with (buildWorkScopeStatusPayload), so the pane, the
  // cell and the MCP tool cannot disagree. Backed by the operator_pot_control_policy row (its
  // `workScope` key); OPERATOR_STATE_SYNC_NAMES bridges every set/clear to this name so a
  // left-open pane learns the flip without a remount.
  'workScope.policy': {
    argsSchema: z.object({ recent: z.number().int().min(0).max(100).optional() }).optional(),
    backingTables: ['harness_shared.operator_pot_control_policy'],
    resolve: async (args) => {
      const { readWorkScopePolicy, buildWorkScopeStatusPayload } = await import('../work-scope-policy');
      const a = (args ?? {}) as { recent?: number };
      return [buildWorkScopeStatusPayload(await readWorkScopePolicy(), { recent: a.recent ?? 20 })];
    },
  } as QueryEntry<unknown>,

  // workItems.detail — the single-item ON-DEMAND detail read (P-006). The Detail
  // pane fetches ONE enriched row (with the full `summary` + payload/completion
  // blobs the list strips) when a WI is selected, instead of the whole harness
  // carrying every row's summary in workItems.byHarness. Always a 1-element array
  // (or [] when the id isn't in this harness). Invalidated via the same work_items
  // table bridge as byHarness.
  'workItems.detail': {
    argsSchema: z.object({ harnessSlug: z.string(), id: z.string().min(1) }),
    resolve: async (args) => {
      const { harnessSlug, id } = args as { harnessSlug: string; id: string };
      const { getEnrichedWorkItem } = await import('../endpoint-route/routes/harness/work-items');
      const item = await getEnrichedWorkItem(harnessSlug, id);
      return item ? [item] : [];
    },
  },

  // workItems.priorAttempts — P-017 slice D: the claim-time prior-attempt brief as a
  // READ. Before this, the brief was computed at claim time and thrown away, so the only
  // way to see "what was already tried on this lane" was to CLAIM the item — a write with
  // side effects. Runs the SAME getClaimTimePriorAttemptBrief port the four claim paths
  // use, so the panel cannot drift from what an agent is actually handed.
  //
  // MOUNTED ONLY ON DEMAND. The collector is multi-table under a 2.5s budget and measured
  // 869–3,499 estimated tokens on real items, so the consumer gates it with
  // `useSyncQuery({ enabled })` and nothing runs until a human opens the section.
  //
  // Both backing tables full-bust deliberately: the brief summarizes the whole plan LANE,
  // so a SIBLING work-item's completion or a new plan decision changes it just as much as
  // a write to this item does. A row-id scope would silently miss exactly the updates
  // this panel exists to show.
  'workItems.priorAttempts': {
    argsSchema: workItemPriorAttemptsArgsSchema,
    resolve: async (args) => resolveWorkItemPriorAttempts(args as WorkItemPriorAttemptsArgs),
    backingTables: ['harness_shared.work_items', 'harness_shared.harness_plans'],
  } as QueryEntry<unknown>,

  // workItems.behaviorContract — P-011: the resolved BehaviorContract as a READ.
  // Runs the SAME resolveWorkItemBehaviorContract port the completion gate uses, so the
  // panel cannot drift from what the gate enforces. Before this, a human could see THAT
  // a completion was refused but never WHICH promises the item is on the hook for, at
  // WHICH revision — and P-016 had just made that resolution cross-namespace.
  //
  // ⚠ ADVISORY (D-017): impact.report and staleEdges describe conditions nothing
  // enforces yet; P-013 owns turning them into refusals. A renderer must not show them
  // as failures.
  //
  // MOUNTED ONLY ON DEMAND, like priorAttempts: resolution reads edges and then clauses
  // per namespace, so the consumer gates it with `useSyncQuery({ enabled })`.
  //
  // The clause + edge tables full-bust deliberately: REVISING a clause is precisely the
  // event this panel must not miss (an open panel would otherwise keep asserting
  // coverage at a superseded revision), and neither table is keyed by a surrogate PK the
  // bridge could scope on.
  'workItems.behaviorContract': {
    argsSchema: workItemBehaviorContractArgsSchema,
    resolve: async (args) => resolveWorkItemBehaviorContract(args as WorkItemBehaviorContractArgs),
    backingTables: [
      'harness_shared.work_items',
      'harness_shared.plan_spec_clauses',
      'harness_shared.plan_spec_clause_revisions',
      'harness_shared.work_item_spec_revision_edges',
    ],
  } as QueryEntry<unknown>,

  // plans.specCoverage — P-011: P-008's plan-ship spec-coverage census as a READ.
  // Runs the SAME evaluatePlanSpecCoverageGate the ship path calls, so the panel cannot
  // drift from what the gate enforces. Before this the verdict was reachable only by
  // ATTEMPTING A SHIP: a human saw THAT plans:set-status refused, never WHICH clauses
  // are uncovered, at WHICH revision, nor that a report existed while the plan was green.
  //
  // ⚠ ADVISORY EXCEPT ONE CODE (D-018): `spec_proof_stale` is the ONLY refusal.
  // `reports` (unproven clauses, ungraded adequacy, undeclared falsifiers) never refuse —
  // P-013 owns widening the enforced set — and `spec_coverage_unavailable` is a
  // deliberate fail-open degradation. A renderer must not show any of those as failures.
  //
  // MOUNTED ONLY ON DEMAND: the census reads clauses, then evidence, then scorecards, so
  // the consumer gates it with `useSyncQuery({ enabled })`.
  //
  // The clause + evidence tables full-bust deliberately: REVISING a clause, or recording
  // evidence at the current revision, are precisely the events that flip this verdict, and
  // an open panel that missed them would keep asserting coverage at a superseded revision.
  // work_items rides because scorecards are stored as work-item rows, so it is the only
  // table a NEW adequacy grading touches; the adequacy leg is advisory-only, but a panel
  // that silently under-reports a gap it claims to census is the defect this plan exists
  // to end, and the query is lazy so the cost is bounded to viewers holding it open.
  'plans.specCoverage': {
    argsSchema: planSpecCoverageArgsSchema,
    resolve: async (args) => resolvePlanSpecCoverage(args as PlanSpecCoverageArgs),
    backingTables: [
      'harness_shared.plan_spec_clauses',
      'harness_shared.plan_spec_clause_revisions',
      'harness_shared.spec_evidence_bindings',
      'harness_shared.work_items',
    ],
  } as QueryEntry<unknown>,

  // plans.provenance — plan-item-provenance-2026-09-29 P-004: both directions of the
  // activation audit for the owner (per-item provenance with quoted source turns; every
  // forward request, rejected/open first) plus audited-vs-current revision. Labels use
  // the verdicts the audit STORED (D-005); quotes are read live. Mounted on demand.
  'plans.provenance': {
    argsSchema: planProvenanceArgsSchema,
    resolve: async (args) => resolvePlanProvenance(args as PlanProvenanceArgs),
    backingTables: ['harness_shared.harness_plans', 'harness_shared.plan_audits', 'harness_shared.session_turns'],
  } as QueryEntry<unknown>,

  // plans.acceptanceGate — P-011: the plan acceptance gate's verdict as a READ.
  // The companion to plans.specCoverage, and deliberately SEPARATE: the gate
  // SHORT-CIRCUITS on its first refusal, so its own specCoverage field is absent on any
  // refusal that precedes the census. Rendering coverage from this verdict alone would
  // show a plan with a real coverage problem as having none, because an earlier check
  // refused first. This query answers "what is blocking the ship RIGHT NOW"; the census
  // answers "what is the coverage picture regardless".
  //
  // ⚠ Its codes ARE real refusals (unlike the census's advisory reports), so a blocker
  // renders as one. The honesty rule runs the other way: `skipped` (the gate did not
  // apply), `forcedPast` (an explicit waiver) and `vettedUnderWaiver` (a rubric nobody
  // critiqued) must never be flattened into a clean green — each is a satisfied verdict
  // that a reader is entitled to see the caveat on.
  //
  // MOUNTED ONLY ON DEMAND: five check families across several tables. Read-only.
  'plans.acceptanceGate': {
    argsSchema: planAcceptanceGateArgsSchema,
    resolve: async (args) => resolvePlanAcceptanceGateVerdict(args as PlanAcceptanceGateArgs),
    backingTables: [
      'harness_shared.harness_plans',
      'harness_shared.work_items',
      'harness_shared.plan_spec_clauses',
      'harness_shared.plan_spec_clause_revisions',
      'harness_shared.spec_evidence_bindings',
    ],
  } as QueryEntry<unknown>,

  // workItems.specAdequacy — P-011: the RUBRIC/TESTING surface. Which rubric governs this
  // item's close, what its gate decides, and the EXACT blocker — without attempting the
  // close. Runs the SAME specTestAdequacyCompletionGate the write path calls.
  //
  // Before this, the adequacy verdict was reachable ONLY by calling work_items:complete —
  // a write with side effects — and the first refusal asks for a `classRef` the caller had
  // no read to discover, so the loop was: attempt, get refused, guess a plan class, attempt
  // again. Omitting classRef here reproduces that first refusal verbatim and harmlessly.
  //
  // ⚠⚠ VERDICT IS A LOWER BOUND (D-020) — the honesty rule this query lives or dies by.
  // `freshness` is graded against fingerprints the CALLER attests at close time about its
  // own working tree; a read cannot have them and must not invent them, so they are never
  // supplied and currentness comes back `unknown` (deliberately NOT `stale`). An `unknown`
  // here means "a read cannot establish this", never "this clause FAILS". Every row carries
  // `verdictIsLowerBound: true` so the caveat travels with the data; a renderer that
  // flattens it into a blocker shows a hard failure for evidence that may be fully current.
  //
  // MOUNTED ONLY ON DEMAND, like every P-011 sibling: contract resolution, then evidence,
  // then scorecards. The consumer gates it with `useSyncQuery({ enabled })`.
  //
  // The clause/edge/evidence tables full-bust deliberately: revising a clause, recording
  // evidence, or grading an adequacy scorecard (stored as a work-item row) are precisely
  // the events that flip this verdict, and an open panel that missed them would keep
  // asserting a close is blocked after the blocker cleared — or clear after one appeared.
  'workItems.specAdequacy': {
    argsSchema: workItemSpecAdequacyArgsSchema,
    resolve: async (args) => resolveWorkItemSpecAdequacy(args as WorkItemSpecAdequacyArgs),
    backingTables: [
      'harness_shared.work_items',
      'harness_shared.plan_spec_clauses',
      'harness_shared.plan_spec_clause_revisions',
      'harness_shared.work_item_spec_revision_edges',
      'harness_shared.spec_evidence_bindings',
    ],
  } as QueryEntry<unknown>,

  // workItems.depEdges — the EDGE half of the Work-tab dependency graph pane
  // (dependency-health-pane-2026-08-02 P-003). Deliberately edges ONLY: the graph's
  // NODES are the rows `workItems.byHarness` already ships, because the owner asked
  // for "the same data as our work items list view but in graph form" and a second
  // node query would drift from the list's. Endpoint resolution is FAMILY-AWARE
  // (feature refs are harness-qualified, issue refs bare) — matching one form only
  // is the D-017 inert-edge defect. See the module header for the full rationale.
  // Invalidated via the harness_shared.work_item_deps bridge added in
  // table-to-query-names.ts (there was none before this query existed).
  'workItems.depEdges': {
    backingTables: ['harness_shared.work_item_deps', 'harness_shared.work_items'],
    argsSchema: z.object({
      harnessSlug: z.string().min(1),
      // CLAMPED in the resolver, not `.max()`-rejected here — same reason as
      // byHarness above: a newer client asking for more than an older deployed
      // resolver allows must degrade, not break the panel.
      limit: z.number().int().positive().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, limit } = args as { harnessSlug: string; limit?: number };
      const [{ getOrgPg }, { activeWorkspaceId }, { resolveDependencyGraphEdges }] = await Promise.all([
        import('@papercusp/db-org'),
        import('../workspace-registry'),
        import('./dependency-graph-edges'),
      ]);
      return await resolveDependencyGraphEdges(getOrgPg().sql, {
        workspaceId: activeWorkspaceId(),
        harnessSlug,
        limit,
      });
    },
  },

  // workItems.stats — the tiny kind × state COUNT aggregate for dashboard/stat
  // tiles (WI-5517, owner ask 2026-07-19: "how many items, how many are bugs vs
  // other"). One GROUP BY over the unified base table instead of shipping the
  // enriched byHarness list (up to 2000 heavy rows) into the webview to count
  // client-side (whole-app-sync-payload-audit-2026-07-19). Observation-lane rows
  // excluded (D-005: corpus notes, not work — same default as the general
  // work-item surface, EI-10422), workspace-scoped, and each cell stamped with
  // the CANONICAL cross-family terminal classification (ALL_TERMINAL_STATUSES)
  // server-side so no client re-derives open-vs-done from a drift-prone state
  // list. Inline SQL here (not a work-items.ts helper) reusing that module's
  // exported observationLaneExclusionSql — the module itself is mid-unification
  // (work-item-status-full-unify) and this read needs no other part of it.
  // Invalidated via the work_items table bridge (same rows as byHarness).
  'workItems.stats': {
    argsSchema: z.object({
      harnessSlug: z.string().optional(),
      harnessSlugs: z.array(z.string().min(1)).max(500).optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, harnessSlugs } = args as { harnessSlug?: string; harnessSlugs?: string[] };
      const [{ getOrgPg }, { observationLaneExclusionSql }, { ALL_TERMINAL_STATUSES }, { activeWorkspaceId }] =
        await Promise.all([
          import('@papercusp/db-org'),
          import('../work-items'),
          import('../work-item-blocking'),
          import('../workspace-registry'),
        ]);
      const { sql } = getOrgPg();
      const rows = await sql<{ kind: string | null; state: string | null; n: number }[]>`
        SELECT wi.item_kind AS kind, wi.status AS state, count(*)::int AS n
          FROM harness_shared.work_items wi
         WHERE wi.workspace_id = ${activeWorkspaceId()}
           AND ${
             harnessSlug
               ? sql`wi.harness_slug = ${harnessSlug}`
               : harnessSlugs
                 ? sql`wi.harness_slug = ANY(${harnessSlugs}::text[])`
                 : sql`TRUE`
           }
           AND ${observationLaneExclusionSql(sql)}
         GROUP BY 1, 2
         ORDER BY 3 DESC`;
      return rows.map((r) => ({
        kind: r.kind ?? 'unknown',
        state: r.state ?? 'unknown',
        n: r.n,
        terminal: ALL_TERMINAL_STATUSES.has(r.state ?? ''),
      }));
    },
  },

  // workItems.delta24h — the 24h burn-down companion to workItems.stats
  // (overview-tab-expansion-2026-07-20 P-002): per-kind opened (created_ts inside
  // the window) vs closed (TERMINAL rows whose last write is inside the window —
  // the unified table records no terminal-transition timestamp, so updated_ts on a
  // terminal row is the honest available proxy; a terminal row touched again later
  // re-counts once, acceptable drift for a dashboard delta). Same workspace scope +
  // observation-lane exclusion as the stats cells; same work_items-bridge
  // invalidation. Kinds with a zero delta are dropped server-side.
  'workItems.delta24h': {
    argsSchema: z.object({
      harnessSlug: z.string().optional(),
      harnessSlugs: z.array(z.string().min(1)).max(500).optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, harnessSlugs } = args as { harnessSlug?: string; harnessSlugs?: string[] };
      const [{ getOrgPg }, { observationLaneExclusionSql }, { ALL_TERMINAL_STATUSES }, { activeWorkspaceId }] =
        await Promise.all([
          import('@papercusp/db-org'),
          import('../work-items'),
          import('../work-item-blocking'),
          import('../workspace-registry'),
        ]);
      const { sql } = getOrgPg();
      const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
      const rows = await sql<{ kind: string | null; opened: number; closed: number }[]>`
        SELECT wi.item_kind AS kind,
               count(*) FILTER (WHERE wi.created_ts >= ${cutoffMs})::int AS opened,
               count(*) FILTER (
                 WHERE wi.updated_ts >= ${cutoffMs}
                   AND wi.status = ANY(${[...ALL_TERMINAL_STATUSES]}::text[])
               )::int AS closed
          FROM harness_shared.work_items wi
         WHERE wi.workspace_id = ${activeWorkspaceId()}
           AND ${
             harnessSlug
               ? sql`wi.harness_slug = ${harnessSlug}`
               : harnessSlugs
                 ? sql`wi.harness_slug = ANY(${harnessSlugs}::text[])`
                 : sql`TRUE`
           }
           AND ${observationLaneExclusionSql(sql)}
           AND (wi.created_ts >= ${cutoffMs} OR wi.updated_ts >= ${cutoffMs})
         GROUP BY 1`;
      return rows
        .filter((r) => r.opened > 0 || r.closed > 0)
        .map((r) => ({ kind: r.kind ?? 'unknown', opened: r.opened, closed: r.closed }))
        .sort((a, b) => b.opened + b.closed - (a.opened + a.closed));
    },
  },

  // fleetAssignments.byHarness — "who's working here?" for the Progress tab's
  // Agents panel (progress-tab-agents-convergence-2026-06-11 P-001/P-002).
  // ⚠ DEPRECATED for NEW consumers (presence-v2 P-007): this is the "divergent"
  // bare-assignment shape (no presence identity / mig-277 scalars / Tier-1).
  // Prefer hiveRoster.byHarness — the unified projection with the SAME
  // {doing,queued,load,orphaned} work shape + agentPaneKind/driveMode stamping.
  // Kept live because AdvAgentsPanel still reads it (its migration belongs to the
  // progress-tab plan, not P-007). The MemberWorkPanel (B10) repointed to
  // hiveRoster.byHarness. Below: the
  // fleet:assignments assembly (presence + plan-item claims + work-item claims,
  // claim-primary, with each agent's ordered work-list) filtered to one harness,
  // each agent stamped with its AgentPaneKind so the desktop shares the colony
  // tab's glyph vocabulary (♛/👁/☕/🛡/📋/🛠). Role context joins from adv_sessions
  // (queen/sentinel/planner kinds are role-keyed; su falls out of the ownerId
  // prefix). Invalidated via the table bridge from coord_presence /
  // feature_claims / claim_audit / spawned_agents.
  'fleetAssignments.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const [
        { listFleetAssignments, groupByAgent },
        { listAdvSessions },
        { classifyAgentPane },
        { activeWorkspaceId },
      ] = await Promise.all([
        import('../fleet/assignments'),
        import('../adv-sessions'),
        import('@papercusp/agent-mcp'),
        import('../workspace-registry'),
      ]);
      // Scope to THIS window's workspace (request-scoped ALS, same as the
      // sibling hiveRoster.byHarness) — without it the harness-slug filter alone
      // surfaced fleet rows from every workspace, so a window never re-scoped its
      // Agents panel on a workspace switch. listFleetAssignments admits the
      // workspace + the '*' global + the plan-store default scope (EI-295), so
      // no claim rows are dropped.
      const rows = await listFleetAssignments({
        harness: harnessSlug,
        workspaceId: activeWorkspaceId(),
      });
      const roleByOwner = new Map<string, string | null>();
      try {
        for (const s of await listAdvSessions(200)) {
          if (s.coordOwnerId && !roleByOwner.has(s.coordOwnerId)) {
            roleByOwner.set(s.coordOwnerId, s.role ?? null);
          }
        }
      } catch {
        /* role enrichment is best-effort — ownerId-only classification still works */
      }
      return groupByAgent(rows).map((a) => {
        const pane = classifyAgentPane({
          role: roleByOwner.get(a.agentId) ?? null,
          ownerId: a.agentId,
        });
        return { ...a, agentPaneKind: pane.kind, driveMode: pane.driveMode } as unknown;
      });
    },
  },

  // scheduler.running — the live-execution view (hybrid-bee-scheduler-work-stealing
  // P-001 / D-007): every live "bee run" (a bee executing a claimed work-item) in a
  // harness, with its claimed-since / lease / heartbeat / progress + the derived
  // idle-blocked reason + the claim-spec specId@revision it runs under. Projects the
  // canonical fleet_assignment work-item-claim rows + the per-bee bee_claim_specs store
  // (read off live state, not a separate store). Invalidated via the same
  // claim/presence/nursery table bridge as fleetAssignments.byHarness, plus
  // bee_claim_specs (a Queen re-steer bumps the shown revision).
  'scheduler.running': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const [{ listBeeRuns }, { activeWorkspaceId }] = await Promise.all([
        import('../scheduler/bee-runs'),
        import('../workspace-registry'),
      ]);
      return listBeeRuns({ harness: harnessSlug, workspaceId: activeWorkspaceId() });
    },
  },

  // hiveRoster.byHive — presence-v2 Phase 3 fold (presence-v2-2026-06-14 P-006):
  // the unified per-agent live-state surface for ONE Hive. Folds coord:presence
  // (identity + the mig-277 last_active_at/agent_role/hive_slug scalars + the
  // P-003 Tier-1 enrichment) with the fleet:assignments work-detail
  // ({doing,queued,load,orphaned,claims}) — one read for "who's in this hive +
  // what is each one doing". Preserves the fleet work-shape (D-009#2 / P-015) so
  // the B10 member dashboard (P-007) repoints with a query swap. Invalidated via
  // the coord_presence / feature_claims / claim_audit / spawned_agents table
  // bridge (same tables as fleetAssignments.byHarness).
  'hiveRoster.byHive': {
    argsSchema: z.object({ potSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { potSlug, workspaceId } = args as { potSlug: string; workspaceId?: string };
      const { listHiveRoster } = await import('../fleet/hive-roster');
      return (await listHiveRoster({ potSlug, workspaceId: workspaceId ?? null })) as unknown[];
    },
  },

  // hiveRoster.byHarness — presence-v2 P-007: the SAME unified hive-roster fold,
  // but keyed by a HARNESS (resolved to its home Hive via potHomeSlugForHarness)
  // and stamped with the SAME AgentPaneKind/driveMode as fleetAssignments.byHarness
  // — so a harness-keyed UI surface (the B10 MemberWorkPanel) reads ONE projection
  // (presence + mig-277 scalars + Tier-1 + the {doing,queued,load,orphaned} work
  // shape) with a query swap, instead of the divergent fleetAssignments.byHarness
  // shape. Falls back to the harness slug as the scope key when the harness has no
  // Hive home — listHiveRoster's includeUnattributed then surfaces the standalone /
  // SU agents (NULL hive_slug). Invalidated via the same coord_presence /
  // feature_claims / claim_audit / spawned_agents bridge.
  'hiveRoster.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const [
        { listHiveRoster },
        { potHomeSlugForHarness },
        { activeWorkspaceId },
        { listAdvSessions },
        { classifyAgentPane },
      ] = await Promise.all([
        import('../fleet/hive-roster'),
        import('../hive-federation'),
        import('../workspace-registry'),
        import('../adv-sessions'),
        import('@papercusp/agent-mcp'),
      ]);
      const workspaceId = activeWorkspaceId();
      const potSlug = (await potHomeSlugForHarness(workspaceId, harnessSlug)) ?? harnessSlug;
      const roster = await listHiveRoster({ potSlug, workspaceId });
      const roleByOwner = new Map<string, string | null>();
      try {
        for (const s of await listAdvSessions(200)) {
          if (s.coordOwnerId && !roleByOwner.has(s.coordOwnerId)) {
            roleByOwner.set(s.coordOwnerId, s.role ?? null);
          }
        }
      } catch {
        /* role enrichment is best-effort — ownerId-only classification still works */
      }
      return roster.map((a) => {
        const pane = classifyAgentPane({
          role: roleByOwner.get(a.agentId) ?? null,
          ownerId: a.agentId,
        });
        return { ...a, agentPaneKind: pane.kind, driveMode: pane.driveMode } as unknown;
      });
    },
  },

  // featuresConsolidated.bySlug — a bounded compatibility page, latest first.
  // WI-7209 moved its last live consumers to the existing one-row detail read
  // and exact work-item aggregate. Older clients may still request this key,
  // but ordinary corpus growth must never make it unbounded again.
  'featuresConsolidated.bySlug': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string().optional(),
      limit: clampedLimit(500, 500),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, limit } = args as {
        harnessSlug: string;
        workspaceId?: string;
        limit: number;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      // Slim wire projection (sync query-health / WI-5412): the sole consumer
      // (useHarnessFeatures → HarnessFeature) renders only these ~11 fields, but
      // `.select()` shipped all 70 columns of the view — including `embedding`
      // (a pgvector ≈15KB/row), `_search` (tsvector), and several jsonb blobs
      // (metadata / payload / completion_ref / worked_by_history / schedule).
      // On papercusp that was 1162 rows ≈ 9.4MB parsed into the webview per load.
      // Projecting to the rendered columns cut it ~20× before cardinality
      // itself became the only remaining payload axis.
      //
      // P-007 (precompute-sync-reads-phase2): `summary` was STILL ~423KB of the
      // remaining ~665KB list payload (1181 rows × ~366 avg chars) — and the grid
      // never renders it (only DetailPanel's Description prose, for the ONE
      // selected feature). Dropped here at the sync boundary; the Detail pane
      // fetches the selected feature's summary on demand via
      // `featuresConsolidated.detail` (mirrors the workItems.byHarness/.detail
      // split, P-006). The selected-row consumer now reads detail directly and
      // exact counts come from workItems.stats, so neither relies on this page's
      // completeness.
      // WI-7203: two more columns left the wire, and the nulls with them.
      //
      // `harnessSlug` is REDUNDANT WITH THE QUERY ARG — every row carries the slug
      // the caller just passed in `args.harnessSlug`, so it is 1,606 copies of a
      // constant the client already has (the same cut agentRunsConsolidated.recent
      // made). `updatedTs` is only ORDERed BY, server-side; SQL happily sorts on an
      // unselected column, and the sole consumer's `SyncFeatureRow` declares
      // NEITHER field, so neither was reachable.
      //
      // Then omit null-valued keys (D-025). This feed is where that pays most:
      // measured live, `claims` was null on 1,560 of 1,606 rows, `tags` on 1,603,
      // `sourcePlanSlug` on 437.
      //
      // Together: 637,015 -> 502,813 B (-21.1%), losslessly. Per-ROW cost falls
      // 394 -> 313 B. Applied HERE in the resolver, not the serializer, for the
      // D-025 reason: the delta protocol hashes the rows this returns, so
      // stripping later would make every delta client force-full forever.
      const rows = (await db
        .select({
          featureId: t.featureId,
          title: t.title,
          status: t.status,
          attempts: t.attempts,
          claims: t.claims,
          tags: t.tags,
          needsHumanReview: t.needsHumanReview,
          sourcePlanSlug: t.sourcePlanSlug,
          workingUsers: t.workingUsers,
        })
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.updatedTs))
        .limit(limit)) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) if (v !== null) out[k] = v;
        return out;
      }) as unknown[];
    },
  },

  // featuresConsolidated.byHive — CROSS-MEMBER browse (WI-259 P-006, D-010).
  // Features across EVERY member harness of a shared hive, latest first. Each row
  // already carries `harness_slug` = the authoring member's slug = its ORIGIN, so
  // the UI can label + drill back to that member. The per-harness reads
  // (featuresConsolidated.bySlug) are UNCHANGED — member-origin-scoped stays the
  // default; this is the EXPLICIT cross-member view a hive rollup consumes.
  //
  // Why this works with NO schema change: post-WI-259-P-002 the membership guard
  // lands each member's content locally under that member's own slug, and joining
  // a hive (discovery/join-pot) registers each member harness with `hive_slug=H`.
  // So the member-slug SET is just the registry projects whose hive_slug points at
  // the home — resolved here exactly like `learning.improvements` (loadHarnessRegistry
  // + hiveMemberHarnessScopes). Best-effort: a registry read failure degrades to the
  // hive-home-slug-only read rather than 500ing the rollup.
  'featuresConsolidated.byHive': {
    argsSchema: z.object({ potHomeSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { potHomeSlug, workspaceId } = args as { potHomeSlug: string; workspaceId?: string };
      const memberSlugs = await resolveHiveMemberSlugs(potHomeSlug, workspaceId);
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq, inArray } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      const slugFilter = inArray(t.harnessSlug, memberSlugs);
      // Slim wire projection (whole-app-sync-payload-audit-2026-07-19 P-002).
      // WI-5412 slimmed the sibling `.bySlug` but MISSED this cross-member `.byHive`,
      // which kept a bare `.select()` (SELECT *) and shipped all ~70 view columns —
      // including `embedding` (a 384-dim pgvector) and `_search` (tsvector). Measured
      // on papercusp: 14,688 rows ≈ 10.2MB parsed into the webview per PotContentPanel
      // load, of which the embedding alone was 6.1MB and _search 0.95MB — search-index
      // internals NO component renders.
      //
      // WI-7087 cut it again, to the FIVE columns its sole consumer declares. The
      // comment here used to claim this "mirrors `.bySlug`'s projection EXACTLY (same
      // HarnessFeature-shaped consumers)"; that was FALSE in the one way that mattered
      // — `.bySlug` had already dropped the heavy per-row `summary` under the P-006
      // list/detail split (detail on demand via `featuresConsolidated.detail`) and this
      // one kept it. Measured live: `summary` alone was 831,678 B = 56.58% of a
      // 1,469,953 B payload, and no consumer had ever read it.
      //
      // The remaining six (attempts/claims/tags/needsHumanReview/sourcePlanSlug/
      // workingUsers) went with it: `.byHive` has exactly ONE consumer, and it declares
      // its own 5-field `PotFeatureRow` (PotContentPanel.tsx) that names none of them.
      // So this deliberately no longer mirrors `.bySlug` — that sibling keeps its 11
      // columns for its OWN wider consumer set. The wire here matches the one consumer's
      // declared row type, pinned BOTH ways (kept + dropped) by the byHive projection
      // test in sync-resolver/index.test.ts.
      //
      // `updatedTs` is kept because the consumer's type + fixtures declare it, though it
      // is currently only ORDERED BY server-side (rows arrive latest-first).
      return (await db
        .select({
          harnessSlug: t.harnessSlug,
          featureId: t.featureId,
          title: t.title,
          status: t.status,
          updatedTs: t.updatedTs,
        })
        .from(t)
        .where(workspaceId != null ? and(slugFilter, eq(t.workspaceId, workspaceId)) : slugFilter)
        .orderBy(desc(t.updatedTs))) as unknown[];
    },
  },

  // featuresConsolidated.byPlanSlug — features promoted from a specific plan,
  // across all harnesses, ordered by created_ts desc. Uses the first-class
  // source_plan_slug column added in migration 084 (indexed; fast).
  'featuresConsolidated.byPlanSlug': {
    argsSchema: z.object({ planSlug: z.string() }),
    resolve: async (args) => {
      const { planSlug } = args as { planSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select({
          featureId: t.featureId,
          harnessSlug: t.harnessSlug,
          title: t.title,
          status: t.status,
        })
        .from(t)
        .where(eq(t.sourcePlanSlug, planSlug))
        .orderBy(desc(t.createdTs))) as unknown[];
    },
  },

  // featuresConsolidated.detail — the single-feature ON-DEMAND detail read
  // (P-007). Carries the per-row `summary` that featuresConsolidated.bySlug
  // dropped at the sync boundary (the grid never renders it; only the Detail
  // pane's Description prose does, for the ONE selected feature). Mirrors the
  // workItems.byHarness/.detail split (P-006): the Detail pane fires this tiny
  // 1-row query on selection instead of the list carrying every feature's
  // summary. Always a 0-or-1-element array (client reads data[0]).
  'featuresConsolidated.detail': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      featureId: z.string().min(1),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, featureId, workspaceId } = args as {
        harnessSlug: string;
        featureId: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select({
          harnessSlug: t.harnessSlug,
          featureId: t.featureId,
          title: t.title,
          summary: t.summary,
          status: t.status,
          attempts: t.attempts,
          claims: t.claims,
          tags: t.tags,
          needsHumanReview: t.needsHumanReview,
          sourcePlanSlug: t.sourcePlanSlug,
          workingUsers: t.workingUsers,
          updatedTs: t.updatedTs,
        })
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.featureId, featureId), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.featureId, featureId)),
        )
        .limit(1)) as unknown[];
    },
  },

  // issuesConsolidated.bySlug — issues for a harness, latest first.
  //   zql.issuesConsolidated.where(harnessSlug).orderBy('updatedTs', 'desc')
  'issuesConsolidated.bySlug': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessIssuesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.updatedTs))) as unknown[];
    },
  },

  // P-008: one normalized harness/running/feature predicate backs the bounded
  // keyset page and exact companion aggregate. The row projection still carries
  // the joined spawn outcome + native resume session id.
  'agentRunsConsolidated.bySlug': agentRunsListQueryPair.rowsEntry as QueryEntry<unknown>,
  'agentRunsConsolidated.summary': agentRunsListQueryPair.summaryEntry as QueryEntry<unknown>,

  // projectHistoryEvents.byHarness — P-009. Reverse-chronological per-harness
  // activity timeline (work-item lifecycle + plan-item status flips + plan
  // decisions) backing the History tab's `?view=live` mode. Cursor is the
  // (tsMs, eventId) tuple, so a page boundary inside a group of
  // same-millisecond events neither repeats nor drops a row.
  [PROJECT_HISTORY_EVENTS_QUERY_NAME]: {
    argsSchema: projectHistoryEventsArgsSchema,
    // One table per event source the resolver reads, in the order the comment
    // above names them: work-item lifecycle, plan-item status flips, plan
    // decisions (which live in plan parts).
    backingTables: [
      'harness_shared.work_items',
      'harness_shared.plan_items',
      'harness_shared.harness_plan_parts',
    ] as const,
    resolve: async (args) => resolveProjectHistoryEvents(args),
  },

  // agentRunsConsolidated.recent — agent runs for a harness, latest 50.
  //   zql.agentRunsConsolidated.where(harnessSlug).orderBy('ts', 'desc').limit(50)
  // Same joined outcome projection as .bySlug (P-023).
  'agentRunsConsolidated.recent': {
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      return agentRunsListQueryPair.rowsEntry.resolve({ harnessSlug, workspaceId, limit: 50 });
    },
  },

  // snapshotsConsolidated.bySlug — snapshots for a harness, latest first.
  //   zql.snapshotsConsolidated.where(harnessSlug).orderBy('ts', 'desc')
  'snapshotsConsolidated.bySlug': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessSnapshotsConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db.select().from(t).where(eq(t.harnessSlug, harnessSlug)).orderBy(desc(t.ts))) as unknown[];
    },
  },

  // userActions.byHarness — harness+workspace-filtered action log.
  //   zql.userActions.where(harnessSlug).where(workspaceId)
  //                  .orderBy('startedAt', 'desc').limit(limit)
  'userActions.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, limit } = args as {
        harnessSlug: string;
        workspaceId: string;
        limit: number;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.userActionsInHarnessShared;
      const { db } = getOrgPg();
      return jsonSafeRows(
        await db
          .select()
          .from(t)
          .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId)))
          .orderBy(desc(t.startedAt))
          .limit(limit),
      );
    },
  },

  // userActions.byKind — harness+workspace+kind-filtered action log.
  //   zql.userActions.where(harnessSlug).where(workspaceId).where(kind)
  //                  .orderBy('startedAt', 'desc').limit(limit)
  'userActions.byKind': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      kind: z.string(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, kind, limit } = args as {
        harnessSlug: string;
        workspaceId: string;
        kind: string;
        limit: number;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.userActionsInHarnessShared;
      const { db } = getOrgPg();
      return jsonSafeRows(
        await db
          .select()
          .from(t)
          .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId), eq(t.kind, kind)))
          .orderBy(desc(t.startedAt))
          .limit(limit),
      );
    },
  },

  // userActions.recent — workspace-wide (NOT harness-scoped) recent action stream,
  // newest-first. Backs the Overview Activity tile's All-Pots view (no ?slug=): the
  // per-harness userActions.byHarness left that tile blank when no harness was selected
  // (data-sync-push-completion P-006 behavior shift; D-008 follow-up closes it).
  // NOTE (D-011): user_actions is mapped in TABLE_TO_QUERY_NAMES but is APPEND-HEAVY and
  // INTENTIONALLY carries NO per-row emit_change_notify trigger (COVERAGE_EXEMPT; mig 376
  // — a per-row notify on a high-write log is the notify-storm anti-pattern). So this (and
  // byHarness/byKind) does NOT SSE-push on a write today; the Activity tile keeps it live
  // with a bounded client pollIntervalMs until the append-heavy DEBOUNCED-invalidation
  // follow-up (COVERAGE_EXEMPT's P-005 TODO) lands. The bridge entry stays so that
  // follow-up wires straight through.
  //   zql.userActions.where(workspaceId).orderBy('startedAt', 'desc').limit(limit)
  'userActions.recent': {
    argsSchema: z.object({
      workspaceId: z.string(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { workspaceId, limit } = args as { workspaceId: string; limit: number };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.userActionsInHarnessShared;
      const { db } = getOrgPg();
      return jsonSafeRows(
        await db.select().from(t).where(eq(t.workspaceId, workspaceId)).orderBy(desc(t.startedAt)).limit(limit),
      );
    },
  },

  // userMemory.list — the settings memory page's row set: the user's
  // personal pool + every harness pool, enriched with canonical audit
  // state + timestamps, newest-first (memory-settings-page-refresh P-007).
  // userId arrives as an arg because resolvers carry no session identity
  // (D-002 — acceptable in the single-owner desktop model). Writes fire
  // notifySyncInvalidate('userMemory.list') from the REST routes AND the
  // memory:* MCP verbs, so the page updates live on agent writes.
  'userMemory.list': {
    // EI-12937: `limit` is optional (undefined = today's exact unbounded behavior) —
    // the settings page defaults to a bounded window and offers an explicit
    // "show all" opt-in that omits it, reproducing the pre-fix full fetch on demand.
    argsSchema: z.object({ userId: z.string().min(1), limit: z.number().int().positive().max(100_000).optional() }),
    resolve: async (args) => {
      const { userId, limit } = args as { userId: string; limit?: number };
      const { listUserMemories } = await import('../memory/list-user-memories');
      return (await listUserMemories(userId, { limit })) as unknown[];
    },
  },

  // personalVault.importJobs — the Settings > Personal Vault archive queue.
  // Like userMemory.list, the acting owner id is an explicit query argument:
  // named-query resolvers carry no request/session identity, and Papercusp is a
  // single-owner desktop app. The workspace remains server-derived so a caller
  // cannot read another workspace by supplying an id. Both the durable jobs and
  // pre-job upload reservations back the live surface; their row triggers are
  // bridged through TABLE_TO_QUERY_NAMES.
  'personalVault.importJobs': {
    backingTables: [
      'harness_shared.personal_vault_import_jobs',
      'harness_shared.personal_vault_import_uploads',
    ],
    argsSchema: z.object({
      userId: z.string().trim().min(1),
      // Clamp in the resolver rather than rejecting a newer client's larger
      // window. The data helper independently enforces the same 100-row cap.
      limit: z.number().int().positive().optional(),
    }),
    resolve: async (args) => {
      const { userId, limit } = args as { userId: string; limit?: number };
      const [{ getOrgPg }, { activeWorkspaceId }, imports] = await Promise.all([
        import('@papercusp/db-org'),
        import('../workspace-registry'),
        import('../personal-vault/import-jobs'),
      ]);
      const jobs = await imports.listPersonalVaultImportJobs(
        getOrgPg().sql,
        activeWorkspaceId(),
        userId,
        Math.min(limit ?? 50, 100),
      );
      return jobs.map(imports.publicPersonalVaultImportJob) as unknown[];
    },
  },

  // userMemory.total — how many memories the Memory page COULD show, so its
  // bounded window can render a denominator ("Showing 500 of 2,465") instead
  // of a bare count (WI-39540). Without this the page's own row count was the
  // only number on screen, and a saturated window reads as a measurement: the
  // owner reasonably concluded a ~2,465-row corpus was 300 rows.
  //
  // Same invalidation key family as userMemory.list — every write that fires
  // notifySyncInvalidate('userMemory.list') also fires this one, so the
  // denominator moves with the rows rather than going stale beside them.
  'userMemory.total': {
    // The corpus is read through the pluggable memory BACKEND seam, not a direct
    // table read — under the Postgres backend it is memory_canonical, and under a
    // remote backend (mem0) there is no local table at all. So a row trigger can
    // never be the whole invalidation story here, and the write paths push
    // instead: every one of them routes through invalidateUserMemoryViews(),
    // which fires this key alongside userMemory.list. Declared (rather than
    // parked in the undeclared baseline) so the pairing is provable; the
    // producer-push rationale is recorded in PUSH_EXEMPT in
    // __tests__/resolver-backing-table-coverage.test.ts.
    backingTables: ['harness_shared.memory_canonical'],
    argsSchema: z.object({ userId: z.string().min(1) }),
    resolve: async (args) => {
      const { userId } = args as { userId: string };
      const { countUserMemories } = await import('../memory/list-user-memories');
      return [{ total: await countUserMemories(userId) }] as unknown[];
    },
  },

  // userMemory.journalStatus — the memory write-ahead journal's live status
  // for the settings Memory page (memory-write-journal-auto-recovery P-006):
  // pending badge count, failed_permanent count, and the last-24h drain
  // recovery window for the "Memory recovered: N facts…" banner. The drain
  // (embed-backfill tick) fires notifySyncInvalidate on both this key and
  // userMemory.list after a recovery, so the page updates live.
  'userMemory.journalStatus': {
    argsSchema: z.object({}),
    resolve: async () => {
      const { journalStatusSnapshot } = await import('../memory/journal-surfacing');
      return [await journalStatusSnapshot()] as unknown[];
    },
  },

  // userMemory.feedbackStats — the settings Memory page's "Lifetime
  // feedback: N edits, M deletes" tile (all-active-surfaces-data-sync-
  // migration-2026-07-11 P-013). Reads harness_shared.memory_feedback for
  // the acting user. Backend/filesystem envelope info (memory-store choice,
  // ~/.claude hygiene, recall-canary) and the learning-instruction text stay
  // a one-shot REST fetch (GET /api/user/memory/backend, GET
  // /api/user/memory/feedback) — neither is a live, multi-writer table read
  // the way this count is, so only the feedback statistics moved to sync.
  // `recordFeedback` (memory/feedback.ts) fires
  // notifySyncInvalidate('userMemory.feedbackStats') after every insert, so
  // the tile updates live on both user edits/deletes and agent-tool writes
  // (memory:update / memory:forget).
  'userMemory.feedbackStats': {
    argsSchema: z.object({ userId: z.string().min(1) }),
    resolve: async (args) => {
      const { userId } = args as { userId: string };
      const { loadFeedbackStats } = await import('../memory/feedback');
      const stats = await loadFeedbackStats(userId);
      return [stats ?? { total_edits: 0, total_deletes: 0, recent: [] }] as unknown[];
    },
  },

  // notes.list — the minimal notes app's row set (owner-ask-batch-2026-07-06
  // P-004, WI-3265), newest-updated-first, optionally filtered by a search
  // term (ILIKE over title+body — see notes.ts). Writes fire
  // notifySyncInvalidate('notes.list') from the /api/notes REST routes so
  // the page updates live with no manual refresh.
  'notes.list': {
    argsSchema: z.object({ query: z.string().optional() }),
    resolve: async (args) => {
      const { query } = args as { query?: string };
      const { listNotes } = await import('../notes');
      return (await listNotes(query)) as unknown[];
    },
  },

  'themes.catalog': {
    // custom-themes + cupboard/theme-store read local JSON/package files.
    backingTables: [],
    argsSchema: z.object({}),
    resolve: async () => {
      const { listThemeCatalog } = await import('../custom-themes');
      return (await listThemeCatalog()) as unknown[];
    },
  },

  // plansDrafts.bySlug — draft plans for a harness, newest-first.
  // Used by ProposalsPanel (plan-feature-pipeline-unification P-022).
  // Reads from PG (plans went PG-canonical — plans-pg-canonical-migration-2026-06-03)
  // via readAllPlans. Returns a lightweight row per draft plan — UI uses these to
  // render proposal cards; clicking Edit navigates to /admin/plans/<slug>.
  'plansDrafts.bySlug': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { resolveHarnessPlansDir, readAllPlans } = await import('../agent-tools/plans/source');

      const dirs = await resolveHarnessPlansDir(harnessSlug);
      const all = await readAllPlans({ harnessSlug: dirs.harnessSlug, workspaceId: dirs.workspaceId });

      const rows: unknown[] = [];
      for (const { parsed, archived, row } of all) {
        if (archived) continue;
        if (parsed.isLegacy) continue;
        // WI-7259 (sibling of WI-7246's coord.plans fix): a scheduled-run
        // snapshot copies its parent plan's body verbatim, frontmatter
        // included, so `parsed.frontmatter.status`/`.slug` read the PARENT's
        // identity/lifecycle for every snapshot. Filter + identify on the
        // canonical row instead — this branch was previously "armed but not
        // firing" only because the one plan family with run-snapshots
        // happened to inherit a non-draft status, not because the filter was
        // correct.
        if (row.status !== 'draft') continue;

        const slug = row.planSlug;
        const itemCount = parsed.items.length;
        // Source tag: slug prefixed with 'scoper-proposal-' → 'scoper'; else 'user'.
        const source = slug.startsWith('scoper-proposal-') ? 'scoper' : 'user';

        rows.push({
          slug,
          title: parsed.frontmatter.title ?? slug,
          status: 'draft' as const,
          nowState: parsed.now?.state ?? null,
          nowNext: parsed.now?.next ?? null,
          itemCount,
          source,
          // Canonical-first, same as WI-7246's `updated` fix on coord.plans —
          // frontmatter fallback preserved for a row where the column is null.
          created: row.created ?? parsed.frontmatter.created ?? null,
          updated: row.updated ?? parsed.frontmatter.updated ?? null,
        });
      }

      // Newest-first by updated, then created.
      rows.sort((a, b) => {
        const ra = a as { updated: string | null; created: string | null };
        const rb = b as { updated: string | null; created: string | null };
        const ta = ra.updated ?? ra.created ?? '';
        const tb = rb.updated ?? rb.created ?? '';
        return tb.localeCompare(ta);
      });

      return rows;
    },
  },

  // ── plans.* — live queries for the Create tab (?tab=plans). ──────────
  //
  // File-backed reads dispatched through the canonical plans:* tools
  // (read-dispatch.ts), so the live-query path can't drift from the admin
  // REST path. Write-side invalidations fire from
  // apps/operator/lib/endpoint-route/routes/admin/plans.ts (coarse, no
  // args — the Create tab fans these across many filter args). No
  // argsSchema: the underlying tool validates its own args.
  //
  // Single-object reads (get/lint) return a 1-element array to fit the
  // useSyncQuery `data: T[]` contract; the client unwraps `data[0]`.
  'plans.list': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('list', (args ?? {}) as Record<string, unknown>)) as {
        plans?: unknown[];
      };
      const plans = Array.isArray(r?.plans) ? r.plans : [];
      if (plans.length === 0) return plans;
      // B1 (shared-hive-collaboration P-001): enrich rows with resolved owner +
      // last-editor identity for the ownership badges. Additive + best-effort.
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return plans;
      const { enrichPlanListRows } = await import('./plan-attribution');
      return enrichPlanListRows(plans);
    },
  },
  // plans.byHive — CROSS-MEMBER browse (WI-259 P-006, D-010). Reuses plans.list's read
  // with the member-slug SET (callPlansRead already accepts `harness_slugs` —
  // read-dispatch.ts), so the rows are identical to the per-harness list + the same
  // attribution enrichment. Member-origin-scoped reads (plans.list) are UNCHANGED.
  //
  // ⚠ Plans are HIVE-scoped, so this fan-out COLLAPSES: every member harness resolves to
  // the same Hive HOME plan set (resolvePlanScope), and there is exactly one plan set per
  // hive to roll up. The `harness` on each row is therefore the hive home, NOT a
  // per-member origin — a member does not own a distinct set of plans the way it owns a
  // distinct set of features (which is why featuresConsolidated.byHive really does fan
  // out and this does not). Reading it as member-origin is what WI-7083 fixed: the
  // fan-out used to dedupe on the REQUESTED slug, so each member re-read the home set and
  // the view served N identical copies stamped with N different member slugs — 1,820 rows
  // / 1,249,750 B for a hive whose real content is 910 rows / 682,955 B.
  'plans.byHive': {
    argsSchema: z.object({ potHomeSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { potHomeSlug, workspaceId } = args as { potHomeSlug: string; workspaceId?: string };
      const memberSlugs = await resolveHiveMemberSlugs(potHomeSlug, workspaceId);
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('list', { harness_slugs: memberSlugs })) as {
        plans?: unknown[];
      };
      const plans = Array.isArray(r?.plans) ? r.plans : [];
      if (plans.length === 0) return plans;
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return plans;
      const { enrichPlanListRows } = await import('./plan-attribution');
      return enrichPlanListRows(plans);
    },
  },
  // plans.viewer — the current viewer's plan-OWNER identity (their git email),
  // for the plans list "my / others' / all" saved views (shared-hive-collaboration
  // P-002). One row: [{ email }] (email null when unresolvable → UI degrades).
  'plans.viewer': {
    resolve: async () => {
      const { getViewerOwnerEmail } = await import('../agent-tools/plans/viewer-identity');
      const email = await getViewerOwnerEmail();
      return [{ email }];
    },
  },
  'plans.items': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('items', (args ?? {}) as Record<string, unknown>)) as {
        items?: unknown[];
      };
      const items = Array.isArray(r?.items) ? r.items : [];
      if (items.length === 0) return items;
      // B1 (shared-hive-collaboration P-001): per-item author attribution.
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return items;
      const { enrichPlanItemsRows } = await import('./plan-attribution');
      return enrichPlanItemsRows(items);
    },
  },
  'plans.attention': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('attention', (args ?? {}) as Record<string, unknown>)) as {
        groups?: unknown[];
      };
      return Array.isArray(r?.groups) ? r.groups : [];
    },
  },
  // plans.attentionBulkRun — the Inbox BULK RESOLVE run the command strip
  // renders (inbox-bulk-resolve-2026-08-23, P-005).
  //
  // ONE row: the run plus its per-item outcomes. The strip's three states
  // (idle / running / review) are derived from `phase`, so this single query
  // drives all of them — and because run state lives in Postgres rather than
  // component state, reopening the pane resumes into the run's current phase
  // instead of losing it (Requirement 7).
  //
  // No `runId` arg by default: the pane's opening question is "is there a run I
  // should be showing?", which is the workspace's LATEST run. Passing an
  // explicit `runId` reads that specific run instead (the `?opcbr=` deep link).
  //
  // A null run is a legitimate, common answer (no run has ever been started),
  // and is returned as an explicit `{ run: null }` row rather than an empty row
  // set — an empty set is indistinguishable from a read that failed, and the
  // strip must render its IDLE state on "no run", never on "unknown".
  'plans.attentionBulkRun': {
    // Producer-push, not table-bridged (the agentOrders.byOwner shape): every
    // writer to both tables fires notifySyncInvalidate('plans.attentionBulkRun')
    // after its write commits — createRun/reportOutcomes in
    // agent-tools/inbox/bulk-run.ts and the admin bulk-resolve route — so the
    // pane refreshes on the write's MEANING, and the per-item outcome batch
    // carries no per-row notify cost. PUSH_EXEMPT in
    // resolver-backing-table-coverage.test.ts documents the pairing + re-arm.
    backingTables: ['harness_shared.attention_bulk_runs', 'harness_shared.attention_bulk_run_items'],
    resolve: async (args) => {
      const { classifyRunLiveness, getRun, getLatestRun, getRunItems } = await import('../attention/bulk-run-store');
      const runId =
        typeof (args as { runId?: unknown })?.runId === 'string' ? String((args as { runId: string }).runId) : null;
      try {
        const run = runId ? await getRun(runId) : await getLatestRun();
        if (!run) return [{ run: null, items: [] }];
        return [{ run: { ...run, liveness: classifyRunLiveness(run) }, items: await getRunItems(run.runId) }];
      } catch {
        // Degrade to idle rather than failing the pane: the inbox itself must
        // stay usable when the bulk-run substrate is unavailable, and every
        // item remains resolvable by hand.
        return [{ run: null, items: [] }];
      }
    },
  },
  // plans.cleanupRun — the Plans-pane cleanup strip + grouped report. Same
  // generalized run table as Inbox bulk resolve, with per-finding rows from
  // migration 937. Writers push one dedupe-disabled invalidation per persisted
  // transition through notifyPlanCleanupRunChanged().
  'plans.cleanupRun': {
    backingTables: ['harness_shared.attention_bulk_runs', 'harness_shared.plan_cleanup_run_findings'],
    resolve: async (args) => {
      const [{ classifyRunLiveness, getRun, getLatestRun }, { getRunFindings }] = await Promise.all([
        import('../attention/bulk-run-store'),
        import('../plan-cleanup/run-store'),
      ]);
      const runId =
        typeof (args as { runId?: unknown })?.runId === 'string' ? String((args as { runId: string }).runId) : null;
      try {
        const run = runId ? await getRun(runId) : await getLatestRun(undefined, 'plan-cleanup');
        if (!run || run.runKind !== 'plan-cleanup') return [{ run: null, findings: [] }];
        return [
          {
            run: { ...run, liveness: classifyRunLiveness(run) },
            findings: await getRunFindings(run.runId, run.workspaceId),
          },
        ];
      } catch {
        // Cleanup is additive: a substrate read failure must not break the
        // Plans pane or mis-render a partially known run.
        return [{ run: null, findings: [] }];
      }
    },
  },
  // plans.attentionCounts — the AGGREGATE half of the attention feed (WI-5955).
  // The sidebar "needs you" badge and the Plans-face badge are mounted on every
  // app start and used to derive two integers by pulling the whole ~1MB unscoped
  // feed. Request the projection before tool serialization so even a warm cache
  // hit avoids constructing and parsing a full feed. Source/cache policy is shared.
  // Deliberately UNSCOPED: the badge answers "how many decisions need you" across
  // the workspace, so it must not inherit a panel's harness scope.
  // One row, like plans.get/plans.attentionItem.
  'plans.attentionCounts': {
    resolve: async () => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const { ATTENTION_COUNTS_FALLBACK_MS, attentionCountsRowFromOutcome, withDeadlineFallback } =
        await import('./attention-counts');
      // The underlying attention aggregation has a 45s cachedRead deadline, but
      // this sync resolver has a 10s outer deadline. Return the badge's graceful
      // empty value first so a slow cold build cannot surface as HTTP 500; the
      // single-flight build continues warming the shared cache for the next poll.
      //
      // ⚠ THAT FALLBACK IS AN EMPTY FEED, WHICH DERIVES TO ALL-ZEROS — the same
      // row a genuinely empty inbox produces. `attentionCountsRowFromOutcome`
      // stamps `degraded` onto the row so the two are distinguishable on the
      // wire; the badge renders an indeterminate mark instead of a confident
      // "nothing needs you" (WI-39779). Do NOT unwrap `.value` and drop the
      // flag here — that is precisely the defect this fixed, and
      // attention-counts.test.ts fails if the graceful empty goes out unmarked.
      return [
        attentionCountsRowFromOutcome(
          await withDeadlineFallback(
            callPlansRead('attention', { output: 'counts' }) as Promise<{
              counts?: import('./attention-counts').AttentionCounts;
              degraded?: boolean;
            }>,
            ATTENTION_COUNTS_FALLBACK_MS,
            () => ({ degraded: true }),
          ),
        ),
      ];
    },
  },
  // plans.waitingCount was REMOVED here 2026-08-10 (P-075). It was the
  // AGGREGATE behind AdvNowRunning's "N plans waiting" nudge
  // (EI-19409535742567802), and that nudge was the only consumer it ever had;
  // the owner directive that deleted the nudge ("remove the 'plans waiting'
  // button") therefore left a live query feeding nothing, which P-075 retired in
  // the same change rather than leaving behind. AdvNowRunning.test.tsx asserts
  // the bar no longer SUBSCRIBES to it (not merely that no button renders), so a
  // re-added consumer fails there first instead of 404ing at runtime.
  //
  // plans.steerable — the 6-field projection behind the Mug steering panel's
  // plan checkboxes (no-http-anywhere-2026-07-28 D-071). Same precedent as
  // plans.attentionCounts above and plans.attentionRefs below: an
  // always-mounted CHROME consumer was holding the whole plans.list superset
  // feed for a sliver of it.
  //
  // MugTab is the DEFAULT-OPEN tab of LeftSidebar, and LeftSidebar mounts on
  // EVERY route (routes/__root.tsx), so this subscription was live on every
  // screen in the app and re-fetched every 180s. Verified live 2026-08-03 by a
  // fiber walk on a headless rig at /adv?tab=harnesses: plans.list had exactly
  // ONE observer and it was MugTab. The `enabled: active` gate meant to stop
  // this (D-030) is a structural no-op — LeftSidebar renders only the ACTIVE
  // tab and passes a literal `true`, so `active` is always true whenever
  // MugTab is mounted. Gating cannot fix a consumer that IS the default.
  //
  // Reads the SUPERSET deliberately: the panel's own pipeline was superset ->
  // filterPlanListRows(false,false) -> selectSteerablePlans, and reproducing
  // that here keeps the rendered set identical while cutting the per-row
  // payload (the panel reads 6 fields off a row that also carries itemCounts /
  // nextAction / ownerIdentity / lastEditor / prose).
  'plans.steerable': {
    backingTables: ['harness_shared.harness_plans'],
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const { selectSteerablePlanRows } = await import('./steerable-plans');
      const readArgs = {
        ...((args ?? {}) as Record<string, unknown>),
        includeArchived: true,
        includeLegacy: true,
      };
      const r = (await callPlansRead('list', readArgs)) as { plans?: Array<Record<string, unknown>> };
      return selectSteerablePlanRows(Array.isArray(r?.plans) ? r.plans : []);
    },
  },
  // plans.attentionRefs — the DRILL-IN projection of the attention feed
  // (no-http-anywhere-2026-07-28 D-031). Sibling of attentionCounts: same
  // problem (an always-mounted chrome consumer pulling the whole feed for a
  // sliver of it), same remedy (project server-side, ride the same cachedRead
  // entry). The chat sidebar is mounted by ChromeShell on EVERY non-chromeless
  // route and holds the feed only to resolve a card row's `ref`; that resolver
  // reads four fields per item. Measured before this existed: 1,461 KB on
  // :3055 (891 KB on :3270) on a git tab that renders no attention feed.
  //
  // Deliberately UNSCOPED, exactly like attentionCounts and attentionItem: a
  // curator card can name something in any harness, and the sidebar mounts
  // cross-harness — a panel-scoped feed would resolve fewer refs and silently
  // render fewer Open buttons.
  'plans.attentionRefs': {
    // Same table as attentionItem/attentionCounts — the attention feed is a
    // projection of harness_plans (+ plan_revisions/plan_parts writes, which
    // land as harness_plans updates per TABLE_TO_QUERY_NAMES). Declared here
    // to satisfy the shrink-only undeclared-baseline ratchet
    // (resolver-backing-table-coverage.test.ts, EI-19411367924293520); the
    // invalidation edge already exists at table-to-query-names.ts's
    // 'harness_shared.harness_plans' -> 'plans.attentionRefs' mapping.
    backingTables: ['harness_shared.harness_plans'],
    resolve: async () => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('attention', { output: 'refs' })) as {
        refs?: import('./attention-counts').AttentionRefRow[];
        degraded?: boolean;
      };
      // Keep the last good sync snapshot on a failed build; an unknown ref set
      // must not look like a successful empty inbox and remove drill-in links.
      if (r?.degraded) throw new Error('Attention refs unavailable: source read deadline exceeded');
      return Array.isArray(r?.refs) ? r.refs : [];
    },
  },
  // plans.attentionItem — the DETAIL half of the attention list/detail split
  // (slim-plans-attention-sync-payload-2026-07-26 P-004). `plans.attention` is
  // the fattest UI read (1490KB), so its list feed clips each item's `body` and
  // drops `actions`; the detail pane (OtherDetail) fetches the ONE selected item
  // back at full fidelity here.
  //
  // Two things make this cheap rather than a second 1.5MB read:
  //   - `uiProjection: false` skips the list projection (that is the entire
  //     point) but NOT the payload-tier ceiling escape — the dispatch still
  //     requests payloadTier:'full', or WI-5078 reappears as an item-less
  //     group summary and this resolver finds nothing.
  //   - the underlying plans:attention tool memoizes its own read (cachedRead),
  //     so on selection this rides the warm entry the list feed just populated
  //     instead of recomputing the ~15-source attention scan.
  // Returns a 1-element array (or [] for an unknown id) to fit the useSyncQuery
  // `data: T[]` contract, like plans.get.
  'plans.attentionItem': {
    // `id` ONLY — deliberately NOT scoped by harnessSlug. Attention item ids are
    // globally unique, so the UNSCOPED read always contains the selection
    // whichever scope the list feed used, and every session already fetches the
    // unscoped feed for the inbox badge (useInboxPendingCount) — so this shares
    // that warm cache entry instead of fragmenting it per scope.
    argsSchema: z.object({ id: z.string().min(1) }),
    resolve: async (args) => {
      const { id } = args as { id: string };
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead(
        'attention',
        {},
        {
          uiProjection: false,
        },
      )) as { groups?: unknown[] };
      const groups = Array.isArray(r?.groups) ? r.groups : [];
      for (const group of groups) {
        const items = (group as { items?: unknown })?.items;
        if (!Array.isArray(items)) continue;
        // An item that is not plan-scoped appears in MULTIPLE groups (the same
        // duplication useInboxAttention dedupes client-side, WI-5337) — first
        // match wins, they are the same object.
        const hit = items.find((it) => (it as { id?: unknown })?.id === id);
        if (hit) {
          // WI-7039/D-025: the LIST feed omits null-valued keys, and the client
          // wire type declares those fields `?: T` on the strength of it. The
          // detail read skips the rest of the UI projection on purpose (it is
          // what re-supplies `actions` + the unclipped `body`), but it must
          // still honour that one contract or the declaration is false here.
          const { omitNullsForAttentionDetail } = await import('../agent-tools/plans/ui-read-projection');
          return [omitNullsForAttentionDetail(hit)];
        }
      }
      return [];
    },
  },
  'plans.search': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('search', (args ?? {}) as Record<string, unknown>)) as {
        hits?: unknown[];
      };
      return Array.isArray(r?.hits) ? r.hits : [];
    },
  },
  'plans.get': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = await callPlansRead('get', (args ?? {}) as Record<string, unknown>);
      // plans:get is a BULK tool — even a single-slug read returns the runBulk envelope
      // `{ ok, results:[plan], counts }` (get.ts → bulkContent). Unwrap `results[0]` to the
      // single plan so this resolver honors its documented `[PlanGetResult]` contract — the
      // SAME shape the REST `fetchPlan` path gets via `unwrapBulkGet` (routes/admin/plans.ts).
      // Without this the live consumer (PlanItemPreview) renders the envelope, not the plan,
      // AND enrichPlanDetail (below) early-returns on the envelope's missing `frontmatter`, so
      // attribution silently no-ops. A non-envelope shape (a bare `{ error }`, or a test mock)
      // passes through unchanged.
      const plan =
        r && typeof r === 'object' && Array.isArray((r as { results?: unknown }).results)
          ? (r as { results: unknown[] }).results[0]
          : r;
      if (!plan) return [];
      // B1 (shared-hive-collaboration P-001): enrich plan-level owner/last-editor
      // + per-item author for the badges. Additive + best-effort.
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return [plan];
      // enrichPlanDetail derives the attribution harness from the plan payload's own stamped
      // `harness` (plans:get → row.harnessSlug) — no caller-side operator-home default (WI-374).
      const { enrichPlanDetail } = await import('./plan-attribution');
      return [await enrichPlanDetail(plan)];
    },
  },

  'plans.revisions': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('revisions', (args ?? {}) as Record<string, unknown>)) as {
        revisions?: unknown[];
      };
      return Array.isArray(r?.revisions) ? r.revisions : [];
    },
  },
  'plans.runs': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('runs', (args ?? {}) as Record<string, unknown>)) as {
        runs?: unknown[];
      };
      return Array.isArray(r?.runs) ? r.runs : [];
    },
  },
  /**
   * The plan-lock banner's read (plan semantic-search-fingerprint-coverage-2026-08-03,
   * P-025 step 2). Replaces the 30s `window.setInterval` poll of
   * `/api/admin/locks/queue` that `usePlanLock` used to run.
   *
   * Args are a SINGLE scalar `{ path }`, matching `notifyPlanLockChange`'s emit
   * exactly (notify-lock-change.ts / D-038): the bus dedupe key is
   * `name|args|dataHash`, so one scalar gives every plan its own dedupe bucket
   * rather than one shared bucket for every lock in the fleet.
   *
   * Returns `[]` or a ONE-row array — `resolve` must return an array, and the
   * banner shows at most one holder. Timestamps are serialized to ISO here so
   * the row is byte-identical to what `/api/admin/locks/queue` returned, which
   * is what the client's `ActiveLock` type (plans-api.ts) already expects.
   *
   * ⚠ `coordinationDomain` is `lockCoordinationDomain()` — the SAME derivation
   * the HTTP route reached through `readIdentity(ctx)`. It resolves to the repo
   * root of whichever process evaluates it, so it is only correct while this
   * resolver runs in the operator, exactly as the route did. Deliberate PARITY
   * with the surface being replaced, not an endorsement: if the banner is ever
   * served from a different checkout it was already wrong before this change.
   *
   * ⚠ No `holder_context` enrichment (locks:queue P-027/D-055 does it). That
   * decoration needs a tool ctx a sync resolver does not have, and the banner
   * neither reads nor renders it — adding it would be scope the client discards.
   */
  'planLock.byPath': {
    // The lock rows live in the SEPARATE `papercusp_su` database, not the
    // operator DB every other entry here reads — so no PG trigger can reach
    // them and no entry in table-to-query-names.ts is possible. The push comes
    // from the WRITERS instead (notifyPlanLockChange, wired at file-lock-guard
    // acquire+release, release.ts and acquire_granular.ts). Declared + exempted
    // rather than omitted, so the gap is documented instead of merely absent —
    // see PUSH_EXEMPT in __tests__/resolver-backing-table-coverage.test.ts.
    backingTables: ['papercusp_su.agent_file_locks'],
    argsSchema: z.object({ path: z.string().min(1) }),
    resolve: async (args) => {
      const { path } = args as { path: string };
      const { ensureBootstrap, getTxPool, readQueue } = await import('../agent-tools/locks/su-lock-store');
      // WI-38252: the FILE-lock domain (the tree agents edit), never
      // `lockCoordinationDomain()` (the tree this process's code loaded from).
      // On `:3070` those differ, and reading the process domain answers an
      // authoritative-looking "no lock on this path" about a checkout nobody
      // edits.
      const { fileLockCoordinationDomain } = await import('../agent-tools/locks/coordination-domain');
      await ensureBootstrap();
      const result = await readQueue(getTxPool(), {
        coordinationDomain: fileLockCoordinationDomain(),
        paths: [path],
      });
      // readQueue already filters `path = ANY(paths)`; the find() keeps the
      // exact-match semantics the client had (`active_locks.find(l => l.path
      // === lockPath)`) so an overlap-style change upstream cannot widen this.
      const hit = result.active_locks.find((l) => l.path === path);
      return hit
        ? [
            {
              ...hit,
              acquired_ts: hit.acquired_ts.toISOString(),
              expires_ts: hit.expires_ts.toISOString(),
            },
          ]
        : [];
    },
  },
  'plans.lint': {
    // PRECOMPUTED (P-004). Linting the whole plan corpus measured 13.8s inline.
    // The precomputed snapshot covers the nullary call — the only shape any UI
    // makes. An explicit ARGS-bearing call (an agent drilling into one plan) is
    // rare, off the panel path, and still computed live so it stays exact.
    //
    // ⚠ LIST/DETAIL SPLIT (WI-7221). The two branches return DIFFERENT shapes,
    // deliberately:
    //   • nullary  → a SUMMARY row per plan: { slug, errors?, warningCount?,
    //     warningCodes? } — warnings are tallied by code, not carried as prose,
    //     and archived/exempt/legacy are omitted when false. 133,328 B / 913
    //     rows (was 561,007 B — 2.24x over the default ceiling).
    //   • args-bearing → the COMPLETE report, computed live and unprojected.
    // Full warning prose is therefore always reachable, just not on the list
    // read. The projection lives in the PRODUCER (derived-reads/producers.ts,
    // `summarizePlanLintReport`) so the stored jsonb shrinks too, not just the
    // wire — and it sits before the resolver, so delta hashing is unaffected.
    resolve: async (args) => {
      const hasArgs = args != null && Object.keys(args as Record<string, unknown>).length > 0;
      if (!hasArgs) {
        const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
        await import('../derived-reads/producers');
        return readDerivedSnapshotRows('plans.lint');
      }
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('lint', args as Record<string, unknown>)) as {
        reports?: unknown[];
        results?: { ok?: boolean; report?: unknown }[];
      };
      // ⚠ WI-7221: `plans:lint { slug }` is a BULK tool — a single-slug read goes
      // through runBulk and returns `{ results:[{ ok, slug, report }], counts }`,
      // NOT a top-level `reports` array (lint.ts:823-848 → bulkContent). So the
      // old `r?.reports ?? []` unwrap made this branch return [] for EVERY
      // args-bearing call, silently, forever — the exact defect this file's
      // `plans.get` sibling already documents and fixes the same way, and the
      // second instance of the shape-mismatch class the producer comment
      // describes for the nullary branch. `reports` is still honored because
      // that IS the shape of the all-plans `full: true` call.
      if (Array.isArray(r?.results)) {
        return r.results.flatMap((x) => (x?.ok && x.report != null ? [x.report] : []));
      }
      return Array.isArray(r?.reports) ? r.reports : [];
    },
  },

  // ── learning.improvements — the Learning tab's self-improvement feed ──
  //
  // (operator-learning-tab-2026-06-09 P-002 / D-003). Reuses the SAME read+score
  // path the `improvements:digest` tool uses (readImprovementItems + buildDigest),
  // so the tab and the tool can never drift. Returns the structured ImprovementDigest
  // — extended with a `flow` block (learning-system-audit P-041: captured-vs-resolved
  // 7d, median open age, recurrence count, watchdog liveness — flows, not stocks;
  // the digest fields themselves are untouched so the tool shape can't drift) —
  // as a 1-element array (client reads data[0]). NOT table-backed — engineer_issues
  // has no emit_change_notify trigger — so it refreshes on mount + the panel's manual
  // `invalidate()` + a server-side notifySyncInvalidate fired from captureImprovement.
  'learning.improvements': {
    argsSchema: z
      .object({
        state: z.enum(['open', 'resolved', 'closed']).optional(),
        limit: clampedLimitOpt(500),
        q: z.string().max(200).optional(),
        kinds: z
          .array(z.enum(['bug', 'change', 'feature', 'task']))
          .max(4)
          .optional(),
        severities: z
          .array(z.enum(['critical', 'major', 'minor', 'nit']))
          .max(4)
          .optional(),
        scopes: z.array(z.string().min(1).max(120)).max(50).optional(),
        lanes: z
          .array(z.enum(['auto', 'human']))
          .max(2)
          .optional(),
        sources: z.array(z.string().min(1).max(120)).max(50).optional(),
        rails: z.array(z.string().min(1).max(120)).max(20).optional(),
        stages: z
          .array(z.enum(['not-ready', 'approved', 'in-flight', 'shipped', 'dropped']))
          .max(5)
          .optional(),
        ideaTypes: z.array(z.string().min(1).max(120)).max(50).optional(),
        lenses: z.array(z.string().min(1).max(120)).max(50).optional(),
        score: z
          .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
          .strict()
          .optional(),
        ageDays: z
          .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
          .strict()
          .optional(),
        // (per-hive-learning-loops P-040) the per-Hive lens: a Hive HOME slug
        // narrows the feed to that Hive's member-harness scopes (D-008). Omit ⇒
        // the whole workspace (papercusp + every harness).
        hive: z.string().max(120).optional(),
        // learning-tab-surface P-002 / D-002: provenance scope. Omitted ⇒ 'loop'
        // (what the learning loop produced). 'all' restores the pre-P-002 view of
        // every captured improvement — 8,272 rows, 8,202 of which also render in
        // the Work tab, which is why it is no longer the default.
        scope: z.enum(['loop', 'all']).optional(),
      })
      .optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as LearningImprovementsArgs;
      // PRECOMPUTED (phase2 P-003, WI-5460 follow-up) — but ONLY the DEFAULT variant.
      // buildDigest + human-queue ranking + flow-metrics over the whole improvement
      // corpus was measured 0.4-0.5s on this user-facing read; the routine now fills
      // a snapshot (short 90s ttl, liveness-sensitive tier) and the panel's default
      // mount ({} args) is a plain SELECT. Derived-read snapshots key on
      // (ws, harness_slug, key) with NO arg dimension, so a NON-default view (a
      // state filter, a custom limit, or the per-Hive lens) cannot be served from
      // the snapshot and falls through to the live inline compute.
      // `scope` participates because the snapshot stores the DEFAULT scope ('loop').
      // An explicit scope:'loop' is still the default variant (same bytes); only
      // scope:'all' is a genuinely different population and must miss the snapshot.
      const isDefaultVariant =
        a.state === undefined &&
        a.limit === undefined &&
        a.q === undefined &&
        a.kinds === undefined &&
        a.severities === undefined &&
        a.scopes === undefined &&
        a.lanes === undefined &&
        a.sources === undefined &&
        a.rails === undefined &&
        a.stages === undefined &&
        a.ideaTypes === undefined &&
        a.lenses === undefined &&
        a.score === undefined &&
        a.ageDays === undefined &&
        a.hive === undefined &&
        a.scope !== 'all';
      // WI-7432: ...and the PER-POT lens, which is the variant the owner is
      // actually in. The Learning tab inherits the pot lens from the top-bar
      // selector (LearningTab.tsx HIVE_AWARE_VIEWS), so a normal desktop mount
      // carries `hive: '<slug>'` and USED to miss the snapshot above and pay a
      // full live compute EVERY time (measured 0.35-0.52s warm, 1.56-3.19s cold,
      // 300,440 B) — i.e. the precomputed fast path served only the All-Pots case,
      // which is the case nobody is in. The fix needs no new arg dimension: the
      // snapshot table already keys on (workspace_id, HARNESS_SLUG, key) and the
      // precompute routine already fires per harness, so the "pot dimension" is
      // the harness dimension the substrate has had all along — a sibling producer
      // (`learning.improvements.hive`) computes the lensed digest per pot and we
      // read it here with harnessSlug = the requested hive.
      const isHiveLensVariant =
        a.state === undefined &&
        a.limit === undefined &&
        a.q === undefined &&
        a.kinds === undefined &&
        a.severities === undefined &&
        a.scopes === undefined &&
        a.lanes === undefined &&
        a.sources === undefined &&
        a.rails === undefined &&
        a.stages === undefined &&
        a.ideaTypes === undefined &&
        a.lenses === undefined &&
        a.score === undefined &&
        a.ageDays === undefined &&
        a.hive !== undefined &&
        a.scope !== 'all';
      let rows: Array<Record<string, unknown>>;
      if (isDefaultVariant) {
        const { readDerivedSnapshot } = await import('../derived-reads/registry');
        await import('../derived-reads/producers');
        // readDerivedSnapshot, NOT ...Rows — the SAME reason the hive branch below
        // gives, which this branch was missing (WI-39773).
        //
        // OBSERVED, not theorised: bumping this producer to v4 for the tierReason
        // interning invalidated every stored v3 row, and because `...Rows` flattens
        // a MISS to `[]`, the tab's DEFAULT view — its landing view — served an
        // EMPTY digest until the producer next ran. Measured live on :3170
        // 2026-08-18: blank immediately after the restart, populated ~2 min later.
        // A background fill is kicked on the miss, so it self-heals, but "the
        // Learning tab is blank for a couple of minutes" is not the right cost for
        // a shape change — and it recurs on EVERY future producerVersion bump and
        // on any cold key.
        //
        // Falling through to the live compute makes a miss exactly as correct as a
        // hit and merely slower (the 0.4-0.5s inline path), which is what the hive
        // branch already does.
        const { payload, meta } = await readDerivedSnapshot<Array<Record<string, unknown>>>('learning.improvements');
        if (!meta.missing && Array.isArray(payload)) {
          rows = payload;
          // Preserve what readDerivedSnapshotRows stamped: the panel renders
          // "as of HH:MM" from _meta.derivedRead, so dropping it would silently
          // remove the staleness disclosure this precomputed read depends on.
          if (rows.length > 0 && rows[0] && typeof rows[0] === 'object') {
            rows[0]._meta = {
              ...(rows[0]._meta as Record<string, unknown> | undefined),
              derivedRead: meta,
            };
          }
        } else {
          const { computeLearningImprovementsSnapshot } =
            await import('../harness/improvements/learning-digest-snapshot');
          rows = (await computeLearningImprovementsSnapshot(a)) as unknown as Array<Record<string, unknown>>;
        }
      } else if (isHiveLensVariant) {
        const { readDerivedSnapshot } = await import('../derived-reads/registry');
        await import('../derived-reads/producers');
        // readDerivedSnapshot, NOT ...Rows: the Rows helper flattens a MISS and a
        // genuinely-empty pot both to `[]`, which would render an unwarmed pot
        // permanently blank instead of falling through to the live compute below.
        const { payload, meta } = await readDerivedSnapshot<Array<Record<string, unknown>>>(
          'learning.improvements.hive',
          { harnessSlug: a.hive },
        );
        if (!meta.missing && Array.isArray(payload)) {
          rows = payload;
          if (rows.length > 0 && rows[0] && typeof rows[0] === 'object') {
            rows[0]._meta = {
              ...(rows[0]._meta as Record<string, unknown> | undefined),
              derivedRead: meta,
            };
          }
        } else {
          // MISS (cold pot, or a producerVersion bump): fall through to the live
          // compute, so this path is never WORSE than the pre-WI-7432 behaviour.
          // readDerivedSnapshot has already kicked a background fill, so the pot
          // heals itself and every later mount is a plain SELECT.
          const { computeLearningImprovementsSnapshot } =
            await import('../harness/improvements/learning-digest-snapshot');
          rows = (await computeLearningImprovementsSnapshot(a)) as unknown as Array<Record<string, unknown>>;
        }
      } else {
        const { computeLearningImprovementsSnapshot } =
          await import('../harness/improvements/learning-digest-snapshot');
        rows = (await computeLearningImprovementsSnapshot(a)) as unknown as Array<Record<string, unknown>>;
      }
      // FB-15 (P-043): this resolver IS the owner's view of the queue, so a hit
      // here = the queue was rendered to the owner. Record a throttled queue-view
      // exposure row — the denominator the owner-preference model learns "ignored
      // despite being shown" from. This MUST fire on the real read (never the
      // precompute routine), so it lives here in BOTH branches, keyed off whatever
      // humanQueue the read actually returned. Fire-and-forget: capture must never
      // affect the read.
      const humanQueue0 = rows[0]?.humanQueue;
      const exposedIds = Array.isArray(humanQueue0)
        ? humanQueue0.map((i) => (i as { id: string }).id).filter((id): id is string => typeof id === 'string')
        : [];
      if (exposedIds.length > 0) {
        void trackDetached(import('../owner-preference/interactions'))
          .then((m) => m.recordQueueExposure(exposedIds))
          .catch(() => {});
      }
      return rows;
    },
  },

  'learning.improvements.summary': {
    // The issue half is table-backed and therefore gets the ordinary work-item
    // trigger bridge. Routed-idea writes are a separate non-triggered store;
    // every routed-ledger writer pushes both row+summary keys explicitly.
    backingTables: ['harness_shared.work_items'],
    argsSchema: z
      .object({
        state: z.enum(['open', 'resolved', 'closed']).optional(),
        limit: clampedLimitOpt(500),
        q: z.string().max(200).optional(),
        kinds: z
          .array(z.enum(['bug', 'change', 'feature', 'task']))
          .max(4)
          .optional(),
        severities: z
          .array(z.enum(['critical', 'major', 'minor', 'nit']))
          .max(4)
          .optional(),
        scopes: z.array(z.string().min(1).max(120)).max(50).optional(),
        lanes: z
          .array(z.enum(['auto', 'human']))
          .max(2)
          .optional(),
        sources: z.array(z.string().min(1).max(120)).max(50).optional(),
        rails: z.array(z.string().min(1).max(120)).max(20).optional(),
        stages: z
          .array(z.enum(['not-ready', 'approved', 'in-flight', 'shipped', 'dropped']))
          .max(5)
          .optional(),
        ideaTypes: z.array(z.string().min(1).max(120)).max(50).optional(),
        lenses: z.array(z.string().min(1).max(120)).max(50).optional(),
        score: z
          .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
          .strict()
          .optional(),
        ageDays: z
          .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
          .strict()
          .optional(),
        hive: z.string().max(120).optional(),
        scope: z.enum(['loop', 'all']).optional(),
      })
      .optional(),
    resolve: async (args) => {
      const { computeLearningImprovementsSummary } = await import('../harness/improvements/learning-digest-snapshot');
      return computeLearningImprovementsSummary((args ?? {}) as LearningImprovementsArgs);
    },
  },

  // ── insights.tokens — the Insights → Tokens subtab (B-TOK-UI / token-tracking-
  // plan-and-briefs-2026-06-20) ──
  //
  // Cache-inclusive token + cost breakdown by model / role / day for ONE harness,
  // over harness_shared.agent_usage_samples. The SIBLING of the SpendCard's single
  // headline total: loadHarnessTokens reuses load-spend's 4-token sum (input +
  // output + cache_read + cache_creation — the B-TOK-2 fix for the ~5× undercount)
  // and groups it so the owner sees WHERE the burn is (opus = 90% of spend,
  // cache-read = 82% of tokens). Workspace + harness scoped via routeWithWorkspace
  // (RLS GUC) PLUS an explicit workspace predicate. Best-effort: the loader degrades
  // a missing column/table to the empty snapshot (never a 500). NOT table-backed —
  // refreshes on mount + the Tokens view's manual invalidate().
  'insights.tokens': {
    argsSchema: z.object({
      harness: z.string().min(1).max(120),
      windowMs: z
        .number()
        .int()
        .positive()
        .max(90 * 24 * 60 * 60 * 1000)
        .optional(),
    }),
    resolve: async (args) => {
      const a = args as { harness: string; windowMs?: number };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { loadHarnessTokens } = await import('../harness-insights/load-tokens');
      const ws = activeWorkspaceId();
      return await routeWithWorkspace(async (tx) => {
        const runQuery = async <T>(query: string, params: unknown[]): Promise<T[]> =>
          (await tx.unsafe(query, params as never)) as unknown as T[];
        const snapshot = await loadHarnessTokens({
          workspace_id: ws,
          harness_slug: a.harness,
          windowMs: a.windowMs,
          runQuery,
        });
        return [snapshot];
      });
    },
  },

  // ── insights.coordTokens — the Tokens subtab's Coordination panel + price book
  // (B-TOK-ROLL / token-tracking-plan-and-briefs-2026-06-20, B-TOK-3 + B-TOK-4) ──
  //
  // Three workspace-scoped sections from load-token-rollups: (1) the model_pricing
  // RATE book (migration 334 — per-MTok rates incl. the dominant cache-read tier);
  // (2) the COORD-COST breakdown — LLM $ by turn-trigger (deploy-gated population)
  // and by role-class (interactive=user vs fleet=coord-driven, ~96% of spend); (3)
  // the COORD-POLL volume (coord:* MCP-call counts — ≈0 LLM tokens; quantifies the
  // wake-board UI poll that is ~75% of all tool_invocations rows = the "327K
  // coord:wake-queue mystery" = cheap polling, not context-injection). Coord cost is
  // fleet-wide, so `harness` is OPTIONAL (omit → whole workspace). Each loader is
  // independently defensive → a missing column/table degrades that section, never a
  // 500. NOT table-backed — refreshes on mount + manual invalidate.
  'insights.coordTokens': {
    // Plain SELECT against the derived-reads precompute substrate. Declared so the guard can see
    // the chain; PUSH_EXEMPT there records that the PRODUCER pushes (notifySyncInvalidate on a
    // real payload change) rather than a table trigger — a strictly better signal.
    backingTables: ['harness_shared.derived_read_snapshots'],
    argsSchema: z.object({
      harness: z.string().min(1).max(120).optional(),
      windowMs: z
        .number()
        .int()
        .positive()
        .max(90 * 24 * 60 * 60 * 1000)
        .optional(),
    }),
    resolve: async (args) => {
      const a = args as { harness?: string; windowMs?: number };
      // PRECOMPUTED (phase2 P-002, WI-5584) — but ONLY the DEFAULT variant. The
      // panel mounts with no args, which is a plain snapshot SELECT produced by the
      // `system:precompute-derived-reads` routine (see derived-reads/producers.ts).
      // Derived-read snapshots key on (ws, harness_slug, key) with no arg
      // dimension, so a NON-default view (an explicit harness or windowMs) cannot
      // be served from the snapshot and falls through to the live inline compute.
      if (a.harness === undefined && a.windowMs === undefined) {
        const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
        await import('../derived-reads/producers');
        return readDerivedSnapshotRows('insights.coordTokens');
      }
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      // BOUNDED + EXTRACTED (WI-39825). The three-leg fan-out and its per-leg
      // degradation policy now live in `insights-coordtokens-read.ts`, shared with
      // the derived-read PRODUCER that computes the default variant every 5
      // minutes — bounding only this copy would have left the one that runs
      // unattended still able to hang. Only the tx acquisition differs between
      // the two callers, which is why `runQuery` is the parameter.
      const { readCoordTokens } = await import('./insights-coordtokens-read');
      const ws = activeWorkspaceId();
      return await routeWithWorkspace(async (tx) => {
        const runQuery = async <T>(query: string, params: unknown[]): Promise<T[]> =>
          (await tx.unsafe(query, params as never)) as unknown as T[];
        return readCoordTokens({ runQuery, workspaceId: ws, harness: a.harness, windowMs: a.windowMs });
      });
    },
  },

  // ── learning.observations + companion summary ──
  // One normalized predicate backs 200-row (created_at,id) keyset pages, exact
  // totals, and scope/role/confidence/kind drill-down facets. The unfiltered
  // first page deliberately keeps the existing derived snapshot fast path.
  'learning.observations': learningObservationsQueryPair.rowsEntry as QueryEntry<unknown>,
  'learning.observations.summary': learningObservationsQueryPair.summaryEntry as QueryEntry<unknown>,

  // ── learning.observations.counts — signal distribution with real DB counts ──
  //
  // (system-health-dashboard-batch WI-4374). Queries the authoritative database
  // to get true counts per observation kind, instead of using the loaded-list
  // length as a fallback (which is a bug when total > limit). Returns an array
  // with one row per kind: { kind, count }. Used by the Observations panel to
  // render signal distribution buttons with "500+" guard when count >= 500.
  'learning.observations.counts': {
    backingTables: ['harness_shared.work_items'],
    argsSchema: z
      .object({
        state: z.enum(['open', 'resolved', 'closed']).optional(),
      })
      .optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { state?: 'open' | 'resolved' | 'closed' };
      const { countObservationsByKind } = await import('../issues-engineer');
      // P-006/D-031: canonical observation identity is the `lane` column.
      const { OBSERVATION_LANE } = await import('../harness/improvements/read-items');
      const filter = {
        lane: OBSERVATION_LANE,
        excludeRubricGraded: true,
        ...(a.state ? { state: a.state } : {}),
      };
      const counts = await countObservationsByKind(filter);
      // Return as array of { kind, count } rows for sync compatibility
      return Object.entries(counts).map(([kind, count]) => ({ kind, count }));
    },
  },

  // ── phone.plane — REMOVED 2026-08-30 (owner directive: the phone surface does
  // not belong to the operator app; it belongs to the SUITE phone app reached
  // from the Portal). Nothing in this registry serves a phone pane any more.
  // Historical marker only — do not re-add a phone query here.
  // ── (removed) ──
  //
  // (WI-1403107, owner ask 2026-08-30 "add a phone button to the sidebar".)
  // The self-hosted media plane from plan phone-app-2026-08-30 P-002 is two
  // systemd units; this reports what systemd actually says about them.
  //
  // DERIVED, never hand-maintained. The tempting version of this pane is a
  // short list of strings naming which pieces exist — a second copy of a truth
  // the units already own, which goes stale silently the first time one is
  // renamed or stopped. `probeUnitStates` is the same reader `dev:service_health`
  // uses, so this pane and that tool cannot disagree.
  //
  // `known` is carried through deliberately: systemd reports a NONEXISTENT unit
  // as `inactive`, identical to a stopped one, so a pane rendering activeState
  // alone would show a typo'd unit name as a service that is merely down.
  // NOT table-backed — refreshes on mount and on manual invalidate.

  // ── learning.health — the composite learning-infra status chip ──
  //
  // (self-improvement-consume-edges-2026-06-12 P-003 / D-002). ONE
  // offline/degraded/ok verdict over the learning system's own infra legs —
  // LLM-spine resolvability, the runner spawn path's watchdog key, the gym fire
  // circuit — read from the snapshot the 2-min DBOS tick maintains (a stale or
  // missing snapshot triggers an on-demand evaluation; same transition +
  // notification semantics either way). Returns [] when the
  // LEARNING_INFRA_HEALTH flag is off (the chip hides). NOT table-backed —
  // refreshes on mount + manual invalidate + the server-side
  // notifySyncInvalidate the tick fires on every status change.
  'learning.health': {
    resolve: async () => {
      const { getLearningInfraHealth } = await import('../harness/improvements/learning-infra-health');
      const health = await getLearningInfraHealth();
      return health ? [health] : [];
    },
  },

  'learning.dream': {
    backingTables: ['harness_shared.routines', 'harness_shared.dream_runs', 'harness_shared.pot_settings', 'harness_shared.learning_spend_events', 'harness_shared.learning_governor_loops', 'harness_shared.learning_pot_scope', 'harness_shared.scout_routed_ideas', 'harness_shared.experiment_runs'],
    argsSchema: z.object({
      potSlug: z.string().trim().min(1).max(120),
      mode: z.enum(['manual', 'auto']).optional(),
      view: z.enum(['controls', 'metrics', 'history', 'run']).optional(),
      since: z.string().datetime().optional(), until: z.string().datetime().optional(),
      cursor: z.string().max(800).optional(), runId: z.string().trim().min(1).max(500).optional(),
    }).refine(args => args.view !== 'run' || Boolean(args.runId), 'A run id is required for Dream detail'),
    resolve: async (raw: unknown) => {
      const args = raw as { potSlug: string; mode?: 'manual' | 'auto'; view?: 'controls' | 'metrics' | 'history' | 'run'; since?: string; until?: string; cursor?: string; runId?: string };
      const [{ activeWorkspaceId }, { routeWithWorkspace }, { readDreamControlSnapshot }] = await Promise.all([
        import('../workspace-registry'), import('../route-workspace'), import('../dream/dream-control'),
      ]);
      const workspaceId = activeWorkspaceId();
      if (args.view === 'run') {
        const { readDreamDetail } = await import('../dream/dream-read');
        return routeWithWorkspace(async tx => {
          const detail = await readDreamDetail(tx as unknown as import('postgres').Sql,
            { workspaceId, potSlug: args.potSlug, runId: args.runId! });
          return detail ? [detail] : [];
        });
      }
      if (args.view === 'history') {
        const { readDreamHistory } = await import('../dream/dream-read');
        const until = args.until ?? new Date().toISOString();
        const since = args.since ?? new Date(Date.parse(until) - 7 * 86_400_000).toISOString();
        return routeWithWorkspace(async tx => [await readDreamHistory(tx as unknown as import('postgres').Sql,
          { workspaceId, potSlug: args.potSlug, since, until }, args.cursor)]);
      }
      if (args.view === 'metrics') {
        const { readDreamMetrics } = await import('../dream/dream-metrics');
        const until = args.until ?? new Date().toISOString();
        const since = args.since ?? new Date(Date.parse(until) - 7 * 86_400_000).toISOString();
        return routeWithWorkspace(async (tx) => [await readDreamMetrics(tx as unknown as import('postgres').Sql,
          { workspaceId, potSlug: args.potSlug, since, until })]);
      }
      return routeWithWorkspace(async (tx) => [await readDreamControlSnapshot(tx as unknown as import('postgres').Sql, { workspaceId, potSlug: args.potSlug, mode: args.mode })]);
    },
  },

  // ── learning.loopControl — the Learnings-tab header pause/resume-all control ──
  //
  // (WI-39501). ONE snapshot of the self-improvement routine GROUP — member /
  // active / group-pause-held counts, the newest groupPause stamp, and the
  // loop-role spend rollup (scout/gym/llm-testing over
  // harness_shared.agent_usage_samples) — feeding the header chip + pause/resume
  // button rendered on EVERY Learnings step. Workspace-scoped via
  // routeWithWorkspace (RLS GUC) with an explicit workspace predicate; the
  // loader degrades a missing column/table to the empty snapshot (never a 500).
  // Writes go through routines:group-set, which fires
  // notifySyncInvalidate('learning.loopControl') after the flip commits — plus
  // the view's own invalidate() after a mutate. Always a 1-element array.
  'learning.loopControl': {
    // agent_usage_samples is bridged in table-to-query-names.ts; `routines` is
    // producer-pushed instead (see PUSH_EXEMPT in
    // __tests__/resolver-backing-table-coverage.test.ts) because the routines
    // row is rewritten on every tick.
    backingTables: ['harness_shared.routines', 'harness_shared.agent_usage_samples'],
    argsSchema: z.object({}).optional(),
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { loadLearningLoopControl } = await import('../harness/improvements/loop-control');
      const ws = activeWorkspaceId();
      return await routeWithWorkspace(async (tx) => {
        const runQuery = async <T>(query: string, params: unknown[]): Promise<T[]> =>
          (await tx.unsafe(query, params as never)) as unknown as T[];
        const snapshot = await loadLearningLoopControl({ workspaceId: ws, runQuery });
        return [snapshot];
      });
    },
  },

  // ── learning.releaseReadiness — the Verify stage's GO/NO-GO strip ──
  //
  // (learning-tab-alignment-2026-07-13 P-001, D-001). blender:success-metrics'
  // six bars + the blender-release-readiness rubric's governance state, surfaced
  // where the Verify stage renders — the gate previously had NO UI at all.
  // D-001: the read module reuses the EXACT readers the MCP tools serve
  // (buildProgramSuccessReport / getRubric / listScorecards) — never a parallel
  // UI-side reimplementation. NOT table-backed — refreshes on mount + staleTime
  // (the learning.gym / learning.apiary posture). Always a 1-element array.
  'learning.releaseReadiness': {
    resolve: async () => {
      // PRECOMPUTED (phase2 P-005) — no args, so a plain snapshot SELECT.
      // readReleaseReadiness reruns blender:success-metrics + rubric governance
      // reads (0.27s) on every Verify-stage mount; the routine now fills it.
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      return readDerivedSnapshotRows('learning.releaseReadiness');
    },
  },

  // ── health.snapshot — the whole-system Health tab snapshot ──
  //
  // (system-health-tab-2026-06-15 P-003, D-001). ONE `SystemHealth` snapshot —
  // Queen / bees / work-feed / tokens / deploy / infra / plans / escalations /
  // autonomy / observations / improvements / SU fleet — read from the per-
  // workspace cache the ~30s DBOS tick maintains (a stale/missing snapshot
  // triggers an on-demand recompute; computeSystemHealth is fail-soft per panel).
  // Returns [] when the SYSTEM_HEALTH_TAB flag is off (the tab hides). NOT
  // table-backed — refreshes on mount + the server-side notifySyncInvalidate the
  // tick fires each cycle. The SAME aggregation feeds the overwatch brief (C-1).
  'health.snapshot': {
    resolve: async () => {
      const { getSystemHealth } = await import('../system-health');
      const health = await getSystemHealth();
      return health ? [health] : [];
    },
  },

  // ── health.history — the Health tab's persisted 24h status history ──
  //
  // (health-tab-v2-2026-07-12 P-006, D-B). Per-panel worst-per-bucket uptime
  // strips + "crit since <t>" + the bounded transition timeline, read from the
  // migration-585 tables the ~30s tick writes (system_health_ticks /
  // system_health_transitions, 14d retention). SSE-live — runSystemHealthTick
  // invalidates this name alongside `health.snapshot` each cycle. Fail-soft:
  // any read error returns [] and the tab degrades to snapshot-only (history
  // must never break the health view it decorates).
  'health.history': {
    resolve: async () => {
      try {
        const [{ activeWorkspaceId }, { readSystemHealthHistory }] = await Promise.all([
          import('../workspace-registry'),
          import('../system-health/history'),
        ]);
        return [await readSystemHealthHistory(activeWorkspaceId())];
      } catch {
        return []; // degrade to snapshot-only (D-B fail-soft)
      }
    },
  },

  // ── overwatch.snapshot — the Overwatch pane's current brief ──
  //
  // (overwatch-role-2026-06-15 B-08, D-006). The ACTIONABLE SUBSET of the same
  // `SystemHealth` the Health tab serves — health panels + detected anomalies +
  // suggested nudges. NOT a second aggregation: `getOverwatchSnapshot` reuses the
  // shared system-health cache and maps it via the pure B-03 mapper/detector.
  // SSE-live — `runSystemHealthTick` invalidates this name alongside
  // `health.snapshot` each ~30s tick. Always returns a 1-element array (the
  // fail-soft neutral brief when health is unreadable), so the pane has a shape.
  'overwatch.snapshot': {
    resolve: async () => {
      const { getOverwatchSnapshot } = await import('../overwatch/snapshot');
      return [await getOverwatchSnapshot()];
    },
  },

  // ── overwatch.controlState — the Overwatch pane's header (start/cadence/liveness) ──
  //
  // (overwatch-role-2026-06-15 B-08). The persisted overwatch_started bit + wake
  // cadence (B-07) + live wake liveness (B-09) + the papercusp-overwatch flag
  // (D-009). `kettle:start` / `kettle:pause` invalidate this name (wired in
  // B-07), so the header flips the moment the owner starts/pauses the loop.
  'overwatch.controlState': {
    resolve: async () => {
      const { getOverwatchControlState } = await import('../overwatch/snapshot');
      return [await getOverwatchControlState()];
    },
  },

  // ── overwatch.liveness — the Overwatch pane's "is-it-alive?" heartbeat strip ──
  //
  // The proof-of-life the control-state CAN'T give: it derives from the
  // `harness_shared.autoloop_state` row (role='overwatch') that EVERY actual fire
  // stamps (`recordFire`), not the one-shot `overwatch-wake` routine row (which is
  // deactivated between fires, so a healthy-between-runs loop looked identical to a
  // dead one). Returns last-run-at + status + a derived next-run estimate + an
  // ALIVE/STALE verdict (stale once the last fire is older than 2× cadence). The
  // overwatch loop's fire path (`overwatch/loop.ts`) invalidates this name after
  // each `recordFire`, so the strip's countdown + badge refresh live over SSE.
  'overwatch.liveness': {
    resolve: async () => {
      const { getOverwatchLiveness } = await import('../overwatch/snapshot');
      return [await getOverwatchLiveness()];
    },
  },

  // ── automation.catalog — the Blender / Docs panes' schedule + spend read model ──
  //
  // (owner ask 2026-07-25.) Every scheduled routine, classified into an
  // owner-facing category, with `spawnsAgent` marking the ones that can COST
  // TOKENS — plus a 7d spend rollup by role. This exists because cron-spawned
  // agents are EPHEMERAL: the agents-running roster reads empty while spend runs
  // continuously, so there was no surface on which the owner could see, let alone
  // pause, the things consuming their weekly limit.
  //
  // `routines:set` / `routines:group-set` invalidate this name, so a pause flips
  // the pane live. Spend is reported BY ROLE and never fused into a per-routine
  // number — there is no FK from a usage row to its spawning routine, and inventing
  // one would present a guess as a fact (see the module header).
  'automation.catalog': {
    resolve: async () => {
      const { getAutomationCatalog } = await import('../automation/catalog');
      return [await getAutomationCatalog()];
    },
  },

  // ── taskManager.inventory — the Tasks pane's read model (WI-6475) ──
  //
  // Every task this operator launched, with the provenance a process table cannot
  // give: who launched it, for which work-item, and what it is consuming. The
  // `live` arm additionally walks the cgroup tree for the no-escape signal
  // (processes inside our slice that no chokepoint registered).
  //
  // This exists as a SYNC query rather than the pane polling its admin route,
  // because a bare `fetch` from the desktop webview does not ride the sys:http IPC
  // bridge that injects the loopback-superuser bearer — it resolves
  // `unverified-loopback`, and the VT-gated admin route 403-blanks the pane
  // (EI-338; the mechanism is written up in endpoint-route/__tests__/
  // auth-posture.test.ts). The sync transport is `auth:'loopback'`, so it is
  // admitted on exactly the path every sibling rail tab already uses.
  //
  // Shares `getTaskInventory` with `/admin/tasks/inventory` so the HTTP surface and
  // the pane can never drift. Callers pace themselves with `staleTime` — the `live`
  // arm is a kernel scan and must not be run on a tab nobody is looking at.
  'taskManager.inventory': {
    resolve: async (args: unknown) => {
      const a = (args ?? {}) as {
        state?: string;
        cls?: string;
        includeEnded?: boolean;
        live?: boolean;
        countsOnly?: boolean;
        includeSchedules?: boolean;
      };
      const [{ getTaskInventory, disabledInventory }, { isTaskManagerEnabled }] = await Promise.all([
        import('../task-manager/inventory'),
        import('../task-manager/enabled'),
      ]);
      // The fail direction lives in the shared authority, never here — this call site
      // used to carry its own `.catch(() => true)`, which is how the flag ended up
      // decorative (WI-6499). It is fail-OPEN again as of WI-6844, but by decision
      // rather than by accident: the flag graduated to default-ON for the standard
      // release, so an explicit OFF still serves `disabledInventory()` while an
      // unreachable backend serves the real one.
      if (!(await isTaskManagerEnabled('sync:taskManager.inventory'))) return [disabledInventory()];
      return [
        await getTaskInventory({
          state: a.state ?? null,
          cls: a.cls ?? null,
          includeEnded: a.includeEnded === true,
          live: a.live === true,
          countsOnly: a.countsOnly === true,
          // P-019 — the recurring kind. Opt-in: this arm reads DBOS + routines and
          // probes sibling processes, so it must not ride the pane's 5s refresh.
          includeSchedules: a.includeSchedules === true,
        }),
      ];
    },
  },

  // ── mugBrief.floorView — REMOVED (P-059) ──
  //
  // Was a client-safe projection of the floor the Mug was briefed with on every
  // wake, for the chat sidebar's pot-status panel
  // (operator-chat-sidebar-revival-2026-07-13 P-018). Its CLIENT was removed
  // first (WI-37654 stripped the pane), leaving a resolver nothing read; the
  // Mug/Kettle retirement then removed the brief it projected. Both halves are
  // gone, so the query is gone with them.
  //
  // `PotHealthPane.test.tsx` guards this: it asserts the pane's query set does
  // NOT contain 'mugBrief.floorView' (alongside the overwatch pair) — "the
  // retired tier's briefs must not come back". Do not reintroduce this key
  // without reading that test first.

  // ── learning.gym — the Learning tab's Gym view (operator-learning-tab P-006) ──
  //
  // Cross-harness rollup of the gym control plane: recent prompt-optimization
  // proposals (pending / accepted = champions / rejected) + each gym harness's
  // autoloop config. Reuses the gym control-plane readers (single source of truth
  // with the gym:* routes). Returns a 1-element array { proposals, autoloops }.
  // NOT table-backed for PG-trigger invalidation — refreshes on mount + the panel's
  // manual `invalidate()`. Empty until a gym actually runs (graceful empty in the UI).
  'learning.gym': {
    // (per-hive-learning-loops P-041) the per-Hive lens: a Hive HOME slug
    // narrows the gym proposals + autoloops to that Hive's gym harness. The gym
    // is scoped per (workspace_id, harness_slug); the Hive home slug IS the gym
    // harness_slug, so the filter is a direct harness_slug match. Omit ⇒ the
    // cross-harness workspace rollup (unchanged default).
    argsSchema: z.object({ hive: z.string().max(120).optional() }).optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { hive?: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      // BOUNDED + EXTRACTED (WI-39825). The five-leg fan-out, the WI-6395 partial
      // degradation (`degradedFields` records WHICH leg degraded, next to the
      // intact data) and the per-leg degradation policy now live in
      // `learning-gym-read.ts`. The move is what makes the deadline GUARDABLE: a
      // budget can only be proved to fire by moving it, and a resolver's only
      // input is its wire args — so the knob had to become a function parameter
      // rather than a client-visible field. That module's header carries the
      // full reasoning and the per-leg policy.
      const { readGymSnapshot } = await import('./learning-gym-read');
      const ws = activeWorkspaceId();
      const harnessSlug = a.hive || undefined;
      const scoped = await readGymSnapshot({
        workspaceId: ws,
        ...(harnessSlug ? { harnessSlug } : {}),
      });
      // WI-5809 (owner report 2026-07-25): NO CROSS-TENANT FALLBACK.
      //
      // This used to detect an empty Hive-scoped read and silently return the
      // WORKSPACE-WIDE rollup flagged `scopeFallback: true` (WI-5420). The intent
      // was kind — surface real rows recorded under an unaffiliated slug like
      // 'gymloopharness' rather than render an empty state. The effect was not:
      // selecting the Oddsmith pot showed PAPERCUSP's gym experiments, with only a
      // muted one-line note to say so. Showing tenant A's data under tenant B's
      // lens is a correctness bug; a note does not make it correct, and the owner
      // read it (rightly) as the view lying about scope.
      //
      // A selected pot now shows ONLY that pot's data, or an honest empty state.
      // The real WI-5420 problem — CLI gym runs landing in the 'gymloopharness'
      // bucket instead of the target hive — is a WRITE-SIDE attribution bug and
      // must be fixed there, not papered over on read.
      return [scoped];
    },
  },

  // ── learning.retain — the Retain view's always-on strip data ──
  //
  // (WI-5412 → slimmed by WI-39493 Variant D): the banked-this-week counts +
  // the ideator lens weights. Everything ELSE the colony keeps now flows
  // through learning.retainFeed below as one recency-interleaved ledger.
  // Every leg degrades independently (learning-retain-read).
  // Push-backed by the four visible stores below (WI-6182): work_items is the
  // engineer_issues compat view's real producer; the other three are direct.
  'learning.retain': {
    backingTables: [
      'harness_shared.work_items',
      'harness_shared.coord_links',
      'harness_shared.harness_plans',
      'harness_shared.scout_lens_weights',
    ] as const,
    argsSchema: z.object({ hive: z.string().max(120).optional() }).optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { hive?: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readRetainExtras } = await import('./learning-retain-read');
      const ws = activeWorkspaceId();
      const { sql } = getOrgPg();
      // P-040-style hive lens: resolve the Hive → member-harness scopes for the
      // banked counts; a registry failure degrades to the workspace-wide count.
      let harnessScopes: string[] | undefined;
      if (a.hive) {
        try {
          const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../harness-registry');
          const reg = await loadHarnessRegistry();
          harnessScopes = hiveMemberHarnessScopes(reg.projects, a.hive);
        } catch (err) {
          console.warn('[learning.retain] hive scope resolution failed:', err instanceof Error ? err.message : err);
        }
      }
      const snapshot = await readRetainExtras(
        sql,
        ws,
        {
          readLensWeights: async () => {
            const { readScoutLensWeights } = await import('../scout/routed-ledger');
            return (await readScoutLensWeights({ workspaceId: ws, sql })) as Record<string, number>;
          },
        },
        {
          ...(harnessScopes ? { harnessScopes } : {}),
          ...(harnessScopes
            ? { memberSlugs: harnessScopes.map((s) => (s.startsWith('harness:') ? s.slice('harness:'.length) : s)) }
            : {}),
        },
      );
      return [snapshot];
    },
  },

  // ── learning.retainFeed — the unified "Retained" ledger (WI-39493, Variant D) ──
  //
  // One recency-interleaved keyset-paged feed over six retained stores: the
  // hive's shared-memory pool (WI-39535), plans the Blender routed, idea-routed
  // work items (plan-born excluded — those roll up under their plan), rubrics,
  // agent-insight runbooks, and code recipes. Tab/shipped filters + the cursor
  // compose SERVER-side; counts (tab badges) ride the first page only. Every
  // leg degrades independently.
  //
  // backingTables: plans + work_items move the statusful legs (bridged in
  // table-to-query-names.ts); code_recipes has no trigger (recipes are
  // poll-only today) and the memory pool rides the pluggable backend seam —
  // both PUSH_EXEMPT with reasons in resolver-backing-table-coverage.test.ts.
  // Memory WRITES push through memory/invalidate-user-memory-views.ts instead.
  'learning.retainFeed': {
    backingTables: [
      'harness_shared.harness_plans',
      'harness_shared.work_items',
      'harness_shared.code_recipes',
      'harness_shared.memory_canonical',
    ],
    argsSchema: retainFeedArgsSchema,
    resolve: async (args) => {
      const a = (args ?? {}) as RetainFeedQueryArgs;
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readRetainFeed } = await import('./learning-retain-read');
      const ws = activeWorkspaceId();
      const { sql } = getOrgPg();
      // Same P-040 hive lens as learning.retain above: scope the plan/wi legs
      // to the Hive's members; the rubric / runbook / recipe corpora are
      // lens-invariant. Degrades workspace-wide.
      const harnessScopes = await retainHiveScopes(a.hive, 'learning.retainFeed');
      const page = await readRetainFeed(sql, ws, await retainStoreDeps(sql, ws, a.hive), {
        tab: a.tab,
        cursor: a.cursor ?? null,
        q: a.q,
        filters: a.filters,
        ...(a.limit != null ? { limit: a.limit } : {}),
        ...(harnessScopes ? { harnessScopes } : {}),
        ...(harnessScopes
          ? { memberSlugs: harnessScopes.map((s) => (s.startsWith('harness:') ? s.slice('harness:'.length) : s)) }
          : {}),
      });
      return [page];
    },
  },

  // Paired exact total + drill-down facets for the selected Retain
  // tab/outcome scope. It reuses the row feed's normalized q/rtf predicate and
  // store deps; a failed leg rejects the summary so the client renders
  // unknown rather than summing a partial corpus.
  'learning.retainFeed.summary': {
    backingTables: [
      'harness_shared.harness_plans',
      'harness_shared.work_items',
      'harness_shared.code_recipes',
      'harness_shared.memory_canonical',
    ],
    argsSchema: retainFeedArgsSchema,
    resolve: async (args) => {
      const a = (args ?? {}) as RetainFeedQueryArgs;
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { normalizeRetainFeedArgs, readRetainSummaryAggregateRows, retainFeedSummarySelection } =
        await import('./learning-retain-read');
      const ws = activeWorkspaceId();
      const { sql } = getOrgPg();
      const harnessScopes = await retainHiveScopes(a.hive, 'learning.retainFeed.summary');
      const opts = {
        tab: a.tab,
        q: a.q,
        filters: a.filters,
        ...(a.limit != null ? { limit: a.limit } : {}),
        ...(harnessScopes ? { harnessScopes } : {}),
        ...(harnessScopes
          ? {
              memberSlugs: harnessScopes.map((scope) =>
                scope.startsWith('harness:') ? scope.slice('harness:'.length) : scope,
              ),
            }
          : {}),
      };
      const normalized = normalizeRetainFeedArgs(opts);
      return readCompanionSummary({
        aggregateRows: readRetainSummaryAggregateRows(sql, ws, await retainStoreDeps(sql, ws, a.hive), opts),
        label: 'learning.retainFeed.summary',
        selection: retainFeedSummarySelection(normalized),
      });
    },
  },

  // ── learning.retainCounts — the Retained ledger's tab badges (WI-39900) ──
  //
  // The six corpus sizes, SPLIT OUT of learning.retainFeed's first page because
  // they were the whole of its latency: Runbooks first page measured 4.79s with
  // them inline vs 0.024s without, and the `all` tab 1.0s vs 0.13s — the rows
  // were never the slow part. Worse than slow, they were COUPLING: the memories
  // count is a full-corpus read over a backend with a measured ~10.9s p50
  // (WI-39554), so every tab's rows — including tabs with no memory rows at all
  // — waited on it, and a hiccup burned the whole 6s read budget before
  // rendering anything.
  //
  // Filter-independent by construction (a badge is a CORPUS size, not a count
  // of the current filter's matches), so it takes no tab/filter/cursor arg and
  // the client can hold it across tab switches. Each leg degrades to null
  // independently: an unreadable badge renders unknown, never 0.
  'learning.retainCounts': {
    backingTables: [
      'harness_shared.harness_plans',
      'harness_shared.work_items',
      'harness_shared.code_recipes',
      'harness_shared.memory_canonical',
    ],
    argsSchema: z.object({ hive: z.string().max(120).optional() }).optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { hive?: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readRetainCounts } = await import('./learning-retain-read');
      const ws = activeWorkspaceId();
      const { sql } = getOrgPg();
      const harnessScopes = await retainHiveScopes(a.hive, 'learning.retainCounts');
      const counts = await readRetainCounts(sql, ws, await retainStoreDeps(sql, ws, a.hive), {
        ...(harnessScopes ? { harnessScopes } : {}),
        ...(harnessScopes
          ? { memberSlugs: harnessScopes.map((s) => (s.startsWith('harness:') ? s.slice('harness:'.length) : s)) }
          : {}),
      });
      return [counts];
    },
  },

  // ── learning.retainPlanChildren — one plan row's plan-born work items ──
  //
  // The expand chevron on a Retained-ledger plan row (WI-39493): work items
  // with engineer_issues.source_plan_slug = planSlug, shipped classified
  // server-side. Best-effort — degrades to [].
  'learning.retainPlanChildren': {
    // Children are work_items rows (engineer_issues is the compat VIEW; the
    // base table carries the trigger) — bridged in table-to-query-names.ts.
    backingTables: ['harness_shared.work_items'],
    // planSlug '' = no plan expanded → [] without a DB round-trip (the client
    // keeps this read mounted under the view's ONE readiness gate — lens-guard).
    // `hive` is accepted for lens consistency but is a no-op: one plan's
    // children are the same under every lens.
    argsSchema: z.object({ planSlug: z.string().max(200), hive: z.string().max(120).optional() }),
    resolve: async (args) => {
      const a = args as { planSlug: string };
      if (!a.planSlug) return [];
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readRetainPlanChildren } = await import('./learning-retain-read');
      const { sql } = getOrgPg();
      return readRetainPlanChildren(sql, activeWorkspaceId(), a.planSlug);
    },
  },

  // ── learning.retainDetail — one Retained-ledger row's expanded detail (WI-39534) ──
  //
  // The detail aside beside the ledger: body/provenance beyond the row's
  // title+status, per kind, in ONE neutral shape (readRetainDetail). Empty id
  // short-circuits to [] without touching a store (the client keeps the read
  // mounted under the view's ONE readiness gate — lens-guard); an unknown id or
  // a store fault resolves to [] and the client renders "detail unavailable".
  // `hive` is accepted for lens consistency but is a no-op: one row's detail is
  // the same under every lens. backingTables mirror retainFeed's (same stores,
  // same exemptions) minus the corpora a detail read never lists.
  'learning.retainDetail': {
    backingTables: [
      'harness_shared.harness_plans',
      'harness_shared.work_items',
      'harness_shared.code_recipes',
      'harness_shared.memory_canonical',
    ],
    argsSchema: z.object({
      kind: z.enum(['memory', 'plan', 'wi', 'rubric', 'runbook', 'recipe']),
      id: z.string().max(400),
      hive: z.string().max(120).optional(),
    }),
    resolve: async (args) => {
      const a = args as { kind: 'memory' | 'plan' | 'wi' | 'rubric' | 'runbook' | 'recipe'; id: string };
      if (!a.id) return [];
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readRetainDetail } = await import('./learning-retain-read');
      const { DOCS_CONTENT_ROOT } = await import('../agent-tools/docs/_repo-paths');
      const { sql } = getOrgPg();
      const insightsDir = `${DOCS_CONTENT_ROOT}/agent-insights`;
      const detail = await readRetainDetail(sql, activeWorkspaceId(), a.kind, a.id, {
        getRubric: async (id) => {
          const { getRubric } = await import('../rubrics');
          const r = await getRubric(id);
          return r
            ? {
                title: r.title,
                description: r.description ?? '',
                status: r.status,
                characteristic: r.characteristic ?? '',
                criteria: r.criteria ?? [],
                updatedAt: r.updatedAt,
              }
            : null;
        },
        getRecipe: async (id) => {
          const { getRecipe } = await import('../code-recipes-store');
          const r = await getRecipe(sql, id);
          return r
            ? {
                title: r.title,
                description: r.description ?? '',
                script: r.script,
                potSlug: r.potSlug ?? null,
                toolsUsed: r.toolsUsed ?? [],
                runCount: r.runCount,
                successCount: r.successCount,
                lastRunAt: r.lastRunAt ?? null,
                status: r.status,
                createdBy: r.createdBy ?? null,
                updatedAt: r.updatedAt,
              }
            : null;
        },
        readRunbook: async (slug) => {
          // Runbook docs exist as BOTH .md and .mdx in the insights tree —
          // try both; ts = file mtime (the same instant the feed leg sorts by).
          const { promises: fs } = await import('node:fs');
          const path = await import('node:path');
          const safe = path.basename(slug);
          for (const ext of ['.md', '.mdx']) {
            const p = path.join(insightsDir, `${safe}${ext}`);
            try {
              const [text, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]);
              return { text, ts: new Date(Math.floor(st.mtimeMs)).toISOString() };
            } catch {
              /* try the next extension */
            }
          }
          return null;
        },
        getMemory: async (id) => {
          const { getMemoryBackend } = await import('../memory/backend');
          const backend = getMemoryBackend();
          const avail = await backend.available();
          if (!avail.ok) throw new Error(avail.reason);
          const entry = await backend.get(id);
          return entry ? (entry as typeof entry & { scope?: string }) : null;
        },
      });
      return detail ? [detail] : [];
    },
  },

  // ── plans.scheduledOccurrences — the Calendar tab's events (scheduled-recurring-plans P-018/P-019/P-026) ──
  //
  // All scheduled-plan occurrences in a [rangeStartMs, rangeEndMs] window, expanded
  // server-side from each template's RRULE/cron/one-shot (the rrule lib is the single
  // source of truth; the calendar UI lib stays swappable — D-004). Workspace-scoped
  // via the active-workspace ALS; the harness_shared.harness_plans filter is by
  // workspace_id (shared table, no schema routing). Best-effort: a read error degrades
  // to [] rather than a 500, so the calendar shows its empty state.
  'plans.scheduledOccurrences': {
    argsSchema: scheduledOccurrencesArgsSchema,
    resolve: async (args) => {
      const a = args as { rangeStartMs: number; rangeEndMs: number; harnessSlug?: string };
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        const { gatherScheduledOccurrences } = await import('../harness/routines/scheduled-occurrences');
        const { sql } = getOrgPg();
        return await gatherScheduledOccurrences(sql, {
          workspaceId: activeWorkspaceId(),
          rangeStartMs: a.rangeStartMs,
          rangeEndMs: a.rangeEndMs,
          ...(a.harnessSlug ? { harnessSlug: a.harnessSlug } : {}),
        });
      } catch (err) {
        console.warn('[plans.scheduledOccurrences] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── plans.schedule — one row per scheduled plan's RAW authored schedule (P-020 / D-020) ──
  //
  // The calendar's schedule editor pre-fills from this, and the per-occurrence
  // EXDATE/RDATE drag reads the source RRULE here. Window-independent (unlike
  // scheduledOccurrences) so a plan whose next fire is outside the calendar view
  // — or opened from the "Schedule a plan" picker — is still editable. Best-effort:
  // a read error degrades to [] so the editor opens fresh (replace-mode).
  'plans.schedule': {
    argsSchema: z.object({ harnessSlug: z.string().max(200).optional() }),
    resolve: async (args) => {
      const a = args as { harnessSlug?: string };
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        const { listPlanSchedules } = await import('../harness/routines/scheduled-occurrences');
        const { sql } = getOrgPg();
        return await listPlanSchedules(sql, {
          workspaceId: activeWorkspaceId(),
          ...(a.harnessSlug ? { harnessSlug: a.harnessSlug } : {}),
        });
      } catch (err) {
        console.warn('[plans.schedule] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── plans.runHistory — the Runs tab's per-template run history + rollup (scheduled-recurring-plans P-022/P-024) ──
  //
  // Distinct from `plans.runs` (the Agents-tab flat PlanRun[] keyed on { slug }):
  // this is the enriched run history for one template (outcome, duration, trigger,
  // work-item rollup, cost) + the computed rollup (success rate, median duration,
  // regression flags) for the summary header, keyed on { planSlug }. Returns a
  // 1-element array [{ runs, rollup }] (cf. learning.apiary). Read-only — the routine
  // tick settles outcomes; this does not reconcile (no side effects on a UI read).
  // Best-effort: a read error degrades to empty so the tab shows its empty state.
  'plans.runHistory': {
    argsSchema: z.object({
      planSlug: z.string().min(1),
      harnessSlug: z.string().max(200).optional(),
    }),
    resolve: async (args) => {
      const a = args as { planSlug: string; harnessSlug?: string };
      try {
        const { listPlanRuns, computePlanRunRollup } = await import('../agent-tools/plans/runs');
        const runs = await listPlanRuns(a.planSlug, a.harnessSlug ? { harnessSlug: a.harnessSlug } : {});
        return [{ runs, rollup: computePlanRunRollup(runs) }];
      } catch (err) {
        console.warn('[plans.runs] read failed:', err instanceof Error ? err.message : err);
        return [{ runs: [], rollup: null }];
      }
    },
  },

  // ── learning.apiary — the Learning tab's Benchmark view (operator-learning-tab P-007) ──
  //
  // The apiary / IQ-battery scoreboard: one summary row per benchmark generation
  // (instance), newest-first, over the canonical beekeeper_instances/runs/scores tables.
  // The yardstick for "are the agents actually getting better" (D-004). Reuses the
  // readApiaryInstanceSummaries reader. Returns a 1-element array { instances }. NOT
  // Push-backed by all three canonical benchmark relations (WI-6182).
  // Best-effort (learning-system-audit P-042): pre-baseline (gen-0 is owner-gated) a
  // missing table / PG error degrades to instances:[] — the clean empty state, not a 500.
  'learning.apiary': {
    backingTables: [
      'harness_shared.cup_keeper_instances',
      'harness_shared.cup_keeper_runs',
      'harness_shared.cup_keeper_scores',
    ] as const,
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readApiaryInstanceSummaries } = await import('../iq-battery/benchmark-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => {
          const instances = await readApiaryInstanceSummaries(tx, { workspaceId: ws, limit: 20 });
          return [{ instances }];
        });
      } catch (err) {
        console.warn('[learning.apiary] benchmark read failed:', err instanceof Error ? err.message : err);
        return [degraded({ instances: [] }, err)];
      }
    },
  },

  // ── learning.hiveEvalTrend — the Benchmark view's "Hive orchestration" trend (HE-07, P-050) ──
  //
  // The Hive-RUN evaluation scoreboard: one summary row per code generation (instance),
  // newest-first, over the hive_eval instances/runs/scores tables (migrations 264/268). The
  // SIBLING of learning.apiary — its OWN tables, so Hive-run scores never contaminate the apiary
  // instance-evolution trend (D-011). Scoped to the current rubric so incomparable scores never
  // mix. Returns a 1-element array { instances }. Push-backed by all three Hive-eval relations
  // (WI-6182). Best-effort: the live
  // cadence is owner-gated (P-051), so pre-baseline a missing table / PG error degrades to
  // instances:[] — the clean empty state, not a 500 (mirrors learning.apiary's P-042 degrade).
  'learning.hiveEvalTrend': {
    backingTables: [
      'harness_shared.pot_eval_instances',
      'harness_shared.pot_eval_runs',
      'harness_shared.pot_eval_scores',
    ] as const,
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readHiveEvalInstanceSummaries } = await import('../pot-eval/trend-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => {
          const instances = await readHiveEvalInstanceSummaries(tx, { workspaceId: ws, limit: 20 });
          return [{ instances }];
        });
      } catch (err) {
        // Pre-baseline, the hive_eval tables don't exist yet: the live cadence is owner-gated
        // (P-051) and the store uses raw SQL not the generated schema (D-011/D-015), so the tables
        // boot-apply only on the next migration run. A missing table (42P01 undefined_table) is the
        // EXPECTED empty state — degrade to [] SILENTLY (no warn). Warn only on a genuine error, so
        // the structural resolver test (which runs the generated schema) stays clean.
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && !/does not exist/i.test(msg)) {
          console.warn('[learning.hiveEvalTrend] hive-eval trend read failed:', msg);
        }
        return [degraded({ instances: [] }, err)];
      }
    },
  },

  // ── learning.bakeoff — the Benchmark view's framework bake-off trend (plan-implementation-
  // framework-2026-06-15 P-014, activation of P-007/P-009) ──
  //
  // One trend row per framework bake-off run (a flag A/B result), newest-first, over the
  // hive_eval_bakeoff_deltas table (migration 293). The A-vs-B proof per bet: did flipping the flag
  // ON beat baseline? Returns a 1-element array { rows }. Best-effort like learning.hiveEvalTrend —
  // the first bake-off is owner-attended + the store uses raw SQL (not the generated schema), so
  // pre-baseline a missing table (42P01) degrades SILENTLY to rows:[] (the clean empty state, not a
  // 500, so the structural resolver test stays clean). runBetBakeoff fires
  // notifySyncInvalidate('learning.bakeoff') after persisting a new result.
  'learning.bakeoff': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readBakeoffTrendRows } = await import('../pot-eval/bakeoff-store');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => {
          const rows = await readBakeoffTrendRows(tx, { workspaceId: ws, limit: 50 });
          return [{ rows }];
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && !/does not exist/i.test(msg)) {
          console.warn('[learning.bakeoff] bake-off trend read failed:', msg);
        }
        return [degraded({ rows: [] }, err)];
      }
    },
  },

  // ── learning.knowledge — the Learning tab's Knowledge view (operator-learning-tab P-008) ──
  //
  // Two best-effort halves (learning-system-audit P-042), each degrading
  // independently so one broken substrate never blanks the other (mirrors the
  // learning.improvements watchdog read):
  //   - insights: count + recent-5 agent-insight runbooks (FS read over the MDX
  //     library via readInsightsSnapshot — the SAME readInsightsDir the prelude
  //     uses). A teaser only; the tab cross-links to ?tab=insights for the library.
  //   - memory: total canonical memories + 30d feedback events (org PG). `null`
  //     when PG is unreachable — the UI shows "unavailable", never a 500.
  // Returns a 1-element array { insights, memory }. NOT table-backed — refreshes
  // on mount + the panel's manual `invalidate()`.
  // ── autonomy.policy — the Queen autonomy policy (queen-autonomy-policy B-03) ──
  //
  // Per-category risk ceilings / locks / graduated levels for the active
  // workspace (harness_shared.autonomy_policy, migration 259), decorated by
  // decoratePolicyForView with the derived effectiveCeiling (min(ceiling,
  // graduated); locked ⇒ none) PLUS the category display metadata the owner
  // settings surface (B-15) renders — label / protected / suggestedPosture /
  // covers — so the client needs no operator-core import (categories.ts stays the
  // single source of truth, D-009). readAutonomyPolicy returns ALL 13 canonical
  // categories — stored rows overlaid on the behavior-neutral defaults — so the
  // surface always renders a complete policy, and a not-yet-applied migration
  // degrades to all-defaults (42P01 swallowed in the store, never a 500). NOT
  // table-backed: autonomy:policy_set / the B-15 write route fire
  // notifySyncInvalidate('autonomy.policy') after each write.
  'autonomy.policy': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readAutonomyPolicy } = await import('../autonomy/policy-store');
      const { decoratePolicyForView } = await import('../autonomy/policy-view');
      const rows = await readAutonomyPolicy(getOrgPg().sql, activeWorkspaceId());
      return rows.map(decoratePolicyForView);
    },
  },

  // ── autonomy.graduation — graduation-eligible standings (queen-autonomy-policy B-16 / P-082; surface P-032) ──
  //
  // Per-category trust-graduation TARGETS: the autonomy level the tripwire
  // evidence has EARNED (clamped ≤ ceiling) vs the current graduated_level, and
  // whether the owner may ratify a promotion (`shouldWrite` — target > current AND
  // not locked/protected/pinned). Recomputed from the autonomy_tripwires ledger
  // (mig 266, B-16) + the policy; categories with no evidence are OMITTED, so this
  // resolves to [] while the system is dark (nothing armed → the settings
  // graduation surface shows its nothing-eligible state, never a 500 — the store
  // swallows a not-yet-applied migration). Mirrors the autonomy:graduation_status
  // tool. Invalidated by a graduatedLevel write (the autonomy-policy-set route).
  'autonomy.graduation': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readTripwireEvidence } = await import('../autonomy/tripwire/store');
      const { readAutonomyPolicy } = await import('../autonomy/policy-store');
      const { getCategory } = await import('../autonomy/categories');
      const { computeAutonomyStandings, computeCategoryGraduationTargets, DEFAULT_AUTONOMY_GRADUATION_POLICY } =
        await import('../autonomy/tripwire/graduation');
      const sql = getOrgPg().sql;
      const ws = activeWorkspaceId();
      const nowMs = Date.now();
      const rows = await readTripwireEvidence(sql, ws, { lookbackDays: 90, nowMs });
      const standings = computeAutonomyStandings(rows, DEFAULT_AUTONOMY_GRADUATION_POLICY, nowMs);
      const policies = await readAutonomyPolicy(sql, ws);
      const policyMap = new Map(policies.map((p) => [p.category, p]));
      const targets = computeCategoryGraduationTargets(standings, policyMap, DEFAULT_AUTONOMY_GRADUATION_POLICY);
      return targets.map((t) => ({ ...t, label: getCategory(t.category)?.label ?? t.category }));
    },
  },

  // ── decision.ledger — the Queen decision ledger (queen-autonomy-policy B-13 / P-113) ──
  //
  // The two-layer D-012 ledger (harness_shared.decision_ledger, migrations 260 +
  // 265): action-chokepoint rows (every governed action that ran — B-06/P-110) +
  // decider-disposition rows (the Queen's per-item choices — P-111). Filterable by
  // layer / posture / category / disposition / time. Backs the settings
  // recent-auto-decisions feed (P-031 — pass {layer:'disposition'}). A
  // not-yet-applied migration degrades to [] (the feed shows its empty state, never
  // a 500). Invalidated by recordDecisionDisposition after a disposition write (the
  // feed-relevant, low-volume layer); the high-volume action emit does NOT
  // invalidate.
  'decision.ledger': {
    argsSchema: z.object({
      layer: z.enum(['action', 'disposition']).optional(),
      posture: z.enum(['auto', 'proposed', 'gated', 'rejected']).optional(),
      category: z.string().min(1).max(60).optional(),
      disposition: z.enum(['act', 'defer', 'reject', 'route-to-research', 'no-op']).optional(),
      sinceHours: z
        .number()
        .positive()
        .max(24 * 90)
        .optional(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const a = args as {
        layer?: 'action' | 'disposition';
        posture?: string;
        category?: string;
        disposition?: string;
        sinceHours?: number;
        limit: number;
      };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { readDecisionLedger } = await import('../decision-ledger/read');
      try {
        return await readDecisionLedger(activeWorkspaceId(), {
          ...(a.layer ? { layer: a.layer } : {}),
          ...(a.posture ? { posture: a.posture } : {}),
          ...(a.category ? { category: a.category } : {}),
          ...(a.disposition ? { disposition: a.disposition } : {}),
          ...(a.sinceHours != null ? { sinceMs: Date.now() - a.sinceHours * 3_600_000 } : {}),
          limit: a.limit,
        });
      } catch (err) {
        console.warn(
          '[decision.ledger] read failed (migration 260/265 pending?):',
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    },
  },

  // Returns a 1-element array { insights, memory }. NOT table-backed — refreshes
  // on mount + the panel's manual `invalidate()`.
  'learning.knowledge': {
    resolve: async () => {
      const { readInsightsSnapshot, readMemoryHealth } = await import('../memory/knowledge-read');
      // WI-7369: the insights snapshot and the memory-health read are INDEPENDENT —
      // neither consumes the other — so they are issued concurrently. Each keeps its
      // own degrade path (a Promise.all that rejected as a unit would let one failed
      // read blank the other, which is exactly what the separate catches prevent).
      //
      // MEASURED, 10 passes with the arm order alternated and a warm-up discarded:
      // legs were insights 155ms / health 510ms / precision 2ms, and running them
      // concurrently took the read 670 -> 520ms. The bigger half of the win is inside
      // readMemoryHealth, whose own four reads were serial too and are now likewise
      // parallel (510 -> 329ms); together the concurrent path lands ~347ms.
      //
      // ⚠ STILL OVER the 150ms sync-read budget, and deliberately not "fixed" further:
      // a cache is the obvious next lever and it is NOT free here the way it was for
      // dev.telemetry (WI-7367). That read is a 24h rollup where 30s of staleness is
      // imperceptible; this one's payload changes between consecutive calls (measured
      // 10,288 -> 10,286 B), so a TTL has to be argued for on freshness, not assumed.
      let insights: Awaited<ReturnType<typeof readInsightsSnapshot>> = { count: 0, recent: [] };
      const { getOrgPg } = await import('@papercusp/db-org');
      const insightsPromise = readInsightsSnapshot().catch((err: unknown) => {
        console.warn('[learning.knowledge] insights read failed:', err instanceof Error ? err.message : err);
        return null;
      });
      let memory: Awaited<ReturnType<typeof readMemoryHealth>> | null = null;
      try {
        memory = await readMemoryHealth(getOrgPg().sql);
        // Attach the memory-precision trend (relight P-033) — best-effort, and a
        // not-yet-applied migration 312 (42P01) degrades to the empty snapshot so
        // the MemoryHealthCard renders its nothing-benchmarked state, never a 500.
        try {
          const { readMemoryPrecision } = await import('../memory/bench/precision-read');
          const { activeWorkspaceId } = await import('../workspace-registry');
          memory.precision = await readMemoryPrecision(getOrgPg().sql, activeWorkspaceId());
        } catch (err) {
          if ((err as { code?: string }).code !== '42P01') {
            console.warn(
              '[learning.knowledge] memory precision read failed:',
              err instanceof Error ? err.message : err,
            );
          }
          const { EMPTY_PRECISION_SNAPSHOT } = await import('../memory/bench/precision-read');
          memory.precision = EMPTY_PRECISION_SNAPSHOT;
        }
      } catch (err) {
        console.warn('[learning.knowledge] memory health read failed:', err instanceof Error ? err.message : err);
      }
      // Joined last so the insights read overlapped the whole memory-health leg.
      // Its own catch already logged and returned null, so a failure here leaves the
      // zero-valued default in place exactly as the original sequential code did.
      const insightsResult = await insightsPromise;
      if (insightsResult !== null) insights = insightsResult;
      return [{ insights, memory }];
    },
  },

  // ── learning.efficacy — the Learning tab's "is the system actually learning" panel ──
  //
  // The complement to the flow strip's THROUGHPUT (in/out/recurring/watchdog): four
  // EFFICACY metrics that say whether the learning HELD (relight-self-learning-edges
  // P-020) — auto-fix survival (matured fix-survival bets), champion score-delta vs
  // the gen-0 baseline (the beekeeper IQ-battery trend), recurrence-decay (verified
  // vs recurred lifecycle), and memory FP@5 (the P-033 bench). Every metric degrades
  // honestly (ok / warming / none) — most of this data is YOUNG. Each read is
  // best-effort and independent: one source failing leaves the others intact.
  // Returns a 1-element array (client reads data[0]); the producers fire
  // notifySyncInvalidate('learning.efficacy') as their data lands.
  'learning.efficacy': {
    resolve: async () => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const {
        EMPTY_EFFICACY,
        GEN0_BASELINE,
        readAutoFixSurvival,
        readRecurrenceDecay,
        championDeltaMetric,
        memoryFpAt5Metric,
      } = await import('../learning/efficacy-read');

      let ws: string;
      let sql: ReturnType<typeof getOrgPg>['sql'];
      try {
        ws = activeWorkspaceId();
        sql = getOrgPg().sql;
      } catch (err) {
        console.warn('[learning.efficacy] no workspace/PG:', err instanceof Error ? err.message : err);
        return [degraded(EMPTY_EFFICACY, err)];
      }

      const result = { ...EMPTY_EFFICACY, gen0Baseline: { ...GEN0_BASELINE } };

      try {
        result.autoFixSurvival = await readAutoFixSurvival(sql, ws);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] auto-fix survival read failed:', err instanceof Error ? err.message : err);
        }
      }
      try {
        result.recurrenceDecay = await readRecurrenceDecay(sql, ws);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] recurrence-decay read failed:', err instanceof Error ? err.message : err);
        }
      }
      try {
        const { readApiaryInstanceSummaries } = await import('../iq-battery/benchmark-read');
        const { routeWithWorkspace } = await import('../route-workspace');
        const summaries = await routeWithWorkspace(async (tx) =>
          readApiaryInstanceSummaries(tx, { workspaceId: ws, limit: 20 }),
        );
        result.championDelta = championDeltaMetric(summaries, GEN0_BASELINE.composite);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] champion-delta read failed:', err instanceof Error ? err.message : err);
        }
      }
      try {
        const { readMemoryPrecision } = await import('../memory/bench/precision-read');
        result.memoryFpAt5 = memoryFpAt5Metric(await readMemoryPrecision(sql, ws));
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] memory FP@5 read failed:', err instanceof Error ? err.message : err);
        }
      }

      return [result];
    },
  },

  // ── learning.demand — the Knowledge view's missing-knowledge demand panel ──
  //
  // The negative-space miner's demand map (self-learning-frontier-2026-06-12
  // P-010 / FB-04): zero-hit docs/plans/memory searches aggregated into
  // harness_shared.negative_space_demand (migration 245) by the
  // system:negative-space-mine cadence. Hottest entries + rollups; PG failure
  // OR a not-yet-applied migration degrades to the empty snapshot (the panel
  // renders its nothing-mined state, never a 500). Returns a 1-element array
  // (client reads data[0]). NOT table-backed — the miner fires
  // notifySyncInvalidate('learning.demand') after each tick.
  'learning.demand': {
    resolve: async () => {
      const { EMPTY_DEMAND_SNAPSHOT, readDemandSnapshot } = await import('../negative-space/demand-read');
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        return [await readDemandSnapshot(getOrgPg().sql, activeWorkspaceId())];
      } catch (err) {
        // 42P01 (undefined table) = migration 245 not applied yet — the
        // expected pre-boot-apply state, not worth a warn.
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.demand] demand read failed:', err instanceof Error ? err.message : err);
        }
        return [degraded(EMPTY_DEMAND_SNAPSHOT, err)];
      }
    },
  },

  // ── learning.ekg — the Benchmark view's Fleet EKG panel ──
  //
  // The Fleet EKG's shift reports + vitals (self-learning-frontier-2026-06-12
  // P-030 / FB-10): session behavioral vectors in fleet_ekg_sessions and
  // detected distribution shifts in fleet_ekg_shifts (migration 251), written
  // by the system:fleet-ekg-scan cadence. PG failure OR a not-yet-applied
  // migration degrades to the empty snapshot (the panel renders its
  // nothing-scanned state, never a 500). Returns a 1-element array (client
  // reads data[0]). NOT table-backed — the scan fires
  // notifySyncInvalidate('learning.ekg') after each tick.
  'learning.ekg': {
    resolve: async () => {
      const { EMPTY_EKG_SNAPSHOT, readEkgSnapshot } = await import('../fleet-ekg/ekg-read');
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        return [await readEkgSnapshot(getOrgPg().sql, activeWorkspaceId())];
      } catch (err) {
        // 42P01 (undefined table) = migration 251 not applied yet — the
        // expected pre-boot-apply state, not worth a warn.
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.ekg] ekg read failed:', err instanceof Error ? err.message : err);
        }
        return [degraded(EMPTY_EKG_SNAPSHOT, err)];
      }
    },
  },

  // ── learning.redQueen — the Benchmark view's MTTSH vital sign ──
  //
  // Red Queen drill vitals (self-learning-frontier-2026-06-12 P-031 / FB-20):
  // per-class mean-time-to-self-heal medians (detect → triage → fix), resolve
  // rate, triage accuracy vs planted ground truth, and the zero-leak record,
  // computed over harness_shared.red_queen_drills (migration 255). PG failure
  // OR a not-yet-applied migration degrades to the empty snapshot (the panel
  // renders its no-drills state, never a 500). Returns a 1-element array
  // (client reads data[0]). NOT table-backed — the drill cycle fires
  // notifySyncInvalidate('learning.redQueen') after each run.
  'learning.redQueen': {
    resolve: async () => {
      const { EMPTY_MTTSH_VITALS } = await import('../red-queen/mttsh');
      try {
        const { readMttshVitalsSnapshot } = await import('../red-queen/store');
        const { getOrgPg } = await import('@papercusp/db-org');
        return [await readMttshVitalsSnapshot(getOrgPg().sql)];
      } catch (err) {
        // 42P01 (undefined table) = migration 255 not applied yet — the
        // expected pre-boot-apply state, not worth a warn.
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.redQueen] vitals read failed:', err instanceof Error ? err.message : err);
        }
        return [degraded(EMPTY_MTTSH_VITALS, err)];
      }
    },
  },

  // ── p2p.* — the P2P work-sharing settings surface (p2p-work-distribution P-002) ──
  //
  // `p2p.settings` is a workspace-singleton (client subscribes with NO args → the
  // p2p-settings-set write route emits NAME-ONLY notifySyncInvalidate('p2p.settings')).
  // Degrades to the baked (structurally inert) defaults on any read failure — the
  // settings page renders, never a 500 — but provenance makes the stand-in
  // distinguishable from an observed CLEAR state.
  'p2p.settings': {
    resolve: async () => {
      const store = await import('../p2p/settings');
      try {
        return [await store.readP2pSettings()];
      } catch (err) {
        console.warn('[p2p.settings] read failed:', err instanceof Error ? err.message : String(err));
        const { activeWorkspaceId } = await import('../workspace-registry');
        const baked = store.bakedP2pDefaults();
        return [
          degraded({
            workspaceId: activeWorkspaceId(),
            baked,
            defaultLayer: null,
            overrideLayer: null,
            effective: baked,
          }, err),
        ];
      }
    },
  },

  // `remoteAccess.overview` — Settings → Remote access (external-app-access P-010, D-025): ONE row
  // with the workspace's switch, every live phone / app key / service key of the workspace (with
  // creator, last use and state, R-26 / D-007), and the install's own-tunnel route + health
  // (P-009). The screen's writes (routes/remote-access, /connected-apps/rotate) invalidate it.
  'remoteAccess.overview': {
    backingTables: ['harness_shared.connected_apps', 'harness_shared.connected_app_access_settings'],
    argsSchema: z.object({ workspaceId: z.string().trim().min(1).max(200).default('default') }),
    resolve: async (args) => {
      const { workspaceId } = args as { workspaceId: string };
      const { getRemoteAccess, listRemoteAccessEntries } = await import('../connected-apps/remote-access');
      const [remoteAccess, entries] = await Promise.all([getRemoteAccess(workspaceId), listRemoteAccessEntries(workspaceId)]);
      let ownTunnel: unknown = null;
      let ownTunnelError: string | null = null;
      try {
        const { ownTunnelStatus } = await import('../own-tunnel/service');
        ownTunnel = await ownTunnelStatus();
      } catch (err) {
        ownTunnelError = err instanceof Error ? err.message : String(err);
      }
      return [{ workspaceId, remoteAccess, entries, ownTunnel, ownTunnelError }];
    },
  },

  // `p2p.devices` — the Identity & devices section (P-002): the LOCAL actor
  // identity (github user + device pubkey) plus, per hive membership, each
  // attested device and whether THIS device is missing from a hive's
  // attestations. Discriminated rows: one {kind:'identity'} row (always first;
  // null fields = identity unresolved → the page shows RED, never silence),
  // then {kind:'device'} rows, then a {kind:'missing'} row per hive where the
  // local device has no live attestation (grants resolve ONLY through attested
  // devices — P-001/X9 — so "missing" means P2P-inert on that hive).
  'p2p.devices': {
    // EI-19304902443341820: the device/member roster reads this table but was not in its
    // invalidation list, so a device joining or leaving never pushed. Mapping added.
    backingTables: ['harness_shared.pot_members'],
    resolve: async () => {
      const rows: unknown[] = [];
      try {
        const { resolveUsageActor } = await import('../harness/usage-actor');
        const actor = await resolveUsageActor();
        rows.push({
          kind: 'identity',
          githubUserId: actor?.githubUserId ?? null,
          devicePubkey: actor?.devicePubkey ?? null,
        });
        if (!actor) return rows;

        const { getOrgPg } = await import('@papercusp/db-org');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { sql } = getOrgPg();
        const members = (await sql`
          SELECT pot_home_slug, device_attestations, revoked_pubkeys
            FROM harness_shared.pot_members
           WHERE workspace_id = ${activeWorkspaceId()}
             AND github_user_id = ${actor.githubUserId}
           ORDER BY pot_home_slug`) as unknown as Array<{
          pot_home_slug: string;
          device_attestations: unknown;
          revoked_pubkeys: unknown;
        }>;
        for (const m of members) {
          const atts = Array.isArray(m.device_attestations)
            ? (m.device_attestations as Array<Record<string, unknown>>)
            : [];
          const revoked = new Set(Array.isArray(m.revoked_pubkeys) ? (m.revoked_pubkeys as string[]) : []);
          let thisDeviceLive = false;
          for (const a of atts) {
            const pubkey = typeof a.device_pubkey === 'string' ? a.device_pubkey : '';
            const isRevoked = revoked.has(pubkey);
            const isThisDevice = pubkey === actor.devicePubkey;
            if (isThisDevice && !isRevoked) thisDeviceLive = true;
            rows.push({
              kind: 'device',
              potHomeSlug: m.pot_home_slug,
              devicePubkey: pubkey,
              deviceLabel: typeof a.device_label === 'string' ? a.device_label : null,
              attestedAtMs: typeof a.created_at === 'number' ? a.created_at : null,
              gistUrl: typeof a.gist_url === 'string' ? a.gist_url : null,
              revoked: isRevoked,
              isThisDevice,
            });
          }
          if (!thisDeviceLive) {
            rows.push({ kind: 'missing', potHomeSlug: m.pot_home_slug });
          }
        }
        return rows;
      } catch (err) {
        console.warn('[p2p.devices] read failed:', err instanceof Error ? err.message : String(err));
        // A backend failure is not the same claim as a genuinely unresolved
        // identity. Emit a non-domain sentinel so the client can say UNKNOWN.
        return [degraded({ kind: 'unavailable' as const }, err)];
      }
    },
  },

  // `p2p.grants` — the Peers capability matrix (P-002 UI over Lane A's P-001
  // grant store). Hive-scoped (grants federate per hive home slug); includes
  // revoked rows so the matrix can show revocation state — the client filters.
  // Writes go through the p2p-grant-set loopback route, which re-invalidates
  // with the SAME {potSlug} args (args-scoped subscription → args-scoped emit).
  'p2p.grants': {
    argsSchema: z.object({ potSlug: z.string().min(1).max(120) }),
    resolve: async (args) => {
      const { potSlug } = args as { potSlug: string };
      try {
        const { listPeerGrants } = await import('../p2p/grant-store');
        const { activeWorkspaceId } = await import('../workspace-registry');
        return await listPeerGrants({ workspaceId: activeWorkspaceId(), potSlug, includeRevoked: true });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && code !== '42703' && !/does not exist/i.test(msg)) {
          console.warn('[p2p.grants] read failed:', msg);
        }
        return [degraded({ kind: 'unavailable' as const }, err)];
      }
    },
  },

  // `p2p.allotments` — the /res Resources board (P-201): every resource
  // allotment in this workspace — a host handing its account pools (remote axis)
  // + local GPUs (local axis) to the fleets in its hive tree, each with a share
  // cap. LOCAL/per-machine (M19), so workspace-scoped via activeWorkspaceId()
  // (NOT hive-federated like p2p.grants). No args → the board reads the whole
  // workspace; includePaused so it can render the Contributing/Paused control,
  // and the client groups rows by fleet + resourceKind. Writes go through the
  // res-allotment-set loopback route, which re-invalidates this NAME (name-only
  // emit, like p2p.settings).
  'p2p.allotments': {
    resolve: async () => {
      try {
        const { listResourceAllotments } = await import('../p2p/resource-allotments');
        const { activeWorkspaceId } = await import('../workspace-registry');
        return await listResourceAllotments({ workspaceId: activeWorkspaceId(), includePaused: true });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && code !== '42703' && !/does not exist/i.test(msg)) {
          console.warn('[p2p.allotments] read failed:', msg);
        }
        return []; // pre-migration-473 degrades to the empty board, never a 500
      }
    },
  },

  // `p2p.foreignWorkspaces` — the Settings page's host-local lifecycle view
  // (P-510). The source record deliberately contains filesystem paths and
  // executor/provisioning internals; this public sync query projects only the
  // identity and lifecycle fields the owner surface renders. A resolver error
  // propagates so the client can distinguish unavailable from a genuine empty
  // registry. Raw writes refresh the open page through the shared table trigger
  // and TABLE_TO_QUERY_NAMES bridge.
  'p2p.foreignWorkspaces': {
    backingTables: ['harness_shared.p2p_foreign_workspaces'],
    resolve: async () => {
      const [{ listForeignWorkspaces }, { activeWorkspaceId }] = await Promise.all([
        import('../p2p/foreign-workspaces'),
        import('../workspace-registry'),
      ]);
      const rows = await listForeignWorkspaces(activeWorkspaceId());
      return rows.map(({ workspaceId, offerId, fleetSlug, sessionId, state, parkReason, updatedAt }) => ({
        workspaceId,
        offerId,
        fleetSlug,
        sessionId,
        state,
        parkReason,
        updatedAt,
      }));
    },
  },

  // `hive.workspaceScope` — pot-seat-pools-prose-ux-2026-07-18 P-002: tells the
  // /res board whether THIS workspace ("pot") has exactly one shared Hive it
  // can publish a pot-scoped seat offer into (resource:delegate { potSlug, … }
  // requires potSlug to be one of the workspace's real shared hives — see
  // offer-store-publish.ts's disambiguator check). Mirrors the same
  // resolveWorkspaceHiveScope the routing-gate kickoff (P-007/P-013,
  // remote-seat-inventory.ts) uses for "is the plan's pot shared" — a single
  // no-arg read so the client never re-derives hive membership itself.
  // Single-row array (like other workspace-scalar queries): { kind, homeSlug,
  // candidates }. Fail-soft: any resolution error degrades to kind:'none' (the
  // pot-wide affordance just hides) rather than a 500.
  'hive.workspaceScope': {
    resolve: async () => {
      try {
        const { resolveWorkspaceHiveScope } = await import('../agent-tools/coordination/federation-scope');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const ws = activeWorkspaceId();
        if (!ws) return [{ kind: 'none', homeSlug: null, candidates: [] }];
        const scope = await resolveWorkspaceHiveScope(ws);
        if (scope.kind === 'one') {
          return [{ kind: 'one', homeSlug: scope.homeSlug, candidates: [scope.homeSlug] }];
        }
        if (scope.kind === 'many') {
          return [{ kind: 'many', homeSlug: null, candidates: scope.candidates }];
        }
        return [{ kind: 'none', homeSlug: null, candidates: [] }];
      } catch (err) {
        console.warn('[hive.workspaceScope] read failed:', err instanceof Error ? err.message : String(err));
        return [{ kind: 'none', homeSlug: null, candidates: [] }];
      }
    },
  },

  // `fleets.byWorkspace` — the /res Resources board's fleet column: this
  // workspace's persisted named fleets (agent_fleets, mig 417), newest first.
  // FLAT — fleets are workspace-scoped with NO hive nesting in the data model
  // (agent_fleets has no hive_slug/parent), so the /res tree renders the real,
  // currently single-level structure; cross-hive nesting fills in only as
  // federation (P-301) lands. No args → server-side activeWorkspaceId(). Fleet
  // create/delete/meta writes should notifySyncInvalidate('fleets.byWorkspace')
  // for a live board.
  'fleets.byWorkspace': {
    resolve: async () => {
      try {
        const { listFleets } = await import('../agent-fleets-store');
        const { activeWorkspaceId } = await import('../workspace-registry');
        return await listFleets(activeWorkspaceId());
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && code !== '42703' && !/does not exist/i.test(msg)) {
          console.warn('[fleets.byWorkspace] read failed:', msg);
        }
        return []; // degrade to an empty board rather than 500 the page
      }
    },
  },

  // `p2p.audit` — the P-002 Audit section: p2p:*-prefixed audit_log rows
  // (kill-switch flips + starter-profile applies now; grant changes + refusal
  // receipts join as P-001/P-004 land — same prefix convention).
  'p2p.audit': {
    argsSchema: z.object({ limit: z.number().int().positive().max(200).default(50) }),
    resolve: async (args) => {
      const { limit } = args as { limit: number };
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { sql } = getOrgPg();
        return (await sql`
          SELECT id, ts, actor, action, subject, details
            FROM harness_shared.audit_log
           WHERE workspace_id = ${activeWorkspaceId()}
             AND action LIKE 'p2p:%'
           ORDER BY ts DESC
           LIMIT ${limit}`) as unknown as unknown[];
      } catch (err) {
        console.warn('[p2p.audit] read failed:', err instanceof Error ? err.message : String(err));
        return [degraded({ kind: 'unavailable' as const }, err)];
      }
    },
  },

  // ── trust.list — the owner's LOCAL trusted-GitHub-user list ──
  //
  // The trust list (listTrustedUsers, ws-scoped D-004) the /settings/trust owner surface renders +
  // the admission gate (work-items-admission.ts) consults so a VERIFIED trusted author's remote work
  // auto-runs (shared-hive-trust-admission-2026-06-14 Phase 4 / P-011, Trust A4). Returns the flat
  // TrustedUser[] (client reads `data` as the array). NOT table-backed — the trust-set write route
  // fires notifySyncInvalidate('trust.list'). A not-yet-applied migration (276) degrades to [] — the
  // page renders its empty state, never a 500.
  'trust.list': {
    resolve: async () => {
      const { listTrustedUsers } = await import('../trust/user-trust-list');
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        return await listTrustedUsers(activeWorkspaceId());
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && code !== '42703' && !/does not exist/i.test(msg)) {
          console.warn('[trust.list] read failed:', msg);
        }
        return [];
      }
    },
  },

  // ── consult.expertRouting — the consult expert-routing owner surface ──
  //
  // The two knobs /settings/expert-routing edits (consult-expert-routing-2026-09-22
  // P-006): the RANKED allowlist of models allowed to ANSWER a consult (D-004,
  // order IS the walk order) and the stage-2 recency half-life (D-001 §2).
  // Workspace-singleton — the client subscribes with NO args, so the
  // consult-expert-routing-set write route emits a NAME-ONLY
  // notifySyncInvalidate('consult.expertRouting'). Returns a 1-element array
  // (client reads data[0]).
  //
  // NOT table-backed: until migration 1202 is armed the row's table does not
  // exist, and readConsultExpertRoutingSettings is total by design — it degrades
  // to the owner-stated seed rather than throwing, because it also sits on the
  // consult dispatch critical path. So this entry needs no catch of its own and
  // there is no degraded() branch to render: a pre-1202 box is a usable default
  // state, not a fault.
  //
  // `bounds` and `defaults` ride along so the page renders the half-life limits
  // and the "same as the default policy" hint from the module that OWNS them
  // rather than re-declaring 0.5/365 and the seed order in client code.
  'consult.expertRouting': {
    backingTables: ['harness_shared.operator_consult_expert_routing'],
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const {
        readConsultExpertRoutingSettings,
        seedConsultExpertRoutingSettings,
        MIN_RECENCY_HALF_LIFE_DAYS,
        MAX_RECENCY_HALF_LIFE_DAYS,
      } = await import('../consult/expert-routing-settings');
      const settings = await readConsultExpertRoutingSettings(activeWorkspaceId());
      return [
        {
          ...settings,
          bounds: {
            minRecencyHalfLifeDays: MIN_RECENCY_HALF_LIFE_DAYS,
            maxRecencyHalfLifeDays: MAX_RECENCY_HALF_LIFE_DAYS,
          },
          defaults: seedConsultExpertRoutingSettings(),
        },
      ];
    },
  },

  // ── learning.scout — the Learning tab's Scout view (learning-system-audit P-042) ──
  //
  // Routed-ideas-by-rail over scout_routed_ideas (migration 194) + the newest
  // scout_ticks row IF that table exists (P-034 lands it separately; the reader
  // omits the tick half on undefined-table). Whole-read PG failure degrades to
  // the empty snapshot — the tab renders "Scout has not routed ideas yet", never
  // a 500. Returns a 1-element array (client reads data[0]). NOT table-backed —
  // refreshes on mount + the panel's manual `invalidate()`.
  // `cycleId` (WI-5417): selects which of the newest ~10 scout_digest_snapshots
  // rows ships full digest entries — the Signals view's browseable per-cycle
  // history (nuqs `?sdig=`). Omitted/not-found falls back to the newest cycle.
  // learning.scoutDrafts — the Improvements view's Drafts-in-iteration read
  // (owner ask 2026-07-19 moved the section out of Ideas): rail='plan' routed
  // ideas joined to their draft plans. A THIN dedicated read — never make the
  // Improvements view pay for the full learning.scout snapshot.
  // WI-6385: pot-scoped like its sibling legs. This resolver used to take no
  // args at all, so the Improvements view rendered two pot-scoped reads beside
  // this workspace-wide one and nothing on screen distinguished them.
  'learning.scoutDrafts': {
    backingTables: ['harness_shared.scout_routed_ideas', 'harness_shared.harness_plans'] as const,
    argsSchema: z.object({ hive: z.string().max(120).optional() }).optional(),
    resolve: async (args) => {
      const { hive } = (args ?? {}) as { hive?: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readScoutDraftIterations } = await import('./learning-scout-read');
      try {
        const ws = activeWorkspaceId();
        // Same member-slug resolution as learning.scout — a pot's rows are its
        // member harnesses' rows (P-005), not just the home slug's.
        const memberSlugs = hive ? await resolveHiveMemberSlugs(hive, ws) : null;
        // WI-6395: ENVELOPED. This is one of only two genuinely flat-array
        // `learning.*` reads, and a flat array has nowhere to hang provenance —
        // a failed read and "no drafts in iteration" were the same `[]`. Wrapping
        // in a 1-element `{ items }` object is not a new convention: it is the
        // shape the other 13 learning.* resolvers already use, so `unavailable`
        // means the same thing everywhere rather than this read inventing a
        // second mechanism (WI-6382).
        const items = await routeWithWorkspace(async (tx) =>
          readScoutDraftIterations({
            workspaceId: ws,
            sql: tx,
            hive: hive ?? null,
            hiveMemberSlugs: memberSlugs,
          }),
        );
        return [{ items }];
      } catch (err) {
        console.warn('[learning.scoutDrafts] read failed:', err instanceof Error ? err.message : err);
        return [degraded({ items: [] }, err)];
      }
    },
  },

  'learning.scout': {
    argsSchema: z.object({ cycleId: z.string().optional(), hive: z.string().max(120).optional() }).optional(),
    resolve: async (args) => {
      const { cycleId, hive } = (args ?? {}) as { cycleId?: string; hive?: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readScoutSnapshot } = await import('./learning-scout-read');
      try {
        const ws = activeWorkspaceId();
        // Pot lens (P-005): the routed-ideas legs scope by member-harness slugs
        // (the learning.improvements pattern); the tick leg scopes by pot_slug.
        const memberSlugs = hive ? await resolveHiveMemberSlugs(hive, ws) : null;
        return await routeWithWorkspace(async (tx) => [
          await readScoutSnapshot(tx, ws, {
            selectedCycleId: cycleId ?? null,
            hive: hive ?? null,
            hiveMemberSlugs: memberSlugs,
          }),
        ]);
      } catch (err) {
        console.warn('[learning.scout] scout read failed:', err instanceof Error ? err.message : err);
        return [
          {
            totalRouted: 0,
            railCounts: [],
            recent: [],
            lastTick: null,
            ticks: [],
            health: { status: 'neutral', markers: [] },
            lensWeights: null,
            groundingTitles: {},
            cadence: null,
            drafts: [],
            digest: null,
            digestHistory: [],
          },
        ];
      }
    },
  },

  // ── learning.analyze — the Learning tab's Analyze stage (learning-tab-
  // visibility-2026-07-18 P-009 / D-001). Per fired cycle, the pipeline's
  // INTERMEDIATE artifacts (migration 623: per-ideator ideas, critique
  // verdicts, debate/recombine fusions, ideator slot outcomes) joined to the
  // cycle's scout_ticks economics + routed-ledger rows by cycle_id.
  // 42P01-tolerant — a substrate without the migration renders the
  // explain-empty state, never a 500. Returns a 1-element array (client reads
  // data[0]). Push-backed by the artifact row and both enrichment ledgers (WI-6182).
  'learning.analyze': {
    backingTables: [
      'harness_shared.scout_cycle_stage_artifacts',
      'harness_shared.scout_ticks',
      'harness_shared.scout_routed_ideas',
    ] as const,
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readAnalyzeSnapshot } = await import('./learning-analyze-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => [await readAnalyzeSnapshot(tx, ws)]);
      } catch (err) {
        console.warn('[learning.analyze] analyze read failed:', err instanceof Error ? err.message : err);
        return [degraded({ cycles: [], generatedAt: new Date().toISOString() }, err)];
      }
    },
  },

  // learning.analyzeCycle — the ON-DEMAND single-cycle detail (P-007,
  // precompute-sync-reads-phase2). learning.analyze now ships only collapsed
  // cycle SUMMARIES (counts + verdicts + spend); this serves the FULL stage
  // artifacts (ideas / scored / proposals / ideator slots) for the ONE cycle
  // whose Analyze disclosure is expanded. Returns a 0-or-1-element array.
  'learning.analyzeCycle': {
    backingTables: [
      'harness_shared.scout_cycle_stage_artifacts',
      'harness_shared.scout_ticks',
      'harness_shared.scout_routed_ideas',
    ] as const,
    argsSchema: z.object({ cycleId: z.string().min(1) }),
    resolve: async (args) => {
      const { cycleId } = args as { cycleId: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readAnalyzeCycle } = await import('./learning-analyze-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => {
          const cycle = await readAnalyzeCycle(tx, ws, cycleId);
          return cycle ? [cycle] : [];
        });
      } catch (err) {
        // WI-6395: this one was NOT the "confident empty list" defect the item
        // was filed for — it was worse. The consumer renders `!cycle` as
        // "Loading cycle artifacts…", so a FAILED read left a spinner running
        // forever: the reader waits indefinitely for something that already
        // failed, with no error, no retry, and nothing in the UI that will ever
        // change. Its success shape is `[cycle]`, so it has somewhere to carry
        // provenance and needs no envelope — just say the read failed.
        console.warn('[learning.analyzeCycle] read failed:', err instanceof Error ? err.message : err);
        return [degraded({}, err)];
      }
    },
  },

  // ── learning.frontier — the Learning tab's Frontier lane-status grid
  // (learning-tab-visibility-2026-07-18 P-003/P-004). One row per workspace-
  // singleton learning loop: liveness from the SAME shared reader
  // improvements:learning_loops uses, the lane's flag gate, and the FB-01
  // governor registration (read-only). Whole-read failure degrades to the
  // empty snapshot, never a 500. Returns a 1-element array (client reads
  // data[0]).
  'learning.frontier': {
    backingTables: [
      'harness_shared.routines',
      'harness_shared.scout_ticks',
      'harness_shared.learning_governor_loops',
      'harness_shared.calibration_predictions',
      'harness_shared.regret_findings',
      'harness_shared.transfer_lessons',
      'harness_shared.prompt_ablation_runs',
    ] as const,
    argsSchema: z.object({ hive: z.string().max(120).optional() }).optional(),
    resolve: async (args) => {
      const { hive } = (args ?? {}) as { hive?: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readFrontierSnapshot } = await import('./learning-frontier-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => [await readFrontierSnapshot(tx, ws, { hive: hive ?? null })]);
      } catch (err) {
        console.warn('[learning.frontier] frontier read failed:', err instanceof Error ? err.message : err);
        return [degraded({ lanes: [], unmatchedGovernor: [], generatedAt: new Date().toISOString() }, err)];
      }
    },
  },

  // ── learning.experiments — the experiment_runs scoreboard (experiment-registry-
  // invocation-api P-051). Returns recent runs (flat array), RLS-scoped via
  // routeWithWorkspace; degrades to [] before the migration applies (42P01).
  'learning.experiments': {
    argsSchema: z.object({
      testId: z.string().optional(),
      limit: clampedLimitOpt(200),
    }),
    resolve: async (args) => {
      const a = (args ?? {}) as { testId?: string; limit?: number };
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { routeWithWorkspace } = await import('../route-workspace');
        const { PgExperimentLedger } = await import('../experiment/ledger');
        const ws = activeWorkspaceId();
        // WI-6395: ENVELOPED — see learning.scoutDrafts for the rationale. The
        // pre-migration case matters most here: this read is explicitly expected
        // to fail with 42P01 on an install that has not applied the experiment
        // tables yet, and it stayed SILENT about it (the warn is suppressed for
        // exactly that code). "The experiment registry isn't installed" then
        // rendered as "no experiments have run", which is a different statement
        // about the system and sends the reader somewhere else entirely.
        const items = await routeWithWorkspace(async (tx) =>
          new PgExperimentLedger(tx).listRecent(ws, { testId: a.testId, limit: a.limit ?? 20 }),
        );
        return [{ items }];
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.experiments] read failed:', err instanceof Error ? err.message : err);
        }
        return [degraded({ items: [] }, err)];
      }
    },
  },

  // ── learning.hiveThroughput — Queen-loop throughput metrics (B-11 / P-050) ──
  //
  // Per-hive throughput ticks (migration 261): latest metric cards + a recent
  // trend window + the operating-well verdict, for the Learning tab's
  // "Throughput" sub-view. Best-effort: a pre-migration substrate / read failure
  // degrades to the empty snapshot (the tab shows "no throughput recorded yet"),
  // never a 500. Pushed by recordHiveThroughputTick (the 30s routinesTick edge).
  // Returns a 1-element array (client reads data[0]).
  'learning.hiveThroughput': {
    argsSchema: z.object({ hive: z.string().max(120).optional() }),
    resolve: async (args) => {
      const hive = typeof (args as { hive?: unknown })?.hive === 'string' ? (args as { hive: string }).hive : undefined;
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readHiveThroughputSnapshot } = await import('./learning-hive-throughput-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => [
          await readHiveThroughputSnapshot(tx, ws, hive ? { potSlug: hive } : {}),
        ]);
      } catch (err) {
        console.warn('[learning.hiveThroughput] read failed:', err instanceof Error ? err.message : err);
        return [degraded({ hives: [] }, err)];
      }
    },
  },

  // ── learning.soakReport — machine-checkable production-readiness gate (WI-1501) ──
  //
  // One hive-soak verdict per hive: READY only when the rolling 12–24h window stays
  // healthy across bg-host stability, infra curses, bee/queen/overwatch turn success,
  // escalation backlog, green-checkpoint ratio, and deploy latency. Derived on demand
  // from existing durable signals + the local bg-host journal. Returns a 1-element array
  // (client reads data[0]). Fail-soft: an individual hive read failure is omitted rather
  // than taking the whole panel down.
  'learning.soakReport': {
    // Plain SELECT against the derived-reads precompute substrate. Declared so the guard can see
    // the chain; PUSH_EXEMPT there records that the PRODUCER pushes (notifySyncInvalidate on a
    // real payload change) rather than a table trigger — a strictly better signal.
    backingTables: ['harness_shared.derived_read_snapshots'],
    argsSchema: z.object({
      hive: z.string().max(120).optional(),
      windowHours: z.number().int().min(12).max(24).optional(),
    }),
    // PRECOMPUTED (P-005) — the audit's worst offender at 27.3s. The journal read
    // is host-global but sat inside this per-pot fan-out, so ~12 hives meant ~24
    // concurrent journalctl scans of a 1.2GB journal per Learnings-tab load.
    //
    // The Learnings tab calls this with `args: {}`, which the precompute covers.
    // A hive/windowHours DRILL-DOWN is off the panel path: a hive filter is served
    // from the snapshot (same data, just narrowed), while an explicit non-default
    // windowHours must be computed live because the snapshot holds the default
    // window and serving it under a different label would be silently wrong.
    resolve: async (args) => {
      const hive = typeof (args as { hive?: unknown })?.hive === 'string' ? (args as { hive: string }).hive : undefined;
      const windowHours =
        typeof (args as { windowHours?: unknown })?.windowHours === 'number'
          ? (args as { windowHours: number }).windowHours
          : undefined;
      if (windowHours === undefined) {
        try {
          const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
          await import('../derived-reads/producers');
          const rows = await readDerivedSnapshotRows<{ hives?: unknown[] }>('learning.soakReport');
          const all = (rows[0]?.hives ?? []) as Array<{ potSlug?: string }>;
          return [{ ...rows[0], hives: hive ? all.filter((r) => r?.potSlug === hive) : all }];
        } catch (err) {
          console.warn('[learning.soakReport] snapshot read failed:', err instanceof Error ? err.message : err);
          return [degraded({ hives: [] }, err)];
        }
      }
      // VARIABLE-ARITY fan-out (WI-39849): the leg count is `homes.length`, so the
      // exposure GROWS with the workspace. One deadline shared by the listPots leg
      // and every per-home soak read — each keeps its own existing fallback, so a
      // lapsed budget degrades that home to null instead of hanging the panel.
      const withinBudget = createReadDeadline(RESOLVER_FANOUT_BUDGET_MS);
      try {
        const { listPots } = await import('../agent-tools/pot/_resolve');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { readPotSoakReport } = await import('../pot/soak-report');
        const ws = activeWorkspaceId();
        const homes = hive ? [{ slug: hive }] : await withinBudget(listPots(ws), 'soakReport listPots').catch(() => []);
        const reports = (
          await Promise.all(
            homes.map(async (home) => {
              try {
                return await withinBudget(readPotSoakReport(home.slug, { windowHours }), `soakReport ${home.slug}`);
              } catch {
                return null;
              }
            }),
          )
        ).filter((report): report is NonNullable<typeof report> => report != null);
        return [{ hives: reports }];
      } catch (err) {
        console.warn('[learning.soakReport] read failed:', err instanceof Error ? err.message : err);
        return [degraded({ hives: [] }, err)];
      }
    },
  },

  // ── learning.hive — one hive's shared learnings pool (knowledge-packs P-008) ──
  //
  // Rows + per-pack rollups + organic count for `hive:<args.hive>`, pack
  // provenance annotated (pristine/modified vs the resolvable pack). Returns a
  // 1-element array (client reads data[0]); store-unreachable degrades to the
  // `unavailable` snapshot, never a 500. Invalidated by seed/install/uninstall
  // (`learning.hive`) + the generic memory mutations fire `userMemory.list`,
  // so the view also refreshes on its manual reload.
  'learning.hive': {
    argsSchema: z.object({ hive: z.string().max(120).optional() }),
    resolve: async (args) => {
      const hive = typeof (args as { hive?: unknown })?.hive === 'string' ? (args as { hive: string }).hive : '';
      // WI-6384: '' is the "All Pots" lens, NOT "no data". It used to return a
      // hard-coded empty snapshot here, so the broadest selection rendered the
      // emptiest view beside a workspace-wide count strip.
      const { readHiveLearnings } = await import('./learning-hive-read');
      const { getMemoryBackend } = await import('../memory/backend');
      const { loadKnowledgePack, listKnowledgePacks } = await import('../knowledge-packs/load-packs');
      const snap = await readHiveLearnings(hive, {
        listPool: async (scope) => {
          const backend = getMemoryBackend();
          const avail = await backend.available();
          if (!avail.ok) throw new Error(avail.reason);
          return backend.list({ scope });
        },
        loadPack: (id) => loadKnowledgePack(id),
        listPotSlugs: async () => {
          const { listPots } = await import('../agent-tools/pot/_resolve');
          const { activeWorkspaceId } = await import('../workspace-registry');
          return (await listPots(activeWorkspaceId())).map((p) => p.slug);
        },
      });
      // Decorate the rollups with enabled state (P-009) + adoptable-version
      // info (P-013) — best-effort; the bare snapshot still renders.
      try {
        const [{ disabledPacksFor }, { activeWorkspaceId }, { semverGt }, catalog] = await Promise.all([
          import('../knowledge-packs/manage'),
          import('../workspace-registry'),
          import('../knowledge-packs/pack-format'),
          listKnowledgePacks(),
        ]);
        // Pack enablement is a PER-POT setting, so it has no meaning under the
        // All Pots rollup — leave `enabled` undefined there rather than assert a
        // single pot's answer over every pot's rows (WI-6384). Version
        // adoptability is pack-global and stays correct either way.
        const disabled = hive ? new Set(await disabledPacksFor(activeWorkspaceId(), hive)) : null;
        for (const p of snap.packs) {
          if (disabled) p.enabled = !disabled.has(p.packId);
          const avail = catalog.find((c) => c.id === p.packId);
          if (avail) {
            p.availableVersion = avail.version;
            p.updateAvailable = semverGt(avail.version, p.packVersion);
          }
        }
      } catch {
        /* decoration only */
      }
      return [snap];
    },
  },

  // ── learning.hiveList — the workspace's hives for the Learnings view picker ──
  //
  // kind:'hive' registry entries (slug only — display strings resolve client
  // side). Cheap operator-state read; failure degrades to [].
  'learning.hiveList': {
    resolve: async () => {
      try {
        const { loadHarnessRegistry } = await import('../harness-registry');
        const reg = await loadHarnessRegistry();
        return reg.projects
          .filter((p) => p.harness_kind === 'hive')
          .map((p) => ({ slug: p.slug, remote: p.remote_hive === true }));
      } catch (err) {
        console.warn('[learning.hiveList] registry read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── hive.overrides — a hive's per-instance customization (domain-generic-hive-architecture-2026-06-18 P-015) ──
  //
  // The settings-resident, FEDERATED per-hive override surface: the PROSE role-prompt
  // overrides (`promptOverride.<role>` — D-007) AND the STRUCTURED config deltas
  // (`localBlueprint.<section>`, e.g. a ScoutConfigOverride — D-005). Returned as a flat
  // row array (the resolver contract): one row per SET override, `kind` distinguishing
  // prompt vs config, so the /settings/pot-customization editors can reconstruct both
  // maps. The loopback write routes (hive-prompt-override-set / hive-config-set)
  // invalidate this by name. Scoped to the hive's HOME slug (the hive_settings scope
  // column); an unknown/empty hive degrades to [] (never a 500 — the picker shows the
  // empty state).
  'hive.overrides': {
    argsSchema: z.object({ potSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { potSlug, workspaceId } = args as { potSlug: string; workspaceId?: string };
      try {
        const [{ activeWorkspaceId }, { listHiveInstancePromptOverrides, listHiveLocalBlueprintConfig }] =
          await Promise.all([import('../workspace-registry'), import('../hive-settings-store')]);
        const ws = workspaceId ?? activeWorkspaceId();
        // BOUNDED (WI-39825). Both legs build the SAME row list, so neither is
        // supplementary and a lapse propagates — into this resolver's own outer
        // catch, which already degrades the whole read to `[]` with a warn. That
        // makes the deadline a strict upgrade: the pre-bound version could hang
        // instead, and a hang reaches neither the catch nor the log.
        const withinBudget = createReadDeadline(RESOLVER_FANOUT_BUDGET_MS);
        const [prompts, config] = await Promise.all([
          withinBudget(listHiveInstancePromptOverrides(ws, potSlug), 'hive.overrides prompts'),
          withinBudget(listHiveLocalBlueprintConfig(ws, potSlug), 'hive.overrides config'),
        ]);
        const rows: Array<{ kind: 'prompt' | 'config'; name: string; value: unknown }> = [];
        for (const [role, md] of Object.entries(prompts)) rows.push({ kind: 'prompt', name: role, value: md });
        for (const [section, val] of Object.entries(config)) rows.push({ kind: 'config', name: section, value: val });
        return rows;
      } catch (err) {
        console.warn('[hive.overrides] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── knowledgePacks.list — the pack catalog (learning-packs-2026-06-11 P-006) ──
  //
  // Resolvable knowledge packs across the builtin + installed roots (builtin
  // wins on id clash). Backs the creation-flow pack picker and the Learning
  // tab's pack management. Rows flat (one per pack); a read failure degrades
  // to [] — the picker falls back to its default-only option, never a 500.
  // NOT table-backed (FS read); installs/uninstalls fire `learning.hive`
  // + this name explicitly.
  'knowledgePacks.list': {
    resolve: async () => {
      try {
        const { listKnowledgePacks } = await import('../knowledge-packs/load-packs');
        return await listKnowledgePacks();
      } catch (err) {
        console.warn('[knowledgePacks.list] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── knowledgePacks.candidates — the fleet→pack candidate pool (consume-edges
  // P-032, B-11; auto-adopt reversal WI-5414). Most candidates are decided by
  // the automated review sweep (autoAdoptPendingCandidates) before an owner
  // ever sees them — the Learnings view reads this for the (usually near-empty)
  // still-pending queue AND, with `{ status: 'adopted', decidedBy:
  // AUTO_ADOPT_REVIEWER }`, the recent-auto-adoptions strip. Defaults to
  // status:'pending' when no args are passed (back-compat with the original
  // shape). Stage/decide fire this name explicitly (an adopt also fires
  // knowledgePacks.list + learning.hive — the version bump lights
  // updateAvailable). Read failure degrades to [] — the strip just
  // disappears, never a 500.
  'knowledgePacks.candidates': {
    resolve: async (args) => {
      try {
        const { listKnowledgePackCandidates } = await import('../knowledge-packs/candidates');
        const a = (args ?? {}) as { status?: 'pending' | 'adopted' | 'dismissed'; decidedBy?: string; limit?: number };
        return await listKnowledgePackCandidates({
          status: a.status ?? 'pending',
          ...(a.decidedBy ? { decidedBy: a.decidedBy } : {}),
          ...(a.limit ? { limit: a.limit } : {}),
        });
      } catch (err) {
        console.warn('[knowledgePacks.candidates] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── dev.* — live-ops glances for the dev admin rail ──────────────────
  //
  // (plan dev-admin-sidebar-2026-06-05, P-005..P-008). NOT table-backed, so
  // there's no TABLE_TO_QUERY_NAMES entry — they have no PG-trigger invalidation
  // and refresh only on mount + the panel's manual `invalidate()` (like the
  // `plans.*` reads above, which dispatch a tool rather than read a table).
  // Single-snapshot reads return a 1-element array (client reads data[0]); list
  // reads return the rows flat. DEV-only by construction — the rail that calls
  // them is gated `import.meta.env.DEV` and absent from user builds.

  // dev.serviceHealth — up/down + latency probe of the dev endpoints now.
  'dev.serviceHealth': {
    // Plain SELECT against the derived-reads precompute substrate. Declared so the guard can see
    // the chain; PUSH_EXEMPT there records that the PRODUCER pushes (notifySyncInvalidate on a
    // real payload change) rather than a table trigger — a strictly better signal.
    backingTables: ['harness_shared.derived_read_snapshots'],
    // PRECOMPUTED (WI-5476): probeAll spawned systemctl on the read path. Served
    // from the derived-read snapshot; the 90s producer ttl + 2-min routine keep it
    // near-live, and _meta.derivedRead.computedAt lets the panel show "as of …".
    resolve: async () => {
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      return readDerivedSnapshotRows('dev.serviceHealth');
    },
  },

  // dev.deployState — read-only release-gate snapshot: green :3070's ref vs
  // `ready` vs `main`, how far behind, last deploy time (the #10 antidote).
  'dev.deployState': {
    // Plain SELECT against the derived-reads precompute substrate. Declared so the guard can see
    // the chain; PUSH_EXEMPT there records that the PRODUCER pushes (notifySyncInvalidate on a
    // real payload change) rather than a table trigger — a strictly better signal.
    backingTables: ['harness_shared.derived_read_snapshots'],
    // PRECOMPUTED (WI-5476): devDeployState spawned git (log/rev-list) on the read
    // path. Served from the derived-read snapshot; the pipeline moves slowly so a
    // 5-min snapshot is amply fresh.
    resolve: async () => {
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      return readDerivedSnapshotRows('dev.deployState');
    },
  },

  // dev.gitPipeline — the whole git-sync → green-checkpoint → release pipeline
  // for the /admin Git tab: routine schedule/active, latest git-sync + resolver
  // state, any OPEN merge conflict, windowed history counts (mig 177 pipeline_events),
  // a recent timeline, and the deploy gap. Snapshot wrapped in a 1-element array.
  'dev.gitPipeline': {
    // Plain SELECT against the derived-reads precompute substrate. Declared so the guard can see
    // the chain; PUSH_EXEMPT there records that the PRODUCER pushes (notifySyncInvalidate on a
    // real payload change) rather than a table trigger — a strictly better signal.
    backingTables: ['harness_shared.derived_read_snapshots'],
    // PRECOMPUTED (whole-app-sync-payload-audit P-007): gitPipelineSnapshot() fans
    // out ~6 `git` fork/execs via devDeployState() on the read path (3.1s cold; the
    // GitClient's 30s staleTime > devDeployState's 10s cache TTL made every panel
    // refetch a cold spawn). Served from the derived-read snapshot instead — the git
    // spawn now runs in the background precompute routine, never on the sync read.
    // Direct gitPipelineSnapshot() callers (watchdogs, why-chain, position, tools)
    // still compute live and are untouched.
    resolve: async () => {
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      return readDerivedSnapshotRows('dev.gitPipeline');
    },
  },

  // dev.gitPipelineHives — per-hive-git-and-release-gate P-014: the PER-HIVE rows for the
  // /admin/git surface — every repo-backed coding hive that is green-gated (NOT the
  // operator-home, which has its own full view above). Each row: resolved green command
  // (+ owner-override flag), gate 🟩/🟥 status, staging↔main gap, last green sha, last
  // deploy. Empty until a coding hive with a repo is gated (PER_POT_RELEASE_GATE is
  // default-OFF during rollout — D-008).
  'dev.gitPipelineHives': {
    // Plain SELECT against the derived-reads precompute substrate. Declared so the guard can see
    // the chain; PUSH_EXEMPT there records that the PRODUCER pushes (notifySyncInvalidate on a
    // real payload change) rather than a table trigger — a strictly better signal.
    backingTables: ['harness_shared.derived_read_snapshots'],
    // PRECOMPUTED (WI-5476): gitPipelineHiveRows spawned git per hive on the read
    // path. Served from the derived-read snapshot.
    resolve: async () => {
      const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
      await import('../derived-reads/producers');
      return readDerivedSnapshotRows('dev.gitPipelineHives');
    },
  },

  // dev.pgHealth — pool usage snapshot (total / active / idle + version).
  'dev.pgHealth': {
    resolve: async () => {
      const { pgHealth } = await import('../dev-data');
      return [await pgHealth()];
    },
  },

  // dev.pgActiveQueries — currently-running queries, oldest first (slow /
  // idle-in-transaction wedge detection).
  'dev.pgActiveQueries': {
    argsSchema: z.object({
      limit: clampedLimit(200, 50),
    }),
    resolve: async (args) => {
      const { limit } = args as { limit: number };
      const { pgActiveQueries } = await import('../dev-data');
      const { queries } = await pgActiveQueries(limit);
      return queries;
    },
  },

  // dev.telemetry — per-tool invocation rollup (calls / bytes / latency p50/p95 /
  // repeat-within-spawn) over a window. Powers the Tool-usage tab's hot-tools +
  // batching-waste panels (usage-insights P-003/P-004). Flat scalar-array rows.
  //
  // CACHED (WI-7367, the latency axis opened by no-http-anywhere D-033). This was
  // the slowest sync read in the tree: 2,472-2,567ms measured live on :3070,
  // steady across repeats. It aggregates the whole `hours` window of
  // harness_shared.tool_invocations — 288,924 rows over 24h on a 2.3 GB table —
  // down to 100 rows / 21 KB. The cost is the SCAN and it scales with the window
  // (24h 2.5s · 6h 0.51s · 1h 0.10s), so NO per-row projection can help: the 21 KB
  // output was never the problem. That is what makes this the LATENCY axis rather
  // than the bytes axis every other audit entry in this file is about.
  //
  // The 30s softTtl is not a guess. ToolUsagePanel.tsx declares
  // `staleTime: 30_000` on this exact query, so the sole consumer has already
  // stated it tolerates 30s of staleness — and recomputing a 24-HOUR rollup more
  // often than that cannot change an answer anyone can perceive. Each recompute
  // otherwise drops 2.5s of work into the concurrency gate alongside real user
  // reads, which is what D-001 forbids.
  //
  // DELIBERATELY UN-TAGGED. tool_invocations takes a row on EVERY tool call
  // fleet-wide (~289k/day), so a `tool_invocations` invalidation tag would evict
  // this entry continuously and buy exactly nothing — the same reasoning
  // plans:attention records for its append-heavy coord_event_log sources (the
  // coord:inbox D-006 problem). Bounded by the short SWR softTtl instead.
  // Do NOT "fix" this by adding a tag.
  'dev.telemetry': {
    argsSchema: z.object({
      hours: z.number().int().positive().max(336).default(24),
      limit: clampedLimit(500, 100),
    }),
    resolve: async (args) => {
      const { hours, limit } = args as { hours: number; limit: number };
      const { cachedRead } = await import('../cache');
      const { telemetryRollup } = await import('../dev-data');
      return cachedRead(
        {},
        // `tags: []` is DELIBERATE, not an unfinished line. CachedReadOptions.tags
        // is REQUIRED, and the empty array is how "no ECA dependency, bounded by
        // softTtl alone" is expressed — see the header comment. Do NOT fill it in.
        { tool: 'dev.telemetry', key: { hours, limit }, tags: [], softTtlMs: 30_000 },
        async () => (await telemetryRollup({ workspaceIds: null, hours, limit })).entries,
      );
    },
  },

  // dev.toolFormatAdoption — served-format mix (toon/json/csv/none) on the MCP
  // transport over a window: the token-opt compact-adoption signal (P-002/D-002).
  //
  // CACHED (WI-7368) — same defect and same remedy as dev.telemetry above, and it
  // shares that read's panel, module (../dev-data), table and window. It returns
  // 121 BYTES over 3 rows and still spent 264-274ms doing it, which is the purest
  // statement of the latency axis in the whole surface: there is no payload story
  // available at 121 bytes, so the entire cost is the scan. Confirmed by the same
  // window test as its sibling — 24h 0.274/0.264s vs 1h 0.0206/0.0213s, a 13x
  // spread on an output that barely moves (121 B vs 116 B).
  //
  // Same 30s softTtl for the same stated reason (ToolUsagePanel.tsx declares
  // staleTime: 30_000 on this query too) and same deliberate absence of tags —
  // see the dev.telemetry comment above for why a tool_invocations tag would
  // evict continuously and buy nothing.
  'dev.toolFormatAdoption': {
    argsSchema: z.object({
      hours: z.number().int().positive().max(336).default(24),
    }),
    resolve: async (args) => {
      const { hours } = args as { hours: number };
      const { cachedRead } = await import('../cache');
      const { toolFormatAdoption } = await import('../dev-data');
      return cachedRead(
        {},
        // tags DELIBERATELY EMPTY — same reasoning as dev.telemetry above.
        { tool: 'dev.toolFormatAdoption', key: { hours }, tags: [], softTtlMs: 30_000 },
        async () => (await toolFormatAdoption({ workspaceIds: null, hours })).rows,
      );
    },
  },

  // dev.coordPresence — LIVE coordination agents and their declared intent: who's
  // working on what right now. Filters out stale rows server-side (heartbeat >10
  // min — almost certainly ended): the roster can hold 150+ rows but only a
  // handful are live, and shipping every stale row each refresh is exactly what
  // overflowed coord:presence's token budget (233-row note in presence.ts).
  'dev.coordPresence': {
    argsSchema: z.object({
      workspace: z.string().optional(),
    }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      const { listPresence } = await import('../agent-tools/coordination/presence');
      const records = (await listPresence({ workspaceId: workspace ?? null })) as Array<{
        stale?: boolean;
      }>;
      return records.filter((r) => !r.stale);
    },
  },

  // dev.assignableMembers — the @-assign picker roster (shared-hive-collaboration
  // P-016 / offline-member assign): the LIVE coordination sessions (present,
  // addressed by ownerId — deliver-and-wake now) UNIONed with the workspace's
  // admitted hive members who are NOT currently present (offline, addressed by
  // `@user:gh:<id>`, which PARKS in slot_parked_messages until that member returns).
  // Each row carries a precomputed `assignAddress` (what AssignDialog passes to
  // coord:send's `to`) + `present`, so the dialog labels online vs offline without
  // knowing the `@user:` convention. Deduping an online member OUT of the offline
  // group is best-effort: presence carries no github id today, so the id spaces
  // only converge once gh-auth / federation lights up (actor-identity.ts).
  'dev.assignableMembers': {
    argsSchema: z.object({ workspace: z.string().optional() }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      // BOUNDED + GUARDED in presence-roster-read.ts (WI-39825): two stores fan
      // out here, and a wedged membership read used to take the whole picker
      // past RESOLVER_READ_TIMEOUT_MS — so AssignDialog rendered nothing and you
      // could not assign to ANYONE, including the live sessions already in hand.
      // Presence PROPAGATES on lapse (an empty online list would read as "nobody
      // is running"); the members leg degrades to a NAMED casualty instead of
      // the old swallowing `.catch(() => [])`, which made an empty offline list
      // indistinguishable from "this workspace has no offline members".
      const { readAssignableMembers } = await import('./presence-roster-read');
      const { rows, degradedFields } = await readAssignableMembers({ workspace });
      // Flat-row sync contract, so degradation travels on row[0]._meta. Absent
      // (not empty) on a healthy read — the field's PRESENCE is the signal.
      return degradedFields ? attachListMeta(rows, { degradedFields }) : rows;
    },
  },

  // dev.coordFeed — the WHOLE coordination firehose: every envelope across every
  // channel + every agent (messages/acks/notifies/broadcasts, handoffs,
  // escalations, plan events), newest-first with a cursor. Backs the /adv
  // Conversations "Feed" view. Same observer read as the high-tier coord:feed
  // tool. One row per envelope (the raw envelope + `surface` + `broadcast`); the
  // first row also carries `_meta` (total / by_kind / next_cursor) hidden behind
  // an underscore so the flat-row contract is preserved. The UI reads _meta off
  // row[0]; the rest are envelopes.
  'dev.coordFeed': {
    argsSchema: z.object({
      kinds: z.array(z.string()).optional(),
      owner: z.string().optional(),
      system_only: z.boolean().optional(),
      plan_slug: z.string().optional(),
      q: z.string().optional(),
      since_ts: z.string().optional(),
      before_ts: z.string().optional(),
      limit: clampedLimitOpt(500),
    }),
    resolve: async (args) => {
      const a = (args ?? {}) as {
        kinds?: string[];
        owner?: string;
        system_only?: boolean;
        plan_slug?: string;
        q?: string;
        since_ts?: string;
        before_ts?: string;
        limit?: number;
      };
      const { readCoordFeed } = await import('../agent-tools/coordination/feed');
      const { rows, nextCursor, total, byKind } = await readCoordFeed({
        kinds: a.kinds as never,
        owner: a.owner,
        system_only: a.system_only,
        plan_slug: a.plan_slug,
        q: a.q,
        since_ts: a.since_ts,
        before_ts: a.before_ts,
        limit: a.limit,
      });
      // Carry page metadata on row[0]._meta (flat-row sync contract, no envelope).
      return attachListMeta(rows, { total, byKind, nextCursor });
    },
  },

  // dev.fleetGovernor — the fleet rate/cap snapshot: hard cap vs in-flight vs
  // AIMD-effective concurrency (the second half of the fleet glance, P-008).
  'dev.fleetGovernor': {
    resolve: async () => {
      const { buildFleetRateStatus } = await import('../fleet-rate-status');
      return [await buildFleetRateStatus()];
    },
  },

  // ─── Left sidebar (left-sidebar-tauri-2026-06-07) — the desktop's Hives /
  // Voice / Swarm rail, the SPA twin of the pui dock tabs. ───────────────

  // sidebar.fleetCups — the whole-fleet assignment groups (every agent's ranked
  // work-list + plan-claim slugs + liveness), the same canonical view
  // `fleet:assignments` serves. Backs the Swarm tab's fleet-wide task list and
  // the per-agent dossier filter.
  'sidebar.fleetCups': {
    argsSchema: z.object({ workspace: z.string().optional() }),
    resolve: async (args) => {
      const { workspace } = (args ?? {}) as { workspace?: string };
      const { listFleetAssignments, groupByAgent } = await import('../fleet/assignments');
      const rows = await listFleetAssignments({ workspaceId: workspace ?? null, activeOnly: true });
      return groupByAgent(rows);
    },
  },

  // sidebar.cupMail — one agent's coord inbox + outbox (the observer view the
  // bee-dossier comms section renders; `fleet:cup_mail`'s core, most-recent 50
  // per side). One row: { owner, inbox, outbox }.
  'sidebar.cupMail': {
    // EI-19304902443341820: reads the coord log via readInbox/readOutbox. It was NOT in that
    // table's invalidation list, so a coord message pushed to coord.inbox and dev.coordFeed while
    // this mailbox beside them stayed stale until remount. Mapping added.
    backingTables: ['harness_shared.coord_event_log'],
    argsSchema: z.object({ owner: z.string().min(1).max(200) }),
    resolve: async (args) => {
      const { owner } = args as { owner: string };
      const { readInbox, readOutbox } = await import('../agent-tools/coordination/messages');
      const TAIL = 50;
      // WI-6939: this had the WORST read-to-use ratio of readInbox's call sites — an
      // unbounded read (~20k rows / ~10MB for a typical owner, 99.8% of it BROADCAST
      // and so barely varying with how much mail this owner actually has) to return
      // tail(50). >99% of what it transferred, JSON-parsed and allocated was thrown
      // away. The unbounded readInbox statement measured 491,954 calls / 220ms mean /
      // 30.1h cumulative ACROSS ALL CALLERS, each call seq-scanning coord_event_log,
      // sorting ~20k rows and launching 3 parallel workers.
      //
      // ⚠ This site's SHARE of that total is NOT established. `backingTables` makes it
      // re-run on every coord_event_log write, but only for SUBSCRIBED clients, and it
      // backs an observer view (the bee-dossier comms section) that is often unwatched.
      // Bounding it is justified by the ratio above on its own, not by a call-count
      // claim — do not cite this site as the source of the 30.1h.
      //
      // Bounding is semantically FREE here, unlike at coord:inbox: `tail` wants the
      // newest TAIL entries and no further filters run, so stopping the read once
      // TAIL are in hand yields the identical result — and when fewer than TAIL
      // exist `enough` stays false and it pages on to exhaustion.
      // BOUNDED (WI-39825). The `enough` predicates above bound how many ROWS each
      // half pulls; they do nothing about a half that never comes back, and
      // `Promise.all` waits for the slowest. Both halves are rendered side by side
      // so neither is supplementary: a lapse propagates as a labelled failure
      // rather than a silent half-view.
      const withinBudget = createReadDeadline(RESOLVER_FANOUT_BUDGET_MS);
      const [inboxAll, outboxAll] = await Promise.all([
        withinBudget(readInbox(owner, {}, { enough: (entries) => entries.length >= TAIL }), 'beeDossier inbox'),
        // EI-19323045109346905: the same stopping rule on the outbox half. This
        // is a SMALLER win than the inbox one and the asymmetry is the point:
        // the outbox predicate (`from = owner`) is genuinely selective, where
        // the inbox predicate matched ~99.8% broadcasts that had nothing to do
        // with this owner. So bounding here fixes a read-to-use RATIO — pulling
        // a sender's entire history to render tail(50) — not a whole-table scan.
        // It is also the LAST unbounded read of the pair, so leaving it would
        // keep this resolver's cost tied to how much the owner has ever sent.
        withinBudget(readOutbox(owner, {}, { enough: (entries) => entries.length >= TAIL }), 'beeDossier outbox'),
      ]);
      const tail = <T>(arr: T[]) => (arr.length > TAIL ? arr.slice(arr.length - TAIL) : arr);
      return [{ owner, inbox: tail(inboxAll), outbox: tail(outboxAll) }];
    },
  },

  // sidebar.conversations — the whole-fleet conversation list (broadcasts +
  // multi-party threads — the all-hands channel the Swarm comms view shows
  // under the selected agent's direct mail).
  'sidebar.conversations': {
    // EI-19304902443341820: the table WAS mapped — but only to conversations.questionsList /
    // questionDetail, not to this all-hands list, which therefore refreshed on remount only.
    // The accounts.pool shape in its subtler form: mapped table, unmapped reader.
    backingTables: ['harness_shared.coord_conversations'],
    argsSchema: z.object({
      state: z.string().optional(),
      limit: clampedLimit(200, 50),
    }),
    resolve: async (args) => {
      const { state, limit } = args as { state?: string; limit: number };
      const { listConversations } = await import('../agent-tools/coordination/conversations');
      type Opts = NonNullable<Parameters<typeof listConversations>[0]>;
      const rows = await listConversations({ state: state as Opts['state'], limit });
      return rows;
    },
  },

  // Canonical operator conversation bootstrap + history. Keeping identity and
  // turns in the shared sync cache prevents the mount-time REST response from
  // racing a newer pushed transcript.
  'operatorConversations.current': {
    // Honor the window's workspace (WI-4801). The batch-fetch transport carries
    // no workspace header, so a bare resolver falls back to the process-global
    // `reg.current` — which diverges from the window's workspace in a multi-window
    // shared operator (or transiently on boot / after a switch), making the READ
    // resolve a different (empty) conversation than the header-scoped WRITE path
    // wrote to. The client passes its `window.__PAPERCUSP_WS__` here; thread it
    // through so read scope == write scope. Blank/absent ⇒ ambient (unchanged).
    argsSchema: z.object({ workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { workspaceId } = args as { workspaceId?: string };
      const { getOrCreateActiveConversation } = await import('../operator-conversations');
      return [await getOrCreateActiveConversation(workspaceId)];
    },
  },
  // Focused, side-effect-free identity read for an inline work-item Discuss
  // host. Creation stays an explicit POST mutation; a cache refetch can never
  // mint a conversation as a side effect.
  'operatorConversations.byWorkItem': {
    backingTables: ['harness_shared.operator_conversations'],
    argsSchema: z.object({
      workspaceId: z.string().optional(),
      harness: z.string().trim().min(1),
      workItemId: z.string().trim().min(1),
    }),
    resolve: async (args) => {
      const { workspaceId, harness, workItemId } = args as {
        workspaceId?: string;
        harness: string;
        workItemId: string;
      };
      const { getWorkItemConversation } = await import('../operator-conversations');
      const conversation = await getWorkItemConversation({
        workspaceId,
        harnessSlug: harness,
        workItemId,
      });
      return conversation ? [conversation] : [];
    },
  },
  // `operatorTurns.byConversation` USED TO LIVE HERE. Removed by
  // EI-19372323793235963, completing P-025 (no-http-anywhere-2026-07-28 D-016/D-018):
  // the chat pane's live tail no longer runs its own query — it reads `initialPage
  // ?.turns` off the existing `operatorTurns.page` hydration, whose args are already
  // identical, so react-query collapses them to one key and one request. All 12
  // invalidation sites were repointed to 'operatorTurns.page' at that time.
  //
  // D-018 recorded this entry (plus its table-to-query-names member and its
  // sync-read-audit fixture) as removed on 2026-08-02; in fact only the client half
  // and the repoint landed, and all three survived ~12h as dead wiring — every
  // operator_turns write synthesizing an invalidation for a name nothing subscribed
  // to. Do not re-add: the guard in table-to-query-names.test.ts arms itself the
  // moment no resolver serves the name, so a re-added mapping now fails loudly.
  'operatorTurns.page': {
    argsSchema: z.object({
      conversationId: z.string().min(1),
      beforeSeq: z.number().int().nonnegative().optional(),
      limit: clampedLimit(500, 200),
    }),
    resolve: async (args) => {
      const { conversationId, beforeSeq, limit } = args as {
        conversationId: string;
        beforeSeq?: number;
        limit: number;
      };
      const { listTurnsRecent } = await import('../operator-conversations');
      return [await listTurnsRecent({ conversationId, beforeSeq, limit })];
    },
  },

  // Legacy /coord screen projections, now backed by the same root cache and
  // SSE invalidation bus as the advanced coordination surfaces.
  'coord.history': {
    argsSchema: z.object({
      kinds: z.array(z.string()).optional(),
      planSlug: z.string().optional(),
      owner: z.string().optional(),
      sinceTs: z.string().optional(),
      limit: clampedLimit(1000, 200),
    }),
    resolve: async (args) => {
      const a = args as { kinds?: string[]; planSlug?: string; owner?: string; sinceTs?: string; limit?: number };
      // PRECOMPUTED (phase2 P-004) — but ONLY the DEFAULT view (all sources, no
      // planSlug/owner/sinceTs filter, the default limit of 200 — the /coord
      // screen's mount). loadCoordHistory scans the whole coord corpus then
      // filters/sorts in JS (0.1-0.8s, growing with volume); the routine now fills
      // a snapshot and the default mount is a plain SELECT. Snapshots have no arg
      // dimension, so any filtered/custom-limit view falls through to the live scan.
      const isDefaultVariant =
        (!a.kinds || a.kinds.length === 0) &&
        !a.planSlug &&
        !a.owner &&
        !a.sinceTs &&
        (a.limit === undefined || a.limit === 200);
      // UI-only slim (WI-7297): `payload` is 76% of this read and the viewer
      // renders AT MOST ONE of them (a single `expanded` useState), on click —
      // so it is dropped here and fetched per-row from
      // /api/coord/history/:source/:msg_id. Applied to BOTH branches so the
      // default and filtered views carry one shape; the producer already strips
      // it at compute time, making the snapshot pass idempotent (and keeping
      // the guarantee if a stored row ever predates that).
      const { projectCoordHistoryForUi } = await import('./coord-ui-projection');
      if (isDefaultVariant) {
        const { readDerivedSnapshotRows } = await import('../derived-reads/registry');
        await import('../derived-reads/producers');
        return projectCoordHistoryForUi(await readDerivedSnapshotRows('coord.history')) as unknown[];
      }
      const { loadCoordHistory } = await import('../endpoint-route/routes/coord');
      return projectCoordHistoryForUi((await loadCoordHistory(a as never)).items) as unknown[];
    },
  },
  'coord.inbox': {
    resolve: async () => {
      // UI-only slim (P-006): CoordDashboard's InboxItem renders `summary`, not
      // the full CoordEnvelope `payload` (88% of a 1.75MB feed). Project it out
      // at the sync boundary; the /api/coord/inbox HTTP loader (pui TUI) keeps it.
      const [{ loadCoordInbox }, { projectCoordInboxForUi }] = await Promise.all([
        import('../endpoint-route/routes/coord'),
        import('./coord-ui-projection'),
      ]);
      return projectCoordInboxForUi(await loadCoordInbox()) as unknown[];
    },
  },
  'coord.plans': {
    resolve: async () => {
      // UI-only slim (P-006): drop `now_state` (rendered nowhere; 60% of a 1.09MB
      // feed — full body loads on-demand via /api/coord/plans/:slug) + clip the
      // truncated-preview `now_next`. HTTP loader (pui TUI) is untouched.
      const [{ loadCoordPlans }, { projectCoordPlansForUi }] = await Promise.all([
        import('../endpoint-route/routes/coord'),
        import('./coord-ui-projection'),
      ]);
      return projectCoordPlansForUi(await loadCoordPlans()) as unknown[];
    },
  },

  'agentChats.detail': {
    argsSchema: z.object({ id: z.string().min(1), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { id, workspaceId } = args as { id: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.agentChatsConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return db
        .select()
        .from(t)
        .where(workspaceId ? and(eq(t.id, id), eq(t.workspaceId, workspaceId)) : eq(t.id, id))
        .limit(1) as unknown as Promise<unknown[]>;
    },
  },

  'dockLayouts.byName': {
    argsSchema: z.object({ workspaceId: z.string(), userId: z.string().optional(), name: z.string().min(1) }),
    resolve: async (args) => {
      const { workspaceId, userId, name } = args as { workspaceId: string; userId?: string; name: string };
      const { getLayout, getUserIdForLayouts } = await import('../dock-layouts');
      const principal = userId ? { workspaceId, userId } : { ...(await getUserIdForLayouts()), workspaceId };
      return [await getLayout(principal, name)];
    },
  },
  'dockLayouts.list': {
    argsSchema: z.object({ workspaceId: z.string(), userId: z.string().optional() }),
    resolve: async (args) => {
      const { workspaceId, userId } = args as { workspaceId: string; userId?: string };
      const { listLayouts, getUserIdForLayouts } = await import('../dock-layouts');
      const principal = userId ? { workspaceId, userId } : { ...(await getUserIdForLayouts()), workspaceId };
      return listLayouts(principal);
    },
  },

  'testing.assertionsByHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string().optional(),
      planSlug: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, planSlug } = args as {
        harnessSlug: string;
        workspaceId?: string;
        planSlug?: string;
      };
      const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
        import('@papercusp/db-org'),
        import('../workspace-registry'),
      ]);
      const { sql } = getOrgPg();
      const ws = workspaceId ?? activeWorkspaceId();
      const rows = await (planSlug
        ? sql`SELECT val_id, plan_slug, item_id, verify_text, status, requires_test
              FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
             ORDER BY val_id`
        : sql`SELECT val_id, plan_slug, item_id, verify_text, status, requires_test
              FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${harnessSlug}
             ORDER BY val_id`);
      return [...rows] as unknown[];
    },
  },

  'operatorConfig.byWorkspace': {
    resolve: async () => {
      const [{ readOperatorState }, { OPERATOR_SUBSTRATE_PROMPT }, defaults] = await Promise.all([
        import('../operator-state-pg'),
        import('../operator-prompt-system'),
        import('../operator-config-defaults'),
      ]);
      // BOUNDED (WI-39825). Two state reads, both rendered by the same editor, so
      // neither is supplementary and a lapse propagates as a labelled failure.
      const withinBudget = createReadDeadline(RESOLVER_FANOUT_BUDGET_MS);
      const [prompt, prefs] = await Promise.all([
        withinBudget(readOperatorState<{ content?: string }>('operator_prompt_user'), 'operatorPrompt user'),
        withinBudget(readOperatorState<{ content?: string }>('operator_preferences'), 'operatorPrompt preferences'),
      ]);
      // SAME fallback as GET /api/agent-mcp/operator-config: an unset table
      // renders the template, never '' — the Settings › Papercup form seeds
      // from THIS read, so '' here meant an empty editor whose Save would have
      // blanked the prompt the REST readers still reported (EI-22439758558949990).
      return [
        {
          prompt_user: defaults.operatorConfigContent(prompt, defaults.DEFAULT_PROMPT_USER),
          preferences: defaults.operatorConfigContent(prefs, defaults.DEFAULT_PREFS),
          substrate_prompt: OPERATOR_SUBSTRATE_PROMPT,
          prompt_user_path: 'harness_shared.operator_prompt_user',
          prefs_path: 'harness_shared.operator_preferences',
        },
      ];
    },
  },
  'operatorPreferences.byWorkspace': {
    resolve: async () => {
      const { listPreferenceEntries } = await import('../operator-preferences');
      return listPreferenceEntries();
    },
  },
  'operatorStandingApprovals.byWorkspace': {
    resolve: async () => {
      const { readCandidates } = await import('../operator-standing-candidates');
      return readCandidates();
    },
  },
  'userPreferences.current': {
    resolve: async () => {
      const [{ getSessionUser }, { loadUserPreferences }] = await Promise.all([
        import('../auth'),
        import('../user-preferences'),
      ]);
      const user = await getSessionUser();
      return [{ payload: await loadUserPreferences(user?.id ?? null), userId: user?.id ?? null }];
    },
  },
  'voicePrefs.effective': {
    resolve: async () => {
      const { loadVoicePrefs } = await import('../voice-prefs');
      return [await loadVoicePrefs()];
    },
  },
  'voicePrefs.workspace': {
    resolve: async () => {
      const { loadWorkspaceVoicePrefs } = await import('../voice-prefs');
      return [await loadWorkspaceVoicePrefs()];
    },
  },
  'accounts.sessionOverride': {
    backingTables: ['harness_shared.operator_account_override'],
    argsSchema: z.object({ workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const [{ getAccountOverride }, { activeWorkspaceId }] = await Promise.all([
        import('../deployment/account-session-override'),
        import('../workspace-registry'),
      ]);
      const { workspaceId } = args as { workspaceId?: string };
      return [await getAccountOverride(workspaceId ?? activeWorkspaceId())];
    },
  },
  'kpis.all': {
    resolve: async () => {
      const { loadAllKpis } = await import('../endpoint-route/routes/harness/all-kpis');
      return [await loadAllKpis()];
    },
  },

  // conversations.* — the cacheable source reads behind the /adv Conversations
  // master/detail surface.  The unified inbox composes the four LIST queries in
  // the browser, so opening a source view reuses the exact same React Query cache
  // entry instead of unmounting the inbox and starting a cold REST lifecycle.
  // Detail reads are independently keyed by id and only enabled while selected.
  'conversations.questionsList': {
    argsSchema: z.object({ limit: clampedLimit(200, 100) }),
    resolve: async (args) => {
      const { limit } = args as { limit: number };
      const { listConversationsWithTopics } = await import('../agent-tools/coordination/conversations');
      const rows = await listConversationsWithTopics({ limit });
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        state: row.state,
        scope: row.scope,
        harness_slug: row.harness_slug,
        title: row.title ?? row.body.slice(0, 100),
        asker_id: row.asker_id,
        topics: row.topics,
        promoted_issue_id: row.promoted_issue_id,
        created_ts: row.created_ts,
        updated_ts: row.updated_ts,
      }));
    },
  },
  'conversations.questionDetail': {
    argsSchema: z.object({ id: z.string().min(1) }),
    resolve: async (args) => {
      const { id } = args as { id: string };
      const { getConversation } = await import('../agent-tools/coordination/conversations');
      const detail = await getConversation(id);
      return detail
        ? [
            {
              ...detail.conversation,
              topics: detail.topics,
              posts: detail.posts,
              subscriber_count: detail.subscriber_count,
            },
          ]
        : [];
    },
  },
  'conversations.deliberationList': {
    argsSchema: z.object({ limit: clampedLimit(1000, 100) }),
    resolve: async (args) => {
      const { limit } = args as { limit: number };
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      // BOUNDED (WI-39825) via the shared rows+count fan-out — third site of this
      // shape, and the third with the same `?? rows.length` wrong-total on a failed
      // count. See `bounded-list-read.ts`.
      const { readBoundedList } = await import('./bounded-list-read');
      return readBoundedList<Record<string, unknown>>({
        // `harness_slug` is null on 5,698 of 5,761 threads, and BOTH the ref
        // pill and WorkItemPopupModal need a harness to scope workItems.detail
        // — so the "ATTACHED TO" link (owner requirement, D-005) was dead on
        // every Decisions row until this fallback existed. The harness is
        // recoverable from the work-item the thread hangs off, fixing 89.7%;
        // the rest keep the honest "no harness context" state.
        //
        // A scalar subquery, NOT a join: `feature_id` is not unique across
        // harnesses for F-NNN ids, so a join would multiply thread rows.
        // And NOT "inherit the pane's harness": issue-thread-WI-6355 renders
        // under papercusp but its work-item lives in oddsmith-hive, so
        // inheriting would look the item up confidently in the WRONG harness.
        rows: sql<Record<string, unknown>[]>`
          SELECT t.thread_id, t.parent_kind, t.parent_ref, t.title, t.created_by,
                 COALESCE(t.harness_slug,
                          (SELECT w.harness_slug
                             FROM harness_shared.work_items w
                            WHERE w.feature_id = t.parent_ref
                              AND w.harness_slug IS NOT NULL
                            LIMIT 1)) AS harness_slug,
                 t.created_at, t.last_post_at, t.post_count
            FROM harness_shared.coord_threads t
           ORDER BY t.last_post_at DESC NULLS LAST, t.created_at DESC NULLS LAST
           LIMIT ${limit}`.then((r) => [...r]),
        count: sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.coord_threads`.then(
          (r) => r[0]?.n ?? null,
        ),
        label: 'conversations.deliberationList',
      });
    },
  },
  'conversations.deliberationDetail': {
    argsSchema: z.object({ id: z.string().min(1) }),
    resolve: async (args) => {
      const { id } = args as { id: string };
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      // BOUNDED (WI-39825). A thread and its posts: the view is a transcript, so
      // neither leg is supplementary (a thread with silently-missing posts reads as
      // an empty conversation) and a lapse propagates as a labelled failure.
      const withinBudget = createReadDeadline(RESOLVER_FANOUT_BUDGET_MS);
      const [thread, posts] = await Promise.all([
        // Same parent-work-item harness fallback as deliberationList — the two
        // MUST agree. A list that resolves the harness while the detail does
        // not is the worst outcome: the pill looks live in the row and dies
        // the moment you open it.
        withinBudget(
          sql`SELECT t.thread_id, t.parent_kind, t.parent_ref, t.title, t.created_by,
                   COALESCE(t.harness_slug,
                            (SELECT w.harness_slug
                               FROM harness_shared.work_items w
                              WHERE w.feature_id = t.parent_ref
                                AND w.harness_slug IS NOT NULL
                              LIMIT 1)) AS harness_slug,
                   t.created_at, t.last_post_at, t.post_count
              FROM harness_shared.coord_threads t
             WHERE t.thread_id = ${id} LIMIT 1`,
          'deliberationDetail thread',
        ),
        withinBudget(
          sql`SELECT id, author_id, body, created_at, harness_slug
              FROM harness_shared.coord_thread_posts
             WHERE thread_id = ${id}
             ORDER BY created_at ASC NULLS LAST
             LIMIT 1000`,
          'deliberationDetail posts',
        ),
      ]);
      if (!thread[0]) return [];
      const safePosts = posts.map((post) => ({
        ...post,
        id: typeof post.id === 'bigint' ? Number(post.id) : post.id,
      }));
      return [{ thread: thread[0], posts: safePosts }];
    },
  },
  'conversations.agentChatList': {
    argsSchema: z.object({
      limit: clampedLimit(1000, 100),
      harness: z.string().optional(),
      role: z.string().optional(),
    }),
    resolve: async (args) => {
      const { limit, harness, role } = args as { limit: number; harness?: string; role?: string };
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      // BOUNDED (WI-39825) via the shared rows+count fan-out. Same shape, and same
      // pre-existing wrong-answer, as projectSpecRevisions.byProject: a failed
      // count resolved to `?? rows.length`, rendering a confident total equal to
      // the window size. The helper flags `totalUnavailable` instead.
      const { readBoundedList } = await import('./bounded-list-read');
      return readBoundedList<Record<string, unknown>>({
        rows: sql<Record<string, unknown>[]>`
          SELECT id, harness_slug, role, feature_id, title,
                 created_at, updated_at, archived_at,
                 total_input_tokens, total_output_tokens, total_cost_usd_cents,
                 jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) AS turns
            FROM harness_shared.agent_chats_consolidated
           WHERE (${harness ?? null}::text IS NULL OR harness_slug = ${harness ?? null})
             AND (${role ?? null}::text IS NULL OR role = ${role ?? null})
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
           LIMIT ${limit}`.then((r) => [...r]),
        count: sql<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM harness_shared.agent_chats_consolidated
           WHERE (${harness ?? null}::text IS NULL OR harness_slug = ${harness ?? null})
             AND (${role ?? null}::text IS NULL OR role = ${role ?? null})`.then((r) => r[0]?.n ?? null),
        label: 'conversations.agentChatList',
      });
    },
  },
  'conversations.agentChatDetail': {
    argsSchema: z.object({ id: z.string().min(1) }),
    resolve: async (args) => {
      const { id } = args as { id: string };
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      const rows = await sql`
        SELECT id, harness_slug, role, feature_id, title, created_at, updated_at,
               archived_at, transcript, total_input_tokens, total_output_tokens,
               total_cost_usd_cents,
               jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) AS turns
          FROM harness_shared.agent_chats_consolidated
         WHERE id = ${id}
         LIMIT 1`;
      return rows;
    },
  },
  // P-029 / cockpit D-004: the ONE typed conversation/context projection.
  // pui calls this through its existing generic rest-query client and the GUI
  // uses useSyncQuery; both therefore receive byte-identical frame semantics.
  'conversations.contextProjection': {
    backingTables: [
      'harness_shared.agent_chats_consolidated',
      'harness_shared.agent_loop_sessions',
      'harness_shared.agent_loop_approvals',
      'harness_shared.session_tasks',
      // P-030 producer-readonly adapters. session_turns/tool_invocations are
      // bounded append-ledger reads; the remaining tables supply the current
      // identity/intent/mode/claim context around that immutable session key.
      'harness_shared.session_turns',
      'harness_shared.tool_invocations',
      'harness_shared.adv_sessions',
      'harness_shared.coord_presence',
      'harness_shared.agent_modes',
      'harness_shared.plan_item_claims',
      'harness_shared.work_items',
    ],
    argsSchema: z.object({
      sourceKind: z.string().min(1),
      sessionId: z.string().min(1),
      harness: z.string().min(1).optional(),
    }),
    resolve: async (args) => {
      const { sourceKind, sessionId, harness } = args as {
        sourceKind: string;
        sessionId: string;
        harness?: string;
      };
      const [{ readConversationContextProjection }, { activeWorkspaceId }] = await Promise.all([
        import('../conversation-context-projection'),
        import('../workspace-registry'),
      ]);
      const projection = await readConversationContextProjection({
        workspaceId: activeWorkspaceId(),
        sourceKind,
        sessionId,
        ...(harness ? { harness } : {}),
      });
      return projection ? [projection] : [];
    },
  },
  // conversations.messageList / conversations.messageDetail (work-item mail
  // read queries over harness_shared.messages_consolidated) retired here —
  // see retire-work-item-mail-surface-2026-07-26 P-004 / _retired/work-item-mail/RESTORE.md.

  // conversations.agentMessage* — agent↔agent `coord:send` traffic as a CURATED
  // conversation source (conversations-agent-messages-2026-07-27 P-001/P-002).
  //
  // This is the highest-volume conversation type in the system (82,440
  // agent-authored envelopes; 10,633 `message` in a single week) and until now
  // it had no curated home at all: its only rendering was the /adv Raw-events
  // firehose, which defaults to `system_only` — so that view showed the ~1.6k
  // SYSTEM envelopes and filtered out the ~10.6k AGENT ones. Owner, 2026-07-27:
  // "I see agents sending messages to each other all the time but I only see 51
  // chat messages and 85 decision messages."
  //
  // Deliberately NOT routed through readCoordFeed (`dev.coordFeed`): that reader
  // fetches bounded per-surface windows and filters in memory, which is right for
  // a debugging firehose but cannot answer "the newest N agent CONVERSATIONS"
  // without over-fetching. These are direct indexed reads instead.
  'conversations.agentMessageList': {
    argsSchema: z.object({
      limit: clampedLimit(500, 100),
      harness: z.string().optional(),
      kinds: z.array(z.string()).optional(),
      /** Filter the append-only message haystack server-side before projecting rows. */
      q: z.string().max(500).optional(),
      /** Include machine traffic — `auto:true` lifecycle projections AND named
       *  service actors. Default false: the pane shows what agents wrote. */
      includeMachine: z.boolean().optional(),
    }),
    resolve: async (args) => {
      const { limit, harness, kinds, q, includeMachine } = args as {
        limit: number;
        harness?: string;
        kinds?: string[];
        q?: string;
        includeMachine?: boolean;
      };
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      const kindFilter = kinds && kinds.length > 0 ? kinds : [...CURATED_COORD_ROOT_KINDS];
      const machineOk = includeMachine === true;
      const query = q?.trim() || null;
      const searchPattern = query ? likeContainsPattern(query) : null;
      // Search against the JSON envelope so every field the unified row exposes
      // (body, summary, sender, recipients, lifecycle, audience, and plan refs)
      // remains searchable without shipping the long body on the default list.
      const searchFilter = searchPattern
        ? sql`(
            c.body::text ILIKE ${searchPattern} ESCAPE '\\'
            OR COALESCE(c.harness_slug, '') ILIKE ${searchPattern} ESCAPE '\\'
          )`
        : sql`TRUE`;
      const [rows, totalRows] = await Promise.all([
        sql`
          SELECT c.msg_id,
                 c.ts,
                 c.harness_slug,
                 c.body,
                 (SELECT count(*)::int
                    FROM harness_shared.coord_event_log r
                   WHERE r.body ? 'related_msg_id'
                     AND r.body ->> 'related_msg_id' = c.msg_id) AS reply_count,
                 (SELECT max(r.ts)
                    FROM harness_shared.coord_event_log r
                   WHERE r.body ? 'related_msg_id'
                     AND r.body ->> 'related_msg_id' = c.msg_id) AS last_reply_ts
            FROM harness_shared.coord_event_log c
           WHERE c.surface = ANY(${[...CURATED_COORD_SURFACES]}::text[])
             AND c.body ->> 'kind' = ANY(${kindFilter}::text[])
             AND NOT (c.body ? 'related_msg_id')
             AND COALESCE(c.body ->> 'from', '') !~* '^system($|[-_:/.])'
             AND (${machineOk}
                  OR (COALESCE(c.body ->> 'auto', '') <> 'true'
                      AND COALESCE(c.body ->> 'from', '') ~* ${AGENT_SESSION_ID_HEX_RUN}))
             AND (${harness ?? null}::text IS NULL OR c.harness_slug = ${harness ?? null})
             AND ${searchFilter}
           ORDER BY c.id DESC
           LIMIT ${limit}`,
        sql<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM harness_shared.coord_event_log c
           WHERE c.surface = ANY(${[...CURATED_COORD_SURFACES]}::text[])
             AND c.body ->> 'kind' = ANY(${kindFilter}::text[])
             AND NOT (c.body ? 'related_msg_id')
             AND COALESCE(c.body ->> 'from', '') !~* '^system($|[-_:/.])'
             AND (${machineOk}
                  OR (COALESCE(c.body ->> 'auto', '') <> 'true'
                      AND COALESCE(c.body ->> 'from', '') ~* ${AGENT_SESSION_ID_HEX_RUN}))
             AND (${harness ?? null}::text IS NULL OR c.harness_slug = ${harness ?? null})
             AND ${searchFilter}`,
      ]);
      // WI-7240: the LIST omits `authored` — only the detail views render it, and it
      // was 43.90% of this payload. `conversations.agentMessageDetail` still carries
      // it in full, via this same mapper.
      return attachListMeta(
        rows.map((r) =>
          toAgentMessageRow(r, {
            includeAuthored: false,
            // A searched row may need its body for the exact client-side
            // highlight/filter pass; the ordinary list never ships it.
            includeBody: searchPattern !== null,
          }),
        ),
        { total: totalRows[0]?.n ?? rows.length },
      );
    },
  },
  'conversations.agentMessageDetail': {
    argsSchema: z.object({ id: z.string().min(1) }),
    resolve: async (args) => {
      const { id } = args as { id: string };
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      // The reply chain is walked transitively (an ack ON an ack), bounded by
      // depth and row count so a pathological cycle in the data can never turn
      // one pane read into an unbounded recursion. `msg_id` is the join key and
      // is indexed; the child edge is indexed by migration 691.
      const [root, replies] = await Promise.all([
        sql`
          SELECT msg_id, ts, harness_slug, body,
                 0::int AS reply_count, NULL::timestamptz AS last_reply_ts
            FROM harness_shared.coord_event_log
           WHERE msg_id = ${id}
           ORDER BY id ASC
           LIMIT 1`,
        sql`
          WITH RECURSIVE chain AS (
            SELECT c.id, c.msg_id, c.ts, c.body, 1 AS depth
              FROM harness_shared.coord_event_log c
             WHERE c.body ? 'related_msg_id' AND c.body ->> 'related_msg_id' = ${id}
            UNION ALL
            SELECT c.id, c.msg_id, c.ts, c.body, chain.depth + 1
              FROM harness_shared.coord_event_log c
              JOIN chain ON c.body ->> 'related_msg_id' = chain.msg_id
             WHERE c.body ? 'related_msg_id' AND chain.depth < 8
          )
          SELECT DISTINCT ON (msg_id) msg_id, ts, body
            FROM chain
           ORDER BY msg_id, id ASC
           LIMIT 200`,
      ]);
      if (!root[0]) return [];
      const ordered = [...replies].sort(
        (a, b) => new Date(a.ts as string).getTime() - new Date(b.ts as string).getTime(),
      );
      return [
        {
          message: toAgentMessageRow({
            ...root[0],
            reply_count: ordered.length,
            last_reply_ts: ordered.at(-1)?.ts ?? null,
          }),
          replies: ordered.map((r) => {
            const body = (r.body ?? {}) as CoordEnvelopeBody;
            return {
              msg_id: r.msg_id as string,
              kind: typeof body.kind === 'string' ? body.kind : '',
              from: typeof body.from === 'string' ? body.from : '',
              to: Array.isArray(body.to) ? body.to.filter((t): t is string => typeof t === 'string') : [],
              summary: typeof body.summary === 'string' ? body.summary : null,
              body: typeof body.body === 'string' ? body.body : null,
              ts: new Date(r.ts as string).toISOString(),
            };
          }),
        },
      ];
    },
  },

  // sidebar.hives — every p2p-swarm peer (`shared_presence` — remote installs
  // whose announces the peer-log projected), INCLUDING stale ones (a hive that
  // joined but went quiet still lists, flagged). The Hives tab groups these
  // per device client-side, mirroring the pui Hives tab.
  'sidebar.hives': {
    // Continuous presence heartbeat — deliberately poll-only (PUSH_EXEMPT in the coverage guard):
    // a per-row notify on every agent keepalive is the notify-storm anti-pattern.
    backingTables: ['harness_shared.shared_presence'],
    resolve: async () => {
      const { listFederatedPresence } = await import('../agent-tools/coordination/federated-presence');
      // All rows, stale ones flagged (a hive that joined but went quiet still
      // lists); fail-soft empty when the org PG is unreachable.
      return listFederatedPresence({});
    },
  },

  // hive.controlState — the global Start/Pause-Hive control's read side
  // (start-hive-wake-orchestration P-006): per registered hive, the persisted
  // started bit (P-004), the pending time wake, the watchdog health signal, and
  // (queen-heartbeat-2026-06-16, owner-priority) the open placements the Queen is
  // DRIVING — so a parked-but-alive Queen visibly shows she's running + what she
  // owns (the owner's "I can't tell she's alive" frustration). Live: pot:start /
  // pot:pause fire `notifySyncInvalidate('hive.controlState', {})`; the heartbeat
  // UI also periodically refetches to keep lastWakeAt / the countdown fresh.
  'hive.controlState': {
    resolve: async () => {
      const { listPots } = await import('../agent-tools/pot/_resolve');
      const { getPotPlacementStarted } = await import('../pot/started');
      const { recentWatchdogFires } = await import('../pot/watchdog');
      const { summarizeOpenPlacements, latestMugWakeAt } = await import('../pot/placement-watchdog');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const ws = activeWorkspaceId();
      // VARIABLE-ARITY fan-out (WI-39849): FOUR store reads per hive, so the leg
      // count is 1 + 4×hives.length and grows with the workspace. One deadline
      // shared by all of them; each read keeps its own existing fallback, so a
      // lapsed budget degrades that field instead of hanging the whole control.
      const withinBudget = createReadDeadline(RESOLVER_FANOUT_BUDGET_MS);
      const hives = await withinBudget(listPots(ws), 'controlState listPots').catch(() => []);
      return Promise.all(
        hives.map(async (hv) => {
          // lastWakeAt = the MORE RECENT of the recordHiveWake ledger AND the Queen's
          // REAL queen-spawn wakes. The wake-brain Queen never calls recordHiveWake, so
          // without the real-spawn read the heartbeat shows "Paused/Stalled" while she
          // is alive (the visibility regression). ISO strings sort chronologically.
          const realWake = await withinBudget(
            latestMugWakeAt(ws, hv.slug),
            `controlState latestMugWakeAt ${hv.slug}`,
          ).catch(() => null);
          const lastWakeAt = [realWake, hv.wake?.lastWakeAt ?? null].filter(Boolean).sort().at(-1) ?? null;
          return {
            slug: hv.slug,
            started: await withinBudget(getPotPlacementStarted(ws, hv.slug), `controlState started ${hv.slug}`).catch(
              () => false,
            ),
            nextFireAt: hv.wake?.nextFireAt ?? null,
            lastWakeAt,
            watchdogFires24h: await withinBudget(
              recentWatchdogFires(ws, hv.slug),
              `controlState watchdog ${hv.slug}`,
            ).catch(() => 0),
            placements: await withinBudget(
              summarizeOpenPlacements(ws, hv.slug),
              `controlState placements ${hv.slug}`,
            ).catch(() => ({
              recovering: 0,
              cursed: 0,
              stranded: 0,
              workingTracked: 0,
              items: [] as Array<{ workItemId: string; status: string; failCount: number; harness: string | null }>,
            })),
          };
        }),
      );
    },
  },

  // hive.steering — the owner steering controls the 👑 Queen tab reads (queen-
  // steering-panel-2026-06-15 B-01, CONTRACT C-1). One row per Hive (mirrors
  // hive.controlState), each the decoded OwnerSteering over the owner-steering:*
  // hive_settings keys: { slug, directive, eligiblePlans, eligibleHives, pauseNewWork, pausedUntil }.
  // A single-hive UI reads data[0]; a multi-hive UI keys by slug. Invalidated
  // explicitly by pot:set-steering (notifySyncInvalidate) AND by the hive_settings
  // table→query map (covers a federated steering write from a peer Swarm).
  'hive.steering': {
    resolve: async () => {
      const { listPots } = await import('../agent-tools/pot/_resolve');
      const { getOwnerSteering, DEFAULT_OWNER_STEERING } = await import('../owner-steering');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const ws = activeWorkspaceId();
      // VARIABLE-ARITY fan-out (WI-39849): one getOwnerSteering read per hive, so
      // the leg count grows with the workspace. One deadline shared by the listPots
      // leg and every per-hive steering read; each keeps its own existing fallback,
      // so a lapsed budget degrades that hive to DEFAULT_OWNER_STEERING rather than
      // hanging the 👑 tab.
      const withinBudget = createReadDeadline(RESOLVER_FANOUT_BUDGET_MS);
      const hives = await withinBudget(listPots(ws), 'steering listPots').catch(() => []);
      // Throttle defaults (queen-steering-panel P-006, D-006): the SYSTEM defaults
      // the 👑-tab shows beside each session override for its default-vs-override
      // badge — so the UI never hardcodes them. Same numbers the live seams clamp
      // against (cadence = wake floor, maxBees = the spawn-concurrency ceiling).
      // Fail-soft: a read failure degrades each default to null (UI shows "—").
      const throttleDefaults = await (async () => {
        try {
          const [{ potWakeFloorSec }, { getCachedRateLimitConfig }, { placementConfig }] = await Promise.all([
            import('../pot/wake'),
            import('../rate-limit-config'),
            import('../pot/placement-watchdog'),
          ]);
          return {
            cadenceFloorSec: potWakeFloorSec(),
            maxBees: getCachedRateLimitConfig().maxSimultaneousAgents,
            // P-009 read-through (su-4d71b): the live cursed-item breaker threshold
            // the autonomy-surfacing UI shows read-only (PAPERCUSP_POT_PLACEMENT_BREAKER).
            breakerThreshold: placementConfig().breakerThreshold,
          };
        } catch {
          return { cadenceFloorSec: null, maxBees: null, breakerThreshold: null };
        }
      })();
      // HOME-hive stamp (2026-07-01): resolve the workspace's HOME queen the SAME way
      // the loops do (resolvePotHomeSlug env/ctx chain → operator-home fallback) and
      // mark its row. The 👑-tab used to GUESS the home as "first project with
      // harness_kind:'hive'" — in a workspace with test hives that picked e.g.
      // sb-devboard-hive (paused, woke-never) and the panel showed a dead queen while
      // the real papercusp queen ran. The UI now prefers this stamp.
      const homeSlug = await (async () => {
        try {
          const [{ resolvePotHomeSlug }, { operatorHomeHarnessSlug }] = await Promise.all([
            import('../pot/wake'),
            import('../harness/operator-home-harness'),
          ]);
          return resolvePotHomeSlug(null, null) ?? operatorHomeHarnessSlug();
        } catch {
          return null;
        }
      })();
      return Promise.all(
        hives.map(async (hv) => ({
          slug: hv.slug,
          isHome: homeSlug != null && hv.slug === homeSlug,
          ...(await withinBudget(getOwnerSteering(ws, hv.slug), `steering ${hv.slug}`).catch(
            () => DEFAULT_OWNER_STEERING,
          )),
          throttleDefaults,
        })),
      );
    },
  },

  // network.board — the aggregate Network-tab board (hive-network-surface
  // B-08 / P-006, CONTRACT C-3): one flat row per other-hive context across the
  // capability-tier ladder (tier 1 this Swarm · tier 2 own other hives · tier 3
  // shared-Hive peer Swarms · tier 4 foreign directory hives + beacon + grants +
  // asks). Composes the same buildNetworkBoard the `network:board` agent tool
  // serves — one composition, no drift. Flat-row contract (each row IS a
  // NetworkBoardRow). SSE-primary + 60s safety-net on the consumer (pui Network
  // pane B-09). Live: invalidated by the table→query bridge on
  // coord_presence/feature_claims writes, and by callers that
  // notifySyncInvalidate('network.board', {}) after a grant / ask / hive
  // start-pause / beacon change.
  'network.board': {
    argsSchema: z.object({ workspace: z.string().optional() }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      const { buildNetworkBoard } = await import('../network-board/build-board');
      return buildNetworkBoard({ workspaceId: workspace });
    },
  },

  // network.hive.beacons — the tier-4 dossier's beacon HISTORY (hive-network-
  // surface P-014 item 2 / D-007 GAP 2, migration 236): how a foreign hive's
  // self-reported status evolved, newest-first. `hiveKey` is the C-3 tier-4 row
  // key — DiscoveredHive.potId or its pubkey-b64, whichever the drill-in holds.
  // Live: captureBeaconSnapshot fires notifySyncInvalidate on each accepted
  // announce; plus the consumer's standard 60s safety-net refetch.
  'network.hive.beacons': {
    argsSchema: z.object({
      hiveKey: z.string(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { hiveKey, limit } = args as { hiveKey: string; limit: number };
      const { listBeaconHistory } = await import('../network-board/beacon-history-pg');
      return listBeaconHistory(hiveKey, limit);
    },
  },

  // network.hive.asks — the FULL C-1 ask log (hive-network-surface P-014
  // item 2 / D-007 GAP 2): every ledgered request both directions, all states
  // (the board row only carries pending/answered counts), newest-first,
  // optionally narrowed to one tier-4 peer. Rows are CrossHiveAsk objects
  // (incl. askedBy + reply body — the dossier's ask/answer traffic view).
  // Live: sendCrossHiveAsk + the wiring's reply-persist fire
  // notifySyncInvalidate after their writes; 60s safety-net on the consumer.
  'network.hive.asks': {
    argsSchema: z.object({
      peerPubkey: z.string().optional(),
      limit: clampedLimit(500, 100),
      workspace: z.string().optional(),
    }),
    resolve: async (args) => {
      const { peerPubkey, limit, workspace } = args as {
        peerPubkey?: string;
        limit: number;
        workspace?: string;
      };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { resolvePotHomeSlug } = await import('../pot/wake');
      const { PgCrossHiveAsks } = await import('../cross-hive-asks-pg');
      const ws = workspace ?? activeWorkspaceId();
      const homeSlug = resolvePotHomeSlug();
      if (!homeSlug) return [];
      return new PgCrossHiveAsks(ws, homeSlug).list({
        ...(peerPubkey ? { peerPubkey } : {}),
        limit,
      });
    },
  },

  // network.hive.wakes — the hive-SCOPED staged-wake board (hive-network-
  // surface P-014 item 3, closing D-007 GAP 1): the pending_wakes queue
  // narrowed to owners attributed to one hive via fleet assignments, so the
  // per-hive drill-in can grow a real wake board instead of the hive-pane
  // header summary. Flat PendingWake rows (owner ASC, oldest-first — the
  // consumer groups per owner like assemble_wake_board). Live: the
  // pending-wakes writers fire notifySyncInvalidate; 60s safety-net.
  'network.hive.wakes': {
    argsSchema: z.object({
      hive: z.string(),
      workspace: z.string().optional(),
    }),
    resolve: async (args) => {
      const { hive, workspace } = args as { hive: string; workspace?: string };
      const { listHiveWakes } = await import('../network-board/hive-wakes');
      return listHiveWakes(hive, { workspaceId: workspace });
    },
  },

  // network.fleet.wakes — the FLEET-WIDE staged-wake board (EI-597 Step B):
  // every owner's pending wakes in the active workspace, the same full read the
  // pui's non-Hive scopes (fleet / queen / single-owner) used to POLL via
  // coord:wake-queue{action:list}. Moving it onto the sync rail collapses the
  // wake-board poll storm (the fleet's #1/#2 tool-call volume): the same
  // pushWakeBoard() writers that fire `network.hive.wakes` also fire this key on
  // every stage/clear, so the pui refetches on mutation (+ a 60s safety net)
  // instead of every 10s. Payload-equivalent to the old poll (listAllPendingWakes
  // is exactly what coord:wake-queue list returns); the pui keeps its existing
  // client-side filter_wake_groups for the fleet/queen/owner narrowing — so this
  // is the SAME ambient-workspace read the proven network.hive.wakes resolver
  // already relies on (listHiveWakes → listAllPendingWakes). su-dfe5e + su-cf7b0.
  'network.fleet.wakes': {
    argsSchema: z.object({
      // accepted for parity with network.hive.wakes (+ future per-scope use);
      // listAllPendingWakes scopes to the active workspace internally (F-C3).
      workspace: z.string().optional(),
    }),
    resolve: async () => {
      const { listAllPendingWakes } = await import('../agent-tools/coordination/pending-wakes');
      return listAllPendingWakes();
    },
  },

  // network.hiveDirectory — the P2P hive-directory browse list (data-sync-push-
  // completion P-009): the SAME un-muted, un-expired, non-private discovered set
  // GET /api/discovery/pots serves to the desktop WorkbenchPotDirectoryPanel,
  // moved onto the sync rail so a withdrawn hive drops out / a new announce
  // appears WITHOUT the old 30s poll. Reuses the directory's own
  // listDiscoveredHives builder + the endpoint's exact row shape (so the panel
  // renders identically). Flat HiveRow array (the panel maps over it directly).
  // IN-MEMORY P2P state (no PG table → no table→query bridge; that would trip the
  // cache-tag-trigger-coverage test which requires a PG trigger per bridged table).
  // Live: the directory ingest path (verify→add / withdraw-tombstone in
  // hive-directory-boot's onAnnounce) + the announce/withdraw/beacon writers fire
  // notifySyncInvalidate('network.hiveDirectory') on every accepted change. The
  // 90s source-side dedupe is fine here — P2P announce/withdraw events are sparse
  // (typically >90s apart), so each invalidation delivers promptly; any miss falls
  // back to the @papercusp/sync 180s drift-repair tick.
  'network.hiveDirectory': {
    resolve: async () => {
      const { buildHiveDirectoryRows } = await import('../discovery-hive-rows');
      return buildHiveDirectoryRows({ includeExpired: false });
    },
  },

  // network.federationStatus — the desktop's LIVE federation status read (data-
  // sync-push-completion P-009): the SAME { ok, substrate, hives } payload GET
  // /api/discovery/federation-status serves to the left-sidebar
  // PotFederationStatus panel, moved onto the sync rail so the old 10s poll is
  // gone. Reuses the endpoint's exact builder (buildFederationStatus) so the
  // FedStatus shape matches precisely. Workspace-singleton, no-arg; returns a
  // FLAT one-element array per the resolver contract — the consumer reads data[0].
  // IN-MEMORY P2P + install-wide substrate state (no PG table → no table→query
  // bridge). Live: the directory ingest path + the announce/withdraw/beacon writers
  // fire notifySyncInvalidate('network.federationStatus') on every accepted change;
  // substrate/drain changes (harness boots) not covered by those fall back to the
  // 180s drift-repair tick — acceptable for a status panel (substrate is steady
  // after boot). Same 90s-dedupe reasoning as network.hiveDirectory.
  'network.federationStatus': {
    resolve: async () => {
      const { buildFederationStatus } = await import('../endpoint-route/routes/discovery/build-federation-status');
      return [await buildFederationStatus()];
    },
  },

  // planItems.byPlan — the parsed plan items (id, text, storedStatus,
  // effectiveStatus, blockedBy, …) for one plan, for the Create-tab kanban.
  // Reads through the SAME path as `plans:get` (parses the plan's `content`
  // markdown) rather than the `harness_plans.items` jsonb column: that jsonb is
  // only re-projected on a plan WRITE, so it is stale/empty for plans not
  // re-written since the projection landed (~30 live plans had items in content
  // but an empty jsonb). Parsing content is always fresh AND carries
  // `effectiveStatus` (the issue-block overlay) for parity with the rail.
  // Keyed by `plan_slug` alone. Live: `plans:set-status` fires
  // `notifySyncInvalidate('planItems.byPlan', { planSlug })`.
  'planItems.byPlan': {
    argsSchema: z.object({ planSlug: z.string() }),
    resolve: async (args) => {
      const { planSlug } = args as { planSlug: string };
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const res = (await callPlansRead('get', { slug: planSlug })) as { items?: unknown[] };
      return Array.isArray(res?.items) ? res.items : [];
    },
  },

  // ─── Evaluation surface — impartial benchmark suite (impartial-benchmark-suite-2026-06-15).
  // evals.suites/evals.runs are P-010 store reads over benchmark_run_result (migration 291);
  // evals.report is P-011's pass@1/CI/Pareto/delta math (buildSuiteReport) over the same rows,
  // grouped per suite (buildSuiteReport is single-suite). emitRollout() fires
  // notifySyncInvalidate('evals.runs', { runId }) + ('evals.suites', {}) after each write.
  'evals.suites': {
    argsSchema: z.object({ runId: z.string().optional() }),
    resolve: async (args) => {
      const { runId } = args as { runId?: string };
      const { listSuites } = await import('../external-bench/reproducibility/store');
      return listSuites({ runId });
    },
  },
  'evals.runs': {
    argsSchema: z.object({ runId: z.string().optional(), suite: z.string().optional() }),
    resolve: async (args) => {
      const { runId, suite } = args as { runId?: string; suite?: string };
      const { listRunResults } = await import('../external-bench/reproducibility/store');
      return listRunResults({ runId, suite });
    },
  },
  'evals.report': {
    argsSchema: z.object({ runId: z.string(), suite: z.string().optional() }),
    resolve: async (args) => {
      const { runId, suite } = args as { runId: string; suite?: string };
      const { listRunResults } = await import('../external-bench/reproducibility/store');
      const { buildSuiteReport } = await import('@papercusp/bench-metrics');
      const rows = await listRunResults({ runId, suite });
      if (rows.length === 0) return [];
      // buildSuiteReport is single-suite — group rows per suite, one report each.
      const bySuite = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = bySuite.get(r.suite) ?? [];
        list.push(r);
        bySuite.set(r.suite, list);
      }
      return [...bySuite.values()].map((suiteRows) => buildSuiteReport(suiteRows));
    },
  },
  // L2 Hive layer (Phase 5 / D-010). evals.fleet = FleetRunSummary[] (P-030
  // Throughput/Coordination subtabs feed P-011's throughputMetrics/buildHiveReport);
  // evals.coordTrace = one fleet run's CoordTrace (P-011's substrateSignalRates /
  // MAST scoring). emitFleetRun/emitCoordEvents invalidate these.
  'evals.fleet': {
    argsSchema: z.object({ runId: z.string().optional() }),
    resolve: async (args) => {
      const { runId } = args as { runId?: string };
      const { listFleetRuns } = await import('../external-bench/reproducibility/fleet');
      return listFleetRuns({ runId });
    },
  },
  'evals.coordTrace': {
    argsSchema: z.object({ fleetRunId: z.string() }),
    resolve: async (args) => {
      const { fleetRunId } = args as { fleetRunId: string };
      const { getCoordTrace } = await import('../external-bench/reproducibility/fleet');
      const trace = await getCoordTrace(fleetRunId);
      return trace ? [trace] : [];
    },
  },
  // Operational live run store (benchmark-evaluation-ui-2026-06-16 P-003 / D-001):
  // bench_runs/bench_run_tasks/bench_run_events (migration 296) — the live, MUTABLE
  // source the Evaluation UI reads for run launch/monitor/history, distinct from the
  // reproducibility cards above. run-store.ts fires notifySyncInvalidate('evals.benchRuns',
  // {}) + ('evals.benchRun', { runId }) on every write, so an in-flight run streams
  // live over desktop SSE with no polling. Detail rows carry the PreservedArmRun shape
  // the eval-viz already renders.
  'evals.benchRuns': {
    argsSchema: z.object({}),
    resolve: async () => {
      const { listBenchRuns } = await import('../external-bench/run-store');
      return listBenchRuns();
    },
  },
  'evals.benchRun': {
    argsSchema: z.object({ runId: z.string() }),
    resolve: async (args) => {
      const { runId } = args as { runId: string };
      const { getBenchRunDetail } = await import('../external-bench/run-store');
      const detail = await getBenchRunDetail(runId);
      return detail ? [detail] : [];
    },
  },
  // Live fleet state for an in-flight run (P-007/P-009) — the Queen's survival,
  // bee status counts, opus-only model-leak check, cumulative spend + wall-clock,
  // per-task progress, read from spawned_agents/agent_usage_samples scoped to the
  // run's hive. The live monitor polls this (the fleet tables aren't bridged to
  // SSE); a completed run returns the not-live shape (signals null).
  'evals.benchRunLive': {
    argsSchema: z.object({ runId: z.string() }),
    resolve: async (args) => {
      const { runId } = args as { runId: string };
      const { getBenchRunLiveState } = await import('../external-bench/live-state');
      const state = await getBenchRunLiveState(runId);
      return state ? [state] : [];
    },
  },
  'evals.benchEstimate': {
    argsSchema: z.object({ taskSetId: z.string().optional(), cap: z.number().optional() }),
    resolve: async (args) => {
      const { taskSetId, cap } = args as { taskSetId?: string; cap?: number };
      const { estimateBenchLaunch } = await import('../external-bench/estimate');
      return [estimateBenchLaunch({ taskSetId, cap })];
    },
  },
  // operatorReports.latest — the newest operator `<report>` turns for the Overview
  // "Operator report" tile (overview-tab-expansion-2026-07-20 P-004). REUSE-FIRST:
  // a thin projection over the report-cards substrate (operator_turns.report jsonb,
  // mig 160, via readRecentOperatorReports — the SAME read the attention inbox's
  // operator-report source uses; 48h window, newest first, no mirror table). Each
  // row: turn identity + parsed title/excerpt + createdAt, EXPLICITLY the operator's
  // narrative account — the other Overview tiles read ground-truth state (D-002).
  'operatorReports.latest': {
    resolve: async () => {
      const [{ readRecentOperatorReports }, { parseReportBlock }] = await Promise.all([
        import('../attention/operator-report-source'),
        import('@papercusp/chat-protocol'),
      ]);
      const rows = await readRecentOperatorReports({ limit: 5 });
      return rows
        .flatMap((r) => {
          const rep = parseReportBlock(r.report);
          if (!rep) return [];
          const firstPlan = rep.plans?.[0];
          return [
            {
              turnId: r.turnId,
              conversationId: r.conversationId,
              createdAt: r.createdAt,
              title: rep.title ?? (r.text ? r.text.slice(0, 120) : 'Operator report'),
              excerpt: firstPlan?.summary ?? firstPlan?.title ?? (r.text ? r.text.slice(0, 200) : null),
              planCount: rep.plans?.length ?? 0,
            },
          ];
        })
        .slice(0, 3);
    },
  },

  // usage.spend — the 1h + 24h LLM spend/calls headline for the Overview Spend
  // tile (overview-tab-expansion-2026-07-20 P-003). A single envelope row
  // { h1:{spendUsd,calls}, h24:{spendUsd,calls} } over summarizeUsage (the SAME
  // aggregation the FleetRateControl wire's 1h read uses — one cost-honest
  // pipeline, two windows). Push-refreshed via the agent_usage_samples
  // append-heavy sweep (no per-row notify storm); the tile's staleTime is the
  // freshness floor between sweeps.
  'usage.spend': {
    resolve: async () => {
      const { summarizeUsage } = await import('../agent-usage-telemetry');
      const [h1, h24] = await Promise.all([summarizeUsage(60 * 60 * 1000), summarizeUsage(24 * 60 * 60 * 1000)]);
      return [
        {
          h1: { spendUsd: h1.spendUsd, calls: h1.calls },
          h24: { spendUsd: h24.spendUsd, calls: h24.calls },
        },
      ];
    },
  },

  // accounts.pool — the Queen's Claude Max account pool as a live read-model for
  // the Accounts tab (accounts-pool-tab-2026-06-15 P-001). One row per pool
  // account: the union of accounts:list + accounts:status (id/label/credentialRef/
  // boundTo/available/sustainedlyLimited/rate/liveBuckets) via accountStatus().
  // accounts:reset-rate / register / remove / link-complete fire
  // notifySyncInvalidate('accounts.pool') so the tab is live without polling.
  'accounts.pool': {
    // THE regression case (WI-6796 / EI-19304902443341820). This table is rewritten continuously by
    // the inference gateway (makeWindowProjector → recordAccountWindow) as it observes each
    // response's anthropic-ratelimit-unified-* headers — that stream IS this tab's live data — yet
    // the pool was in neither invalidation map for ~7 weeks. Pinned by the coverage guard.
    backingTables: ['harness_shared.operator_account_pool'],
    argsSchema: z.object({ workspace: z.string().min(1).optional() }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      const { accountStatus } = await import('../deployment/account-pool-store');
      const { activeWorkspaceId } = await import('../workspace-registry');
      return accountStatus(workspace ?? activeWorkspaceId());
    },
  },
  // codeRecipes — the corpus of reusable code:run RECIPES for the /admin/recipes
  // dashboard (code-recipes-2026-06-21 P-009). One row per recipe, newest-run then
  // most-run first — exactly listRecipes()'s order.
  //
  // GLOBAL, not hive-scoped: recipes are a reusable capability like a tool
  // DEFINITION (data-scoping-audit-2026-06-22 P-001, which REVERSED the earlier
  // hive-scoping D-005 — a good recipe should help every hive). `limit` is the only
  // argument; there is no harnessSlug/allHives scoping to pass. (This comment used
  // to describe the pre-P-001 D-005 hive scoping and args that do not exist —
  // corrected under WI-7085.)
  //
  // Rows are projected to the UI read set by code-recipes-ui-projection.ts, and the
  // `script` body is not selected at all (listRecipes returns CodeRecipeListRow):
  // together those took the payload from 2,936,018 B to the allowlisted ceiling —
  // it was the fattest sync read in the tree. See that file for the field census.
  //
  // The capture path (capture-recipe.ts), recipes:sweep, and recipes:merge fire
  // notifySyncInvalidate('codeRecipes') after committing, so the tab is live over
  // desktop SSE with no polling; the resource keys its rows-delta on `id`
  // (resource-delta-config.ts) so one capture re-sends one row, not the corpus.
  codeRecipes: {
    argsSchema: z
      .object({
        limit: clampedLimit(2000, 1000),
      })
      .optional(),
    resolve: async (args) => {
      const { limit } = (args ?? {}) as { limit?: number };
      const lim = limit ?? 1000;
      const [{ getOrgPg }, { listRecipes, countRecipes }, { projectCodeRecipeRows }] = await Promise.all([
        import('@papercusp/db-org'),
        import('../code-recipes-store'),
        import('./code-recipes-ui-projection'),
      ]);
      const sql = getOrgPg().sql;
      // Recipes are GLOBAL (P-001): capped list + cheap COUNT (no workspace/hive
      // filter), so the dashboard can show "N of TOTAL" via attachListMeta.
      const [rows, total] = await Promise.all([
        // Admin/management view shows the FULL corpus including low-value recipes —
        // they are the sweep/merge targets here, and it keeps the listed rows consistent
        // with countRecipes' total (P-004: the AGENT-facing recipes:list hides them).
        listRecipes(sql, { limit: lim, includeTrivial: true }),
        countRecipes(sql),
      ]);
      // Project to the UI read set BEFORE attachListMeta, so `_meta` (which the
      // client reads off row[0] via readListTotal) survives the projection.
      return attachListMeta(projectCodeRecipeRows(rows), { total }) as unknown[];
    },
  },

  // recipeCandidates — the Queen's deterministic graduation worklist for the
  // /admin/recipes dashboard's Candidates section (code-recipes-2026-06-21 P-009;
  // the read behind recipes:candidates). Returns a SINGLE envelope row
  // { promoteCandidates[], mergeClusters[] } (wrapped in a 1-elem array per the
  // resolver's flat-row contract — the same shape evals.benchEstimate uses). NO
  // LLM: the rubric scoring + the merge-cluster similarity legs (embedder +
  // tool-cooccurrence) run server-side, exactly like the tool handler. Invalidated
  // alongside codeRecipes on every recipe write (a sweep/merge/capture shifts the
  // candidate set), so the dashboard's worklist stays live.
  recipeCandidates: {
    // CLAMP, don't `.max()`-REJECT (clamp-not-reject, P-001/D-002): a newer UI
    // bundle sending minRunCount/limit above an older deployed resolver's cap must
    // not 400 the /admin/recipes Candidates section on a client/server skew. Both
    // stay optional (absent → the downstream recipeCandidates() defaults apply).
    argsSchema: z
      .object({
        minRunCount: clampedLimitOpt(1000),
        limit: clampedLimitOpt(100),
      })
      .optional(),
    resolve: async (args) => {
      const { minRunCount, limit } = (args ?? {}) as {
        minRunCount?: number;
        limit?: number;
      };
      const [
        { getOrgPg },
        { recipeCandidates },
        { activeWorkspaceId },
        { buildQueryEmbedder },
        { buildRecipeCooccurrenceDep },
      ] = await Promise.all([
        import('@papercusp/db-org'),
        import('../code-recipes-candidates'),
        import('../workspace-registry'),
        import('../agent-tools/search/embedder'),
        import('../recipe-cooccurrence-leg'),
      ]);
      const workspaceId = activeWorkspaceId();
      const embedder = await buildQueryEmbedder().catch(() => null);
      // recipes are global (P-001); the co-occurrence signal is workspace-scoped telemetry.
      const toolCooccurrence = await buildRecipeCooccurrenceDep(workspaceId).catch(() => null);
      const { promoteCandidates, mergeClusters } = await recipeCandidates(
        getOrgPg().sql,
        { minRunCount, limit },
        { embedder, toolCooccurrence },
      );
      return [{ promoteCandidates, mergeClusters }] as unknown[];
    },
  },

  // agentConfig.modelTiersBaseline — the effective workspace model-tier menu
  // for the Queen sidebar's session override editor. Settings writes invalidate
  // this query, so the sidebar tracks workspace-tier edits without raw fetches.
  'agentConfig.modelTiersBaseline': {
    argsSchema: z.object({}),
    resolve: async () => {
      const [{ readAgentConfig }, { DEFAULT_MODEL_TIERS }] = await Promise.all([
        import('../agent-config'),
        import('../agent-config-constants'),
      ]);
      const cfg = await readAgentConfig();
      return (cfg.tiers && cfg.tiers.length > 0 ? cfg.tiers : DEFAULT_MODEL_TIERS) as unknown[];
    },
  },

  // prReviewerSettings.byHarness — single-row-per-harness PR-reviewer settings
  // + trust list + audit log (all-active-surfaces-data-sync-migration-2026-07-11
  // P-011). Shares its response builder with the GET route handler
  // (buildPrReviewerSettingsResponse) so the sync path and the REST route never
  // drift. Bridged tables: pr_reviewer_settings / trusted_authors /
  // auto_review_audit (see ./table-to-query-names for the write invalidations).
  'prReviewerSettings.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string().trim().min(1) }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { buildPrReviewerSettingsResponse } = await import('../endpoint-route/routes/harness/pr-reviewer-settings');
      return [await buildPrReviewerSettingsResponse(harnessSlug)] as unknown[];
    },
  },
} satisfies Record<string, QueryEntry<unknown>>;

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Bound on a single query name's resolve() (EI-18106470827657366): a resolver
 * commonly awaits an unbounded downstream primitive (a PG-pool acquire, an fs
 * walk) with no timeout of its own. When that primitive wedges — e.g. a
 * starved getOrgPg pool, the same failure class dbos/pool-pressure.ts guards
 * on the routines-tick path — the resolve() promise never settles, and the
 * caller hangs indefinitely (observed: advRoster.list, self-recovered after
 * 5-8 minutes with zero visible error in between, HTTP 000 on the client the
 * whole time). This turns that silent indefinite hang into a fast, loud,
 * recoverable 500 (rest-query.ts already catches + surfaces any resolve()
 * rejection). Override via
 * PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS; comfortably under the ~15s window where
 * a client gives up and reports HTTP 000, so a wedge fails clearly on the
 * SERVER side first.
 */
const RESOLVER_TIMEOUT_MS = Number(process.env.PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS) || 10_000;

/**
 * Resolve a named query against the v2 registry. Returns flat rows on
 * success, NAME_NOT_FOUND if the name isn't registered yet (callers
 * fall back to the legacy resolver). Throws on schema-validation
 * failure, downstream errors, or a resolver that didn't settle within
 * RESOLVER_TIMEOUT_MS (QueryResolveTimeoutError) — the route handler maps
 * every throw to HTTP.
 */
export const resolveNamedQueryV2 = createResolver(REGISTRY as unknown as QueryRegistry, {
  timeoutMs: RESOLVER_TIMEOUT_MS,
});

/** Test-only — enumerate which names the v2 registry currently knows. */
export function knownQueryNamesV2(): string[] {
  return Object.keys(REGISTRY).sort();
}

/** Test-only — useful for assertions in migration progress tests. */
export function isRegisteredV2(name: string): boolean {
  return name in REGISTRY;
}

/**
 * Test-only — return one registry entry by name (or undefined) so tests can
 * assert each entry is STRUCTURALLY well-shaped (a callable `resolve`, an
 * optional `.parse`-bearing `argsSchema`) WITHOUT executing the resolver. The
 * old breadth check dispatched every entry against real PG/FS, so its runtime
 * scaled with (entry count × I/O latency) and repeatedly tripped the green gate
 * under load (timeout bumped 10s→30s→120s, then blown past 120s at ~123 entries
 * / load-90). Structural inspection catches the same bug class — a typo'd
 * `resolves:` key leaves `resolve` undefined — in O(1) per entry, no I/O.
 */
export function getRegistryEntryV2(name: string): QueryEntry<unknown> | undefined {
  return REGISTRY[name] as QueryEntry<unknown> | undefined;
}
