/**
 * sessions:timeline — reconstruct what an agent DID across a time window
 * (session-search-scope-2026-07-05 P-006): its transcript turns
 * (session_turns) + tool calls (tool_invocations.coord_owner_id) + coord
 * messages it sent (coord_event_log body->>'from'), merged newest-first.
 * The postmortem / "what happened in that lane" read.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import { resolveAgentIdentity } from '../coordination/identity';
import { restrictedTurnSql } from '../../personal-vault/transcript-exclusion';
import { isSessionShapedOwnerId } from '../coordination/dead-session-recipient-guidance';
import {
  knownOwnerIdSet,
  resolveRecipients,
  resolveRecipientsAgainst,
} from '../coordination/recipient-resolve';
import {
  SESSION_TURN_REF_PREFIX,
  sessionSearchEnabled,
  disabledResult,
  refreshLiveSessionsBeforeRead,
} from './_shared';
import {
  decodeSessionCursor,
  encodeSessionCursor,
  sessionCursorBoundsMatch,
  sessionCursorQueryFingerprint,
} from './cursor';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

type TimelineOwnerResolutionFailure = {
  ok: false;
  error: 'owner_resolution_unavailable' | 'owner_not_found' | 'owner_ambiguous';
  owner: string;
  matches?: string[];
  message: string;
};

type TimelineOwnerResolution = { ok: true; ownerId: string } | TimelineOwnerResolutionFailure;

/**
 * Resolve the display handle accepted by the historical reader to the
 * canonical owner id used by the timeline tables.
 *
 * Full session-shaped ids are intentionally kept verbatim: a historical
 * timeline must remain queryable after that live session has ended. Short
 * handles and non-session-shaped ids, however, must resolve against the live
 * roster before SQL construction; otherwise a valid short handle silently
 * produces an empty history. `resolveRecipients` is the shared normalization
 * seam. Its send-path fail-open behavior is retained for an unavailable
 * roster, so the extra membership check below turns that particular case into
 * an explicit historical-read error instead of accepting the literal handle.
 */
async function resolveTimelineOwner(
  owner: string,
  workspaceId?: string | null,
): Promise<TimelineOwnerResolution> {
  if (isSessionShapedOwnerId(owner)) return { ok: true, ownerId: owner };

  const resolution = await resolveRecipients([owner], workspaceId);
  const ambiguous = resolution.ambiguous[0];
  if (ambiguous) {
    return {
      ok: false,
      error: 'owner_ambiguous',
      owner,
      matches: ambiguous.matches,
      message: `Owner '${owner}' matches more than one live ownerId; pass the full ownerId.`,
    };
  }
  if (resolution.unknown.length > 0 || resolution.resolved.length === 0) {
    return {
      ok: false,
      error: 'owner_not_found',
      owner,
      message: `Owner '${owner}' matches no known ownerId; pass the full ownerId or check coord:presence.`,
    };
  }

  const resolved = resolution.resolved[0]!;
  if (resolved !== owner) return { ok: true, ownerId: resolved };

  // resolveRecipients deliberately passes entries through when no roster is
  // available. A historical reader cannot distinguish that passthrough from
  // an exact match without checking the shared cached roster itself.
  const known = await knownOwnerIdSet(workspaceId);
  if (!known) {
    return {
      ok: false,
      error: 'owner_resolution_unavailable',
      owner,
      message:
        `Cannot resolve owner '${owner}' because the live owner roster is unavailable. ` +
        'Retry with the full ownerId or after coord:presence is available.',
    };
  }
  const strict = resolveRecipientsAgainst([owner], [...known]);
  const strictAmbiguous = strict.ambiguous[0];
  if (strictAmbiguous) {
    return {
      ok: false,
      error: 'owner_ambiguous',
      owner,
      matches: strictAmbiguous.matches,
      message: `Owner '${owner}' matches more than one live ownerId; pass the full ownerId.`,
    };
  }
  if (strict.unknown.length > 0 || strict.resolved.length === 0) {
    return {
      ok: false,
      error: 'owner_not_found',
      owner,
      message: `Owner '${owner}' matches no known ownerId; pass the full ownerId or check coord:presence.`,
    };
  }
  return { ok: true, ownerId: strict.resolved[0]! };
}

function timelineOwnerResolutionError(failure: TimelineOwnerResolutionFailure) {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: failure.error,
          owner: failure.owner,
          ...(failure.matches ? { matches: failure.matches } : {}),
          message: failure.message,
        }),
      },
    ],
  };
}

/**
 * A timeline is a read-only forensic view, so transient PostgreSQL contention
 * is a retryable read outcome rather than an opaque handler failure. The
 * admin pool can raise either a raw SQLSTATE or a bounded transaction error;
 * keep this mapping in one place so every query leg shares the same contract.
 */
export function timelineContentionResult(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} | null {
  if (!isWorkspaceContended(error)) return null;
  const pgCode =
    error && typeof error === 'object' && typeof (error as { pgCode?: unknown }).pgCode === 'string'
      ? (error as { pgCode: string }).pgCode
      : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          error: 'timeout',
          retryable: true,
          ...(pgCode ? { pgCode } : {}),
          message:
            `sessions:timeline read hit transient database contention: ${detail}. ` +
            'No timeline entries were returned; retry shortly.',
        }),
      },
    ],
  };
}

/**
 * Keep the model-facing JSON body below the result door. The timeline can
 * still be read losslessly by paging with `nextCursor`; this cap only limits
 * the text block that has to fit in one agent turn.
 */
export const SESSION_TIMELINE_RESPONSE_BUDGET_CHARS = 4_800;
// Re-exported (EI-19984789589075138 / EI-19986796515232861) from the dependency-free
// automatic-tool-names.ts so other evidence-of-work checks — e.g. the cold-wake
// un-checkpointed-work banner (su-cold-loop.ts / loop.ts's countAgentToolCallsInWindow) —
// share this ONE classification without pulling this file's `@papercusp/agent-mcp`
// import (and its bootstrap side effects) into their own module graph.
export { AUTOMATIC_TOOL_NAMES } from './automatic-tool-names';
import {
  AGENT_CALL_ORIGINS,
  AUTOMATIC_CALL_ORIGINS,
  AUTOMATIC_TOOL_NAMES,
  agentToolInvocationPredicate,
  automaticToolInvocationPredicate,
} from './automatic-tool-names';
import { isWorkspaceContended } from '../locks/contention-retry';

/** One resolved watermark → how many live assumptions it covers (P-024 (c)).
 *  `watermark` is typed `string | number` because postgres-js returns BIGINT as
 *  a string — the same reason {@link TimelineEntry.assumption_set_id} is. */
interface AssumptionCountRow {
  watermark: string | number;
  n: number;
}

export interface AutomaticCallAuditRow {
  total_tool_calls: number;
  automatic_calls: number;
  agent_calls: number;
}

export function buildAutomaticCallAuditSummary(row: AutomaticCallAuditRow) {
  return {
    total_tool_calls: row.total_tool_calls,
    automatic_calls: row.automatic_calls,
    agent_calls: row.agent_calls,
    automatic_share:
      row.total_tool_calls > 0
        ? Number((row.automatic_calls / row.total_tool_calls).toFixed(4))
        : 0,
    classification: {
      automatic_tools: [...AUTOMATIC_TOOL_NAMES],
      automatic_origins: [...AUTOMATIC_CALL_ORIGINS],
      agent_origins: [...AGENT_CALL_ORIGINS],
      rule: 'explicit call_origin wins: hook/ui/system are automatic and agent/unknown are agent-authored; NULL rows use the legacy automatic tool-name set; include_auto=true shows all traffic',
    },
  };
}

export interface TimelineEntry {
  kind: 'turn' | 'tool' | 'coord';
  ts: string;
  ref: string;
  text: string;
  tool_name?: string | null;
  status?: string | null;
  auto?: boolean;
  /** Migration 809 provenance; NULL means the row predates origin tracking. */
  call_origin?: string | null;
  call_origin_source?: string | null;
  repeat_count?: number;
  oldest_ts?: string;
  /**
   * P-024 / D-046: the goal this call served, as a RESOLVED ref (`WI-6393`,
   * `plan:slug#P-009`) — never a raw bigint, which is not a read surface. Comes
   * straight off `tool_invocations.goal_ref`, which P-009 deliberately typed as
   * text so this projection needs no join. `tool` rows only; null when the agent
   * held no goal (or predates the stamp).
   */
  goal_ref?: string | null;
  /**
   * P-024: the assumption WATERMARK live at call time — every non-retracted,
   * non-superseded assumption of this owner with `agent_facts.id <= this`.
   * Resolving it to a COUNT is deliberately on-demand (see below).
   *
   * ⚠ `number | string` because postgres-js hands BIGINT back as a STRING (the
   * same reason the sibling `ref` column is written `id::text`). Typing this as
   * `number` alone would compile, pass every hand-built fixture, and then match
   * nothing at runtime — the resolver would silently resolve zero watermarks
   * with no error anywhere. Normalize through {@link toWatermark}, never with a
   * bare `typeof x === 'number'`.
   */
  assumption_set_id?: number | string | null;
  /**
   * P-024 (c): how many assumptions that watermark covers. Present ONLY on a
   * `goalRef`/`assumptionSetId`-filtered read — never eagerly per row, because
   * resolving it for every row of an unfiltered postmortem page is an N+1 over
   * `agent_facts`. Absent ⇒ not resolved, which is NOT the same as zero.
   */
  assumption_count?: number;
}

/**
 * Keep the lossless timeline object available as MCP structuredContent for
 * programmatic callers (ptool / MCP clients that request `_meta.structured`).
 * The human-facing text body is still subject to the ordinary result door, but
 * a large postmortem page must not become an invalid JSON prefix for a caller
 * that asked for machine-readable output.
 */
const timelineSuccessResultSchema = z.object({
  ok: z.literal(true),
  owner: z.string(),
  since: z.string(),
  until: z.string(),
  filters: z.record(z.string(), z.unknown()),
  stamp_coverage: z.object({
    goal_scoped: z.boolean(),
    assumption_sets_resolved: z.number().int().nonnegative(),
    assumptions_observed: z.number().int().nonnegative(),
    assumption_coverage: z.enum([
      'not-goal-scoped',
      'no-stamp',
      'producer-unbuilt',
      'none-for-owner',
      'observed',
    ]),
    assumption_zero_reason: z.string().optional(),
    zero_reason: z.string().optional(),
  }),
  raw_count: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  entriesTruncated: z
    .object({
      requested: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      raw_requested: z.number().int().nonnegative(),
      raw_returned: z.number().int().nonnegative(),
      reason: z.literal('response_budget'),
    })
    .optional(),
  audit_summary: z.object({
    total_tool_calls: z.number().int().nonnegative(),
    automatic_calls: z.number().int().nonnegative(),
    agent_calls: z.number().int().nonnegative(),
    automatic_share: z.number().min(0).max(1),
    classification: z.object({
      automatic_tools: z.array(z.string()),
      automatic_origins: z.array(z.string()),
      agent_origins: z.array(z.string()),
      rule: z.string(),
    }),
  }),
  entries: z.array(
    z.object({
      kind: z.enum(['turn', 'tool', 'coord']),
      ts: z.string(),
      ref: z.string(),
      text: z.string(),
      tool_name: z.string().nullable().optional(),
      status: z.string().nullable().optional(),
      auto: z.boolean().optional(),
      call_origin: z.string().nullable().optional(),
      call_origin_source: z.string().nullable().optional(),
      repeat_count: z.number().int().positive().optional(),
      oldest_ts: z.string().optional(),
      goal_ref: z.string().nullable().optional(),
      assumption_set_id: z.union([z.number(), z.string()]).nullable().optional(),
      assumption_count: z.number().int().nonnegative().optional(),
    }),
  ),
});

const timelineErrorResultSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
    retryable: z.boolean().optional(),
    pgCode: z.string().optional(),
    message: z.string().optional(),
    note: z.string().optional(),
    owner: z.string().optional(),
    matches: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * MCP outputSchema must describe every handler result, not only successful
 * pages. Otherwise a valid cursor/owner error cannot be attached as structured
 * content and strict MCP clients replace the useful error with -32600.
 */
export const timelineResultSchema = z.discriminatedUnion('ok', [
  timelineSuccessResultSchema,
  timelineErrorResultSchema,
]);

/**
 * P-024 (c): which assumption watermarks a page needs resolved — DISTINCT, and
 * only from `tool` rows that actually carry one.
 *
 * Pure + exported so the N+1 guard is directly testable: the whole point is that
 * a 300-row page resolves at most a handful of DISTINCT watermarks in ONE query,
 * never one query per row. An agent's watermark only moves when it asserts an
 * assumption (~0–3 per task), so in practice a long page collapses to 1–2 ids.
 */
export function toWatermark(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function assumptionSetIdsToResolve(rows: TimelineEntry[]): number[] {
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.kind !== 'tool') continue;
    const id = toWatermark(r.assumption_set_id);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * P-015: what a goal-scoped read's assumption counts ACTUALLY mean.
 *
 * ── THE EMPTY SET THIS EXISTS TO STOP BEING MISREAD ─────────────────────────
 *
 * {@link attachAssumptionCounts} already separates "not resolved" from "resolved
 * to zero" PER ROW. That is not enough, because the dangerous case is a page
 * where every watermark resolved cleanly and every count is 0. Nothing is
 * missing, no error fires, and the response reads exactly like a confident
 * finding: *"this agent assumed nothing."*
 *
 * Today that reading is FALSE for a reason no per-row field can express:
 * `kind='assumption'` has ZERO producers fleet-wide (WI-6465, 0 of 2,212 rows),
 * so no agent's count can be anything but 0. The number is UNINTERPRETABLE, not
 * clean — the same trichotomy P-001's census draws between `no-producer` and
 * `no-data`, and the same one D-101 draws for a metric whose companion is dead.
 *
 * ⚠ THE DISCRIMINATOR MUST BE GLOBAL, NOT PER-OWNER. "This owner has no
 * assumptions" cannot tell the two apart — it is equally true of an agent who
 * simply never asserted one. Only "does ANY assumption fact exist, for anyone"
 * separates an unbuilt producer from a genuine per-agent zero, which is why
 * {@link AssumptionCoverage.anyAssumptionExists} is a fleet-wide probe.
 *
 * Pure, so every state is testable without a database — including the two this
 * box cannot currently be in (a producer that exists, an owner who has none).
 */
export type AssumptionCoverageVerdict =
  /** Not a goal-scoped read; nothing was resolved and nothing is claimed. */
  | 'not-goal-scoped'
  /** Goal-scoped, but no row carried a watermark — the P-009 stamp never ran. */
  | 'no-stamp'
  /** Watermarks resolved, all zero, and no assumption exists anywhere: UNINTERPRETABLE. */
  | 'producer-unbuilt'
  /** Watermarks resolved, all zero, but assumptions DO exist elsewhere: a real finding. */
  | 'none-for-owner'
  /** Assumptions were actually observed. The only reading that needs no caveat. */
  | 'observed';

export interface AssumptionCoverage {
  goalScoped: boolean;
  /** Distinct watermarks expanded on this page. */
  setsResolved: number;
  /** Total assumptions across those watermarks. */
  assumptionsObserved: number;
  /**
   * Does ANY non-retracted assumption fact exist, for ANY owner? Probed only when
   * it can change the verdict (see above). `null` ⇒ not probed.
   */
  anyAssumptionExists: boolean | null;
}

export function judgeAssumptionCoverage(c: AssumptionCoverage): AssumptionCoverageVerdict {
  if (!c.goalScoped) return 'not-goal-scoped';
  if (c.setsResolved === 0) return 'no-stamp';
  if (c.assumptionsObserved > 0) return 'observed';
  // All resolved, all zero — the ambiguous case the global probe disambiguates.
  // Unprobed is reported as unbuilt rather than as a clean per-owner zero: an
  // unverified zero must not be the one that reads as a finding.
  return c.anyAssumptionExists === true ? 'none-for-owner' : 'producer-unbuilt';
}

/** Why a goal-scoped read's assumption counts are what they are, in the reader's words. */
export const ASSUMPTION_COVERAGE_REASONS: Readonly<
  Record<AssumptionCoverageVerdict, string | null>
> = Object.freeze({
  'not-goal-scoped': null,
  'no-stamp':
    'no tool call on this page carried an assumption watermark — the P-009 stamp did not run for these calls, so their assumption state is UNKNOWN, not empty',
  'producer-unbuilt':
    "every watermark resolved to ZERO assumptions, and no assumption fact exists anywhere — kind='assumption' currently has no producer (WI-6465). This count is UNINTERPRETABLE: it is NOT evidence that this agent assumed nothing, because no agent could have registered one",
  'none-for-owner':
    'every watermark resolved to ZERO assumptions for this owner, while assumptions DO exist elsewhere — so this is a genuine finding about this agent, not an unbuilt producer',
  observed: null,
});

/**
 * Attach `assumption_count` to each row from a watermark→count map.
 *
 * A watermark with NO entry in the map is left ABSENT rather than defaulted to
 * 0 — "not resolved" and "resolved to zero" are different facts, and this
 * column's producer is measured-empty today (D-089 §2), so a defaulted 0 would
 * read as "checked, no assumptions" on every row forever. Same zero-must-name-
 * itself discipline as D-086/D-087.
 */
export function attachAssumptionCounts(
  rows: TimelineEntry[],
  counts: ReadonlyMap<number, number>,
): TimelineEntry[] {
  return rows.map((r) => {
    if (r.kind !== 'tool') return r;
    const id = toWatermark(r.assumption_set_id);
    if (id === null || !counts.has(id)) return r;
    return { ...r, assumption_count: counts.get(id) };
  });
}

/** Collapse identical entries in one bounded window while preserving newest-first order. */
export function groupRepeatedTimelineEntries(rows: TimelineEntry[]): TimelineEntry[] {
  const grouped = new Map<string, TimelineEntry>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.tool_name ?? ''}\u0000${row.status ?? ''}\u0000${row.text}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row, repeat_count: 1, oldest_ts: row.ts });
      continue;
    }
    existing.repeat_count = (existing.repeat_count ?? 1) + 1;
    existing.oldest_ts = row.ts;
  }
  return [...grouped.values()];
}

export interface BoundedTimelineResponse {
  text: string;
  entries: TimelineEntry[];
  rawCount: number;
  count: number;
  hasMore: boolean;
  nextCursor?: string;
  entriesTruncated?: {
    requested: number;
    returned: number;
    raw_requested: number;
    raw_returned: number;
    reason: 'response_budget';
  };
}

/**
 * Serialize a timeline page without allowing the result door to cut JSON in
 * half. We trim a RAW prefix, then group that prefix (when requested), so the
 * cursor always advances over exactly the rows represented by the response.
 */
export function buildBoundedTimelineResponse(
  base: Record<string, unknown>,
  pageRows: TimelineEntry[],
  groupRepeated: boolean,
  sourceHasMore: boolean,
  offset: number,
  cursorForOffset: (nextOffset: number) => string | undefined,
  budget = SESSION_TIMELINE_RESPONSE_BUDGET_CHARS,
): BoundedTimelineResponse {
  const fullEntries = groupRepeated ? groupRepeatedTimelineEntries(pageRows) : pageRows;

  for (let rawCount = pageRows.length; rawCount >= 0; rawCount -= 1) {
    const candidateRows = pageRows.slice(0, rawCount);
    const entries = groupRepeated ? groupRepeatedTimelineEntries(candidateRows) : candidateRows;
    const truncated = rawCount < pageRows.length;
    const hasMore = sourceHasMore || truncated;
    const nextCursor = hasMore ? cursorForOffset(offset + rawCount) : undefined;
    const entriesTruncated = truncated
      ? {
          requested: fullEntries.length,
          returned: entries.length,
          raw_requested: pageRows.length,
          raw_returned: rawCount,
          reason: 'response_budget' as const,
        }
      : undefined;
    const payload = {
      ...base,
      raw_count: rawCount,
      count: entries.length,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      ...(entriesTruncated ? { entriesTruncated } : {}),
      entries,
    };
    const text = JSON.stringify(payload);
    if (text.length <= budget) {
      return {
        text,
        entries,
        rawCount,
        count: entries.length,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        ...(entriesTruncated ? { entriesTruncated } : {}),
      };
    }
  }

  // The envelope is intentionally small and every TimelineEntry is bounded by
  // the SELECT projections above, so the zero-row candidate should fit. Keep a
  // total fallback for future schema growth rather than returning invalid JSON.
  const hasMore = pageRows.length > 0 || sourceHasMore;
  const nextCursor = hasMore ? cursorForOffset(offset) : undefined;
  const entriesTruncated =
    pageRows.length > 0
      ? {
          requested: fullEntries.length,
          returned: 0,
          raw_requested: pageRows.length,
          raw_returned: 0,
          reason: 'response_budget' as const,
        }
      : undefined;
  const fallbackPayload = {
    ...base,
    raw_count: 0,
    count: 0,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    ...(entriesTruncated ? { entriesTruncated } : {}),
    entries: [],
  };
  return {
    text: JSON.stringify(fallbackPayload),
    entries: [],
    rawCount: 0,
    count: 0,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    ...(entriesTruncated ? { entriesTruncated } : {}),
  };
}

export default defineTool({
  name: 'sessions:timeline',
  needsWorkspaceTx: true,
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Merged activity timeline for ONE agent: transcript turns + tool calls + coord messages, newest-first. owner:'self' = the caller. Audit filters can select kind/tool/status/goalRef, hide automatic hook traffic (default), group repeats, continue with nextCursor, and report automatic-versus-agent tool-call counts. Tool rows carry the goal and assumptions that were live when each call was made.",
  guidance: {
    when: '"What did agent X actually do yesterday" — a postmortem / handoff-archaeology read joining speech + tool calls + coord traffic by owner and time. Also "what did they do while holding goal X, and under which assumptions": pass goalRef.',
    notWhen:
      'Searching for specific content — sessions:search. Live state — coord:presence / fleet:assignments (this is HISTORY). In particular do NOT read goal_ref/assumption_set_id to learn what an agent is assuming NOW — that is a per-call retrospective stamp; live state is the goal cell.',
    chaining:
      'Filter failures with kinds:["tool"], status:"invalid-input" (or another exact status); turn refs carry session id + turn idx → sessions:read. goalRef:"WI-6393" scopes to one goal and resolves each row\'s assumption_count; stamp_coverage says whether anything was actually resolved, so an empty result names its own cause.',
    seeAlso: ['sessions:search', 'dev:session_detail (one spawn drilldown)'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    // EI-22069000224788496: the cursor is an OFFSET (see cursorForOffset) — it carries
    // neither the owner nor the filters, so a continuation sent as `{ cursor }` alone is
    // refused for a missing `owner`, and the caller reads only Zod's "expected string,
    // received undefined". The response that handed them the cursor never restated the
    // requirement. A field-level `error` is the seam that reaches them: it replaces that
    // leaf at the moment of refusal and is not emitted into the JSON Schema, so it costs
    // no prompt weight. It covers the plain missing-owner call too, which is the same
    // question asked earlier.
    owner: z
      .string({
        error:
          "owner is required — sessions:timeline reads ONE agent's timeline; pass 'self' for yourself, " +
          'or an ownerId / short handle. A `cursor` does NOT carry it: the cursor is a position only, ' +
          'so a continuation must re-send the SAME owner and filters alongside it.',
      })
      .min(1)
      .max(120)
      .describe("Agent ownerId, short handle, or 'self'."),
    since: z.string().max(40).optional().describe('ISO lower bound (default: 24h ago).'),
    until: z.string().max(40).optional().describe('ISO upper bound (default: now).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(300)
      .optional()
      .describe('Max merged entries, 1..300 (default 100).'),
    kinds: z
      .array(z.enum(['turn', 'tool', 'coord']))
      .max(3)
      .optional()
      .describe('Only these entry kinds.'),
    tool: z.string().min(1).max(160).optional().describe('Exact tool name; implies tool entries.'),
    status: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('Exact tool-invocation status, e.g. invalid-input, error, timeout, ok.'),
    goalRef: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Only calls made while the agent held THIS goal (e.g. "WI-6393") — answers "what did they do under goal X" in one call. Implies tool entries, and resolves each row\'s assumption count.',
      ),
    include_auto: z
      .boolean()
      .optional()
      .describe(
        'Include automatic hook/status traffic such as activity:report, coord:glance, coord:inbox, and auto:true coord messages. Default false.',
      ),
    group_repeated: z
      .boolean()
      .optional()
      .describe(
        'Collapse identical entries in the returned window and add repeat_count/oldest_ts. Default false.',
      ),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'Opaque nextCursor from a prior sessions:timeline call. It is a POSITION only — re-send the same `owner` and filters with it; `{ cursor }` alone is refused, and different filters page a different result set.',
      ),
  }),
  result: timelineResultSchema,
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const tx = ctx.tx!;
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const identity = resolveAgentIdentity(ctx);
    const requestedOwner = args.owner === 'self' ? (identity.ownerId ?? '') : args.owner;
    const ownerResolution =
      args.owner === 'self'
        ? { ok: true as const, ownerId: requestedOwner }
        : await resolveTimelineOwner(requestedOwner, workspaceId);
    if (!ownerResolution.ok) return timelineOwnerResolutionError(ownerResolution);
    const owner = ownerResolution.ownerId;
    const limit = args.limit ?? 100;
    const kinds = args.kinds?.length ? args.kinds : null;
    const includeAuto = args.include_auto ?? false;
    const fingerprint = sessionCursorQueryFingerprint(
      { ...args },
      { workspaceId, selfOwnerId: args.owner === 'self' ? owner : undefined },
    );
    const cursor = decodeSessionCursor(args.cursor, 'sessions:timeline', fingerprint);
    if (!cursor.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...cursor, ok: false }) }],
      };
    }
    if (
      args.cursor &&
      !sessionCursorBoundsMatch({ since: args.since, until: args.until }, cursor.bounds)
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'invalid_cursor',
              message: 'Cursor bounds do not match the requested timeline bounds.',
            }),
          },
        ],
      };
    }
    const until = args.until ?? cursor.bounds.until ?? new Date().toISOString();
    const since =
      args.since ??
      cursor.bounds.since ??
      new Date(Date.parse(until) - 24 * 3600 * 1000).toISOString();
    const offset = cursor.offset;
    const fetchLimit = offset + limit + 1;
    try {
      await refreshLiveSessionsBeforeRead(tx, [owner]);
      const automaticToolPredicate = automaticToolInvocationPredicate(tx);
      const agentToolPredicate = agentToolInvocationPredicate(tx);

      // Each branch renders ts as TEXT, so the merge must order by the instant
      // (u.ts::timestamptz), not the text: text carries the session's UTC offset and
      // misorders across a DST fall-back hour (WI-10004628). A set-operation ORDER BY
      // accepts only output names, hence the derived table.
      const rows = await tx<TimelineEntry[]>`
      SELECT * FROM ((
        SELECT 'turn' AS kind, COALESCE(ts, ingested_at)::text AS ts,
               CONCAT(${SESSION_TURN_REF_PREFIX}::text, source_kind, ':', session_id, ':', turn_idx) AS ref,
               '[' || speaker || '] ' || left(text, 300) AS text,
               NULL::text AS tool_name, NULL::text AS status, false AS auto,
               NULL::text AS call_origin, NULL::text AS call_origin_source,
               NULL::text AS goal_ref, NULL::bigint AS assumption_set_id
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND owner = ${owner}
           AND COALESCE(ts, ingested_at) >= ${since}::timestamptz
           AND COALESCE(ts, ingested_at) < ${until}::timestamptz
           AND (${kinds}::text[] IS NULL OR 'turn' = ANY(${kinds}::text[]))
           -- D-006 reader rule (WI-10005570): another agent's disclosure-window turns never reach a timeline.
           AND NOT ${restrictedTurnSql(tx as unknown as Parameters<typeof restrictedTurnSql>[0], 'session_turns', [identity.ownerId]) as never}
           AND ${args.tool ?? null}::text IS NULL
           AND ${args.status ?? null}::text IS NULL
           AND ${args.goalRef ?? null}::text IS NULL
         ORDER BY COALESCE(ts, ingested_at) DESC LIMIT ${fetchLimit}
      )
      UNION ALL
      (
        SELECT 'tool' AS kind, invoked_at::text AS ts, id::text AS ref,
               tool_name || ' (' || COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status, '?') || COALESCE(', ' || duration_ms || 'ms', '') || ')' AS text,
               tool_name, COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status) AS status,
               ${automaticToolPredicate} AS auto,
               call_origin, call_origin_source,
               -- P-024 / D-046: two columns in an existing SELECT. goal_ref is
               -- already a RESOLVED ref (P-009 typed it text for exactly this),
               -- so there is no join and nothing to hydrate.
               goal_ref, assumption_set_id
          FROM harness_shared.tool_invocations
         WHERE coord_owner_id = ${owner}
           AND invoked_at >= ${since}::timestamptz AND invoked_at < ${until}::timestamptz
           AND (${kinds}::text[] IS NULL OR 'tool' = ANY(${kinds}::text[]))
           AND (${args.tool ?? null}::text IS NULL OR tool_name = ${args.tool ?? null})
           AND (${args.status ?? null}::text IS NULL OR COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status) = ${args.status ?? null})
           AND (${args.goalRef ?? null}::text IS NULL OR goal_ref = ${args.goalRef ?? null})
           AND (${includeAuto} OR ${agentToolPredicate})
         ORDER BY invoked_at DESC LIMIT ${fetchLimit}
      )
      UNION ALL
      (
        SELECT 'coord' AS kind, ts::text AS ts, msg_id AS ref,
               left(COALESCE(body->>'summary', body->>'body', ''), 300) AS text,
               NULL::text AS tool_name, NULL::text AS status,
               COALESCE(body->>'auto', 'false') = 'true' AS auto,
               NULL::text AS call_origin, NULL::text AS call_origin_source,
               NULL::text AS goal_ref, NULL::bigint AS assumption_set_id
          FROM harness_shared.coord_event_log
         WHERE surface = 'messages' AND body->>'from' = ${owner}
           AND ts >= ${since}::timestamptz AND ts < ${until}::timestamptz
           AND (${kinds}::text[] IS NULL OR 'coord' = ANY(${kinds}::text[]))
           AND ${args.tool ?? null}::text IS NULL
           AND ${args.status ?? null}::text IS NULL
           AND ${args.goalRef ?? null}::text IS NULL
           AND (${includeAuto} OR COALESCE(body->>'auto', 'false') <> 'true')
         ORDER BY coord_event_log.ts DESC LIMIT ${fetchLimit}
      )) u
      ORDER BY u.ts::timestamptz DESC
      LIMIT ${fetchLimit}
    `;

      const hasMore = rows.length > offset + limit;
      let pageRows = rows.slice(offset, offset + limit);

      // P-024 (c): resolve the assumption SET only on a goal-scoped read, and only
      // for the DISTINCT watermarks this page actually carries — ONE query, never
      // one per row. An unfiltered postmortem page skips this entirely, which is
      // the whole point: eager resolution would turn the ordinary "what did agent
      // X do yesterday" read into an N+1 over agent_facts.
      //
      // The watermark→set expansion mirrors isAssumptionFact (D-087 R2): `kind`
      // when declared WINS, else the pre-migration-690 legacy form
      // confidence='suspected'. A kind-only count here would silently read 0 for
      // every legacy assumption while passing every fixture that sets the new field
      // — the exact defect the facts:assert guard caught one item ago.
      let assumptionSetsResolved = 0;
      let assumptionsObserved = 0;
      let anyAssumptionExists: boolean | null = null;
      if (args.goalRef) {
        const wanted = assumptionSetIdsToResolve(pageRows);
        if (wanted.length > 0) {
          const countRows = await tx<AssumptionCountRow[]>`
          SELECT w.watermark::bigint AS watermark,
                 count(f.id)::int AS n
            FROM unnest(${wanted}::bigint[]) AS w(watermark)
            LEFT JOIN harness_shared.agent_facts f
              ON f.created_by = ${owner}
             AND f.id <= w.watermark
             AND f.retracted_at IS NULL
             AND f.superseded_at IS NULL
             AND (CASE WHEN f.kind IS NOT NULL THEN f.kind = 'assumption'
                       ELSE f.confidence = 'suspected' END)
           GROUP BY w.watermark
        `;
          const counts = new Map<number, number>(
            countRows.map((r: AssumptionCountRow): [number, number] => [
              Number(r.watermark),
              Number(r.n),
            ]),
          );
          pageRows = attachAssumptionCounts(pageRows, counts);
          assumptionSetsResolved = counts.size;
          for (const n of counts.values()) assumptionsObserved += n;
        }
        // P-015: only when every resolved watermark came back ZERO is the reading
        // ambiguous, and only then is the global probe worth a query. It asks a
        // fleet-wide question on purpose — a per-owner count cannot separate "no
        // producer exists" from "this agent never asserted one", and the whole
        // failure being prevented is an empty set that reads as the latter.
        if (assumptionSetsResolved > 0 && assumptionsObserved === 0) {
          const [existsRow] = await tx<{ any_exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM harness_shared.agent_facts f
             WHERE f.retracted_at IS NULL
               AND f.superseded_at IS NULL
               AND (CASE WHEN f.kind IS NOT NULL THEN f.kind = 'assumption'
                         ELSE f.confidence = 'suspected' END)
             LIMIT 1
          ) AS any_exists
        `;
          anyAssumptionExists = Boolean(existsRow?.any_exists);
        }
      }
      const assumptionVerdict = judgeAssumptionCoverage({
        goalScoped: Boolean(args.goalRef),
        setsResolved: assumptionSetsResolved,
        assumptionsObserved,
        anyAssumptionExists,
      });

      const [auditRow = { total_tool_calls: 0, automatic_calls: 0, agent_calls: 0 }] = await tx<
        AutomaticCallAuditRow[]
      >`
      SELECT count(*)::int AS total_tool_calls,
             count(*) FILTER (WHERE ${automaticToolPredicate})::int AS automatic_calls,
             count(*) FILTER (WHERE ${agentToolPredicate})::int AS agent_calls
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ${owner}
         AND invoked_at >= ${since}::timestamptz AND invoked_at < ${until}::timestamptz
         AND (${args.tool ?? null}::text IS NULL OR tool_name = ${args.tool ?? null})
         AND (${args.status ?? null}::text IS NULL OR COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status) = ${args.status ?? null})
    `;
      // P-024 ACCEPTANCE / D-046 FLOOR: adoption of this read is measured on
      // the goalRef filter, and if it is never passed it is P-009's STAMP
      // that gets cut, not this projection. Reporting the resolution here
      // makes an empty goal-scoped read self-describing: goal_scoped tells
      // you the filter ran, assumption_sets_resolved tells you whether any
      // watermark was actually expanded — so `count: 0` can never be read as
      // "this agent did nothing under that goal" when it really means "no
      // call ever carried that goal_ref".
      const baseResponse = {
        ok: true,
        owner,
        since,
        until,
        filters: {
          ...(kinds ? { kinds } : {}),
          ...(args.tool ? { tool: args.tool } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.goalRef ? { goalRef: args.goalRef } : {}),
          include_auto: includeAuto,
          group_repeated: args.group_repeated ?? false,
        },
        stamp_coverage: {
          goal_scoped: Boolean(args.goalRef),
          assumption_sets_resolved: assumptionSetsResolved,
          // P-015: the counts alone cannot say what a zero MEANS, so the
          // verdict ships with them. Without this, a page of cleanly-resolved
          // zeros reads as "this agent assumed nothing" when the truth is that
          // nothing can assume anything yet (WI-6465).
          assumptions_observed: assumptionsObserved,
          assumption_coverage: assumptionVerdict,
          ...(ASSUMPTION_COVERAGE_REASONS[assumptionVerdict]
            ? { assumption_zero_reason: ASSUMPTION_COVERAGE_REASONS[assumptionVerdict] }
            : {}),
          ...(args.goalRef && pageRows.length === 0
            ? {
                zero_reason:
                  'no tool call in this window carried that goal_ref — either the agent never held it, or the calls predate the P-009 stamp',
              }
            : {}),
        },
        audit_summary: buildAutomaticCallAuditSummary(auditRow),
      };
      const bounded = buildBoundedTimelineResponse(
        baseResponse,
        pageRows,
        args.group_repeated ?? false,
        hasMore,
        offset,
        (nextOffset) =>
          encodeSessionCursor('sessions:timeline', nextOffset, fingerprint, { since, until }),
      );
      return { content: [{ type: 'text' as const, text: bounded.text }] };
    } catch (error) {
      const contention = timelineContentionResult(error);
      if (contention) return contention;
      throw error;
    }
  },
});
