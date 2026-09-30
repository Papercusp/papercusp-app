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
  getActiveRun,
  setRunPhase,
  type BulkRunSeedItem,
} from '../../attention/bulk-run-store';
import {
  resolveBulkResolverLaunch,
  type EffectiveBulkResolverLaunch,
} from '../../agent-config-constants';
import { launchResolver } from '../../endpoint-route/routes/admin/attention-bulk-resolve';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const INBOX_BULK_RESOLVE = 'inbox-bulk-resolve';
export const INBOX_BULK_RESOLVE_CAP = 200;

interface AttentionFeedItem {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  ref?: unknown;
  ownerAgentId?: unknown;
  actions?: unknown;
}

function seedItems(data: unknown, cap = INBOX_BULK_RESOLVE_CAP): BulkRunSeedItem[] {
  const groups = data && typeof data === 'object' && Array.isArray((data as { groups?: unknown }).groups)
    ? (data as { groups: unknown[] }).groups
    : [];
  const out: BulkRunSeedItem[] = [];
  const seen = new Set<string>();
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
  activeRun: (workspaceId: string) => Promise<unknown>;
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
    activeRun: (workspaceId) => getActiveRun(workspaceId, 'inbox-resolve'),
    launch: productionLaunch,
    log: (message) => console.log(`[${INBOX_BULK_RESOLVE}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    if (!(await deps.enabled())) return;
    if (await deps.activeRun(ctx.workspaceId)) return;
    const items = seedItems(await deps.readAttention());
    if (items.length === 0) return;
    const policy = bulkAutomationSnapshot(await readStandingBulkAutomationPolicy(ctx.workspaceId));
    const resolved = resolveBulkResolverLaunch({
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
        requestedBy: 'system:inbox-bulk-resolve',
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
      if (error instanceof BulkRunAlreadyActiveError) return;
      deps.log(`scheduled start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

registerSystemAction(INBOX_BULK_RESOLVE, makeInboxBulkResolveAction());

export { seedItems as buildInboxBulkResolveSeedItems };
