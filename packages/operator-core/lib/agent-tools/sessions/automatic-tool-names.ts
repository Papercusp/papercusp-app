/**
 * The set of tool names classified as AUTOMATIC (hook/status calls a session makes
 * without agent judgment) rather than AGENT-authored. Shared by sessions:timeline's
 * activity audit and loop.ts's cold-wake evidence check (countAgentToolCallsInWindow,
 * EI-19984789589075138) so the two classifications can't drift apart.
 *
 * Deliberately dependency-free (no `@papercusp/agent-mcp`, no DB client). loop.ts is
 * a core routines module reachable from many lightweight import graphs (tests,
 * scripts, the loop-fire path) — EI-19986796515232861 measured that having loop.ts
 * import this constant from `./timeline` instead pulled in agent-mcp's WHOLE
 * bootstrap chain (timeline.ts imports `defineTool`/`SU_ROLES` from
 * `@papercusp/agent-mcp`, whose index.ts unconditionally `import`s `./bootstrap`,
 * which side-effect-registers the full read-tool catalog, several of which read
 * `generated.*` schema exports from `@papercusp/db-org` AT MODULE LOAD — see EI-362).
 * That silently broke any test importing loop.ts whose db-org mock used a bare
 * factory instead of spreading `importOriginal`. Keep this file free of any import
 * that could reintroduce that chain.
 */
import type { Sql } from 'postgres';

export const AUTOMATIC_TOOL_NAMES = ['activity:report', 'coord:glance', 'coord:inbox'] as const;

/**
 * EI-20543456503122446: calls that WRITE the very carry surfaces a "did any work happen
 * after the note?" question is asked ABOUT. These are agent-authored (the model chooses
 * them), so they are deliberately NOT in AUTOMATIC_TOOL_NAMES — sessions:timeline's
 * activity audit must keep counting them as real agent behavior, and folding them in
 * there would silently rewrite that audit too.
 *
 * They matter only to countAgentToolCallsInWindow, whose window OPENS at the carry
 * note's `updated_at`. A tool_invocations row is stamped at INSERT, after the handler's
 * write commits — measured on this very path: note updated_at 18:20:06.840Z, its own
 * loop:checkpoint row invoked_at 18:20:07.136Z (duration 391ms). So the note-writing
 * call always lands strictly INSIDE (noteUpdatedAt, lastTurnAt] and counts ITSELF as
 * evidence of post-note work. Every session that checkpoints and then dies therefore
 * scored >= 1 by construction, and a session that never checkpointed has no note for
 * the banner to be stale against — leaving the guard structurally dead in exactly the
 * case it was built for (a usage-wall bounce that did nothing).
 *
 * Excluding them cannot suppress a REAL alarm: work that actually happened leaves other
 * agent-authored rows in the same window, so the count only reaches 0 when these
 * bookkeeping calls were the ONLY thing that happened — which is precisely the
 * bounced-fire case. And their content is by definition already checkpointed, so there
 * is nothing un-checkpointed for a successor to recover from them.
 */
export const CARRY_NOTE_BOOKKEEPING_TOOL_NAMES = [
  'loop:checkpoint',
  'work_items:checkpoint',
] as const;

/**
 * Explicit origins are the source of truth once migration 809 has stamped a row.
 * NULL means the row predates origin tracking, so it deliberately falls back to the
 * legacy tool-name classification. Keep these lists beside the fallback names so
 * every behavior reader composes the same contract.
 */
export const AUTOMATIC_CALL_ORIGINS = ['hook', 'ui', 'system'] as const;
export const AGENT_CALL_ORIGINS = ['agent', 'unknown'] as const;

export type ToolInvocationBehavior = 'automatic' | 'agent' | 'unclassified';

/**
 * Classify one telemetry row for behavior-facing readers.
 *
 * Explicit origins always override the legacy tool-name list. Only pre-migration
 * NULL origins use that list; an invalid non-NULL value stays visible as
 * `unclassified` instead of being silently counted as agent behavior.
 */
export function classifyToolInvocationBehavior(
  toolName: string,
  callOrigin: string | null | undefined,
): ToolInvocationBehavior {
  if (callOrigin == null) {
    return (AUTOMATIC_TOOL_NAMES as readonly string[]).includes(toolName)
      ? 'automatic'
      : 'agent';
  }
  if ((AUTOMATIC_CALL_ORIGINS as readonly string[]).includes(callOrigin)) {
    return 'automatic';
  }
  if ((AGENT_CALL_ORIGINS as readonly string[]).includes(callOrigin)) {
    return 'agent';
  }
  return 'unclassified';
}

/**
 * P-012 (goal-mode-design-intent-hardening-2026-08-16): the metadata_json key a
 * DISPATCH WRAPPER stamps on its own telemetry row. tools:invoke and a
 * tool-dispatching code:run / recipes:run produce TWO rows per logical call — the
 * wrapper's own row plus the inner tool's row from its own dispatch — so a raw
 * tool_name census overstates ~2x on that path. The wrapper row is the overhead
 * row (the inner name is the real subject), so census surfaces exclude marked
 * rows by default via the predicates below. Write side: the handlers stamp it
 * through ctx.metadata, gated by TELEMETRY_DISPATCH_WRAPPER_MARK (see
 * telemetry-dispatch-wrapper.ts) — flag OFF stops marking, and unmarked rows are
 * excluded by nothing, restoring pre-P-012 counts end-to-end with one lever.
 */
export const DISPATCH_WRAPPER_METADATA_KEY = 'dispatchWrapper';

/** Plain-string census predicate (true = KEEP the row) for raw SQL constants that
 *  are not built through a `sql` tag. NULL/absent metadata keeps the row. */
export const DISPATCH_WRAPPER_EXCLUSION_SQL =
  `NOT coalesce((metadata_json->>'${DISPATCH_WRAPPER_METADATA_KEY}')::boolean, false)`;

/** `sql`-tag form of {@link DISPATCH_WRAPPER_EXCLUSION_SQL}, alias-aware like the
 *  behavior predicates below (alias is an internal identifier from the reader,
 *  never caller input — postgres cannot parameterize column names). */
export function dispatchWrapperExclusionPredicate(sql: Sql, alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  const metadata = sql.unsafe(`${prefix}metadata_json`);
  return sql`NOT coalesce((${metadata}->>${DISPATCH_WRAPPER_METADATA_KEY})::boolean, false)`;
}

/** Pure row-side classifier for TS readers that already hold the parsed metadata. */
export function isDispatchWrapperMetadata(metadataJson: unknown): boolean {
  return (
    typeof metadataJson === 'object' &&
    metadataJson !== null &&
    (metadataJson as Record<string, unknown>)[DISPATCH_WRAPPER_METADATA_KEY] === true
  );
}

/**
 * SQL fragment for automatic traffic. The optional alias is restricted to an
 * internal identifier supplied by these two readers, then passed through
 * `sql.unsafe` because postgres cannot parameterize column names.
 */
export function automaticToolInvocationPredicate(
  sql: Sql,
  alias?: string,
) {
  const prefix = alias ? `${alias}.` : '';
  const callOrigin = sql.unsafe(`${prefix}call_origin`);
  const toolName = sql.unsafe(`${prefix}tool_name`);
  return sql`(
    ${callOrigin} = ANY(${sql.array([...AUTOMATIC_CALL_ORIGINS])}::text[])
    OR (${callOrigin} IS NULL AND ${toolName} = ANY(${sql.array([...AUTOMATIC_TOOL_NAMES])}::text[]))
  )`;
}

/** SQL fragment for agent-authored behavior, preserving legacy NULL rows. */
export function agentToolInvocationPredicate(
  sql: Sql,
  alias?: string,
) {
  const prefix = alias ? `${alias}.` : '';
  const callOrigin = sql.unsafe(`${prefix}call_origin`);
  const toolName = sql.unsafe(`${prefix}tool_name`);
  return sql`(
    ${callOrigin} = ANY(${sql.array([...AGENT_CALL_ORIGINS])}::text[])
    OR (${callOrigin} IS NULL AND ${toolName} <> ALL(${sql.array([...AUTOMATIC_TOOL_NAMES])}::text[]))
  )`;
}
