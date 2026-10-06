/**
 * condition-upsert.ts — WI-39594: the detector/seeder filing upsert.
 *
 * A recurring DETECTOR EMISSION (a seeder re-pass, a gate RED, a sweep finding)
 * must refresh the ONE open work-item that owns its condition, not file a
 * sibling per emission. Migration 741's partial unique index
 * (`work_items_condition_key_uq` on (workspace_id, harness_slug, condition_key)
 * WHERE condition_key IS NOT NULL) already makes that race-proof; this module is
 * the thin filing seam that lets an ORDINARY create site use it without joining
 * the condition-bridge's reconciler lifecycle.
 *
 * HOW IT DIFFERS FROM `acquireConditionOwner` (condition-bridge.ts) — deliberately:
 *   • no opt-in catalog: the bridge's ACTIONABLE_CONDITIONS gates which WATCHDOG
 *     conditions may mint items on the reconciler tick; a filing site that calls
 *     THIS function has already decided to file — the key is its identity, not a
 *     policy question.
 *   • REFRESH on adopt: the bridge adopts an incumbent silently (its tick has no
 *     new reading). A detector emission IS a new reading, so the incumbent's
 *     title/summary refresh to it and an occurrence counter bumps — the
 *     queue-audit-2026-08-17 ruling ("the NEWEST item per condition is kept open").
 *   • no auto-settle marker: these items close when someone fixes them, not when
 *     a condition clears; nothing here participates in releaseConditionOwner's
 *     settle path.
 *
 * ⚠ KEY DESIGN: the caller's key should embed everything that makes the
 * condition unique WITHIN A WORKSPACE (e.g. `spec-triad:<harness>/<plan>`).
 * Ownership reads here are workspace-scoped and deliberately NOT harness-scoped:
 * `createWorkItem` → `createIssue` normalizes a member harness to its Pot home
 * slug before the row lands, so a harness-scoped read with the caller's slug can
 * miss the very row a previous call stored (the measured oddsmith→oddsmith-hive
 * re-mint loop, EI-19407969585168294). A workspace-scoped read of a
 * workspace-unique key cannot.
 *
 * ⚠ Do NOT use this for a producer whose rows FEDERATE IN from other machines
 * (e.g. the episodic-ei detectors): two machines minting the same key
 * independently is resolved there by the duplicate-collapse retirement pass, and
 * a hard unique claim on the ingest path is the wrong tool. This seam is for
 * single-host system filers (routines, gates, seeders).
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { TransactionSql } from 'postgres';
import { createWorkItem, setWorkItemState, type CreateWorkItemInput } from '../work-items';
import { claimConditionKey, findConditionKeyHolder, releaseStaleConditionKeys } from './condition-bridge';
import { linkWorkItemToCondition } from './condition-object';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { neutralizeToolCallTags, sanitizePersistedText } from '../text-safety';

/** Lifecycle actor for the lost-race stand-down close (see CONDITION_BRIDGE_ACTOR
 *  for why an anonymous terminal transition is refused by the completion gate). */
export const CONDITION_UPSERT_ACTOR = 'system:condition-upsert' as const;

/** Payload key stamping occurrence state on the owning row. */
export const CONDITION_UPSERT_MARKER = '_conditionUpsert';

/**
 * Namespaced identity for one acceptance-grading target.
 *
 * Acceptance dispatch has two different idempotency surfaces: the launcher
 * receipt (which protects a process launch) and the durable assignment a
 * reviewer sees (which must protect the review target).  Keep the latter in
 * the condition-upsert seam so retries race on the same partial unique index.
 * The complete tuple is hashed because condition_key is also used by older
 * callers with a compact, bounded key; the payload retains the typed tuple for
 * inspection and future migrations.
 */
export const ACCEPTANCE_REVIEW_TARGET_NAMESPACE = 'acceptance-review-target:v1';

export interface AcceptanceReviewTarget {
  workspaceId: string;
  harnessSlug: string | null;
  planSlug: string;
  rubricId: string;
  /** The subject/rubric revision being graded; null is an explicit legacy pin. */
  revision: number | null;
}

export interface AcceptanceReviewReservationRef {
  conditionKey: string;
  id: string | null;
}

function normalizeAcceptanceReviewTarget(target: AcceptanceReviewTarget): AcceptanceReviewTarget {
  const workspaceId = target.workspaceId.trim();
  const planSlug = target.planSlug.trim();
  const rubricId = target.rubricId.trim();
  if (!workspaceId || !planSlug || !rubricId) {
    throw new Error('acceptanceReviewTargetConditionKey: workspaceId, planSlug, and rubricId are required');
  }
  const harnessSlug = target.harnessSlug?.trim() || null;
  const revision = target.revision == null ? null : Number(target.revision);
  if (revision !== null && (!Number.isInteger(revision) || revision < 0)) {
    throw new Error('acceptanceReviewTargetConditionKey: revision must be a non-negative integer or null');
  }
  return { workspaceId, harnessSlug, planSlug, rubricId, revision };
}

/** Stable condition key for one (workspace, harness, plan, rubric, revision). */
export function acceptanceReviewTargetConditionKey(target: AcceptanceReviewTarget): string {
  const normalized = normalizeAcceptanceReviewTarget(target);
  const tuple = JSON.stringify([
    ACCEPTANCE_REVIEW_TARGET_NAMESPACE,
    normalized.workspaceId,
    normalized.harnessSlug,
    normalized.planSlug,
    normalized.rubricId,
    normalized.revision,
  ]);
  return `${ACCEPTANCE_REVIEW_TARGET_NAMESPACE}:${createHash('sha256').update(tuple).digest('hex').slice(0, 32)}`;
}

/**
 * Reserve/adopt the durable acceptance assignment for one typed target.
 * Callers pass the returned key and id into every fresh-judge or cascade brief
 * so a retry can be traced back to the one canonical assignment.
 */
export async function reserveAcceptanceReviewTarget(
  target: AcceptanceReviewTarget,
  input: Partial<Pick<CreateWorkItemInput, 'title' | 'summary'>> = {},
): Promise<AcceptanceReviewReservationRef & { created: boolean }> {
  const normalized = normalizeAcceptanceReviewTarget(target);
  const conditionKey = acceptanceReviewTargetConditionKey(normalized);
  const result = await upsertConditionWorkItem(conditionKey, {
    kind: 'task',
    title: input.title ?? `Acceptance review-target reservation — ${normalized.planSlug} (${normalized.rubricId})`,
    summary:
      input.summary ??
      `Canonical reviewer assignment for acceptance target ${normalized.planSlug} at revision ${normalized.revision ?? 'legacy'}.`,
    harness: normalized.harnessSlug ?? undefined,
    workspaceId: normalized.workspaceId,
    payload: { acceptanceReviewTarget: normalized },
  });
  return { conditionKey: result.conditionKey, id: result.id, created: result.created };
}

/** What settling a terminal plan's review-target reservations did. */
export interface AcceptanceReviewReservationSettlement {
  /** Reservations this call moved to `dropped`. */
  settled: string[];
  /** Reservations whose terminal write failed — reported, never swallowed. */
  failed: Array<{ id: string; error: string }>;
}

/**
 * Close every still-open review-target reservation whose subject plan just went
 * terminal (shipped or superseded).
 *
 * condition-upsert filings have no auto-settle: the FILER owns the close. A
 * reservation's filer is the acceptance recruiter, whose job ends when the subject
 * plan leaves the review lifecycle. Without this, a reservation closed only if the
 * grader happened to claim and complete that exact row; a grader who graded through
 * their own item left it open forever (EI-24654801606034099 measured 32 open,
 * unheld reservations on shipped plans).
 *
 * The terminal state is `dropped`, not `done`: the reservation was not the vehicle of
 * the review, so recording it as completed work would be false. Idempotent — a second
 * call finds nothing open. Scoped by the typed target in the payload to (workspace,
 * harness, plan), so a same-slug plan in another harness or workspace is untouched.
 */
export async function settleAcceptanceReviewReservationsForPlan(
  planSlug: string,
  options: { workspaceId: string; harnessSlug: string | null; terminalStatus: 'shipped' | 'superseded' },
): Promise<AcceptanceReviewReservationSettlement> {
  const slug = planSlug.trim();
  const workspaceId = options.workspaceId.trim();
  if (!slug || !workspaceId) return { settled: [], failed: [] };
  const harnessSlug = options.harnessSlug?.trim() || null;
  const sql = getOrgPg().sql;
  const rows = await sql<{ feature_id: string; harness_slug: string | null }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND condition_key LIKE ${`${ACCEPTANCE_REVIEW_TARGET_NAMESPACE}:%`}
       AND payload -> 'acceptanceReviewTarget' ->> 'planSlug' = ${slug}
       AND (payload -> 'acceptanceReviewTarget' ->> 'harnessSlug') IS NOT DISTINCT FROM ${harnessSlug}::text
       AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))`;
  const settled: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const row of rows) {
    try {
      await setWorkItemState(row.feature_id, 'dropped', {
        harness: row.harness_slug ?? undefined,
        by: CONDITION_UPSERT_ACTOR,
        completionRef: `review target ${slug} reached ${options.terminalStatus}; reservation settled with its plan (EI-24654801606034099)`,
      });
      settled.push(row.feature_id);
    } catch (err) {
      failed.push({ id: row.feature_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { settled, failed };
}

export interface ConditionUpsertResult {
  conditionKey: string;
  /** The work-item that owns the condition after this call. */
  id: string | null;
  /** True when THIS call created the row; false = refreshed an incumbent. */
  created: boolean;
  /** Set when a lost claim race left our optimistically-minted row open. */
  duplicateLeftOpen?: string;
}

/**
 * Refresh the incumbent with the newest reading: bump the occurrence counter,
 * stamp lastSeenAt, and replace title/summary. Returns false when the row
 * vanished between the read and the write (caller treats it as a miss).
 */
async function refreshIncumbent(
  id: string,
  conditionKey: string,
  input: Pick<CreateWorkItemInput, 'title' | 'summary' | 'workspaceId'>,
): Promise<boolean> {
  const sql = getOrgPg().sql;
  const marker = CONDITION_UPSERT_MARKER;
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET title = ${input.title},
           summary = COALESCE(${input.summary ?? null}::text, summary),
           updated_ts = (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
           payload = jsonb_set(
             COALESCE(payload, '{}'::jsonb),
             ARRAY[${marker}::text],
             jsonb_build_object(
               'conditionKey', ${conditionKey}::text,
               'occurrences', COALESCE((payload -> ${marker}::text ->> 'occurrences')::int, 1) + 1,
               'lastSeenAt', to_jsonb(now())
             ),
             true
           )
     WHERE feature_id = ${id}
       AND condition_key = ${conditionKey}
       AND (${input.workspaceId ?? null}::text IS NULL OR workspace_id = ${input.workspaceId ?? null})
    RETURNING feature_id`;
  return rows.length > 0;
}

/**
 * ADOPT half (exported for the WI-39604 tool-path leg): self-heal a wedged key,
 * then refresh-and-return the open incumbent holding `conditionKey` — or null
 * when no adoptable incumbent exists (including the row vanishing between the
 * holder read and the refresh write, which a caller must treat as a miss and
 * mint fresh rather than returning a dangling id).
 */
export async function adoptConditionIncumbent(
  conditionKey: string,
  input: Pick<CreateWorkItemInput, 'title' | 'summary' | 'workspaceId'>,
): Promise<string | null> {
  const key = conditionKey.trim();
  if (!key) throw new Error('adoptConditionIncumbent: empty conditionKey');
  // Self-heal a missed key release so a settled row can never wedge the key.
  await releaseStaleConditionKeys(key, input.workspaceId);
  // Adopt-and-refresh the incumbent. Workspace-scoped on purpose — see header.
  const holder = await findConditionKeyHolder(key, { workspaceId: input.workspaceId });
  if (!holder) return null;
  const refreshed = await refreshIncumbent(holder, key, input);
  return refreshed ? holder : null;
}

/** Outcome of claiming `conditionKey` for a freshly-minted row. */
export type ConditionClaimSettlement =
  | { won: true }
  | { won: false; winnerId: string | null; duplicateLeftOpen?: string };

/**
 * CLAIM half (exported for the WI-39604 tool-path leg): claim `conditionKey`
 * for the row this caller just minted. On a lost race the incumbent winner is
 * refreshed with this reading and the caller's own row is settled (dropped);
 * a failed stand-down is reported as `duplicateLeftOpen`, never swallowed.
 */
export async function settleConditionClaim(
  itemId: string,
  conditionKey: string,
  input: Pick<CreateWorkItemInput, 'title' | 'summary' | 'workspaceId' | 'harness'>,
): Promise<ConditionClaimSettlement> {
  const key = conditionKey.trim();
  const won = await claimConditionKey(itemId, key, input.workspaceId);
  if (won) {
    // The condition_key column is the current singleton owner; the about→event
    // link is the append-only history and the resolver's ownership surface. Keep
    // both writes in this shared fresh-claim seam so the module and tool paths
    // cannot create an invisible owner. A link failure must not undo a successful
    // unique claim, matching the bridge's best-effort history write.
    await linkWorkItemToCondition(itemId, key, { harness: input.harness }).catch(() => undefined);
    return { won: true };
  }

  // A peer won the race: refresh THEIR row with this reading, settle ours.
  const winner = await findConditionKeyHolder(key, { workspaceId: input.workspaceId });
  if (winner) await refreshIncumbent(winner, key, input);
  // WI-10004234: a single failed stand-down write used to leave the loser OPEN
  // beside the winner, and most callers ignore `duplicateLeftOpen`, so one
  // transient write error became a silent second open lane. Retry the write
  // (throws only) before reporting the duplicate.
  let droppedOk = false;
  for (let attempt = 0; attempt < STAND_DOWN_ATTEMPTS && !droppedOk; attempt += 1) {
    if (attempt > 0) await sleep(STAND_DOWN_BACKOFF_MS[attempt - 1] ?? 250);
    try {
      await setWorkItemState(itemId, 'dropped', {
        harness: input.harness,
        by: CONDITION_UPSERT_ACTOR,
        completionRef: `superseded by ${winner ?? 'the concurrent owner'} — lost the condition-key claim race for '${key}'`,
      });
      droppedOk = true;
    } catch {
      // Retried above; a persistent failure is reported, never swallowed.
    }
  }
  return { won: false, winnerId: winner ?? null, ...(droppedOk ? {} : { duplicateLeftOpen: itemId }) };
}

/** Stand-down write attempts before a lost-race row is reported as `duplicateLeftOpen`. */
const STAND_DOWN_ATTEMPTS = 3;
const STAND_DOWN_BACKOFF_MS = [50, 250] as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * File-or-refresh the work-item owning `conditionKey`.
 *
 * Idempotent under re-fire and race-proof under concurrent filers: create is
 * optimistic (mint, then claim the key); the 741 unique index serializes the
 * winner, and the loser settles its own row and adopts the incumbent — the same
 * shape `acquireConditionOwner` proves out, minus catalog and lifecycle.
 * Composed from the two exported halves above so the tool path (`work_items:
 * create { conditionKey }`, WI-39604) and this module-level filer cannot drift.
 */
export async function upsertConditionWorkItem(
  conditionKey: string,
  input: CreateWorkItemInput,
): Promise<ConditionUpsertResult> {
  const key = conditionKey.trim();
  if (!key) throw new Error('upsertConditionWorkItem: empty conditionKey');

  const incumbent = await adoptConditionIncumbent(key, input);
  if (incumbent) return { conditionKey: key, id: incumbent, created: false };

  // Mint, then claim. Optimistic on purpose — a check-then-act "is there one
  // already?" is the exact shape that raced 40-of-88 rows into duplicates
  // (WI-6986); the unique index needs no check at all.
  const item = await createWorkItem({
    ...input,
    payload: {
      ...((input.payload as Record<string, unknown> | undefined) ?? {}),
      [CONDITION_UPSERT_MARKER]: {
        conditionKey: key,
        occurrences: 1,
        lastSeenAt: new Date().toISOString(),
      },
    },
  });

  const settled = await settleConditionClaim(item.id, key, input);
  if (settled.won) return { conditionKey: key, id: item.id, created: true };
  return {
    conditionKey: key,
    id: settled.winnerId ?? item.id,
    created: false,
    ...(settled.duplicateLeftOpen ? { duplicateLeftOpen: settled.duplicateLeftOpen } : {}),
  };
}

/**
 * Transaction-bound condition filing for a caller that is already inside the
 * transaction whose state makes the condition actionable.
 *
 * This is intentionally a narrow SQL seam rather than a second general
 * `createWorkItem` implementation. The acceptance-drain handoff must commit
 * the plan's `awaiting-acceptance` transition and its accountable task
 * together, while `createWorkItem` currently owns its own transaction. The
 * ordinary upsert above remains the reusable retrying path for sweeps.
 *
 * The partial unique index is the final race guard. A terminal stale holder is
 * released in this same transaction before the upsert, so an old settled row
 * cannot wedge a newly-drained plan. Any error escapes to the caller and rolls
 * back the enclosing transaction; callers must not turn that into a
 * post-commit notification.
 */
export async function upsertConditionWorkItemInTransaction(
  tx: TransactionSql,
  conditionKey: string,
  input: Pick<
    CreateWorkItemInput,
    'kind' | 'title' | 'summary' | 'harness' | 'workspaceId' | 'createdBy' | 'payload' | 'assignee'
  >,
): Promise<ConditionUpsertResult> {
  const key = conditionKey.trim();
  if (!key) throw new Error('upsertConditionWorkItemInTransaction: empty conditionKey');
  if (input.kind !== 'task') {
    throw new Error(`upsertConditionWorkItemInTransaction: unsupported kind '${input.kind}'`);
  }
  const workspaceId = input.workspaceId?.trim();
  const harnessSlug = input.harness?.trim();
  if (!workspaceId || !harnessSlug) {
    throw new Error('upsertConditionWorkItemInTransaction: workspaceId and harness are required');
  }

  await tx`
    UPDATE harness_shared.work_items
       SET condition_key = NULL
     WHERE workspace_id = ${workspaceId}
       AND condition_key = ${key}
       AND status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
  `;

  const payload = {
    ...((input.payload as Record<string, unknown> | undefined) ?? {}),
    [CONDITION_UPSERT_MARKER]: {
      conditionKey: key,
      occurrences: 1,
      lastSeenAt: new Date().toISOString(),
    },
    _ei: {
      scope: `harness:${harnessSlug}`,
      source: 'engineer',
      created_by: input.createdBy ?? null,
      signal_origin: 'organic',
    },
  };
  const title = sanitizePersistedText(neutralizeToolCallTags(input.title));
  const summary = sanitizePersistedText(neutralizeToolCallTags(input.summary ?? ''));
  const assignee = input.assignee?.trim() || null;
  const rows = await tx<{ feature_id: string; inserted: boolean }[]>`
    INSERT INTO harness_shared.work_items (
      workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
      origin, ts, created_ts, updated_ts, payload, condition_key, taken_by, taken_at, expires_at
    )
    VALUES (
      ${workspaceId}, ${harnessSlug}, harness_shared.next_work_item_id(),
      ${title}, ${summary}, 'open', 'task', 'local',
      (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
      (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
      (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
      ${JSON.stringify(payload)}::text::jsonb, ${key},
      ${assignee},
      CASE WHEN ${assignee}::text IS NULL THEN NULL ELSE clock_timestamp() END,
      CASE WHEN ${assignee}::text IS NULL THEN NULL ELSE clock_timestamp() + INTERVAL '7 days' END
    )
    ON CONFLICT (workspace_id, harness_slug, condition_key)
      WHERE condition_key IS NOT NULL
    DO UPDATE SET
      -- A replay of the handoff must not overwrite a later gate observation,
      -- completion evidence or a peer's in-flight content/claim.
      taken_by = COALESCE(harness_shared.work_items.taken_by, EXCLUDED.taken_by),
      taken_at = CASE WHEN harness_shared.work_items.taken_by IS NULL
        THEN EXCLUDED.taken_at ELSE harness_shared.work_items.taken_at END,
      expires_at = CASE WHEN harness_shared.work_items.taken_by IS NULL
        THEN EXCLUDED.expires_at ELSE harness_shared.work_items.expires_at END
    WHERE NOT (harness_shared.work_items.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
    RETURNING feature_id, (xmax = 0) AS inserted
  `;
  const row = rows[0];
  if (!row?.feature_id) throw new Error(`condition upsert returned no row for '${key}'`);
  return {
    conditionKey: key,
    id: row.feature_id,
    created: row.inserted,
  };
}
