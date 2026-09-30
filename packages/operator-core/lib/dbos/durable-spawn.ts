/**
 * dbos/durable-spawn — the reusable DURABLE-SPAWN wrapper
 * (unify-agent-spawn-chokepoint-2026-06-06, P-010 / D-003 / D-007).
 *
 * Generalizes the feature pipeline's durable-step pattern (a registered DBOS
 * workflow + a retried step + a dedup-keyed start) into a reusable primitive for
 * the AUTONOMOUS launches that used to `void loopbackFetch(/invoke)` and LOSE the
 * agent on a host crash. `durableSpawnFire(input)` wraps the `/invoke` fire in a
 * registered, step-retried, dedup-keyed DBOS workflow: a host crash mid-fire is
 * resumed by DBOS recovery and the fire re-runs once, instead of silently vanishing.
 *
 * Degrade-safe by spawn class / DBOS state (D-003 / D-007). Request-only hosts
 * enqueue with DBOSClient into the same durable queue. `durableSpawnFire`
 * returns `false` only when no enqueue was attempted, for example when:
 *   • DBOS is OFF (`PAPERCUSP_DBOS_ORCHESTRATOR=0`), or
 *   • the request-only host cannot create a DBOS client, or
 *   • it cannot start a durable workflow here (`DBOS.isInStep()` — e.g. it was
 *     called from inside another DBOS step/transaction, like git-sync's
 *     `git-sync:record` checkpoint dispatching the doc-steward), where starting a
 *     child workflow is disallowed.
 * An attempted enqueue with an unconfirmed outcome THROWS: a direct fallback
 * could duplicate a child whose durable workflow already committed. It never
 * blocks on the agent's lifetime; the executor runs detached.
 *
 * Per-class durability (D-003 — the class is the dial, not a global on/off):
 *   • launch-blueprints (release cadence, event reactions, git-sync merge-resolver)
 *     fire top-level → this wrapper makes them durable.
 *   • the routine bare-role fire runs INSIDE a durable `routineFireWorkflow` step;
 *     its recovery is the routine cadence (the next due tick re-fires) — it stays
 *     as-is (a child-workflow can't start from inside a step anyway).
 *   • a SYSTEM action that wants a durable child fire (EI-403-A) returns the fire
 *     request as `SystemActionResult.durableSpawns`; `routineFireWorkflow` drains it
 *     via `startDurableSpawns` AFTER the action's step, at the workflow layer where
 *     `startWorkflow` is legal — escaping the from-a-step limitation for the
 *     implement lane without making the fire fire-and-forget.
 *   • `cup:spawn` (operator-spawn) keeps the durable nursery row + the P-011
 *     reclaim sweeper (fail-loud + free the ceiling on a dead host) — chosen to
 *     preserve `fleet:cancel`'s in-process abort and because a one-shot
 *     operator-initiated spawn should not silently re-run on a host restart.
 *
 * Registered in bootstrap.ts under `dbosOrchestratorActive()` — BEFORE
 * `DBOS.launch()`, like the feature-pipeline + coord-program workflows.
 */
import { DBOS, DBOSClient, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { queueConcurrency } from './queue-concurrency';
import { dbosOrchestratorActive } from './dbos-flags';
import { dbosStarted, withDbosIdleTxGrace } from './bootstrap';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { loopbackFetch } from '../loopback-fetch';
import { agentProducedTurn, type SpawnFailureClass } from '../fleet/invoke-outcome';
import {
  isReleaseFixerNoTurnFailure,
  recordReleaseFixerNoTurnEscalation,
} from '../release/fixer-liveness';
import type { Db } from '../fleet/pg-stores';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

/**
 * HTTP statuses where retrying the IDENTICAL replayed request can never succeed,
 * so the fire step does NOT retry or DBOS-recover them — it returns a terminal
 * result, closes the fleet:tree row `failed`, and stops.
 *
 * Two deterministic-failure families:
 *   • TARGET GONE (404/410): the harness was deleted, so `/invoke` 404s forever
 *     (observed on green for deleted harnesses like offsite-planner-demo).
 *   • CLIENT ERROR (other 4xx): the persisted request is malformed for the target
 *     — e.g. WI-262/D1: a durable replay after a bg-host restart lost its resolved
 *     workspace and re-fires with `workspace:"*"` → 400 `unknown_workspace`. The
 *     same persisted body 400s on every replay, so 3 step-retries × 5 DBOS
 *     recoveries spam `→ HTTP 400` every ~1s and hold a zombie row. Deterministic
 *     → terminal.
 *
 * EXCEPT the genuinely transient 4xx — 408 (timeout) + 429 (rate-limit / gateway
 * pacing) — which stay retryable, as do all 5xx + network errors.
 */
export function isPermanentSpawnStatus(status: number): boolean {
  if (status === 408 || status === 429) return false; // transient 4xx
  return status >= 400 && status < 500;
}

export interface DurableSpawnFireInput {
  /** The `/invoke?role=<role>` URL to POST. */
  url: string;
  /** The POST body (kickoff, extra, timeoutMs, …). Plain data → DBOS-serializable. */
  body: Record<string, unknown>;
  /** Unique-per-fire key → the DBOS workflow ID + dedup ID. A crash recovers THIS
   *  fire by this id; two distinct fires must use distinct keys. */
  idempotencyKey: string;
  /** For logging — "<slug>/<role>". */
  label?: string;
  /**
   * OPT-IN fleet:tree visibility (EI-403 round-2). When set, the durable workflow
   * writes a `spawned_agents` row (stable `spawn_id = durable-spawn:<idempotencyKey>`,
   * idempotent on conflict so a step retry / DBOS recovery replay never duplicates
   * it) BEFORE the fire and `finishSpawn`s it after — so a durably-fired launch
   * appears in fleet:tree, the same invariant the fire-and-forget fallback holds
   * (WI-108). Recording is best-effort: a bookkeeping failure never aborts the fire.
   * OMIT for callers whose spawn is recorded by another path (e.g. hive launches
   * write their own queen/bee rows — recording here too would double-count).
   */
  spawnRecord?: {
    workspaceId: string;
    harnessSlug?: string;
    childRole: string;
    /** Defaults to 'operator' — a parentless system launch (matches every root spawn). */
    parentRole?: string;
    parentSpawnId?: string | null;
    /** e.g. the improvement-lane `EI-NNN` the worker is fixing — shows in fleet:tree. */
    itemId?: string | null;
  };
}

export const DURABLE_SPAWN_FINISH_CUSHION_MS = 60_000;
const CONTROL_PLANE_USAGE_LIMIT_PAUSE_MS = 10 * 60_000;

type SpawnRecordInput = NonNullable<DurableSpawnFireInput['spawnRecord']>;
type QueenSingletonAdmission =
  | { admitted: true }
  | { admitted: false; activeSpawnId: string; activeHarnessSlug: string | null };

export function durableSpawnWorkflowTimeoutMs(input: DurableSpawnFireInput): number | undefined {
  const timeoutMs = input.body?.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.trunc(timeoutMs) + DURABLE_SPAWN_FINISH_CUSHION_MS;
}

function isCodexModelSpec(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  const id = spec.trim().toLowerCase();
  return id.startsWith('openai-codex/') || id.startsWith('chatgpt:') || /^gpt-\d/.test(id);
}

function parseInvokeTarget(input: DurableSpawnFireInput): { role: string; harnessSlug: string; workspaceId: string } | null {
  try {
    const u = new URL(input.url);
    const role = (u.searchParams.get('role') ?? '').trim();
    const workspaceId = (input.spawnRecord?.workspaceId ?? u.searchParams.get('ws') ?? '').trim();
    const m = u.pathname.match(/\/api\/harness\/([^/]+)\/invoke$/);
    const harnessSlug = m?.[1] ? decodeURIComponent(m[1]) : '';
    if (!role || !workspaceId || !harnessSlug) return null;
    return { role, workspaceId, harnessSlug };
  } catch {
    return null;
  }
}

/**
 * A gone target is normally a harmless stale queued fire.  Repeated gone-target
 * skips are different: they mean a control loop is still armed for a harness
 * that no longer exists.  Keep the detector durable because queued fires can be
 * handled by different operator processes (or after a restart).
 */
export const DURABLE_SPAWN_GONE_TARGET_SKIP_THRESHOLD = 3;
const GONE_TARGET_SKIP_KEY_PREFIX = 'durable_spawn_gone_target_skips:';

export function durableSpawnGoneTargetSkipThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_DURABLE_SPAWN_GONE_TARGET_SKIP_THRESHOLD ?? DURABLE_SPAWN_GONE_TARGET_SKIP_THRESHOLD);
  return Number.isFinite(raw) && raw >= 1 ? Math.max(1, Math.floor(raw)) : DURABLE_SPAWN_GONE_TARGET_SKIP_THRESHOLD;
}

function goneTargetSkipKey(target: { role: string; harnessSlug: string; workspaceId: string }): string {
  return `${GONE_TARGET_SKIP_KEY_PREFIX}${encodeURIComponent(target.workspaceId)}:${encodeURIComponent(target.harnessSlug)}:${encodeURIComponent(target.role)}`;
}

async function noteGoneTargetSkip(
  target: { role: string; harnessSlug: string; workspaceId: string },
): Promise<{ count: number; escalated: boolean } | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const key = goneTargetSkipKey(target);
    const rows = await getOrgPg().sql<Array<{ value?: string }>>`
      INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
      VALUES (
        ${key}, '1',
        ${'Durable-spawn gone-target detector streak. A negative value means the started bit was auto-cleared after escalation.'},
        ${Date.now()}, ${target.workspaceId}
      )
      ON CONFLICT (key) DO UPDATE SET
        value = CASE
          WHEN harness_shared.operator_settings.value ~ '^-\\d+$' THEN harness_shared.operator_settings.value
          WHEN harness_shared.operator_settings.value ~ '^\\d+$' THEN (harness_shared.operator_settings.value::int + 1)::text
          ELSE '1'
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING value
    `;
    const value = String(rows[0]?.value ?? '1');
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return { count: 1, escalated: false };
    return parsed < 0
      ? { count: Math.abs(Math.trunc(parsed)), escalated: true }
      : { count: Math.max(1, Math.trunc(parsed)), escalated: false };
  } catch (e) {
    // The detector must never turn a harmless stale fire into a failed workflow.
    console.warn(
      `[durable-spawn] gone-target streak write failed (${target.workspaceId}/${target.harnessSlug}/${target.role}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

async function clearGoneTargetSkip(target: { role: string; harnessSlug: string; workspaceId: string }): Promise<void> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    await getOrgPg().sql`
      DELETE FROM harness_shared.operator_settings
       WHERE key = ${goneTargetSkipKey(target)}`;
  } catch (e) {
    console.warn(
      `[durable-spawn] gone-target streak reset failed (${target.workspaceId}/${target.harnessSlug}/${target.role}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

async function markGoneTargetSkipEscalated(
  target: { role: string; harnessSlug: string; workspaceId: string },
  count: number,
): Promise<void> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    await getOrgPg().sql`
      UPDATE harness_shared.operator_settings
         SET value = ${String(-Math.max(1, Math.trunc(count)))}, updated_at = ${Date.now()}
       WHERE key = ${goneTargetSkipKey(target)}`;
  } catch (e) {
    console.warn(
      `[durable-spawn] gone-target escalation marker failed (${target.workspaceId}/${target.harnessSlug}/${target.role}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** Stop the armed control loop after a confirmed repeated gone-target streak. */
async function escalateGoneTargetSkip(
  input: DurableSpawnFireInput,
  target: { role: string; harnessSlug: string; workspaceId: string },
  count: number,
  detail: string,
): Promise<void> {
  let cleared = false;
  try {
    if (target.role === 'mug') {
      const { setPotStarted } = await import('../pot/started');
      await setPotStarted(target.workspaceId, target.harnessSlug, false);
      cleared = true;
    } else if (target.role === 'kettle') {
      const { setOverwatchStarted } = await import('../overwatch/control-state');
      await setOverwatchStarted(target.workspaceId, target.harnessSlug, false);
      cleared = true;
    }
  } catch (e) {
    console.warn(
      `[durable-spawn] gone-target auto-clear failed (${input.label ?? input.idempotencyKey}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const summary =
    `⚠️ Durable-spawn skipped ${count} consecutive fires for missing ${target.role} target ` +
    `"${target.harnessSlug}" in workspace ${target.workspaceId}: ${detail}. ` +
    (cleared ? 'The started bit was auto-cleared; inspect the harness lifecycle.' : 'The started bit could not be auto-cleared; inspect the harness lifecycle.');
  try {
    const { resolveBrainOwner } = await import('../harness/routines/wake-brain-action');
    const owner = await resolveBrainOwner(target.workspaceId).catch(() => null);
    if (owner) {
      const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
      await wakeRecipients([owner], {
        summary,
        source: 'durable-spawn:gone-target',
        workspaceId: target.workspaceId,
      });
    }
  } catch (e) {
    console.warn(
      `[durable-spawn] gone-target owner alert failed (${input.label ?? input.idempotencyKey}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (cleared) await markGoneTargetSkipEscalated(target, count);
  console.warn(`[durable-spawn] ${summary}`);
}

function parseInvokeResultBody(bodyText: string): {
  ok?: unknown;
  rawStdoutTail?: unknown;
} | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    return parsed && typeof parsed === 'object' ? parsed as { ok?: unknown; rawStdoutTail?: unknown } : null;
  } catch {
    return null;
  }
}

function runIdFromWrapperTail(rawStdoutTail: unknown): string | null {
  if (typeof rawStdoutTail !== 'string') return null;
  const m =
    rawStdoutTail.match(/\/([0-9]{10,}-[A-Za-z0-9_-]+)\.(?:out|jsonl|err)\b/) ??
    rawStdoutTail.match(/\brun(?:Id)?[=:]\s*["']?([0-9]{10,}-[A-Za-z0-9_-]+)/i);
  return m?.[1] ?? null;
}

async function enrichInvokeBodyWithPgRunOutput(bodyText: string, input: DurableSpawnFireInput): Promise<string> {
  const parsed = parseInvokeResultBody(bodyText);
  if (!parsed || typeof parsed.ok !== 'boolean') return bodyText;
  const runId = runIdFromWrapperTail(parsed.rawStdoutTail);
  if (!runId) return bodyText;
  const target = parseInvokeTarget(input);
  if (!target) return bodyText;

  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;
    if (typeof sql !== 'function') return bodyText;
    const rows = await sql<Array<{ diagnostic: string | null }>>`
      SELECT left(concat_ws(E'\n', jsonl_body, err_body, out_body), 4000) AS diagnostic
      FROM harness_shared.harness_run_output
      WHERE workspace_id = ${target.workspaceId}
        AND harness_slug = ${target.harnessSlug}
        AND run_id = ${runId}
      LIMIT 1
    `;
    const diagnostic = rows?.[0]?.diagnostic?.trim();
    if (!diagnostic) return bodyText;
    const rawTail = typeof parsed.rawStdoutTail === 'string' ? parsed.rawStdoutTail : '';
    return JSON.stringify({
      ...parsed,
      rawStdoutTail: `${rawTail}\n[pgRunOutput:${runId}]\n${diagnostic}`,
    });
  } catch {
    return bodyText;
  }
}

async function refreshControlPlaneSpawnModel(input: DurableSpawnFireInput): Promise<Record<string, unknown>> {
  const existing = input.body.spawnModel;
  if (typeof existing === 'string' && existing.trim()) return input.body;

  const target = parseInvokeTarget(input);
  if (!target || (target.role !== 'mug' && target.role !== 'kettle')) return input.body;

  try {
    const { getOwnerSteering } = await import('../owner-steering');
    const steering = await getOwnerSteering(target.workspaceId, target.harnessSlug);
    let spawnModel: string | null | undefined = null;
    if (target.role === 'kettle') {
      spawnModel = steering.modelOverrides?.kettle;
    } else {
      const [{ readAgentConfig }, { effectiveTierConfig, resolveRoleOwnModelSpec }] = await Promise.all([
        import('../agent-config'),
        import('../fleet/model-tiers'),
      ]);
      const cfg = await readAgentConfig().catch(() => null);
      // Resolve against the owner's 'mug' tier keys (config keys migrated
      // with the S2 role contract — see the WI-2932 runbook).
      spawnModel = resolveRoleOwnModelSpec(target.role, effectiveTierConfig(cfg, steering));
    }
    return typeof spawnModel === 'string' && spawnModel.trim()
      ? { ...input.body, spawnModel: spawnModel.trim() }
      : input.body;
  } catch {
    return input.body;
  }
}

async function recordControlPlaneCodexUsageLimit(
  input: DurableSpawnFireInput,
  fireBody: Record<string, unknown>,
): Promise<void> {
  if (!isCodexModelSpec(fireBody.spawnModel)) return;
  const target = parseInvokeTarget(input);
  if (!target) return;

  try {
    const [{ selectSpawnAccount, updateAccountPool }, { recordAccountPenalty }] = await Promise.all([
      import('../deployment/account-pool-store'),
      import('../deployment/account-pool'),
    ]);
    const accountId = await selectSpawnAccount(
      target.workspaceId,
      target.harnessSlug,
      undefined,
      'codex',
    );
    if (!accountId) return;
    const now = Date.now();
    const pausedUntil = now + CONTROL_PLANE_USAGE_LIMIT_PAUSE_MS;
    await updateAccountPool(
      (pool) => recordAccountPenalty(pool, accountId, now, { pausedUntil }),
      target.workspaceId,
    );
    console.warn(
      `[durable-spawn] marked Codex account '${accountId}' paused after control-plane usage_limit (${target.harnessSlug}/${target.role})`,
    );
  } catch (e) {
    console.warn(
      `[durable-spawn] Codex usage_limit account feedback failed (${input.label ?? ''}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * EI-9759 root cause: a fire SKIPPED before the /invoke POST (gateway-storm gate,
 * gone-target) never reaches the /invoke route's worker-exit back-edge (EI-404) —
 * there is no worker, no exit, nothing to await. When the skipped fire carries an
 * `improvementDispatch` correlation (the auto-implement lane, dispatch-ledger.ts),
 * improvement-actions.ts already optimistically recorded `fire_result: 'ok'` on
 * that ledger row BEFORE this workflow-layer fire ran (the fire-and-forget
 * contract: "durably handed off" is recorded at dispatch time, not at actual
 * /invoke completion) — so a skip here left the row open with NO diagnostic,
 * stranded for the 2h orphan collector to catch with an unhelpful blank
 * `fire_error`, and fed the "auto-implement lane is broken" watchdog signal
 * (EI-9759) for a death that was never about the item OR the lane: the gateway
 * was throttled, or the target harness was gone, at DISPATCH time. Close it here
 * instead — same shape as implement-worker-exit.ts's env-failure rollback
 * (roll the attempt back so the transient skip can't drain the auto-eligible
 * pool), tagged distinctly so it's traceable to this exact skip reason.
 * Best-effort + fail-soft: bookkeeping must never turn a legitimate skip into a
 * failed workflow.
 */
async function closeSkippedImprovementDispatch(fireBody: Record<string, unknown>, reason: string): Promise<void> {
  const dispatch = fireBody.improvementDispatch as
    | { dispatchId?: string; itemId?: string; attempt?: number }
    | undefined;
  if (!dispatch?.dispatchId || !dispatch.itemId) return;
  try {
    const [{ markDispatchOrphaned }, { mergeIssuePayload }] = await Promise.all([
      import('../harness/improvements/dispatch-ledger'),
      import('../issues-engineer'),
    ]);
    const attempt = Number(dispatch.attempt) || 1;
    const marked = await markDispatchOrphaned(
      dispatch.dispatchId,
      `pre-invoke-skip:${reason}`,
      `pre-invoke skip: ${reason} — attempt ${attempt} not charged`,
    );
    if (marked) {
      // Not a real attempt (the worker never launched) — roll the counter back,
      // mirroring the env-failure rollback in implement-worker-exit.ts.
      await mergeIssuePayload(dispatch.itemId, { implementAttempts: Math.max(0, attempt - 1) });
    }
  } catch (e) {
    console.warn(
      `[durable-spawn] closeSkippedImprovementDispatch failed for ${dispatch.dispatchId} (${reason}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

async function shouldSkipForGatewayDispatchGate(
  input: DurableSpawnFireInput,
  fireBody: Record<string, unknown>,
): Promise<boolean> {
  if (isCodexModelSpec(fireBody.spawnModel)) return false;
  let enabled = true;
  try {
    enabled = await getFlag(FLAGS.AUTONOMOUS_SPAWN_GATEWAY_DISPATCH_GATE, 'system');
  } catch (e) {
    console.warn(
      `[durable-spawn] gateway dispatch gate flag read failed (${input.label ?? ''}); dispatching anyway: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
  if (!enabled) return false;

  try {
    const { gatewayWholesaleThrottled } = await import('../inference-gateway/observability');
    return await gatewayWholesaleThrottled();
  } catch (e) {
    console.warn(
      `[durable-spawn] gateway dispatch gate probe failed (${input.label ?? ''}); dispatching anyway: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

/**
 * EI-8177: skip a durable-spawn fire whose TARGET HARNESS no longer exists.
 * `durableSpawnFireImpl` runs at DEQUEUE time — the WorkflowQueue's concurrency cap
 * (`queueConcurrency(8)`) can delay actual execution well past when the fire was
 * originally requested (hive boot / a scheduled blueprint-run). A short-lived
 * EPHEMERAL harness (a benchmark run: `xbench-su-*`, `xbq*`, …) can finish its whole
 * scenario and get torn down (its registry entry removed) BEFORE this queued fire
 * ever executes, so the `/invoke` POST 404s "unknown project" forever —
 * `isPermanentSpawnStatus` correctly never retries it, but it still burns a
 * `spawned_agents` row + feeds the failed-spawn watchdog as pure noise for an
 * already-gone target (observed recurring across 30+ distinct `xbench-su-*`
 * harnesses, 2026-06-25..07-06 — the dominant "other"-class contributor).
 * Mirrors `blueprint-run-action.ts`'s EI-1575 routine-side self-heal (which only
 * guards a RECURRING routine's own `install_slug`), but at the FIRE seam itself —
 * so it also catches a one-shot (non-routine) kickoff durable-spawn queued at
 * hive-boot, which EI-1575 never sees. Fail-open (never blocks a legitimate fire)
 * on an unreadable registry or an unparseable target — an uncertain check must
 * never silently swallow a real launch.
 */
async function shouldSkipForGoneTarget(input: DurableSpawnFireInput): Promise<{ skip: boolean; detail?: string }> {
  const target = parseInvokeTarget(input);
  if (!target || target.harnessSlug.startsWith('@')) return { skip: false };
  try {
    const { resolveProject } = await import('../harness-core');
    const project = await resolveProject(target.harnessSlug, target.workspaceId);
    if (project) return { skip: false };
    return {
      skip: true,
      detail:
        `target harness '${target.harnessSlug}' no longer exists in workspace ${target.workspaceId} ` +
        `(torn down before this queued fire executed)`,
    };
  } catch (e) {
    console.warn(
      `[durable-spawn] gone-target probe failed (${input.label ?? ''}); dispatching anyway: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { skip: false };
  }
}

async function recordDurableSpawnAdmission(
  input: DurableSpawnFireInput,
  rec: SpawnRecordInput,
  spawnId: string,
  initialSpawnModel: string | null,
): Promise<QueenSingletonAdmission> {
  const [{ recordSpawn }, { getOrgPg }] = await Promise.all([
    import('../fleet/spawn-tree'),
    import('@papercusp/db-org'),
  ]);
  const { sql } = getOrgPg();
  const writeRecord = async (db: Db): Promise<void> => {
    await recordSpawn(db, {
      spawnId,
      workspaceId: rec.workspaceId,
      harnessSlug: rec.harnessSlug,
      parentSpawnId: rec.parentSpawnId ?? null,
      parentRole: rec.parentRole ?? 'operator',
      childRole: rec.childRole,
      runId: input.idempotencyKey,
      itemId: rec.itemId ?? null,
      modelSpec: initialSpawnModel,
      status: 'running',
    });
    // The /invoke route owns the actual invoke-once child and may run in a
    // different operator/cluster process from this DBOS worker. Its child PID
    // and launcher boot are stamped after admission by the route handoff below;
    // recording this process's identity here makes a healthy fixer look like a
    // prior-boot orphan (EI-20981156698708733).
  };

  if (rec.childRole !== 'mug') {
    await writeRecord(sql);
    return { admitted: true };
  }

  return sql.begin(async (tx): Promise<QueenSingletonAdmission> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'queen-singleton:' + rec.workspaceId}))`;
    await tx`
      UPDATE harness_shared.spawned_agents AS a
         SET status = 'cancelled',
             cancel_requested = true,
             cancel_reason = COALESCE(
               a.cancel_reason,
               'DBOS workflow is terminal but the Mug singleton nursery row was still running; retired during singleton admission'
             ),
             cancelled_at = COALESCE(a.cancelled_at, now()),
             finished_at = COALESCE(a.finished_at, now()),
             duration_ms = COALESCE(a.duration_ms, (EXTRACT(EPOCH FROM (now() - a.started_at)) * 1000)::bigint)
        FROM dbos.workflow_status AS w
       WHERE a.workspace_id = ${rec.workspaceId}
         AND a.child_role = 'mug'
         AND a.status IN ('running', 'restarting')
         AND a.spawn_id = w.workflow_uuid
         AND w.status IN ('CANCELLED', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')`;
    const active = await tx<{ spawn_id: string; harness_slug: string | null }[]>`
      SELECT spawn_id, harness_slug
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${rec.workspaceId}
         AND child_role = 'mug'
         AND status IN ('running', 'restarting')
         AND spawn_id <> ${spawnId}
       ORDER BY started_at DESC
       LIMIT 1`;
    const incumbent = active[0];
    if (incumbent) {
      return {
        admitted: false,
        activeSpawnId: incumbent.spawn_id,
        activeHarnessSlug: incumbent.harness_slug ?? null,
      };
    }
    await writeRecord(tx);
    return { admitted: true };
  });
}

export async function durableSpawnFireImpl(input: DurableSpawnFireInput): Promise<void> {
  const rec = input.spawnRecord;
  // Stable so a step retry / recovery replay updates the SAME row, not a new one.
  const spawnId = `durable-spawn:${input.idempotencyKey}`;
  const initialFireBody = await refreshControlPlaneSpawnModel(input);
  const initialSpawnModel =
    typeof initialFireBody.spawnModel === 'string' && initialFireBody.spawnModel.trim()
      ? initialFireBody.spawnModel.trim()
      : null;

  // EI-8177: skip cleanly (no spawned_agents row, no /invoke 404, no watchdog
  // noise) when the target harness was torn down before this queued fire got to
  // execute — see shouldSkipForGoneTarget's docstring. Checked BEFORE the
  // spawned_agents row is recorded, same as the gateway-dispatch-gate skip below.
  const goneCheck = await shouldSkipForGoneTarget(input);
  if (goneCheck.skip) {
    const target = parseInvokeTarget(input);
    const streak = target ? await noteGoneTargetSkip(target) : null;
    const count = streak?.count ?? 1;
    console.warn(
      `[durable-spawn] skipped ${input.label ?? input.idempotencyKey}: ${goneCheck.detail} ` +
        `(consecutive gone-target skips: ${count})`,
    );
    await closeSkippedImprovementDispatch(initialFireBody, 'gone-target');
    if (
      target &&
      (target.role === 'mug' || target.role === 'kettle') &&
      streak &&
      !streak.escalated &&
      streak.count >= durableSpawnGoneTargetSkipThreshold()
    ) {
      await escalateGoneTargetSkip(input, target, streak.count, goneCheck.detail ?? 'target harness is missing');
    }
    return;
  }
  const target = parseInvokeTarget(input);
  if (target && (target.role === 'mug' || target.role === 'kettle')) {
    // A target that exists again closes the prior gone-target streak, even if
    // this particular fire later fails for an unrelated transient reason.
    await clearGoneTargetSkip(target);
  }

  // WI-2376: avoid launching autonomous agents into a known all-account gateway
  // storm. This runs BEFORE the spawned_agents row is recorded, so the skip does
  // not charge a visible spawn attempt; the existing routine/retry clock re-offers
  // later once the gateway is serviceable again. Fail-open: uncertain health must
  // never strand the loop.
  if (await shouldSkipForGatewayDispatchGate(input, initialFireBody)) {
    console.warn(
      `[durable-spawn] skipped ${input.label ?? input.idempotencyKey} before /invoke: inference gateway wholesale-throttled; will retry on the next autonomous dispatch tick`,
    );
    await closeSkippedImprovementDispatch(initialFireBody, 'gateway-wholesale-throttled');
    return;
  }

  // Make the durable launch visible in fleet:tree (opt-in), mirroring the
  // fire-and-forget fallback's recordSpawn (WI-108). Best-effort: a bookkeeping
  // failure must never abort the actual fire below.
  if (rec) {
    const admission = await DBOS.runStep(
      async (): Promise<QueenSingletonAdmission> => {
        try {
          return await recordDurableSpawnAdmission(input, rec, spawnId, initialSpawnModel);
        } catch (e) {
          if (rec.childRole === 'mug') throw e;
          console.warn(
            `[durable-spawn] record-spawn failed (${input.label ?? ''}): ${e instanceof Error ? e.message : String(e)}`,
          );
          return { admitted: true };
        }
      },
      { name: 'durable-spawn-record', retriesAllowed: false },
    );
    if (!admission.admitted) {
      console.warn(
        `[durable-spawn] skipped duplicate Mug launch (${input.label ?? ''}); ` +
          `workspace ${rec.workspaceId} already has active Mug ${admission.activeSpawnId}` +
          `${admission.activeHarnessSlug ? ` (${admission.activeHarnessSlug})` : ''}`,
      );
      return;
    }
  }

  let heartbeat: ManagedHandle | null = null;
  if (rec) {
    try {
      const [{ heartbeatSpawns, SPAWN_HEARTBEAT_INTERVAL_MS }, { getOrgPg }] = await Promise.all([
        import('../fleet/spawn-reclaim'),
        import('@papercusp/db-org'),
      ]);
      const { sql } = getOrgPg();
      heartbeat = managedSetInterval('durable-spawn-heartbeat', SPAWN_HEARTBEAT_INTERVAL_MS, () => {
        void heartbeatSpawns(sql, [spawnId]).catch(() => {
          /* best-effort: a later reclaim/retry is safer than blocking the fire */
        });
      }, { category: 'lifecycle', instanced: true });
    } catch {
      /* best-effort: durable completion still closes the row */
    }
  }
  const stopHeartbeat = (): void => {
    if (heartbeat) {
      heartbeat.stop();
      heartbeat = null;
    }
  };

  let fireError: unknown = null;
  // The fire step returns a discriminated result (memoized by DBOS, so it
  // survives a recovery replay) instead of leaking via closure side-effects.
  let fireResult:
    | { ok: true }
    | { ok: false; permanentStatus: number; detail: string }
    | { ok: false; failureClass: SpawnFailureClass; detail: string }
    | null = null;
  try {
    fireResult = await DBOS.runStep(
      async () => {
        const fireBody: Record<string, unknown> = {
          ...(await refreshControlPlaneSpawnModel(input)),
          // Internal route bookkeeping. The route does not forward this field
          // to the child; it uses it to stamp the actual invoke-once PID.
          spawnRecordId: spawnId,
        };
        const r = await loopbackFetch(input.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fireBody),
        }, { launch: true });
        if (r.ok) {
          // D-007/D-010 fail-loud: the fire holds the connection for the agent's run, so r.ok
          // ≈ "the run finished" — but HTTP 200 does NOT mean the agent actually RAN. On an
          // unstable/restarting launcher host the invoke returns ok-shaped while the agent
          // never produced a turn (the ~3s, 0-token Mug/overwatch wakes that were recorded
          // 'done' → silent placement/scorecard stalls). Inspect the invoke body (the route
          // returns { ok: exitCode===0 && !timedOut, agentOutput, ... }): treat a parseable
          // result reporting the agent did NOT complete a turn (route ok:false, OR empty
          // agentOutput — blueprint roles ALWAYS emit a decision line, so empty ⇒ no turn) as
          // an infra-loss recorded `failed`, not `done`. An unreadable/unparseable body ⇒ keep
          // the OLD 'done' behavior — never flip on uncertainty (most load-bearing path).
          // HTTP 200 ≠ the agent ran. Judge the invoke body with the SHARED rule
          // (fleet/invoke-outcome) so this path and launch-blueprint classify a
          // no-turn death identically — a 429'd/dead-launcher spawn is `failed`
          // (infra_loss), never silently `done` (docs-audit 2026-06-23 #1).
          const rawBodyText = typeof r.text === 'function' ? await r.text().catch(() => '') : '';
          const bodyText = await enrichInvokeBodyWithPgRunOutput(rawBodyText, input);
          const prelim = agentProducedTurn(bodyText, input.label ?? '');
          if (prelim.ran) return { ok: true } as const;
          // No turn. Corroborate with the LIVE gateway state to tell a CAPACITY-SHED
          // (the all-accounts 429 storm killed the agent mid-turn — RETRYABLE) from a
          // genuine launcher-host loss (terminal). H13/P-006: a capacity shed was being
          // mislabeled `infra_loss` / "host dead/unstable" → sent debuggers hunting a
          // phantom host bug (~2h) when the real cause was the gateway storm.
          const { gatewayWholesaleThrottled } = await import('../inference-gateway/observability');
          const gatewayThrottled = isCodexModelSpec(fireBody.spawnModel)
            ? false
            : await gatewayWholesaleThrottled().catch(() => false);
          const outcome = agentProducedTurn(bodyText, input.label ?? '', { gatewayThrottled });
          if (outcome.failureClass === 'capacity_shed') {
            // RETRYABLE: THROW so the step retry (maxAttempts:3, 10s/20s backoff) re-fires
            // through the PACED gateway once capacity returns — instead of recording a
            // terminal phantom host death. The `capacity_shed:` prefix makes the persisted
            // error self-diagnosing (capacity event, NOT infra_loss). After the retries
            // exhaust it lands `failed` with the capacity_shed label, never "host dead".
            throw new Error(`capacity_shed:${outcome.detail.trim()}`);
          }
          return {
            ok: false,
            failureClass: outcome.failureClass ?? 'infra_loss',
            detail: outcome.detail,
          } as const;
        }
        // Capture the response body so a non-2xx fire is self-diagnosing: the bare
        // status (`→ HTTP 400`) tells the watchdog/operator nothing about WHICH
        // install or WHY the /invoke route rejected the spawn, so a recurring 400
        // (observed: papercup/papercup-hive queen fires) is undebuggable from the
        // persisted error alone. Mirrors the describeFetchError convention for
        // network errors (loopback-fetch.ts). Bounded + whitespace-collapsed to
        // keep the persisted workflow_status error row small.
        // Defensive: the diagnostic read must never itself break the fire step,
        // so guard that `.text` exists (real Response always has it) and swallow
        // any read error.
        const body =
          typeof r.text === 'function' ? await r.text().catch(() => '') : '';
        const detail = body ? ` — ${body.replace(/\s+/g, ' ').trim().slice(0, 300)}` : '';
        // Deterministic failure (target gone 404/410, or a non-retryable 4xx like
        // the workspace:"*" 400 — see isPermanentSpawnStatus): retrying (3×) + DBOS
        // recovery (5×) can never succeed and just spams the log. Return — the step
        // SUCCEEDS, so neither retries nor recovery fire and the workflow ends.
        // Transient non-2xx (5xx, 408, 429, network) throws → retry.
        if (isPermanentSpawnStatus(r.status)) {
          return { ok: false, permanentStatus: r.status, detail } as const;
        }
        throw new Error(`durable-spawn fire ${input.label ?? ''} → HTTP ${r.status}${detail}`);
      },
      { name: 'durable-spawn-fire', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 10, backoffRate: 2 },
    );
  } catch (e) {
    fireError = e;
  } finally {
    stopHeartbeat();
  }
  // A permanent failure is terminal but deliberately NOT thrown — throwing would
  // end the workflow ERROR and trigger DBOS recovery. Surface it once and let the
  // fleet:tree row close `failed` below.
  const permanentMsg =
    fireResult && !fireResult.ok
      ? 'failureClass' in fireResult
        ? `${fireResult.failureClass}:${fireResult.detail}`
        : `durable-spawn fire ${input.label ?? ''} → HTTP ${fireResult.permanentStatus}${fireResult.detail} (permanent client/target error — not retried)`
      : null;
  if (permanentMsg) {
    console.warn(`[durable-spawn] ${permanentMsg}`);
    if (
      fireResult &&
      !fireResult.ok &&
      'failureClass' in fireResult &&
      fireResult.failureClass === 'usage_limit'
    ) {
      await recordControlPlaneCodexUsageLimit(input, initialFireBody);
    }
  }

  // The durable path must leave the same durable signal as launch-blueprint's fallback:
  // a release-fixer that produced no turn did not diagnose the red gate. Keep this outside
  // the fire step so an escalation-write problem cannot trigger another DBOS recovery.
  if (
    rec?.childRole === 'release-fixer' &&
    permanentMsg &&
    isReleaseFixerNoTurnFailure(permanentMsg)
  ) {
    const releaseFixerContext = initialFireBody.releaseFixerContext as
      | { candidate?: unknown; failingTests?: unknown }
      | undefined;
    const { getOrgPg } = await import('@papercusp/db-org');
    const opened = await recordReleaseFixerNoTurnEscalation(getOrgPg().sql, {
      installSlug: rec.harnessSlug ?? parseInvokeTarget(input)?.harnessSlug ?? '',
      workspaceId: rec.workspaceId,
      spawnId,
      candidate: typeof releaseFixerContext?.candidate === 'string' ? releaseFixerContext.candidate : null,
      failingTests: Array.isArray(releaseFixerContext?.failingTests)
        ? releaseFixerContext.failingTests.filter((test): test is string => typeof test === 'string')
        : [],
      errorMessage: permanentMsg,
    });
    if (opened) {
      console.warn(`[durable-spawn] release-fixer no-turn escalation opened (${input.label ?? spawnId})`);
    }
  }

  // Close the fleet:tree row — `done` when the fire landed, `failed` (with the
  // error) when it exhausted retries. The /invoke fire holds the connection for the
  // worker's run, so `done` ≈ the worker completed (matches the fallback's finish).
  if (rec) {
    await DBOS.runStep(
      async () => {
        try {
          const { finishSpawn } = await import('../fleet/spawn-tree');
          const { getOrgPg } = await import('@papercusp/db-org');
          await finishSpawn(getOrgPg().sql, {
            spawnId,
            workspaceId: rec.workspaceId,
            status: fireError || permanentMsg ? 'failed' : 'done',
            errorMessage: fireError
              ? fireError instanceof Error
                ? fireError.message
                : String(fireError)
              : permanentMsg,
          });
        } catch (e) {
          console.warn(
            `[durable-spawn] finish-spawn failed (${input.label ?? ''}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
      { name: 'durable-spawn-finish', retriesAllowed: false },
    );
  }

  // Preserve the original contract: a fully-failed fire throws so the workflow ends
  // ERROR (and DBOS recovery can retry it), exactly as before this change.
  if (fireError) throw fireError;
}

export const durableSpawnFireWorkflow = idempotentRegisterWorkflow('durableSpawnFire', () =>
  DBOS.registerWorkflow(durableSpawnFireImpl, {
    name: 'durableSpawnFire',
    maxRecoveryAttempts: 5,
  }),
);

// WI-4015: idempotentWorkflowQueue guards the module-top-level-DBOS-singleton class
// (see idempotent-register-workflow.ts's doc comment).
export const durableSpawnQueue = idempotentWorkflowQueue('durable-spawn-fire', () =>
  new WorkflowQueue('durable-spawn-fire', { concurrency: queueConcurrency(8) }),
);

/** Request-only hosts can enqueue on the existing DBOS primary without running
 * an executor locally. This mirrors enqueueRoutineFire's DBOSClient path. */
interface DurableSpawnRemoteClient {
  enqueue(options: {
    queueName: string;
    workflowName: string;
    workflowID: string;
    deduplicationID: string;
    duplicationPolicy: 'return-existing';
    appVersion: string;
    workflowTimeoutMS?: number;
  }, input: DurableSpawnFireInput): Promise<{ workflowID: string }>;
  getWorkflow(workflowId: string): Promise<unknown | undefined>;
}
let remoteSpawnClient: Promise<DurableSpawnRemoteClient> | null = null;

function primarySpawnAppVersion(): string {
  return process.env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION?.trim() || 'bg-host-v1';
}

function getRemoteSpawnClient(): Promise<DurableSpawnRemoteClient> {
  remoteSpawnClient ??= DBOSClient.create({
    systemDatabaseUrl: withDbosIdleTxGrace(getHarnessAdminUrlWithSource().url),
    systemDatabaseSchemaName: 'dbos',
  }).catch((error: unknown) => {
    remoteSpawnClient = null;
    throw error;
  });
  return remoteSpawnClient;
}

/** The enqueue write may have committed before its response was lost. Direct
 * fallback after this error could start a conflicting child. */
export class DurableSpawnEnqueueUncertainError extends Error {
  constructor(readonly workflowId: string, cause: unknown) {
    super(`durable spawn enqueue outcome unknown for ${workflowId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'DurableSpawnEnqueueUncertainError';
  }
}

/**
 * Durably fire an autonomous agent launch. Returns true only after a durable
 * workflow row is confirmed, false only when no enqueue was attempted. An
 * uncertain enqueue throws, so callers cannot launch a conflicting fallback.
 */
export async function durableSpawnFire(
  input: DurableSpawnFireInput,
  deps: { remoteClient?: () => Promise<DurableSpawnRemoteClient> } = {},
): Promise<boolean> {
  if (!dbosOrchestratorActive()) return false;
  const id = `durable-spawn:${input.idempotencyKey}`;
  const remoteClient = deps.remoteClient ?? getRemoteSpawnClient;
  const timeoutMS = durableSpawnWorkflowTimeoutMs(input);

  if (!dbosStarted()) {
    let client: DurableSpawnRemoteClient;
    try {
      client = await remoteClient();
    } catch (error) {
      // No enqueue was attempted. Best-effort callers may use their declared
      // direct fallback; a checkpointed one-shot caller must retry instead.
      console.warn(`[durable-spawn] remote DBOS client unavailable (${input.label ?? id}): ${error instanceof Error ? error.message : error}`);
      return false;
    }
    try {
      await client.enqueue({
        queueName: durableSpawnQueue.name,
        workflowName: 'durableSpawnFire',
        workflowID: id,
        deduplicationID: id,
        duplicationPolicy: 'return-existing',
        appVersion: primarySpawnAppVersion(),
        ...(timeoutMS ? { workflowTimeoutMS: timeoutMS } : {}),
      }, input);
      return true;
    } catch (error) {
      // A lost response is not proof that the write failed. A positive lookup
      // confirms acceptance; a negative/unreadable lookup stays uncertain.
      if (await client.getWorkflow(id).catch(() => undefined)) return true;
      throw new DurableSpawnEnqueueUncertainError(id, error);
    }
  }

  // Starting a child workflow inside a DBOS step is forbidden. System actions
  // return their request for the parent workflow to enqueue after the step.
  try {
    if (DBOS.isInStep()) return false;
  } catch {
    // The start call below remains the authoritative attempt.
  }
  try {
    await DBOS.startWorkflow(durableSpawnFireWorkflow, {
      workflowID: id,
      queueName: durableSpawnQueue.name,
      ...(timeoutMS ? { timeoutMS } : {}),
      enqueueOptions: { deduplicationID: id },
      duplicationPolicy: 'return-existing',
    })(input);
    return true;
  } catch (error) {
    let client: DurableSpawnRemoteClient | null = null;
    try { client = await remoteClient(); } catch { /* no status reader is available */ }
    if (client && await client.getWorkflow(id).catch(() => undefined)) return true;
    throw new DurableSpawnEnqueueUncertainError(id, error);
  }
}

/**
 * Start a batch of durable spawns from a WORKFLOW context — the EI-403-A seam. A
 * system action that can't start a child workflow from inside its own step instead
 * RETURNS its fire requests (`SystemActionResult.durableSpawns`); the routine
 * workflow calls this AFTER the action's step, where `startWorkflow` is legal.
 *
 * Recovery-safe BY THE CALLER'S contract: the requests come from the step's
 * checkpointed return value, so a replay re-drains the same list, and each fire is
 * idempotency-keyed (`durable-spawn:<key>`) — a stable key dedups the re-fire, a
 * clock-derived key would double-dispatch (hence the SystemActionResult doc's
 * STABLE-key requirement). A declined or uncertain enqueue fails the parent
 * workflow, leaving its checkpointed request available for DBOS recovery.
 */
export async function startDurableSpawns(
  spawns: DurableSpawnFireInput[] | undefined,
): Promise<{ enqueued: number; total: number }> {
  const reqs = spawns ?? [];
  let enqueued = 0;
  // COOPERATIVE YIELD between fires (event-loop-lag root fix). A big drain
  // (the implement lane / a Queen's batch placement) runs N `DBOS.startWorkflow`
  // enqueues back-to-back; under DBOS catch-up load each can be synchronous-heavy,
  // and the unbroken loop starves the routine ticker → the CPU-bound-main-thread
  // restart loop that reclaim-kills queen/bee spawns. Yield the macrotask queue
  // between fires so the ticker interleaves (quiet drain ≈ free; a saturated loop
  // yields every iteration via loopPressure()).
  const { cooperativeYield } = await import('../event-loop-lag-monitor');
  let yielded = 0;
  for (const req of reqs) {
    // The parent workflow owns this checkpointed one-shot request. A declined
    // enqueue must ERROR that workflow so recovery replays this same stable key;
    // returning success here would silently drop accepted work.
    if (!await durableSpawnFire(req)) {
      throw new Error(`durable spawn enqueue unavailable for ${req.idempotencyKey}; parent workflow retains the checkpointed request`);
    }
    enqueued += 1;
    const dispatch = req.body.improvementDispatch as { dispatchId?: unknown } | undefined;
    if (typeof dispatch?.dispatchId === 'string') {
      const { recordFireResult } = await import('../harness/improvements/dispatch-ledger');
      await recordFireResult(dispatch.dispatchId, {
        ok: true,
        spawnedRunId: `durable-spawn:${req.idempotencyKey}`,
      });
    }
    yielded = await cooperativeYield(yielded);
  }
  return { enqueued, total: reqs.length };
}
