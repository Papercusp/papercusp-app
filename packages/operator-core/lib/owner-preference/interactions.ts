/**
 * owner-preference IO leg (self-learning-frontier-2026-06-12 P-043 / FB-15) —
 * capture into and read back from `harness_shared.owner_interactions`
 * (migration 254, append-only at the GRANT level).
 *
 * CAPTURE IS SUBSTRATE, not a frontier loop: rows are inert history with no
 * LLM spend and no queue filing, so it is deliberately UNFLAGGED and always
 * on (the FB-02/FB-03 precedent — the preference model needs interaction
 * history to already exist when it arms at P-001; only the RANKING feature
 * is dark). Every writer here is fail-safe: a telemetry insert must never
 * break the write it observes, so failures warn and return false.
 *
 * v0 kinds (vocabulary owned here, plain text in the schema):
 *  - 'grade' / 'regrade' — an OWNER grade on a routed idea, hooked at the
 *    gradeRoutedIdea seam. Queen grades are NOT captured: this stream models
 *    the owner's attention, nobody else's.
 *  - 'queue-view' — the human queue was rendered to the owner, captured at
 *    the `learning.improvements` sync-resolver seam (the UI-only read path;
 *    the improvements:digest tool and the digest routine do not pass through
 *    it). Throttled DB-side so the tab's 30s refetch doesn't flood: at most
 *    one row per QUEUE_VIEW_THROTTLE_MS.
 */

import { getOrgPg } from '@papercusp/db-org';
import { coerceJson } from '../pg-jsonb';
import { activeWorkspaceId } from '../workspace-registry';
import {
  bucketKeysFor,
  type OwnerEngagement,
  type OwnerSignal,
} from './affinity';

export type OwnerInteractionKind = 'grade' | 'regrade' | 'queue-view';

export interface RecordOwnerInteractionInput {
  kind: OwnerInteractionKind;
  /** 'routed-idea' | 'learning-tab' | 'improvement' (reserved). */
  subjectKind: string;
  subjectId: string;
  payload?: Record<string, unknown>;
}

/** At most one queue-view row per window — the tab refetches every ~30s. */
export const QUEUE_VIEW_THROTTLE_MS = 5 * 60 * 1000;

/** Cap the ids stored per queue-view row (jsonb hygiene; the drain shows ~7). */
const QUEUE_VIEW_MAX_IDS = 100;

/**
 * Append one interaction row. Fail-safe by contract: returns false (after a
 * console.warn) on any failure — callers fire-and-forget.
 */
export async function recordOwnerInteraction(
  input: RecordOwnerInteractionInput,
): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.owner_interactions
        (workspace_id, kind, subject_kind, subject_id, payload)
      VALUES (${activeWorkspaceId()}, ${input.kind}, ${input.subjectKind},
              ${input.subjectId}, ${JSON.stringify(input.payload ?? {})}::text::jsonb)`;
    return true;
  } catch (err) {
    console.warn(
      '[owner-preference] interaction capture failed (ignored):',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Record a queue-view exposure event (the model's denominator), throttled.
 * The throttle is a DB read, not module state — stateless across restarts
 * and shared between any hosts writing the same store.
 */
export async function recordQueueExposure(
  visibleIds: readonly string[],
  view = 'improvements',
): Promise<boolean> {
  if (visibleIds.length === 0) return false;
  try {
    const { sql } = getOrgPg();
    // `ts` is a timestamptz; the org PG driver returns it as a STRING on this
    // path (not a Date), so calling `.getTime()` directly throws
    // "ts.getTime is not a function" — the error was swallowed below, silently
    // dropping every queue-exposure denominator. Coerce defensively (handles
    // both Date and string, NaN-safe: an unparseable value falls through to
    // recording, the safe default). Matches the dateMs convention elsewhere.
    const last = await sql<{ ts: string | Date }[]>`
      SELECT ts FROM harness_shared.owner_interactions
       WHERE kind = 'queue-view'
       ORDER BY ts DESC
       LIMIT 1`;
    if (last[0]) {
      const lastMs =
        last[0].ts instanceof Date ? last[0].ts.getTime() : Date.parse(String(last[0].ts));
      if (Date.now() - lastMs < QUEUE_VIEW_THROTTLE_MS) return false;
    }
    const ids = visibleIds.slice(0, QUEUE_VIEW_MAX_IDS);
    return await recordOwnerInteraction({
      kind: 'queue-view',
      subjectKind: 'learning-tab',
      subjectId: view,
      payload: { ids, total: visibleIds.length },
    });
  } catch (err) {
    console.warn(
      '[owner-preference] exposure capture failed (ignored):',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Engagement look-back (grades age slowly); exposure look-back (denominator). */
const ENGAGEMENT_WINDOW_DAYS = 90;
const EXPOSURE_WINDOW_DAYS = 30;

/** Strip the improvements-rail ref prefix: 'wi:EI-12' → 'EI-12'. */
function refToItemId(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || ref === '') return undefined;
  return ref.startsWith('wi:') ? ref.slice(3) : ref;
}

/**
 * Assemble the OwnerSignal the ranking feature consumes: recent owner
 * engagements joined to their items' attributes, plus per-item and per-bucket
 * exposure counts from queue-view events.
 *
 * Reads are NOT workspace-narrowed — same EI-346 reasoning as the
 * gradeRoutedIdea resolver: in-process tool dispatch runs under the 'default'
 * ALS workspace while rows carry the active one; a workspace clause here
 * would silently strand every captured interaction.
 */
export async function readOwnerSignal(): Promise<OwnerSignal> {
  const { sql } = getOrgPg();

  const [engRows, expRows] = await Promise.all([
    sql<{ kind: string; subject_id: string; payload: Record<string, unknown> }[]>`
      SELECT kind, subject_id, payload
        FROM harness_shared.owner_interactions
       WHERE kind IN ('grade', 'regrade')
         AND ts > now() - ${`${ENGAGEMENT_WINDOW_DAYS} days`}::interval
       ORDER BY ts DESC
       LIMIT 2000`,
    sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload
        FROM harness_shared.owner_interactions
       WHERE kind = 'queue-view'
         AND ts > now() - ${`${EXPOSURE_WINDOW_DAYS} days`}::interval
       ORDER BY ts DESC
       LIMIT 1000`,
  ]);

  // Every EI id referenced by either side, joined once for attributes.
  const engagedItemIdByRow = engRows.map((r) => refToItemId(coerceJson<{ routedRef?: unknown }>(r.payload)?.routedRef));
  const exposureCountById = new Map<string, number>();
  let totalExposures = 0;
  for (const r of expRows) {
    const p = coerceJson<{ ids?: unknown }>(r.payload);
    const ids = Array.isArray(p?.ids) ? (p!.ids as unknown[]) : [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      exposureCountById.set(id, (exposureCountById.get(id) ?? 0) + 1);
      totalExposures += 1;
    }
  }
  const allIds = [
    ...new Set([...exposureCountById.keys(), ...engagedItemIdByRow.filter((x): x is string => !!x)]),
  ];

  const attrsById = new Map<string, { severity?: string; scope?: string }>();
  if (allIds.length > 0) {
    const attrRows = await sql<{ issue_id: string; severity: string; scope: string }[]>`
      SELECT issue_id, severity, scope
        FROM harness_shared.engineer_issues
       WHERE issue_id = ANY(${allIds})`;
    for (const r of attrRows) attrsById.set(r.issue_id, { severity: r.severity, scope: r.scope });
  }

  const engagements: OwnerEngagement[] = engRows.map((r, i) => {
    const itemId = engagedItemIdByRow[i];
    const attrs = itemId ? attrsById.get(itemId) : undefined;
    return {
      kind: r.kind === 'regrade' ? 'regrade' : 'grade',
      ...(itemId ? { itemId } : {}),
      ...(attrs?.severity ? { severity: attrs.severity } : {}),
      ...(attrs?.scope ? { scope: attrs.scope } : {}),
    };
  });

  const exposureCountByBucket = new Map<string, number>();
  for (const [id, n] of exposureCountById) {
    const attrs = attrsById.get(id);
    if (!attrs) continue;
    for (const key of bucketKeysFor(attrs)) {
      exposureCountByBucket.set(key, (exposureCountByBucket.get(key) ?? 0) + n);
    }
  }

  return { engagements, exposureCountById, exposureCountByBucket, totalExposures };
}
