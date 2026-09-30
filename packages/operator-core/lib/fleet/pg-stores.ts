/**
 * fleet/pg-stores — the Postgres implementations of the @papercusp/structured-concurrency
 * ports, over harness_shared.{spawned_agents,fleet_governor,fleet_sagas,fleet_tombstones}.
 *
 * This is the host adapter: the generic toolkit names no table, no SQL, no domain — it
 * drives these stores through the port interfaces. The compound atomic operations
 * (cancelActiveSubtree, recordRestartIntensity, the governor transaction) own a real PG
 * `BEGIN … FOR UPDATE`; the toolkit supplies only the pure decision policy.
 *
 * session_owner (migration 146) is the link that lets transitive cancellation reach a
 * node's locks/claims; the claim releases (harness_features_consolidated.taken_by +
 * plan_item_claims) ride inside cancelActiveSubtree's transaction so they are atomic with
 * the status flip — and reported back as opaque `resourcesReleased` counts.
 */
import type { Sql, TransactionSql } from 'postgres';
import type {
  BucketRow,
  CancelActiveResult,
  CircuitRow,
  CreditRow,
  FinishSpawnInput,
  GovernorStore,
  GovernorTx,
  IntensityDecision,
  RecordSpawnInput,
  RestartWindowRow,
  SagaJournal,
  SagaStepLog,
  SpawnTreeStore,
  SubtreeQuery,
  TombstoneRef,
  TombstoneStore,
} from '@papercusp/structured-concurrency';
import {
  isActiveStatus,
  type IntensityResult,
  type RestartStrategy,
  type SpawnNode,
  type SpawnStatus,
} from '@papercusp/structured-concurrency';
import { trackDetached } from '../detached-imports';

/** A query handle the stores accept — a pooled client or an open transaction. */
export type Db = Sql | TransactionSql;

const MAX_TREE_DEPTH = 32; // cycle guard for the recursive walks

interface SpawnRowDb {
  spawn_id: string;
  parent_spawn_id: string | null;
  workspace_id: string;
  harness_slug: string | null;
  parent_role: string | null;
  child_role: string;
  status: string;
  session_owner: string | null;
  coordination_domain: string | null;
  feature_id: string | null;
  chunk_id: string | null;
  plan_slug: string | null;
  item_id: string | null;
  model_spec: string | null;
  model_tier: string | null;
  brief: string | null;
  restart_strategy: string | null;
  restart_count: number | null;
  restart_window_start: Date | null;
  heartbeat_at: string | Date | null;
  last_output_at: string | Date | null;
  depth?: number;
}

const SELECT_COLS = `spawn_id, parent_spawn_id, workspace_id, harness_slug, parent_role,
  child_role, status, session_owner, coordination_domain, feature_id, chunk_id,
  plan_slug, item_id, model_spec, model_tier, brief, restart_strategy, restart_count,
  restart_window_start, heartbeat_at, last_output_at`;

function rowToNode(r: SpawnRowDb): SpawnNode {
  const toDate = (v: string | Date | null | undefined): Date | null => {
    if (!v) return null;
    return v instanceof Date ? v : new Date(v);
  };
  return {
    spawnId: r.spawn_id,
    parentSpawnId: r.parent_spawn_id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    parentRole: r.parent_role,
    childRole: r.child_role,
    status: (r.status as SpawnStatus) ?? 'running',
    sessionOwner: r.session_owner,
    coordinationDomain: r.coordination_domain || 'default',
    featureId: r.feature_id,
    chunkId: r.chunk_id,
    planSlug: r.plan_slug,
    itemId: r.item_id,
    modelSpec: r.model_spec,
    modelTier: r.model_tier,
    brief: r.brief,
    restartStrategy: (r.restart_strategy as RestartStrategy) || 'one_for_one',
    restartCount: Number(r.restart_count ?? 0),
    restartWindowStart: r.restart_window_start,
    heartbeatAt: toDate(r.heartbeat_at),
    lastOutputAt: toDate(r.last_output_at),
    depth: Number(r.depth ?? 0),
  };
}

// ── Standalone spawn-tree ops (Db-typed so they compose inside a caller's txn) ────────

export async function recordSpawnPg(sql: Db, input: RecordSpawnInput): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents (
      spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role, child_role,
      run_id, feature_id, chunk_id, plan_slug, item_id, model_spec, model_tier, brief,
      session_owner, coordination_domain, restart_strategy, status, started_at
    ) VALUES (
      ${input.spawnId}, ${input.workspaceId}, ${input.harnessSlug ?? null},
      ${input.parentSpawnId ?? null}, ${input.parentRole ?? null}, ${input.childRole},
      ${input.runId}, ${input.featureId ?? null}, ${input.chunkId ?? null},
      ${input.planSlug ?? null}, ${input.itemId ?? null}, ${input.modelSpec ?? null},
      ${input.modelTier ?? null}, ${input.brief ?? null}, ${input.sessionOwner ?? null},
      ${input.coordinationDomain ?? 'default'}, ${input.restartStrategy ?? 'one_for_one'},
      ${input.status ?? 'running'}, now()
    )
    ON CONFLICT (spawn_id) DO UPDATE SET
      session_owner = COALESCE(EXCLUDED.session_owner, harness_shared.spawned_agents.session_owner),
      plan_slug     = COALESCE(EXCLUDED.plan_slug, harness_shared.spawned_agents.plan_slug),
      item_id       = COALESCE(EXCLUDED.item_id, harness_shared.spawned_agents.item_id),
      model_spec    = COALESCE(EXCLUDED.model_spec, harness_shared.spawned_agents.model_spec),
      model_tier    = COALESCE(EXCLUDED.model_tier, harness_shared.spawned_agents.model_tier),
      restart_strategy = EXCLUDED.restart_strategy
  `;
  // data-sync-push-completion-2026-06-23 D-008 follow-up (P-007 freshness gap): the
  // MugHeartbeat sidebar reads `hive.controlState`, whose lastWakeAt = the MORE RECENT
  // of the recordHiveWake ledger AND `latestQueenWakeAt` (= max(started_at) of THIS
  // table's child_role='queen' rows). The wake-brain Queen spawns the queen WITHOUT
  // calling recordHiveWake, so before this a real queen wake only surfaced on the
  // @papercusp/sync 180s drift-repair tick — a freshness regression from the heartbeat's
  // old 12s self-poll. recordSpawnPg is the single spawned_agents INSERT chokepoint, so
  // pushing here on a QUEEN spawn (rare — once per wake cycle, NOT per heartbeat: status
  // updates go through finishSpawnPg/heartbeat paths) covers every queen-spawn path
  // (wake-brain, pot:wake, urgent-wake, create) uniformly. Fire-and-forget + non-throwing
  // (mirrors pot:start/pause + recordHiveWake); name-only/{} matches the no-arg consumer;
  // the 90s source-dedupe caps the rate. A rolled-back caller txn is harmless — the
  // resolver just re-reads the unchanged max.
  if (input.childRole === 'mug') {
    void trackDetached(import('../sync-sse'))
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('hive.controlState', {}))
      .catch(() => {});
  }
}

export async function finishSpawnPg(sql: Db, input: FinishSpawnInput): Promise<void> {
  // WI-3302: durable-spawn / blueprint / chat launch paths call heartbeatSpawns()
  // with no output-activity map at all (mapless by construction — they never track
  // per-chunk activity), so last_output_at stays null for their entire run even when
  // real output landed (output_tail proves it). Stamp it here as a cheap terminal
  // fallback: whenever this finish carries a non-null outputTail (real output was
  // captured), record SOME last_output_at rather than leaving it permanently null.
  // Never clobbers an earlier, more precise mid-run heartbeat stamp with an older
  // value — GREATEST keeps whichever is newer.
  const outputTail: string | null = input.outputTail ?? null;
  await sql`
    UPDATE harness_shared.spawned_agents
       SET status = ${input.status},
           finished_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
           exit_code = ${input.exitCode ?? null},
           error_message = COALESCE(${input.errorMessage ?? null}, error_message),
           output_tail = COALESCE(${outputTail}::text, output_tail),
           last_output_at = CASE
             WHEN ${outputTail}::text IS NOT NULL THEN GREATEST(COALESCE(last_output_at, now()), now())
             ELSE last_output_at
           END
     WHERE workspace_id = ${input.workspaceId} AND spawn_id = ${input.spawnId}
  `;
}

export async function getSpawnPg(sql: Db, workspaceId: string, spawnId: string): Promise<SpawnNode | null> {
  const rows = await sql<SpawnRowDb[]>`
    SELECT ${sql.unsafe(SELECT_COLS)}, 0 AS depth
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND spawn_id = ${spawnId}`;
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function getSubtreePg(sql: Db, opts: SubtreeQuery): Promise<SpawnNode[]> {
  const rows = await sql<SpawnRowDb[]>`
    WITH RECURSIVE tree AS (
      SELECT ${sql.unsafe(SELECT_COLS)}, 0 AS depth
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${opts.workspaceId} AND spawn_id = ${opts.rootSpawnId}
      UNION ALL
      SELECT ${sql.unsafe(
        SELECT_COLS.split(',')
          .map((c) => 'c.' + c.trim())
          .join(', '),
      )}, t.depth + 1
        FROM harness_shared.spawned_agents c
        JOIN tree t ON c.parent_spawn_id = t.spawn_id
       WHERE c.workspace_id = ${opts.workspaceId} AND t.depth < ${MAX_TREE_DEPTH}
    )
    SELECT * FROM tree
     ${opts.includeRoot === false ? sql`WHERE depth > 0` : sql``}
     ORDER BY depth ASC, spawn_id ASC`;
  return rows.map(rowToNode);
}

export async function openChildrenPg(sql: Db, workspaceId: string, parentSpawnId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH RECURSIVE tree AS (
      SELECT spawn_id, status, 0 AS depth
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId} AND parent_spawn_id = ${parentSpawnId}
      UNION ALL
      SELECT c.spawn_id, c.status, t.depth + 1
        FROM harness_shared.spawned_agents c
        JOIN tree t ON c.parent_spawn_id = t.spawn_id
       WHERE c.workspace_id = ${workspaceId} AND t.depth < ${MAX_TREE_DEPTH}
    )
    SELECT count(*)::int AS n FROM tree WHERE status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

export async function directChildrenPg(sql: Db, workspaceId: string, parentSpawnId: string): Promise<SpawnNode[]> {
  const rows = await sql<SpawnRowDb[]>`
    SELECT ${sql.unsafe(SELECT_COLS)}, 1 AS depth
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND parent_spawn_id = ${parentSpawnId}
     ORDER BY started_at ASC, spawn_id ASC`;
  return rows.map(rowToNode);
}

/** Phase-1 of transitive cancellation: status flip + claim releases, atomically. */
export async function cancelActiveSubtreePg(
  sql: Sql,
  opts: { workspaceId: string; rootSpawnId: string; reason: string },
): Promise<CancelActiveResult> {
  return sql.begin(async (tx) => {
    const subtree = await getSubtreePg(tx, { workspaceId: opts.workspaceId, rootSpawnId: opts.rootSpawnId });
    const toCancel = subtree.filter((n) => isActiveStatus(n.status));
    const alreadyTerminalNodes = subtree.filter((n) => !isActiveStatus(n.status));
    const alreadyTerminal = alreadyTerminalNodes.map((n) => n.spawnId);

    if (toCancel.length > 0) {
      const ids = toCancel.map((n) => n.spawnId);
      await tx`
        UPDATE harness_shared.spawned_agents
           SET status = 'cancelled',
               cancel_requested = true,
               cancelled_at = now(),
               cancel_reason = ${opts.reason},
               finished_at = COALESCE(finished_at, now())
         WHERE workspace_id = ${opts.workspaceId}
           AND spawn_id = ANY(${ids}::text[])
           AND status IN ('running', 'restarting')`;
    }

    // EI-6324: release claims for the WHOLE subtree, not just the freshly-cancelled
    // nodes. A node that already died on its own (crashed / reaped / failed before
    // this call — the "alreadyTerminal" set) is EXACTLY the case the caller most
    // needs `fleet:cancel` to unstick: its status transition never went through THIS
    // path, so nothing else guaranteed its work-item/plan-item claim was released —
    // the periodic stale-claims reaper (work-items-stale-claims.ts) only catches it
    // after a grace window (or immediately, but only for a NARROW confirmed-terminal
    // status set, and only within its own poll cadence). `fleet:cancel`'s documented
    // contract is "release its claims + locks NOW" — that must hold for a dead-but-
    // never-cancelled node too, or the caller is left with an orphaned, unreclaimable
    // lane (observed live: EI-6324 — "returned ok but released 0 claims", the
    // work-item then un-claimable by a replacement spawn). We do NOT touch
    // already-terminal nodes' `status`/`cancelled_at` (they are already at their real
    // terminal state — only the resource release is new), so this is additive and
    // safe: no already-terminal node's own history/verdict changes.
    const claimEligible = [...toCancel, ...alreadyTerminalNodes];

    // Release work-item claims this subtree held (feature taken_by = the node's owner).
    const claimNodes = claimEligible.filter((n) => n.featureId && n.harnessSlug && n.sessionOwner);
    let claimsReleased = 0;
    if (claimNodes.length > 0) {
      const released = await tx<{ feature_id: string }[]>`
        UPDATE harness_shared.harness_features_consolidated f
           -- WI-6303: clear last_progress_at with the claim — a fleet:cancel
           -- release must not leave a stale progress stamp that later reads as
           -- genuinely in-flight work (see work-items-stale-claims.ts's identical
           -- WI-6303 fix for the live-verified root-cause writeup).
           SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL, updated_ts = ${Date.now()}
          FROM unnest(
                 ${claimNodes.map((n) => n.harnessSlug!)}::text[],
                 ${claimNodes.map((n) => n.featureId!)}::text[],
                 ${claimNodes.map((n) => n.sessionOwner!)}::text[]
               ) AS p(harness, feature, owner)
         WHERE f.workspace_id = ${opts.workspaceId}
           AND f.harness_slug = p.harness
           AND f.feature_id = p.feature
           AND f.taken_by = p.owner
        RETURNING f.feature_id`;
      claimsReleased = released.length;
    }

    // Release plan-item claims (leases) this subtree held (EI-6324: both freshly-
    // cancelled AND already-terminal nodes — same rationale as claimNodes above).
    const planNodes = claimEligible.filter((n) => n.planSlug && n.itemId && n.harnessSlug && n.sessionOwner);
    let planClaimsReleased = 0;
    if (planNodes.length > 0) {
      const released = await tx<{ item_id: string }[]>`
        DELETE FROM harness_shared.plan_item_claims c
         USING unnest(
                 ${planNodes.map((n) => n.harnessSlug!)}::text[],
                 ${planNodes.map((n) => n.planSlug!)}::text[],
                 ${planNodes.map((n) => n.itemId!)}::text[],
                 ${planNodes.map((n) => n.sessionOwner!)}::text[]
               ) AS p(harness, plan_slug, item_id, owner)
         WHERE c.workspace_id = ${opts.workspaceId}
           AND c.harness_slug = p.harness
           AND c.plan_slug = p.plan_slug
           AND c.item_id = p.item_id
           AND c.owner = p.owner
        RETURNING c.item_id`;
      planClaimsReleased = released.length;
    }

    return {
      cancelled: toCancel,
      alreadyTerminal,
      resourcesReleased: { claims: claimsReleased, planClaims: planClaimsReleased },
    };
  }) as Promise<CancelActiveResult>;
}

/** Atomic, row-locked restart-window record; the toolkit supplies the windowing policy. */
export async function recordRestartIntensityPg(
  sql: Sql,
  opts: { workspaceId: string; spawnId: string; maxRestarts: number; windowSec: number },
  decide: (row: RestartWindowRow, nowMs: number) => IntensityDecision,
): Promise<IntensityResult | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ restart_count: number; restart_window_start: Date | null }[]>`
      SELECT restart_count, restart_window_start
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${opts.workspaceId} AND spawn_id = ${opts.spawnId}
       FOR UPDATE`;
    if (rows.length === 0) return null;
    const nowMs = Date.now();
    const decision = decide(
      { restartCount: Number(rows[0].restart_count), restartWindowStart: rows[0].restart_window_start },
      nowMs,
    );
    const updated = await tx<{ restart_window_start: Date }[]>`
      UPDATE harness_shared.spawned_agents
         SET restart_count = ${decision.count},
             restart_window_start = to_timestamp(${decision.windowStartMs}::double precision / 1000.0)
       WHERE workspace_id = ${opts.workspaceId} AND spawn_id = ${opts.spawnId}
      RETURNING restart_window_start`;
    return {
      spawnId: opts.spawnId,
      count: decision.count,
      windowStart: updated[0].restart_window_start,
      windowReset: decision.windowReset,
      intensityExceeded: decision.intensityExceeded,
      maxRestarts: opts.maxRestarts,
      windowSec: opts.windowSec,
    };
  }) as Promise<IntensityResult | null>;
}

export async function markRestartingPg(sql: Db, workspaceId: string, spawnIds: string[]): Promise<void> {
  if (spawnIds.length === 0) return;
  await sql`
    UPDATE harness_shared.spawned_agents
       SET status = 'restarting', finished_at = NULL
     WHERE workspace_id = ${workspaceId}
       AND spawn_id = ANY(${spawnIds}::text[])
       AND status IN ('running', 'failed', 'cancelled', 'restarting')`;
}

export async function markFailedPg(sql: Db, workspaceId: string, spawnId: string, reason: string): Promise<void> {
  await sql`
    UPDATE harness_shared.spawned_agents
       SET status = 'failed', error_message = ${reason}
     WHERE workspace_id = ${workspaceId} AND spawn_id = ${spawnId}`;
}

/** Wire the PG spawn-tree ops into the SpawnTreeStore port (bound to one pool handle). */
export function pgSpawnTreeStore(sql: Sql): SpawnTreeStore {
  return {
    recordSpawn: (input) => recordSpawnPg(sql, input),
    finishSpawn: (input) => finishSpawnPg(sql, input),
    getSpawn: (ws, id) => getSpawnPg(sql, ws, id),
    getSubtree: (query) => getSubtreePg(sql, query),
    openChildren: (ws, parent) => openChildrenPg(sql, ws, parent),
    directChildren: (ws, parent) => directChildrenPg(sql, ws, parent),
    cancelActiveSubtree: (opts) => cancelActiveSubtreePg(sql, opts),
    recordRestartIntensity: (opts, decide) => recordRestartIntensityPg(sql, opts, decide),
    markRestarting: (ws, ids) => markRestartingPg(sql, ws, ids),
    markFailed: (ws, id, reason) => markFailedPg(sql, ws, id, reason),
  };
}

// ── Governor store ──────────────────────────────────────────────────────────────────

function msOf(v: string | Date | null | undefined, fallback: number): number {
  if (!v) return fallback;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

function pgGovernorTx(tx: TransactionSql): GovernorTx {
  return {
    async lockCircuit(ws, scope) {
      const r = await tx<
        {
          cb_state: string | null;
          cb_failures: number;
          cb_threshold: number | null;
          cb_cooldown_sec: number | null;
          cb_opened_at: string | Date | null;
        }[]
      >`
        SELECT cb_state, cb_failures, cb_threshold, cb_cooldown_sec, cb_opened_at
          FROM harness_shared.fleet_governor
         WHERE workspace_id = ${ws} AND kind = 'circuit' AND scope_key = ${scope}
         FOR UPDATE`;
      if (r.length === 0) return null;
      return {
        state: (r[0].cb_state as CircuitRow['state']) ?? 'closed',
        failures: Number(r[0].cb_failures ?? 0),
        threshold: r[0].cb_threshold ?? null,
        cooldownSec: r[0].cb_cooldown_sec ?? null,
        openedAtMs: r[0].cb_opened_at ? msOf(r[0].cb_opened_at, 0) : null,
      };
    },
    async setCircuit(ws, scope, patch) {
      if (patch.openedAtMs !== undefined) {
        await tx`
          UPDATE harness_shared.fleet_governor
             SET cb_state = COALESCE(${patch.state ?? null}, cb_state),
                 cb_failures = COALESCE(${patch.failures ?? null}::int, cb_failures),
                 cb_opened_at = to_timestamp(${patch.openedAtMs}::double precision / 1000.0)
           WHERE workspace_id = ${ws} AND kind = 'circuit' AND scope_key = ${scope}`;
      } else {
        await tx`
          UPDATE harness_shared.fleet_governor
             SET cb_state = COALESCE(${patch.state ?? null}, cb_state),
                 cb_failures = COALESCE(${patch.failures ?? null}::int, cb_failures)
           WHERE workspace_id = ${ws} AND kind = 'circuit' AND scope_key = ${scope}`;
      }
    },
    async lockBucket(ws, scope) {
      const r = await tx<
        { capacity: string; refill_per_sec: string; tokens: string; updated_at: string | Date | null }[]
      >`
        SELECT capacity, refill_per_sec, tokens, updated_at
          FROM harness_shared.fleet_governor
         WHERE workspace_id = ${ws} AND kind = 'bucket' AND scope_key = ${scope}
         FOR UPDATE`;
      if (r.length === 0) return null;
      return {
        capacity: Number(r[0].capacity),
        refillPerSec: Number(r[0].refill_per_sec),
        tokens: Number(r[0].tokens),
        updatedAtMs: r[0].updated_at ? msOf(r[0].updated_at, 0) : null,
      } satisfies BucketRow;
    },
    async setBucketTokens(ws, scope, tokens, nowMs) {
      await tx`
        UPDATE harness_shared.fleet_governor
           SET tokens = ${tokens}, updated_at = to_timestamp(${nowMs}::double precision / 1000.0)
         WHERE workspace_id = ${ws} AND kind = 'bucket' AND scope_key = ${scope}`;
    },
    async lockCredit(ws, scope) {
      const r = await tx<{ credits: number | null; credit_max: number | null }[]>`
        SELECT credits, credit_max FROM harness_shared.fleet_governor
         WHERE workspace_id = ${ws} AND kind = 'credit' AND scope_key = ${scope}
         FOR UPDATE`;
      if (r.length === 0) return null;
      return { credits: Number(r[0].credits ?? 0), creditMax: r[0].credit_max ?? null } satisfies CreditRow;
    },
    async consumeCredit(ws, scope) {
      await tx`
        UPDATE harness_shared.fleet_governor SET credits = credits - 1
         WHERE workspace_id = ${ws} AND kind = 'credit' AND scope_key = ${scope} AND credits IS NOT NULL`;
    },
  };
}

export function pgGovernorStore(sql: Sql): GovernorStore {
  return {
    async configureBucket(opts) {
      const ts: Date | ReturnType<Sql> = opts.nowMs != null ? new Date(opts.nowMs) : sql`now()`;
      await sql`
        INSERT INTO harness_shared.fleet_governor (workspace_id, kind, scope_key, capacity, refill_per_sec, tokens, updated_at)
        VALUES (${opts.workspaceId}, 'bucket', ${opts.scopeKey}, ${opts.capacity}, ${opts.refillPerSec}, ${opts.tokens ?? opts.capacity}, ${ts})
        ON CONFLICT (workspace_id, kind, scope_key) DO UPDATE SET
          capacity = EXCLUDED.capacity, refill_per_sec = EXCLUDED.refill_per_sec,
          tokens = LEAST(EXCLUDED.tokens, EXCLUDED.capacity), updated_at = ${ts}`;
    },
    async configureCircuit(opts) {
      await sql`
        INSERT INTO harness_shared.fleet_governor (workspace_id, kind, scope_key, cb_state, cb_failures, cb_threshold, cb_cooldown_sec)
        VALUES (${opts.workspaceId}, 'circuit', ${opts.scopeKey}, 'closed', 0, ${opts.threshold}, ${opts.cooldownSec})
        ON CONFLICT (workspace_id, kind, scope_key) DO UPDATE SET
          cb_threshold = EXCLUDED.cb_threshold, cb_cooldown_sec = EXCLUDED.cb_cooldown_sec`;
    },
    async configureCredits(opts) {
      await sql`
        INSERT INTO harness_shared.fleet_governor (workspace_id, kind, scope_key, credits, credit_max)
        VALUES (${opts.workspaceId}, 'credit', ${opts.scopeKey}, ${opts.credits}, ${opts.max ?? opts.credits})
        ON CONFLICT (workspace_id, kind, scope_key) DO UPDATE SET
          credits = EXCLUDED.credits, credit_max = EXCLUDED.credit_max`;
    },
    async grantCredits(opts) {
      const rows = await sql<{ credits: number }[]>`
        UPDATE harness_shared.fleet_governor
           SET credits = LEAST(COALESCE(credit_max, credits + ${opts.n}), credits + ${opts.n})
         WHERE workspace_id = ${opts.workspaceId} AND kind = 'credit' AND scope_key = ${opts.scopeKey}
        RETURNING credits`;
      return rows[0] ? Number(rows[0].credits) : 0;
    },
    async recordCircuitSuccess(opts) {
      await sql`
        UPDATE harness_shared.fleet_governor
           SET cb_state = 'closed', cb_failures = 0, cb_opened_at = NULL
         WHERE workspace_id = ${opts.workspaceId} AND kind = 'circuit' AND scope_key = ${opts.scopeKey}`;
    },
    transaction<T>(fn: (tx: GovernorTx) => Promise<T>): Promise<T> {
      return sql.begin((tx) => fn(pgGovernorTx(tx))) as Promise<T>;
    },
  };
}

// ── Saga journal + tombstone store ────────────────────────────────────────────────────

export function pgSagaJournal(sql: Db): SagaJournal {
  return {
    async create(opts) {
      await sql`
        INSERT INTO harness_shared.fleet_sagas (workspace_id, saga_id, name, status, steps)
        VALUES (${opts.workspaceId}, ${opts.sagaId}, ${opts.name}, 'running', ${JSON.stringify(opts.steps)}::text::jsonb)`;
    },
    async update(opts: { workspaceId: string; sagaId: string; steps: SagaStepLog[]; status: string; error?: string }) {
      await sql`
        UPDATE harness_shared.fleet_sagas
           SET steps = ${JSON.stringify(opts.steps)}::text::jsonb, status = ${opts.status},
               error = ${opts.error ?? null}, updated_at = now()
         WHERE workspace_id = ${opts.workspaceId} AND saga_id = ${opts.sagaId}`;
    },
  };
}

export function pgTombstoneStore(sql: Db): TombstoneStore {
  return {
    async upsert(ref: TombstoneRef, opts) {
      await sql`
        INSERT INTO harness_shared.fleet_tombstones (workspace_id, ref_kind, ref_id, reason, deleted_by, deleted_at, gc_after)
        VALUES (${ref.workspaceId}, ${ref.refKind}, ${ref.refId}, ${opts.reason}, ${opts.deletedBy}, ${new Date(opts.deletedAtMs)}, ${new Date(opts.gcAfterMs)})
        ON CONFLICT (workspace_id, ref_kind, ref_id) DO UPDATE SET
          deleted_at = ${new Date(opts.deletedAtMs)}, restored_at = NULL, gc_after = ${new Date(opts.gcAfterMs)}, reason = EXCLUDED.reason`;
    },
    async restore(ref: TombstoneRef) {
      const rows = await sql<{ ref_id: string }[]>`
        UPDATE harness_shared.fleet_tombstones SET restored_at = now()
         WHERE workspace_id = ${ref.workspaceId} AND ref_kind = ${ref.refKind} AND ref_id = ${ref.refId}
           AND restored_at IS NULL
        RETURNING ref_id`;
      return rows.length > 0;
    },
    async isTombstoned(ref: TombstoneRef) {
      const rows = await sql`
        SELECT 1 FROM harness_shared.fleet_tombstones
         WHERE workspace_id = ${ref.workspaceId} AND ref_kind = ${ref.refKind} AND ref_id = ${ref.refId}
           AND restored_at IS NULL`;
      return rows.length > 0;
    },
    async gcExpired(opts) {
      const cutoff = opts.nowMs != null ? new Date(opts.nowMs) : null;
      const rows = await sql<{ ref_kind: string; ref_id: string }[]>`
        DELETE FROM harness_shared.fleet_tombstones
         WHERE workspace_id = ${opts.workspaceId}
           AND restored_at IS NULL
           AND gc_after <= ${cutoff ?? sql`now()`}
           AND ${opts.refKind ? sql`ref_kind = ${opts.refKind}` : sql`TRUE`}
        RETURNING ref_kind, ref_id`;
      return rows.map((r) => `${r.ref_kind}:${r.ref_id}`);
    },
  };
}
