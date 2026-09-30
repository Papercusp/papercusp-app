/**
 * invalid-args-miner.ts — WI-5017: mine `harness_shared.tool_invocations`
 * invalid-input rows into improvement candidates.
 *
 * [owner 2026-07-15 "do we have anything that logs the args that agents
 * try to pass but aren't valid? If not what do you think about adding one?"]
 * The LOGGING already exists: every rejected call (route-stack.ts's `input`
 * step / tooldef's dispatch-stack.ts) stamps `status='invalid-input'`,
 * `error_code='invalid_input'`, the full `error_message`, and the offending
 * `args_json` onto `harness_shared.tool_invocations`. What was missing was the
 * CONSUMER — nothing mined these rows for RECURRING patterns, so a schema-
 * confusion discovery stayed anecdotal (EI-10897's `body`/`comment` alias on
 * `work_items:comment` only happened because a human noticed agents
 * repeatedly passing `comment`; that discovery should be mechanical).
 *
 * The existing `repeated-tool-error` collector (watchdog.ts) explicitly
 * excludes these rows (`status IN ('error', 'timeout')`) — this is a
 * deliberately SEPARATE, WEEKLY, capture-only routine
 * (`system:improvement-invalid-args-miner`), not folded into the 15-min
 * watchdog tick: the signal here is a slow-accumulating cross-agent DX
 * pattern, not something that needs sub-hour freshness, and per-(tool,
 * offending-key) aggregation is a different shape than the watchdog's
 * per-(tool, error-CLASS) aggregation.
 *
 * Threshold to kill noise (kills a one-off typo from becoming a filed item):
 * a (tool, key) pair only files when it recurs across >= minDistinctOwners
 * distinct agents OR >= minOccurrences raw occurrences in the window — either
 * bar alone is enough (a single agent hammering the same wrong arg 10x is as
 * real a signal as 3 different agents each hitting it once).
 *
 * A recurring (tool, key) pair is either (a) an alias candidate (like
 * EI-10897), (b) a confusing schema field to rename, or (c) an agent-prior
 * drift to correct in guidance — the filed `change` leaves that call to a
 * human/triage pass; this module only surfaces the pattern with evidence.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { captureImprovement, type CaptureImprovementResult, type CaptureDeps } from './capture-core';
import { isImprovementLoopTool } from './watchdog';

type Sql = ReturnType<typeof getOrgPg>['sql'];

export interface InvalidArgsRow {
  tool_name: string;
  error_message: string | null;
  args_json: unknown;
  coord_owner_id: string | null;
  invoked_at: string | Date;
}

export interface InvalidArgsAggregate {
  tool: string;
  key: string;
  count: number;
  distinctOwners: number;
  sampleArgs: unknown;
  sampleMessage: string;
  /** ISO timestamp of the most recent occurrence in this aggregate. */
  latestAt: string;
}

export interface InvalidArgsMinerOptions {
  /** Lookback window. Default 7 days. */
  windowDays?: number;
  /** File a candidate once it recurs across at least this many distinct callers... */
  minDistinctOwners?: number;
  /** ...OR at least this many raw occurrences in the window (either bar fires). */
  minOccurrences?: number;
  /** Cap on candidates captured in one tick (anti-flood, mirrors the watchdog). */
  maxPerTick?: number;
}

export const DEFAULT_INVALID_ARGS_WINDOW_DAYS = 7;
export const DEFAULT_INVALID_ARGS_MIN_DISTINCT_OWNERS = 3;
export const DEFAULT_INVALID_ARGS_MIN_OCCURRENCES = 10;
export const DEFAULT_INVALID_ARGS_MAX_PER_TICK = 5;

/**
 * Pure: extract the offending arg key from a stored invalid-input
 * `error_message`. Two shapes occur in practice (standard-schema.ts's
 * `formatIssues` / route-stack.ts's zod-issue join — both render
 * `"${path}: ${message}"` per issue, joined with '; '):
 *
 *   - path-prefixed  — "coordNotes: Required" / "id: Expected string,
 *     received number" → the leading path segment before the first
 *     top-level ": " is the key.
 *   - root-level (unrecognized/extra key — the issue has NO path, since it's
 *     reported on the object itself) — "Unrecognized key(s) in object:
 *     'unreadOnly'" / `Unrecognized key: "unreadOnly"` → the quoted token is
 *     the key.
 *
 * Returns null when neither shape matches — kept OUT of the aggregate rather
 * than lumped into a per-tool catch-all bucket that could mask a real signal
 * behind noise.
 */
/**
 * EI-22170146677569151: known error-CODE tokens that some message shapes
 * (define-tool.ts's dispatch-stack path: `` `invalid_args: ${formatIssues(...)}` ``)
 * embed as a literal prefix on the message TEXT itself, ahead of the real
 * per-issue path list. Such a prefix has the same "identifier followed by
 * ': '" shape as a genuine zod-issue path, so without stripping it first the
 * path-prefixed branch below extracts the CODE and mistakes it for the
 * offending FIELD (measured: 9 of the top 12 mined pairs were this pseudo-key).
 */
const CODE_PREFIX_KEYS: ReadonlySet<string> = new Set(['invalid_args', 'invalid_input']);

export function extractOffendingKey(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null;
  let msg = errorMessage.trim();
  const unrecognized = msg.match(/Unrecognized key\(?s?\)?[^:]*:\s*['"]([a-zA-Z0-9_]+)['"]/i);
  if (unrecognized) return unrecognized[1];
  for (const codeKey of CODE_PREFIX_KEYS) {
    const prefix = `${codeKey}: `;
    if (msg.startsWith(prefix)) {
      msg = msg.slice(prefix.length);
      break;
    }
  }
  const firstClause = msg.split('; ')[0] ?? '';
  const pathMatch = firstClause.match(/^([a-zA-Z0-9_]+)(?:\.[a-zA-Z0-9_[\]]+)*:\s/);
  if (pathMatch && !CODE_PREFIX_KEYS.has(pathMatch[1])) return pathMatch[1];
  return null;
}

/**
 * Pure: group raw invalid-input rows into (tool, key) aggregates, dropping
 * any pair that doesn't clear the recurrence bar. Sorted highest-signal first
 * (most distinct callers, then most occurrences) so `maxPerTick` keeps the
 * strongest evidence.
 */
export function planInvalidArgsSignals(
  rows: readonly InvalidArgsRow[],
  opts: Pick<InvalidArgsMinerOptions, 'minDistinctOwners' | 'minOccurrences'> = {},
): InvalidArgsAggregate[] {
  const minDistinctOwners = opts.minDistinctOwners ?? DEFAULT_INVALID_ARGS_MIN_DISTINCT_OWNERS;
  const minOccurrences = opts.minOccurrences ?? DEFAULT_INVALID_ARGS_MIN_OCCURRENCES;

  interface Bucket {
    tool: string;
    key: string;
    owners: Set<string>;
    count: number;
    sampleArgs: unknown;
    sampleMessage: string;
    latestAtMs: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    if (!row.tool_name || isImprovementLoopTool(row.tool_name)) continue;
    const key = extractOffendingKey(row.error_message);
    if (!key) continue;
    const bucketKey = `${row.tool_name}\0${key}`;
    const owner = row.coord_owner_id ?? '(unknown)';
    const invokedAtMs = new Date(row.invoked_at).getTime();
    const safeMs = Number.isFinite(invokedAtMs) ? invokedAtMs : 0;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.owners.add(owner);
      existing.count += 1;
      if (safeMs >= existing.latestAtMs) {
        existing.latestAtMs = safeMs;
        existing.sampleArgs = row.args_json;
        existing.sampleMessage = row.error_message ?? existing.sampleMessage;
      }
    } else {
      buckets.set(bucketKey, {
        tool: row.tool_name,
        key,
        owners: new Set([owner]),
        count: 1,
        sampleArgs: row.args_json,
        sampleMessage: row.error_message ?? '',
        latestAtMs: safeMs,
      });
    }
  }
  const out: InvalidArgsAggregate[] = [];
  for (const b of buckets.values()) {
    if (b.owners.size < minDistinctOwners && b.count < minOccurrences) continue;
    out.push({
      tool: b.tool,
      key: b.key,
      count: b.count,
      distinctOwners: b.owners.size,
      sampleArgs: b.sampleArgs,
      sampleMessage: b.sampleMessage,
      latestAt: new Date(b.latestAtMs).toISOString(),
    });
  }
  out.sort((a, b) => b.distinctOwners - a.distinctOwners || b.count - a.count);
  return out;
}

/** Query `harness_shared.tool_invocations` for invalid-input rows in the window. */
export async function readInvalidArgsRows(
  sql: Sql,
  opts: { windowDays?: number; workspaceId?: string } = {},
): Promise<InvalidArgsRow[]> {
  const windowDays = opts.windowDays ?? DEFAULT_INVALID_ARGS_WINDOW_DAYS;
  const scopes = opts.workspaceId ? [...new Set([opts.workspaceId, '*', DEFAULT_COORD_WORKSPACE])] : null;
  const rows = await sql<InvalidArgsRow[]>`
    SELECT tool_name, error_message, args_json, coord_owner_id, invoked_at
      FROM harness_shared.tool_invocations
     WHERE status = 'invalid-input'
       AND invoked_at > now() - make_interval(days => ${windowDays})
       AND ${scopes ? sql`workspace_id = ANY(${scopes}::text[])` : sql`TRUE`}
       AND tool_name NOT LIKE 'improvements:%'
       AND tool_name NOT LIKE 'system:improvement-%'
     ORDER BY invoked_at DESC
     LIMIT 20000
  `;
  return rows;
}

export interface InvalidArgsMinerResult {
  /** Raw invalid-input rows scanned in the window. */
  scanned: number;
  /** (tool, key) pairs that cleared the recurrence bar. */
  candidates: number;
  /** Ids of newly-created improvement items this tick. */
  captured: string[];
  /** Candidates declined as a likely duplicate of an already-open item. */
  declined: number;
  /** Capture calls that errored (never blocks the rest of the tick). */
  failed: number;
}

function safeJsonPreview(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 400);
  } catch {
    return '(unserializable)';
  }
}

/**
 * The full weekly tick: query → aggregate → threshold → capture. Self-
 * measuring (close-loop D-006 pattern): the returned counts make the miner's
 * own yield visible in the routine's log line, the same self-measurement
 * discipline `improvement-watchdog` already logs each tick.
 */
export async function runInvalidArgsMinerTick(
  workspaceId: string,
  opts: InvalidArgsMinerOptions = {},
  deps: { sql?: Sql; capture?: typeof captureImprovement; captureDeps?: CaptureDeps; rows?: InvalidArgsRow[] } = {},
): Promise<InvalidArgsMinerResult> {
  const capture = deps.capture ?? captureImprovement;
  const maxPerTick = opts.maxPerTick ?? DEFAULT_INVALID_ARGS_MAX_PER_TICK;
  const windowDays = opts.windowDays ?? DEFAULT_INVALID_ARGS_WINDOW_DAYS;
  const rows = deps.rows ?? (await readInvalidArgsRows(deps.sql ?? getOrgPg().sql, { windowDays, workspaceId }));
  const signals = planInvalidArgsSignals(rows, opts).slice(0, maxPerTick);

  const capturedIds: string[] = [];
  let declined = 0;
  let failed = 0;
  for (const s of signals) {
    try {
      const result: CaptureImprovementResult = await capture(
        {
          kind: 'change',
          title: `Tool ${s.tool} repeatedly rejects the "${s.key}" arg (${s.distinctOwners} agent(s), ${s.count}x/${windowDays}d)`,
          body:
            `Invalid-args miner (WI-5017): ${s.tool} rejected a call over the "${s.key}" field ${s.count}x ` +
            `from ${s.distinctOwners} distinct agent(s) in the last ${windowDays} day(s).\n\n` +
            `Sample error: ${s.sampleMessage}\n\nSample args: ${safeJsonPreview(s.sampleArgs)}\n\n` +
            `This is either (a) an alias candidate for "${s.key}" (like EI-10897's body/comment alias), ` +
            `(b) a confusing schema field to rename, or (c) an agent-prior drift to correct in guidance.`,
          severity: 'minor',
          subTopic: 'invalid-args-miner',
          scope: 'operator',
          sourceRole: 'system',
          dedupScope: 'open',
          watchdogKey: `invalid-args-miner:${s.tool}:${s.key}`,
          findingClass: `invalid-args-miner:${s.tool}:${s.key}`,
          evidenceAt: s.latestAt,
        },
        deps.captureDeps,
      );
      if (result.created) capturedIds.push(result.issue?.id ?? '(unknown-id)');
      else declined += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[improvement-invalid-args-miner] capture failed for ${s.tool}:${s.key}:`, e instanceof Error ? e.message : e);
    }
  }
  return { scanned: rows.length, candidates: signals.length, captured: capturedIds, declined, failed };
}
