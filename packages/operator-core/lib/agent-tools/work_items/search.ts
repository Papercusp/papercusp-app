/**
 * work_items:search — cross-kind full-text search over the unified surface
 * (parity with issues:search / features search). Searches both kind-tables and
 * merges the matches; filter by harness / kind.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { searchWorkItems, type WorkItem, type WorkItemKind } from '../../work-items';

/**
 * A search result is a deduplication hint, not a work-item detail read. Returning
 * the complete WorkItem here used to put the unbounded `payload` and terminal
 * evidence of every hit on one JSON line. A bounded query could therefore still
 * overflow the result door before ptool saw complete JSON (EI-20242958830709441).
 * Full state remains available through work_items:get { id }.
 */
const SEARCH_TITLE_CHARS = 180;
const SEARCH_SUMMARY_CHARS = 240;

export interface WorkItemSearchMatch {
  id: string;
  kind: string;
  family: string;
  harness: string | null;
  title: string;
  summary: string;
  state: string;
  severity: string | null;
  title_truncated?: true;
  title_full_chars?: number;
  summary_truncated?: true;
  summary_full_chars?: number;
}

function clipSearchText(value: string, maxChars: number): { value: string; truncated: boolean; fullChars: number } {
  if (value.length <= maxChars) return { value, truncated: false, fullChars: value.length };
  return { value: `${value.slice(0, maxChars - 1)}…`, truncated: true, fullChars: value.length };
}

/** Project one hydrated WorkItem to the compact, machine-readable search row. */
export function projectWorkItemSearchMatch(item: WorkItem): WorkItemSearchMatch {
  const title = clipSearchText(item.title, SEARCH_TITLE_CHARS);
  const summary = clipSearchText(item.summary ?? '', SEARCH_SUMMARY_CHARS);
  return {
    id: item.id,
    kind: item.kind,
    family: item.family,
    harness: item.harness,
    title: title.value,
    summary: summary.value,
    state: item.state,
    severity: item.severity,
    ...(title.truncated ? { title_truncated: true, title_full_chars: title.fullChars } : {}),
    ...(summary.truncated ? { summary_truncated: true, summary_full_chars: summary.fullChars } : {}),
  };
}

const SEARCH_TIER_CAPS = {
  standard: { rows: 40, title: 160, summary: 180 },
  trimmed: { rows: 20, title: 120, summary: 120 },
} as const;

/**
 * Keep the tiered/default search response bounded even when a caller asks for a
 * large result page. The omitted count is explicit; callers can narrow the query
 * or ask work_items:get for selected ids rather than mistaking a short page for
 * an empty/degraded search.
 */
export function shapeWorkItemsSearch(data: unknown, tier: keyof typeof SEARCH_TIER_CAPS): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const envelope = data as Record<string, unknown>;
  if (!Array.isArray(envelope.items)) return data;
  const caps = SEARCH_TIER_CAPS[tier];
  const items = envelope.items
    .slice(0, caps.rows)
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const match = row as Record<string, unknown>;
      const title = clipSearchText(typeof match.title === 'string' ? match.title : '', caps.title);
      const summary = clipSearchText(typeof match.summary === 'string' ? match.summary : '', caps.summary);
      const projected: Record<string, unknown> = { ...match, title: title.value, summary: summary.value };
      if (title.truncated || match.title_truncated === true) {
        projected.title_truncated = true;
        projected.title_full_chars = match.title_full_chars ?? title.fullChars;
      }
      if (summary.truncated || match.summary_truncated === true) {
        projected.summary_truncated = true;
        projected.summary_full_chars = match.summary_full_chars ?? summary.fullChars;
      }
      return projected;
    });
  const truncated = envelope.items.length > caps.rows;
  return {
    ...envelope,
    items,
    ...(truncated
      ? {
          returnedCount: items.length,
          truncated: true,
          note: `showing ${items.length} of ${envelope.items.length} matches — narrow the query or use work_items:get { id } for detail`,
        }
      : {}),
  };
}

export default defineTool({
  name: 'work_items:search',
  profile: 'engineer',
  description: 'Search work-items across kinds (feature/chunk/bug/change/task): full-text over title + body/summary FUSED (RRF) with a semantic (embedding cosine) leg, so differently-worded matches surface too (semantic:false for lexical-only). Filter by harness or kind. The required free-text argument is `query` — `q` is not an alias. Use to dedup before creating. Returns compact match rows in { ok, count, items, legs, retryable, retry? } — use work_items:get { id } for full state; NOTE the matches array is `items`, not `results` (unlike work_items:get/list, which use `results`). READ `legs` before concluding "no duplicate exists": legs.degraded:true means a ranking leg did not contribute (legs.warning says why, e.g. the embedder is down), so a short list may be a degraded search rather than an absence. When `retryable:true`, retry before treating the result as a verified-empty or creating a new item. A cold query-embedder warmup includes a stable `retry.token` shared by concurrent calls and `retry.afterMs` guidance.',
  guidance: {
    when: 'You want to find existing work-items by free text (e.g. dedup before filing, or locate a known issue/feature).',
    chaining: 'work_items:search (dedup) → work_items:create, or → work_items:get { id } for detail.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  // EI-20191189382971662: searchWorkItems owns its database scopes and this
  // handler never reads ctx.tx. Do not hold the ambient workspace transaction
  // across hybrid-search awaits, or fleet load can starve the org-app pool.
  skipWorkspaceTx: true,
  // The handler returns structured data so the framework can apply the
  // context-tier projection. It previously returned a raw content[] JSON blob,
  // which bypassed payload-tier shaping entirely.
  shape: {
    standard: (data) => shapeWorkItemsSearch(data, 'standard'),
    trimmed: (data) => shapeWorkItemsSearch(data, 'trimmed'),
  },
  agentRoles: [...COORD_ROLES],
  args: z.object({
    query: z
      .string()
      .min(1)
      .max(400)
      .describe('Required free-text search input. Use `query`; `q` is not an alias.'),
    harness: z.string().max(80).optional(),
    // P-001/P-011 generic-kind: a built-in kind OR a workspace-registered generic-kind
    // datatype. familyOf() routes it to the feature family + featureFamilyKindClause admits
    // it, so the filter works; an unknown kind simply yields no matches. Enum-locking this
    // blocked filtering search by a declared datatype. Mirrors work_items:create.
    kind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype',
      ),
    limit: z.number().int().positive().max(200).optional(),
    semantic: z
      .boolean()
      .optional()
      .describe('default true: merge embedding-cosine hits after the lexical ones (fail-open). false = lexical-only.'),
    includeObservations: z
      .boolean()
      .optional()
      .describe(
        "EI-10422: by default a payload.lane:'observation' row (a turn-end reflection / rubric scorecard filed via improvements:capture { lane:'observation' }) is EXCLUDED from matches — by design (D-005) it never enters the work queue/triage. Pass true to include raw observations in search results.",
      ),
  }),
  async handler(args) {
    const { items, legs, retry } = await searchWorkItems(args.query, {
      harness: args.harness,
      kind: args.kind as WorkItemKind | undefined,
      limit: args.limit,
      semantic: args.semantic,
      includeObservations: args.includeObservations,
    });
    // P-016/P-020: report which ranking legs actually ran and contributed.
    // A dedup search that silently fell back to lexical-only (embedder down,
    // embeddings not backfilled) returns a plausible SHORT list and reads as
    // "no duplicate exists" — the one reading that makes this tool actively
    // harmful. `degraded` says so; the per-leg counts say why.
    return {
      data: {
        ok: true,
        count: items.length,
        items: items.map(projectWorkItemSearchMatch),
        legs,
        // A degraded search is fail-open for availability, but it is not a
        // sound dedup answer. Give callers a machine-readable receipt so a
        // `count: 0` result cannot be mistaken for a verified-empty search.
        retryable: legs.degraded,
        ...(retry ? { retry } : {}),
      },
    };
  },
});
