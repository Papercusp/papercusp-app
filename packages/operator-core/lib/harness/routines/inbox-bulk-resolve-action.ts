/**
 * `system:inbox-bulk-resolve` — scheduled Inbox resolver launcher.
 *
 * This is the durable backstop for the owner-triggered bulk resolver. It reads
 * the canonical action-bearing plans:attention feed, snapshots at most 200
 * items, and starts the same supervised resolver process as the HTTP route.
 * `createRun` remains the single-flight authority; a concurrent run is a
 * normal skip, never a second launch.
 */
import { randomUUID } from 'node:crypto';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { callPlansRead } from '../../agent-tools/plans/read-dispatch';
import { readStandingBulkAutomationPolicy } from '../../attention/automation-policy';
import { bulkAutomationSnapshot } from '../../attention/bulk-dispositions';
import {
  BulkRunAlreadyActiveError,
  createRun,
  getItemIdsAwaitingOwnerReview,
  getRunningRun,
  readConsecutiveNeverBeatRuns,
  setRunPhase,
  type BulkRunSeedItem,
} from '../../attention/bulk-run-store';
import {
  resolveBulkResolverLaunch,
  type BulkResolverLaunchProfile,
  type EffectiveBulkResolverLaunch,
} from '../../agent-config-constants';
import { readAgentConfig } from '../../agent-config';
import { launchResolver } from '../../endpoint-route/routes/admin/attention-bulk-resolve';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const INBOX_BULK_RESOLVE = 'inbox-bulk-resolve';
export const INBOX_BULK_RESOLVE_CAP = 200;
const SCHEDULED_REQUESTER = 'system:inbox-bulk-resolve';

/** After this many scheduled runs in a row whose resolver never reported... */
export const NEVER_BEAT_BACKOFF_THRESHOLD = 3;
/** ...launch at most once per this window until one does (WI-10004887). */
export const NEVER_BEAT_BACKOFF_MS = 60 * 60_000;

/**
 * PURE: should this fire skip because recent scheduled launches never produced a
 * working resolver? Repeating a launch that cannot work is not a backstop: on
 * 2026-10-01 a walled launch account turned every 15-minute fire into a dead run.
 * The back-off still retries once per window, so recovery needs no human.
 */
export function neverBeatBackoff(input: {
  consecutive: number;
  newestCreatedAt: string | null;
  nowMs: number;
}): { retryInMs: number } | null {
  if (input.consecutive < NEVER_BEAT_BACKOFF_THRESHOLD || !input.newestCreatedAt) return null;
  const newest = Date.parse(input.newestCreatedAt);
  if (!Number.isFinite(newest)) return null;
  const retryInMs = newest + NEVER_BEAT_BACKOFF_MS - input.nowMs;
  return retryInMs > 0 ? { retryInMs } : null;
}

interface AttentionFeedItem {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  ref?: unknown;
  ownerAgentId?: unknown;
  actions?: unknown;
}

/**
 * `exclude` holds ids that already await the owner in an open review run. They
 * are skipped BEFORE the cap, so a fire seeds the next 200 unreviewed items
 * rather than re-seeding the head of the feed (WI-10004720 follow-up).
 */
function seedItems(
  data: unknown,
  cap = INBOX_BULK_RESOLVE_CAP,
  exclude: ReadonlySet<string> = new Set(),
): BulkRunSeedItem[] {
  const groups = data && typeof data === 'object' && Array.isArray((data as { groups?: unknown }).groups)
    ? (data as { groups: unknown[] }).groups
    : [];
  const out: BulkRunSeedItem[] = [];
  const seen = new Set<string>(exclude);
  for (const group of groups) {
    const items = group && typeof group === 'object' && Array.isArray((group as { items?: unknown }).items)
      ? (group as { items: unknown[] }).items
      : [];
    for (const raw of items) {
      const item = raw as AttentionFeedItem;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id) || !Array.isArray(item.actions) || item.actions.length === 0) continue;
      seen.add(id);
      out.push({
        itemId: id,
        kind: typeof item.kind === 'string' ? item.kind : null,
        title: typeof item.title === 'string' ? item.title.slice(0, 1000) : null,
        ref: item.ref && typeof item.ref === 'object' && !Array.isArray(item.ref)
          ? (item.ref as Record<string, unknown>)
          : {},
        ownerAgentId: typeof item.ownerAgentId === 'string' ? item.ownerAgentId : null,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export interface InboxBulkResolveActionDeps {
  enabled: () => Promise<boolean>;
  readAttention: () => Promise<unknown>;
  /**
   * The run that EXCLUDES a new one: `pending`/`running` only — the same set
   * `createRun` and migration 915's single-flight index key on. A run waiting in
   * `review` is waiting on the OWNER, not working, so it must never gate the
   * scheduled backstop. It used to (via getActiveRun), and one review list left
   * open on 2026-08-24 silently no-op'd every 15-minute fire for 37 days
   * (WI-10004720).
   */
  runningRun: (workspaceId: string) => Promise<{ runId: string; phase: string } | null>;
  /**
   * Feed ids already waiting on the owner in an open `review` run. Dropping the
   * review gate (above) without this made every fire re-seed the same 200
   * items — 13 duplicate runs in 3h (WI-10004720 follow-up).
   */
  awaitingReview: (workspaceId: string) => Promise<ReadonlySet<string>>;
  /**
   * The owner's saved inbox-resolve launch profile (model / effort / account /
   * carry) — the same settings the pane's Run button uses. The scheduled path
   * used to ignore it, so every scheduled resolver ran the default Claude model
   * on the system login regardless of what the owner chose (WI-10004887).
   */
  readLaunchProfile: () => Promise<Partial<BulkResolverLaunchProfile> | null>;
  /** Consecutive newest scheduled runs that failed without one heartbeat. */
  recentNeverBeat: (workspaceId: string) => Promise<{ consecutive: number; newestCreatedAt: string | null }>;
  nowMs: () => number;
  launch: (input: {
    runId: string;
    itemCount: number;
    launch: EffectiveBulkResolverLaunch;
    resolverOwner: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  log: (message: string) => void;
}

async function productionLaunch(input: {
  runId: string;
  itemCount: number;
  launch: EffectiveBulkResolverLaunch;
  resolverOwner: string;
}): Promise<{ ok: boolean; error?: string }> {
  return launchResolver(input.runId, input.itemCount, null, input.launch, input.resolverOwner);
}

export function makeInboxBulkResolveAction(overrides: Partial<InboxBulkResolveActionDeps> = {}) {
  const deps: InboxBulkResolveActionDeps = {
    enabled: () => getFlag(FLAGS.INBOX_BULK_RESOLVE, 'system:inbox-bulk-resolve').catch(() => false),
    readAttention: () => callPlansRead('attention', {}, { uiProjection: false }),
    runningRun: (workspaceId) => getRunningRun(workspaceId, 'inbox-resolve'),
    awaitingReview: (workspaceId) => getItemIdsAwaitingOwnerReview(workspaceId, 'inbox-resolve'),
    readLaunchProfile: async () => (await readAgentConfig()).resolverProfiles?.['inbox-resolve'] ?? null,
    recentNeverBeat: (workspaceId) =>
      readConsecutiveNeverBeatRuns({ workspaceId, kind: 'inbox-resolve', requestedBy: SCHEDULED_REQUESTER }),
    nowMs: () => Date.now(),
    launch: productionLaunch,
    log: (message) => console.log(`[${INBOX_BULK_RESOLVE}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    if (!(await deps.enabled())) {
      deps.log('skip: feature flag is off');
      return;
    }
    // Every skip says why. A bare `return` here made "a run is executing" and
    // "the backstop is wedged" byte-identical for 37 days.
    const running = await deps.runningRun(ctx.workspaceId);
    if (running) {
      deps.log(`skip: run=${running.runId} is ${running.phase} (single-flight)`);
      return;
    }
    const held = await deps.awaitingReview(ctx.workspaceId);
    const items = seedItems(await deps.readAttention(), INBOX_BULK_RESOLVE_CAP, held);
    if (items.length === 0) {
      deps.log(
        held.size > 0
          ? `skip: no unreviewed action-bearing attention items (${held.size} already await owner review)`
          : 'skip: no action-bearing attention items',
      );
      return;
    }
    const backoff = neverBeatBackoff({ ...(await deps.recentNeverBeat(ctx.workspaceId)), nowMs: deps.nowMs() });
    if (backoff) {
      deps.log(
        `skip: the last ${NEVER_BEAT_BACKOFF_THRESHOLD}+ scheduled runs failed before their resolver ever ` +
          `reported (launch route not working); next attempt in ${Math.ceil(backoff.retryInMs / 60_000)}m`,
      );
      return;
    }
    const policy = bulkAutomationSnapshot(await readStandingBulkAutomationPolicy(ctx.workspaceId));
    const profile = await deps.readLaunchProfile();
    // Same shape as plan-cleanup-sweep-action: the profile supplies the launch
    // route, the standing automation policy supplies authority. An absent field
    // inherits the launcher default, exactly as the pane's Run button does.
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
      return;
    }
    const runId = `bulk-${randomUUID()}`;
    const resolverOwner = `su-${randomUUID()}`;
    try {
      const run = await createRun({
        items,
        workspaceId: ctx.workspaceId,
        requestedBy: SCHEDULED_REQUESTER,
        automationPolicy: policy,
        launchSnapshot: resolved.effective,
      });
      await setRunPhase({ runId: run.runId, phase: 'pending', resolverOwner, workspaceId: ctx.workspaceId });
      const launched = await deps.launch({
        runId: run.runId,
        itemCount: items.length,
        launch: resolved.effective,
        resolverOwner,
      });
      await setRunPhase({
        runId: run.runId,
        phase: launched.ok ? 'running' : 'failed',
        resolverOwner,
        workspaceId: ctx.workspaceId,
        ...(launched.ok ? {} : { error: launched.error ?? 'scheduled resolver launch failed' }),
      });
      deps.log(`run=${run.runId} items=${items.length} phase=${launched.ok ? 'running' : 'failed'}`);
    } catch (error) {
      if (error instanceof BulkRunAlreadyActiveError) {
        deps.log(`skip: lost the single-flight race (${error.message})`);
        return;
      }
      deps.log(`scheduled start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

registerSystemAction(INBOX_BULK_RESOLVE, makeInboxBulkResolveAction());

export { seedItems as buildInboxBulkResolveSeedItems };
