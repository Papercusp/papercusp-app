/**
 * work-items-release-request — WI-5974: `work_items:request_release { id, deadlineSec,
 * onSilence, reason }` makes "announced consequence" a RAIL instead of a temperament.
 *
 * ORIGIN (owner question 2026-07-26 06:26Z, after a leader (su-e3b21216) moved to
 * reassign a work-item from a holder reading as an orphan and the claim rail correctly
 * refused with `claim_conflict`): the rail is right to refuse a contested reassignment,
 * but it refuses and then STOPS — no sanctioned path forward. A leader who wants to
 * reclaim a LIVE peer's claim outside the existing force-release authority basis
 * (holder-not-live / queen / leads-the-holder's-fleet — see release-force-guard.ts)
 * previously had no sanctioned lever at all. This module is that lever: message the
 * holder with an explicit deadline + explicit consequence, record the request durably
 * on the item (visible to every peer, not just a DM), and — on silence past the
 * deadline — execute the ANNOUNCED consequence. The announcement is the new authority
 * basis: a silent reclaim becomes impossible to do BY ACCIDENT, because it requires
 * having announced it first and given the holder the chance to respond.
 *
 * STORAGE: flat `release_request_*` keys on the work-item's jsonb `payload` column —
 * same convention as `_claimHold`/`held_open_*`/`claim_hold_*` in work-items.ts (a
 * nested object would need `payload->'release_request'->>'x'` everywhere the sweep
 * scans; flat keys let the due-scan use a plain `payload->>'release_request_...'`
 * predicate with the SAME pattern every other work-item payload scan already uses).
 * ONE active request per item (a fresh request while one is pending is a conflict —
 * see the tool handler); resolving NEVER deletes the keys (the item's history should
 * keep showing the request + deadline + what fired), it only stamps
 * `release_request_resolved`/`release_request_resolution`/`release_request_resolved_at`.
 *
 * Resolution paths (mutually exclusive, first to land wins — see the CAS guard on
 * {@link resolveWorkItemReleaseRequest}):
 *   - holder-released    → work_items:release wired this in (release.ts) — the holder
 *                           voluntarily released before the deadline: instant resolve,
 *                           no consequence.
 *   - holder-declined     → work_items:decline_release_request — the holder explicitly
 *                           pushed back before the deadline: instant resolve, no
 *                           consequence (the requester must escalate manually).
 *   - holder-progressed   → the deadline sweep observed fresh item progress since the
 *                           request: the holder responded through work, so no silence
 *                           consequence fires.
 *   - requester-withdrawn → work_items:withdraw_release_request — the requester
 *                           withdrew before the deadline: instant resolve, no
 *                           consequence.
 *   - consequence-reclaim  → deadline passed unanswered, onSilence:'reclaim' fired: the
 *                           sweep force-frees the item.
 *   - consequence-escalate → deadline passed unanswered, onSilence:'escalate' fired: the
 *                           sweep pages the owner; the item stays held.
 *   - consequence-nothing  → deadline passed unanswered, onSilence:'nothing' fired: the
 *                           sweep records the silence; the item stays held.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

export type ReleaseRequestOnSilence = 'reclaim' | 'escalate' | 'nothing';

export type ReleaseRequestResolution =
  | 'holder-released'
  | 'holder-declined'
  | 'holder-progressed'
  | 'requester-withdrawn'
  | 'consequence-reclaim'
  | 'consequence-escalate'
  | 'consequence-nothing'
  /** The item was freed by a DIFFERENT, already-authorized force-release (WI-4198's
   *  holder-not-live/queen/leads-holder-fleet basis) before the request's own deadline, or
   *  the item terminalized before the deadline — the pending request is now moot, so it
   *  resolves without the announced onSilence consequence ever needing to fire. */
  | 'superseded';

export interface WorkItemReleaseRequest {
  by: string;
  holder: string;
  reason: string;
  onSilence: ReleaseRequestOnSilence;
  deadlineAt: number;
  requestedAt: number;
  resolved: boolean;
  resolution: ReleaseRequestResolution | null;
  resolvedAt: number | null;
}

/** A held item's recorded progress after the request was filed is a response: the
 * announced consequence applies only to silence, so it must not fire later merely
 * because the holder's session has since parked or gone stale. */
export function hasWorkItemProgressAfterReleaseRequest(
  request: WorkItemReleaseRequest,
  lastProgressAt: string | Date | null,
): boolean {
  if (lastProgressAt == null || !Number.isFinite(request.requestedAt)) return false;
  const progressAt = lastProgressAt instanceof Date ? lastProgressAt.getTime() : Date.parse(lastProgressAt);
  return Number.isFinite(progressAt) && progressAt > request.requestedAt;
}

/** Same located-row lookup `setWorkItemClaimHold` uses (work-items.ts) — prefer the
 *  active-workspace row when present, else take the row regardless of ambient scope. */
async function locateWorkItem(
  sql: Sql,
  id: string,
  harness?: string,
): Promise<{ harnessSlug: string | null; workspaceId: string } | null> {
  const located = await sql<{ harness_slug: string | null; workspace_id: string }[]>`
    SELECT harness_slug, workspace_id
      FROM harness_shared.work_items
     WHERE feature_id = ${id}
       AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
     ORDER BY (workspace_id = ${activeWorkspaceId()}) DESC, updated_ts DESC NULLS LAST
     LIMIT 1`;
  if (!located[0]) return null;
  return { harnessSlug: located[0].harness_slug, workspaceId: located[0].workspace_id };
}

/** Parse the flat `release_request_*` payload keys back into a structured request, or
 *  `null` when the item carries none. Never throws on a malformed payload — a request
 *  missing its required fields reads as absent rather than crashing the caller. */
export function readWorkItemReleaseRequest(payload: unknown): WorkItemReleaseRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.release_request_by !== 'string' || !p.release_request_by) return null;
  if (typeof p.release_request_holder !== 'string' || !p.release_request_holder) return null;
  const deadlineAt = Number(p.release_request_deadline_at);
  if (!Number.isFinite(deadlineAt)) return null;
  const onSilenceRaw = p.release_request_on_silence;
  const onSilence: ReleaseRequestOnSilence =
    onSilenceRaw === 'reclaim' || onSilenceRaw === 'escalate' || onSilenceRaw === 'nothing' ? onSilenceRaw : 'nothing';
  // Number(null) coerces to 0 (finite!), so a genuinely-null/undefined field must be
  // distinguished BEFORE the numeric coercion — otherwise "never resolved" (null) reads
  // back as "resolved at epoch 0".
  const numOrNull = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const requestedAt = numOrNull(p.release_request_requested_at);
  const resolvedAt = numOrNull(p.release_request_resolved_at);
  return {
    by: p.release_request_by,
    holder: p.release_request_holder,
    reason: typeof p.release_request_reason === 'string' ? p.release_request_reason : '',
    onSilence,
    deadlineAt,
    requestedAt: requestedAt ?? deadlineAt,
    resolved: p.release_request_resolved === true || p.release_request_resolved === 'true',
    resolution:
      typeof p.release_request_resolution === 'string'
        ? (p.release_request_resolution as ReleaseRequestResolution)
        : null,
    resolvedAt,
  };
}

/**
 * Record a NEW release request on the item (overwrites any prior — the tool handler is
 * responsible for refusing to stomp a live pending request from a DIFFERENT requester;
 * see `work_items:request_release`'s conflict guard). `expectedHolder` closes the
 * requester's read→write window: if the claim changed after the holder was observed,
 * the UPDATE matches zero rows and no request is written against the successor. Returns
 * null when the item can't be located or the expected holder no longer owns it.
 */
export async function setWorkItemReleaseRequest(
  id: string,
  req: {
    harness?: string;
    by: string;
    holder: string;
    expectedHolder?: string;
    reason: string;
    onSilence: ReleaseRequestOnSilence;
    deadlineAt: number;
  },
): Promise<{ id: string; harness: string | null; workspaceId: string } | null> {
  const { sql } = getOrgPg();
  const located = await locateWorkItem(sql, id, req.harness);
  if (!located) return null;
  const expectedHolder = req.expectedHolder?.trim() || null;
  const requestedAt = Date.now();
  const patch = JSON.stringify({
    release_request_by: req.by,
    release_request_holder: req.holder,
    release_request_reason: req.reason,
    release_request_on_silence: req.onSilence,
    release_request_deadline_at: req.deadlineAt,
    release_request_requested_at: requestedAt,
    release_request_resolved: false,
    release_request_resolution: null,
    release_request_resolved_at: null,
  });
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET payload = COALESCE(payload, '{}'::jsonb) || ${patch}::text::jsonb,
           updated_ts = ${Date.now()}
     WHERE workspace_id = ${located.workspaceId} AND feature_id = ${id}
       -- The handler read the holder before this write. Keep the request tied to
       -- that exact claim, so a transfer cannot retarget it to a fresh successor.
       AND (${expectedHolder}::text IS NULL OR taken_by = ${expectedHolder})
     RETURNING feature_id`;
  if (!rows[0]) return null;
  return { id, harness: located.harnessSlug, workspaceId: located.workspaceId };
}

/**
 * Compare-and-resolve (CAS): stamps `resolved`/`resolution`/`resolvedAt` ONLY when the
 * item currently carries an UNRESOLVED request — so a holder-release racing the sweep's
 * deadline-fire (or two sweep ticks racing each other) can never double-resolve. Returns
 * the resolved request, or `null` when there was nothing to resolve (already resolved,
 * or no request present) — the caller's side effect (release / notify) must be gated on
 * a non-null return, never fired unconditionally.
 */
export async function resolveWorkItemReleaseRequest(
  id: string,
  opts: {
    harness?: string;
    resolution: ReleaseRequestResolution;
    expectedBy?: string;
    expectedHolder?: string;
    /** CAS the exact announced deadline too. A requester may refresh their own
     *  request; an old sweep/manual force must never resolve the refreshed row. */
    expectedDeadlineAt?: number;
    /** CAS the progress snapshot used to decide whether the holder responded. */
    expectedLastProgressAt?: string | Date | null;
  },
): Promise<WorkItemReleaseRequest | null> {
  const { sql } = getOrgPg();
  const located = await locateWorkItem(sql, id, opts.harness);
  if (!located) return null;
  const resolvedAt = Date.now();
  const expectedBy = opts.expectedBy?.trim() || null;
  const expectedHolder = opts.expectedHolder?.trim() || null;
  const expectedDeadlineAt = Number.isFinite(opts.expectedDeadlineAt) ? opts.expectedDeadlineAt! : null;
  const checkLastProgressAt = opts.expectedLastProgressAt !== undefined;
  const rows = await sql<{ payload: Record<string, unknown> | null }[]>`
    UPDATE harness_shared.work_items
       SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
             'release_request_resolved', true,
             -- A terminal item is already settled. Mark the request moot while
             -- preserving the CAS, so the deadline sweep cannot emit a false
             -- reclaim after completion wins the race (EI-21205403365070536).
             'release_request_resolution', CASE
               WHEN COALESCE(status, '') = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
                 THEN 'superseded'::text
               ELSE ${opts.resolution}::text
             END,
             'release_request_resolved_at', ${resolvedAt}::bigint
           ),
           updated_ts = ${Date.now()}
     WHERE workspace_id = ${located.workspaceId} AND feature_id = ${id}
       AND payload ? 'release_request_by'
       AND COALESCE(payload->>'release_request_resolved', 'false') <> 'true'
       AND (${expectedBy}::text IS NULL OR payload->>'release_request_by' = ${expectedBy})
       AND (${expectedHolder}::text IS NULL OR payload->>'release_request_holder' = ${expectedHolder})
       AND (${expectedDeadlineAt}::bigint IS NULL OR (payload->>'release_request_deadline_at')::bigint = ${expectedDeadlineAt})
       AND (NOT ${checkLastProgressAt} OR last_progress_at IS NOT DISTINCT FROM ${opts.expectedLastProgressAt ?? null}::timestamptz)
     RETURNING payload`;
  if (!rows[0]) return null;
  return readWorkItemReleaseRequest(rows[0].payload);
}

export interface DueReleaseRequestRow {
  id: string;
  harness: string | null;
  workspaceId: string;
  holderNow: string | null;
  lastProgressAt: string | Date | null;
  /** The durable work-item touch-set used to target consequence lock release. */
  paths: string[];
  request: WorkItemReleaseRequest;
}

/** Read the explicit repository touch-set from a work-item payload. */
export function readWorkItemPaths(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const raw = (payload as Record<string, unknown>).paths;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const value of raw) {
    const path = typeof value === 'string' ? value.trim() : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Scan for release requests whose deadline has passed and are still unresolved — the
 * sweep's input. A plain SELECT (no `FOR UPDATE`: `harness_shared.work_items` is a
 * UNION ALL view and doesn't support row locks) — safe because the sweep resolves each
 * row via the CAS above BEFORE acting, so a row raced by another tick / a concurrent
 * holder-release is simply skipped (CAS returns null), never double-fired.
 */
export async function findDueReleaseRequests(
  sql: Sql,
  opts: { nowMs: number; limit?: number },
): Promise<DueReleaseRequestRow[]> {
  const rows = await sql<
    { feature_id: string; harness_slug: string | null; workspace_id: string; taken_by: string | null; last_progress_at: string | Date | null; payload: Record<string, unknown> | null }[]
  >`
    SELECT feature_id, harness_slug, workspace_id, taken_by, last_progress_at, payload
      FROM harness_shared.work_items
     WHERE payload ? 'release_request_by'
       AND COALESCE(payload->>'release_request_resolved', 'false') <> 'true'
       AND (payload->>'release_request_deadline_at')::bigint <= ${opts.nowMs}
     ORDER BY (payload->>'release_request_deadline_at')::bigint ASC
     LIMIT ${opts.limit ?? 200}`;
  const out: DueReleaseRequestRow[] = [];
  for (const r of rows) {
    const request = readWorkItemReleaseRequest(r.payload);
    if (!request) continue;
    out.push({
      id: r.feature_id,
      harness: r.harness_slug,
      workspaceId: r.workspace_id,
      holderNow: r.taken_by,
      lastProgressAt: r.last_progress_at,
      paths: readWorkItemPaths(r.payload),
      request,
    });
  }
  return out;
}
