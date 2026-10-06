/**
 * `system:intake-triage-drain` — the registered executor for saved intake triage
 * (observation-candidate-acceptance-promotion-2026-09-30, P-008 / Decision D-020).
 *
 * Before this action, awaiting observations and unverified candidates had no
 * registered executor: the only scheduled resolver (`system:inbox-bulk-resolve`)
 * seeds from the attention feed, which admits improvement rows only when they are
 * flagged for a human. Measured on 2026-10-01: 3,800 items seeded in three days,
 * zero of kind `improvement`, while ~10.8k observation-lane rows were created in
 * the same week.
 *
 * This launcher drains intake SEPARATELY from accepted implementation work:
 *   - it seeds a run of kind `intake-triage` (its own single-flight slot), so it
 *     never contends with the Inbox run and its outcomes read apart from delivery;
 *   - it selects only rows the shared awaiting-triage predicate
 *     (`intakeTriageStateSql`, owned by P-010) reports as `awaiting`;
 *   - it never claims a work-item. Intake rows stay observation-lane, which the
 *     claim floor excludes from every implementation fleet; only a decision the
 *     P-006 path seals becomes claimable work.
 *
 * Each seeded item is `improvement:<id>` with ref `{ kind: 'improvement', issueId,
 * harnessSlug }`, so the existing intake decision validation (P-004), application
 * (P-006 `apply-intake`) and compensation (P-009) apply unchanged.
 */
import { randomUUID } from 'node:crypto';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { readStandingBulkAutomationPolicy } from '../../attention/automation-policy';
import { bulkAutomationSnapshot } from '../../attention/bulk-dispositions';
import { UNATTENDED_INTAKE_REQUESTER } from '../../attention/bulk-run-owner-digest';
import {
  BulkRunAlreadyActiveError,
  createRun,
  getRunningRun,
  readConsecutiveNeverBeatRuns,
  setRunPhase,
  type BulkRunSeedItem,
} from '../../attention/bulk-run-store';
import { intakeTriageStateSql } from '../../attention/intake-promotion';
import {
  resolveBulkResolverLaunch,
  type BulkResolverLaunchProfile,
  type EffectiveBulkResolverLaunch,
} from '../../agent-config-constants';
import { readAgentConfig } from '../../agent-config';
import { launchResolver } from '../../endpoint-route/routes/admin/attention-bulk-resolve';
import { NEVER_BEAT_BACKOFF_THRESHOLD, neverBeatBackoff } from './inbox-bulk-resolve-action';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const INTAKE_TRIAGE_DRAIN = 'intake-triage-drain';
export const INTAKE_TRIAGE_DRAIN_CAP = 200;
/** One constant with the owner digest, which recognizes this requester as unattended (R-27). */
export const INTAKE_TRIAGE_REQUESTER = UNATTENDED_INTAKE_REQUESTER;
export const INTAKE_TRIAGE_RUN_KIND = 'intake-triage' as const;

/** The intake population: observation-lane bug/change rows, minus scorecard rows. */
export const INTAKE_ITEM_KINDS = ['bug', 'change'] as const;
const TERMINAL_STATUSES = ['done', 'dropped', 'resolved', 'closed'];
/** A run in one of these phases still holds its items (awaiting work or the owner). */
const OPEN_RUN_PHASES = ['pending', 'running', 'review'];

export interface AwaitingIntakeRow {
  id: string;
  harnessSlug: string | null;
  title: string | null;
}

/** PURE: map awaiting intake rows onto run seed items (deduplicated, capped). */
export function buildIntakeTriageSeedItems(
  rows: readonly AwaitingIntakeRow[],
  cap = INTAKE_TRIAGE_DRAIN_CAP,
): BulkRunSeedItem[] {
  const out: BulkRunSeedItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      itemId: `improvement:${id}`,
      kind: 'improvement',
      title: row.title ? row.title.slice(0, 1000) : null,
      ref: { kind: 'improvement', issueId: id, harnessSlug: row.harnessSlug ?? null },
      ownerAgentId: null,
    });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Newest awaiting intake first: a fresh observation still has live context, and
 * the shared predicate re-opens an older row the moment a new occurrence lands.
 * Rows already held by ANY open run (any kind) are excluded, so a fire never
 * re-seeds items another run is deciding or the owner is reviewing.
 */
export async function readAwaitingIntake(workspaceId: string, cap = INTAKE_TRIAGE_DRAIN_CAP): Promise<AwaitingIntakeRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string; harness_slug: string | null; title: string | null }[]>`
    SELECT ei.feature_id, ei.harness_slug, ei.title
      FROM harness_shared.work_items ei
     WHERE ei.workspace_id = ${workspaceId}
       AND ei.item_kind = ANY(${[...INTAKE_ITEM_KINDS]}::text[])
       AND ei.payload->>'lane' = 'observation'
       AND (ei.payload->'observation'->>'rubricRef') IS NULL
       AND ei.status <> ALL(${TERMINAL_STATUSES}::text[])
       AND ${intakeTriageStateSql(sql, {
         payload: 'ei.payload',
         latestOccurrenceId: `(SELECT max(occurrence_id) FROM harness_shared.work_item_occurrences o
           WHERE o.workspace_id = ei.workspace_id AND o.canonical_harness_slug = ei.harness_slug
             AND o.canonical_work_item_id = ei.feature_id)`,
       })} = 'awaiting'
       AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.attention_bulk_run_items i
           JOIN harness_shared.attention_bulk_runs r
             ON r.workspace_id = i.workspace_id AND r.run_id = i.run_id
          WHERE i.workspace_id = ei.workspace_id
            AND i.item_id = 'improvement:' || ei.feature_id
            AND r.phase = ANY(${OPEN_RUN_PHASES}::text[])
       )
     ORDER BY ei.created_ts DESC NULLS LAST
     LIMIT ${cap}
  `;
  return rows.map((r) => ({ id: r.feature_id, harnessSlug: r.harness_slug, title: r.title }));
}

export interface IntakeTriageDrainDeps {
  enabled: () => Promise<boolean>;
  /** `pending`/`running` intake-triage run only; a `review` run waits on the owner. */
  runningRun: (workspaceId: string) => Promise<{ runId: string; phase: string } | null>;
  readAwaitingIntake: (workspaceId: string, cap: number) => Promise<AwaitingIntakeRow[]>;
  /**
   * The owner's saved Inbox resolver profile. Intake triage has no pane of its own,
   * so a separate profile key would only ever hold the default (the system login),
   * which is the launch route WI-10004887 found failing at its session limit (D-021).
   */
  readLaunchProfile: () => Promise<Partial<BulkResolverLaunchProfile> | null>;
  recentNeverBeat: (workspaceId: string) => Promise<{ consecutive: number; newestCreatedAt: string | null }>;
  readAutomationPolicy: (workspaceId: string) => Promise<ReturnType<typeof bulkAutomationSnapshot>>;
  createRun: typeof createRun;
  setRunPhase: typeof setRunPhase;
  nowMs: () => number;
  newOwnerId: () => string;
  launch: (input: {
    runId: string;
    itemCount: number;
    launch: EffectiveBulkResolverLaunch;
    resolverOwner: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  log: (message: string) => void;
}

export type IntakeTriageDrainOutcome =
  | { status: 'disabled' }
  | { status: 'skipped'; reason: 'single-flight' | 'no-awaiting-intake' | 'never-beat-backoff' | 'launch-settings' | 'lost-race' }
  | { status: 'launched' | 'launch-failed'; runId: string; items: number }
  | { status: 'error'; error: string };

export function makeIntakeTriageDrainAction(overrides: Partial<IntakeTriageDrainDeps> = {}) {
  const deps: IntakeTriageDrainDeps = {
    // The SAME kill switch as the Inbox resolver: one owner switch stops every
    // unattended bulk resolver.
    enabled: () => getFlag(FLAGS.INBOX_BULK_RESOLVE, INTAKE_TRIAGE_REQUESTER).catch(() => false),
    runningRun: (workspaceId) => getRunningRun(workspaceId, INTAKE_TRIAGE_RUN_KIND),
    readAwaitingIntake,
    readLaunchProfile: async () => (await readAgentConfig()).resolverProfiles?.['inbox-resolve'] ?? null,
    recentNeverBeat: (workspaceId) =>
      readConsecutiveNeverBeatRuns({ workspaceId, kind: INTAKE_TRIAGE_RUN_KIND, requestedBy: INTAKE_TRIAGE_REQUESTER }),
    readAutomationPolicy: async (workspaceId) => bulkAutomationSnapshot(await readStandingBulkAutomationPolicy(workspaceId)),
    createRun,
    setRunPhase,
    nowMs: () => Date.now(),
    newOwnerId: () => `su-${randomUUID()}`,
    launch: (input) => launchResolver(input.runId, input.itemCount, null, input.launch, input.resolverOwner),
    log: (message) => console.log(`[${INTAKE_TRIAGE_DRAIN}] ${message}`),
    ...overrides,
  };

  /** Every skip says why — "nothing to drain" and "the drain is wedged" must differ. */
  async function fire(ctx: SystemActionCtx): Promise<IntakeTriageDrainOutcome> {
    if (!(await deps.enabled())) return { status: 'disabled' };
    const running = await deps.runningRun(ctx.workspaceId);
    if (running) {
      deps.log(`skip: run=${running.runId} is ${running.phase} (single-flight)`);
      return { status: 'skipped', reason: 'single-flight' };
    }
    const items = buildIntakeTriageSeedItems(
      await deps.readAwaitingIntake(ctx.workspaceId, INTAKE_TRIAGE_DRAIN_CAP),
      INTAKE_TRIAGE_DRAIN_CAP,
    );
    if (items.length === 0) {
      deps.log('skip: no awaiting intake outside an open run');
      return { status: 'skipped', reason: 'no-awaiting-intake' };
    }
    const backoff = neverBeatBackoff({ ...(await deps.recentNeverBeat(ctx.workspaceId)), nowMs: deps.nowMs() });
    if (backoff) {
      deps.log(
        `skip: the last ${NEVER_BEAT_BACKOFF_THRESHOLD}+ intake runs failed before their resolver ever reported; ` +
          `next attempt in ${Math.ceil(backoff.retryInMs / 60_000)}m`,
      );
      return { status: 'skipped', reason: 'never-beat-backoff' };
    }
    const policy = await deps.readAutomationPolicy(ctx.workspaceId);
    const profile = await deps.readLaunchProfile();
    const resolved = resolveBulkResolverLaunch({
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
      ...(profile?.account ? { account: profile.account } : {}),
      ...(profile?.carry ? { carry: profile.carry } : {}),
      automationMode: policy.mode,
      minConfidence: policy.minConfidence,
    });
    if (!resolved.ok || !resolved.effective) {
      deps.log(`launch settings refused: ${resolved.message ?? 'invalid standing resolver settings'}`);
      return { status: 'skipped', reason: 'launch-settings' };
    }
    const resolverOwner = deps.newOwnerId();
    try {
      const run = await deps.createRun({
        items,
        runKind: INTAKE_TRIAGE_RUN_KIND,
        workspaceId: ctx.workspaceId,
        requestedBy: INTAKE_TRIAGE_REQUESTER,
        automationPolicy: policy,
        launchSnapshot: resolved.effective,
      });
      await deps.setRunPhase({ runId: run.runId, phase: 'pending', resolverOwner, workspaceId: ctx.workspaceId });
      const launched = await deps.launch({
        runId: run.runId,
        itemCount: items.length,
        launch: resolved.effective,
        resolverOwner,
      });
      await deps.setRunPhase({
        runId: run.runId,
        phase: launched.ok ? 'running' : 'failed',
        resolverOwner,
        workspaceId: ctx.workspaceId,
        ...(launched.ok ? {} : { error: launched.error ?? 'scheduled intake resolver launch failed' }),
      });
      deps.log(`run=${run.runId} items=${items.length} phase=${launched.ok ? 'running' : 'failed'}`);
      return { status: launched.ok ? 'launched' : 'launch-failed', runId: run.runId, items: items.length };
    } catch (error) {
      if (error instanceof BulkRunAlreadyActiveError) {
        deps.log(`skip: lost the single-flight race (${error.message})`);
        return { status: 'skipped', reason: 'lost-race' };
      }
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`scheduled start failed: ${message}`);
      return { status: 'error', error: message };
    }
  }

  const action = async (ctx: SystemActionCtx): Promise<void> => {
    await fire(ctx);
  };
  return Object.assign(action, { fire });
}

registerSystemAction(INTAKE_TRIAGE_DRAIN, makeIntakeTriageDrainAction());
