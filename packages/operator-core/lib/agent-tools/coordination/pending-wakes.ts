/**
 * pending-wakes.ts — the STAGED-wake queue for manual-mode agents
 * (hive-agent-tabs-psu-tui-2026-06-09 P-007 / D-005).
 *
 * When an agent's wake-mode is `manual` (wake-mode.ts), `wakeRecipients` STAGES
 * the wake here instead of firing it (the agent is NOT re-invoked). The owner
 * reviews them from the agent's pane and releases / edits / skips (P-008/P-009).
 * Table: harness_shared.pending_wakes (migration 204).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { trackDetached } from '../../detached-imports';

/**
 * Push the wake board after a queue write — both the hive-scoped
 * (`network.hive.wakes`, P-014 item 3) and fleet-wide (`network.fleet.wakes`,
 * EI-597 Step B) sync queries, so the pui's Hive AND non-Hive scopes refetch on
 * mutation instead of polling. Lazy fire-and-forget so this PG seam (+ its tests)
 * never statically depends on the SSE layer; a missing bus is a no-op.
 */
function pushWakeBoard(): void {
  void trackDetached(import('../../sync-sse'))
    .then((m) => {
      m.notifySyncInvalidate('network.hive.wakes');
      m.notifySyncInvalidate('network.fleet.wakes');
    })
    .catch(() => {});
}

export interface StageWakeInput {
  ownerId: string;
  summary?: string;
  /** Arbitrary wake payload (stored as jsonb). */
  payload?: unknown;
  source?: string;
  workspaceId?: string;
}

export interface PendingWake {
  id: number;
  ownerId: string;
  summary: string | null;
  payload: unknown;
  source: string | null;
  workspaceId: string | null;
  createdAt: string;
  /** How many identical fires coalesced into this row (EI-312; ≥1). */
  count: number;
  /** When the newest coalesced fire was staged (== createdAt until a re-fire). */
  lastSeenAt: string;
}

/**
 * Bound the fleet-wide board read (`coord:wake-queue {action:list}` agent-less, the
 * `pui` wake-pane's poll) so a bloated / un-swept queue can never turn it into an
 * unbounded full-table scan — the failure mode that produced repeated 60s tool
 * timeouts on a debris-laden `pending_wakes`. Far above the depth-invariant alarm
 * (DEFAULT_THRESHOLDS.wakeQueueDepthMax = 50, coord-invariant-actions.ts), so every
 * realistic review queue is still returned whole; the depth monitor + the
 * dead-owner sweep (EI-314) are the real backstops for genuine growth.
 */
export const BOARD_READ_LIMIT = 500;

/**
 * Fail FAST and CLEAR on a missing owner id at a per-owner queue op, instead of
 * letting `undefined` reach a postgres binding as the opaque
 * `UNDEFINED_VALUE: Undefined values are not allowed` (EI-943 — the watchdog could
 * only see the cryptic driver error, never the offending call site). Every per-owner
 * op REQUIRES a concrete owner id; the agent-less board read (listAllPendingWakes) is
 * the only legitimate no-owner read and never goes through here.
 */
function assertOwnerId(ownerId: string, fn: string): void {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error(
      `pending-wakes.${fn}: ownerId is required (got ${ownerId === undefined ? 'undefined' : JSON.stringify(ownerId)})`,
    );
  }
}

/**
 * Stage a wake for a manual-mode agent (the P-007 gate calls this instead of firing).
 *
 * EI-312: identical (owner, source, summary, workspace) re-fires COALESCE into the
 * existing staged row — bump `count` + `last_seen_at`, keep the newest payload as the
 * headline — instead of inserting review-spam duplicates. This mirrors the live pump's
 * per-subscriber coalescing (events/await/engine.ts) at the staging boundary, so a
 * wake storm against a paused agent reads as "watchdog ×11", not 11 queue rows.
 *
 * WI-37390 — `workspaceId` DEFAULTS to `activeWorkspaceId()`; a stage must never persist
 * NULL. The four readers below split in exactly the wrong direction: the two TARGETED
 * reads (`listPendingWakes` / `countPendingWakes`) carry no workspace predicate, while the
 * two DISCOVERY surfaces — `listAllPendingWakes` (the owner's fleet-wide board) and
 * `countAllPendingWakes` (the roster badge) — filter `WHERE workspace_id =
 * activeWorkspaceId()`, which is never true for NULL. So a NULL row was visible only to a
 * caller who ALREADY knew whose queue to open, i.e. hidden on precisely the surface whose
 * job is to tell you that.
 *
 * That was not a corner case: EVERY agent-authored stage landed NULL. The sole non-test
 * call site (inbox-wake.ts:190) forwards `opts.workspaceId`, which the agent `coord:send`
 * path leaves undefined — so `coord:send { wake:'required' }` at a manual-mode agent
 * returned `staged: 1` with a note saying the wake was "queued for owner review", for a row
 * no review surface listed. Recipient gated by the manual mode, owner never shown it: the
 * pause/edit gate silently degraded from pause-and-review into DROP, and reported success
 * while doing so. Measured live 2026-08-09 on all 6 rows of the table — the 4 with a
 * workspace were UI `mode:set` notices, both NULL rows were real agent directives, one of
 * them a handoff of the critical release blocker WI-37144.
 *
 * Defaulting HERE — the single insert every stage passes through — rather than at the
 * caller keeps F-C3's isolation intact BY CONSTRUCTION: the row is written with the same
 * value the board filters on, instead of relying on a second rule at each call site that
 * can drift. A genuine cross-workspace stage still overrides it by passing `workspaceId`.
 * ⚠ Note this also changes the dedupe key's third component
 * (`coalesce(workspace_id, '')`), so a row staged before this fix will not coalesce with an
 * otherwise-identical one staged after; both simply appear on the board.
 */
export async function stagePendingWake(input: StageWakeInput): Promise<void> {
  assertOwnerId(input.ownerId, 'stagePendingWake');
  const { sql } = getOrgPg();
  const payloadJson = input.payload != null ? JSON.stringify(input.payload) : null;
  await sql`
    INSERT INTO harness_shared.pending_wakes (owner_id, summary, payload, source, workspace_id)
    VALUES (
      ${input.ownerId},
      ${input.summary ?? null},
      ${payloadJson}::text::jsonb,
      ${input.source ?? null},
      -- WI-37390: DEFAULT the workspace, never persist NULL -- a NULL row is invisible
      -- to the owner's board and the roster badge (both filter on workspace_id) while
      -- staying visible to the two targeted reads. Full rationale in the JSDoc above.
      ${input.workspaceId ?? activeWorkspaceId()}
    )
    ON CONFLICT (owner_id, coalesce(source, ''), coalesce(summary, ''), coalesce(workspace_id, ''))
    DO UPDATE SET
      count = pending_wakes.count + 1,
      last_seen_at = now(),
      payload = EXCLUDED.payload
  `;
  pushWakeBoard();
}

/** An agent's staged wakes, oldest-first (the pane lists them in order). */
export async function listPendingWakes(ownerId: string): Promise<PendingWake[]> {
  assertOwnerId(ownerId, 'listPendingWakes');
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT id, owner_id, summary, payload, source, workspace_id, created_at, count, last_seen_at
    FROM harness_shared.pending_wakes
    WHERE owner_id = ${ownerId}
    ORDER BY id ASC
  `;
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    ownerId: String(r.owner_id),
    summary: (r.summary as string | null) ?? null,
    payload: r.payload ?? null,
    source: (r.source as string | null) ?? null,
    workspaceId: (r.workspace_id as string | null) ?? null,
    createdAt: String(r.created_at),
    count: Number(r.count ?? 1),
    lastSeenAt: String(r.last_seen_at ?? r.created_at),
  }));
}

/**
 * EVERY agent's staged wakes in one read, grouped by owner (owner, then
 * oldest-first) — the fleet-wide wake board (`pui wake-pane`, EI-312). The
 * roster only carries ACTIVE agents, so a per-agent fan-out would miss queues
 * staged for agents that have since gone stale; this is the whole truth.
 */
export async function listAllPendingWakes(): Promise<PendingWake[]> {
  const { sql } = getOrgPg();
  // F-C3 (workspace-data-isolation-leaks): pending_wakes has workspace_id but no
  // RLS + getOrgPg() bypasses it, so scope the fleet-wide wake board to the active
  // workspace (else every workspace's staged wakes appear in one board).
  const rows = await sql`
    SELECT id, owner_id, summary, payload, source, workspace_id, created_at, count, last_seen_at
    FROM harness_shared.pending_wakes
    WHERE workspace_id = ${activeWorkspaceId()}
    ORDER BY owner_id ASC, id ASC
    LIMIT ${BOARD_READ_LIMIT}
  `;
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    ownerId: String(r.owner_id),
    summary: (r.summary as string | null) ?? null,
    payload: r.payload ?? null,
    source: (r.source as string | null) ?? null,
    workspaceId: (r.workspace_id as string | null) ?? null,
    createdAt: String(r.created_at),
    count: Number(r.count ?? 1),
    lastSeenAt: String(r.last_seen_at ?? r.created_at),
  }));
}

/** How many wakes are staged for an agent (the pane's pending-count badge). */
export async function countPendingWakes(ownerId: string): Promise<number> {
  assertOwnerId(ownerId, 'countPendingWakes');
  const { sql } = getOrgPg();
  const rows = await sql`SELECT count(*)::int AS n FROM harness_shared.pending_wakes WHERE owner_id = ${ownerId}`;
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/**
 * Staged-wake counts for ALL agents in one read, keyed by ownerId — for the
 * roster badge (P-008), where countPendingWakes per agent would be N
 * round-trips. Agents with nothing staged are absent (count 0).
 */
export async function countAllPendingWakes(): Promise<Map<string, number>> {
  const { sql } = getOrgPg();
  // F-C3: scope the per-agent badge counts to the active workspace (see listAllPendingWakes).
  const rows = await sql`
    SELECT owner_id, count(*)::int AS n
    FROM harness_shared.pending_wakes
    WHERE workspace_id = ${activeWorkspaceId()}
    GROUP BY owner_id
  `;
  const out = new Map<string, number>();
  for (const r of rows as unknown as Array<{ owner_id: string; n: number }>) {
    if (r.owner_id) out.set(r.owner_id, Number(r.n));
  }
  return out;
}

/**
 * Does the owner already have a staged wake from a source with this prefix?
 * The watchdog's manual-mode idempotence check (EI-312 leg 1): while a
 * watchdog wake sits staged for owner review, the liveness invariant is
 * satisfied — re-checking seams must skip, not stage again (mirrors the
 * auto-mode "a wake is already armed" skip).
 */
export async function hasPendingWakeFromSource(ownerId: string, sourcePrefix: string): Promise<boolean> {
  assertOwnerId(ownerId, 'hasPendingWakeFromSource');
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT 1 FROM harness_shared.pending_wakes
    WHERE owner_id = ${ownerId} AND source LIKE ${sourcePrefix + '%'}
    LIMIT 1
  `;
  return (rows as unknown[]).length > 0;
}

/** Drop one staged wake (after the owner releases / skips it). */
export async function releasePendingWake(id: number): Promise<void> {
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new Error(
      `pending-wakes.releasePendingWake: id must be a finite number (got ${
        id === undefined ? 'undefined' : JSON.stringify(id)
      })`,
    );
  }
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.pending_wakes WHERE id = ${id}`;
  pushWakeBoard();
}

/** Drop ALL of an agent's staged wakes (release_all / skip_all). Returns rows dropped. */
export async function clearPendingWakes(ownerId: string): Promise<number> {
  assertOwnerId(ownerId, 'clearPendingWakes');
  const { sql } = getOrgPg();
  const rows = await sql`
    DELETE FROM harness_shared.pending_wakes WHERE owner_id = ${ownerId} RETURNING id
  `;
  pushWakeBoard();
  return (rows as unknown[]).length;
}

/**
 * GC staged wakes whose owner is GONE (EI-314). A manual-mode staged wake is only
 * ever released by the OWNER reviewing it (releasePendingWake / clearPendingWakes),
 * so a wake staged for an ENDED session — whose owner no longer has a live presence
 * heartbeat — can never be released and accumulates forever, tripping the
 * wake-queue-depth/age invariant as pure debris.
 *
 * Drop wakes for owners with NO presence heartbeat within `liveGraceMin`, and only
 * those rows older than the same grace (so a just-staged wake for an agent
 * momentarily between heartbeat writes is never reaped). A LIVE paused agent
 * (pot:pause → wake-mode manual, but the session is alive) keeps heartbeating, so
 * its review queue is untouched — exactly the rows a human still intends to review.
 *
 * Returns the number of rows swept. Best-effort: the caller (the hourly monitor)
 * swallows errors so a sweep failure never aborts the invariant pass.
 */
export async function sweepDeadOwnerPendingWakes(opts: { liveGraceMin?: number } = {}): Promise<number> {
  const grace = Math.max(1, opts.liveGraceMin ?? 60);
  const { sql } = getOrgPg();
  const rows = await sql`
    DELETE FROM harness_shared.pending_wakes pw
     WHERE pw.created_at < now() - make_interval(mins => ${grace})
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.coord_presence cp
          WHERE cp.owner_id = pw.owner_id
            AND cp.heartbeat_at > now() - make_interval(mins => ${grace})
       )
    RETURNING id`;
  if ((rows as unknown[]).length > 0) pushWakeBoard();
  return (rows as unknown[]).length;
}

/**
 * GC staged wakes past a plain AGE cap, regardless of owner liveness (WI-3097,
 * root-cause follow-up to EI-7765). {@link sweepDeadOwnerPendingWakes} only reaps a
 * DEAD owner's orphaned wakes — a LIVE owner who simply never reviews their wake
 * board (releasePendingWake / clearPendingWakes, the P-008/P-009 agent-pane review
 * flow) can let a staged wake sit indefinitely, silently aging. EI-8664: this auto-EXPIRY
 * sweep IS the substrate's drain mechanism for that case, and the coord-invariant
 * watchdog's wake-queue AGE alarm now fires on THIS deadline (pendingWakeStaleHours +
 * grace) rather than a separate lower threshold — so a wake reaped here never trips the
 * alarm, and the alarm fires only if this sweep genuinely fails to keep the queue bounded.
 *
 * This is the auto-EXPIRY counterpart: unconditionally drop any wake older than
 * `staleHours` (a genuine grace window for a busy-but-live owner to review it before it is
 * swept), independent of presence/heartbeat. A live owner who wants to act on an expired wake still has the
 * underlying coordination event in coord:feed/coord:thread; this only bounds how long
 * an UNREVIEWED staged copy can accumulate as debris.
 *
 * Returns the number of rows swept. Best-effort: callers swallow errors so a sweep
 * failure never aborts the invariant pass it runs alongside.
 */
export async function sweepStalePendingWakes(opts: { staleHours?: number } = {}): Promise<number> {
  const hours = Math.max(1, opts.staleHours ?? 24);
  const { sql } = getOrgPg();
  const rows = await sql`
    DELETE FROM harness_shared.pending_wakes pw
     WHERE pw.created_at < now() - make_interval(hours => ${hours})
    RETURNING id`;
  if ((rows as unknown[]).length > 0) pushWakeBoard();
  return (rows as unknown[]).length;
}
