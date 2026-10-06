/**
 * Device attention (Inbox) feed — mobile-apps-revival-redesign-2026-06-05
 * (D-002, D-003 Inbox tab).
 *
 *   GET /device/attention   device JWT
 *
 * The phone's Inbox tab is the actionable attention feed: everything
 * awaiting the human or pickable — approvals, blocked work, agent
 * questions, completions. It is the deep-link target for push (D-004).
 *
 * Two layers, both scoped to the device's workspace:
 *   1. `groups` — the canonical attention groups from the `plans:attention`
 *      reader (plan items + coord escalations + coord messages-to-human +
 *      smoke-fails), the SAME shape the desktop Planning
 *      tab renders, so mobile and desktop share the AttentionItem contract.
 *   2. `workItems` — the unified work-item surface (feature/bug/change)
 *      filtered to attention-worthy states. This is what makes the feed
 *      work_items-native from day one (plan Risk note): non-primary pots'
 *      features surface here as work_items rather than riding the legacy
 *      features views, and the upcoming WI-rename lands underneath without
 *      touching this route.
 */
import {
  defineTool,
  dispatchProjectedTool,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { withWorkspace } from '@papercusp/db-org';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { listHarnessesFor } from '../../../device-harnesses';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import {
  buildWorkItemsPredicate, normalizeWorkItemsListArgs, readWorkItemsPageFromStore,
  type WorkItemsListRow,
} from '../../../sync-resolver/work-items-list-query';
import {
  releaseGateTile,
  poolTile,
  systemAlerts,
  type SystemAlert,
} from '../../../device-monitoring';

/** Feature-family states that mean "needs a human / stuck". */
const FEATURE_ATTENTION_STATES = new Set(['needs-human', 'blocked', 'failing']);

const unavailableAttention = (reason: string, details?: Record<string, unknown>) => {
  // Keep the public response stable, but retain the producer/contract boundary
  // that failed. Otherwise live acceptance cannot distinguish a dispatch
  // refusal, an incomplete page and an unmeasured monitoring source.
  console.warn('[device/attention] unavailable:', reason, details ?? {});
  return Response.json({ error: 'attention_unavailable' }, { status: 503 });
};

/** Is this work-item worth surfacing in the human's inbox? */
function isAttentionWorkItem(wi: { family: string; kind: string; state: string }): boolean {
  if (wi.family === 'feature') return FEATURE_ATTENTION_STATES.has(wi.state);
  // issue-family: open bugs/changes await triage; delegated `task`s are the
  // operator's own work, not the human's inbox.
  return (wi.kind === 'bug' || wi.kind === 'change') && wi.state === 'open';
}

const attention = defineTool({
  method: 'GET',
  path: '/device/attention',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);

    const toolCtx: UnifiedToolContext = {
      log: () => {},
      signal: ctx.signal,
      progress: () => {},
      emit: () => {},
      workspaceId: principal.workspaceId,
      // The canonical reader requires an explicit harness scope. Use the
      // same operator-home source as desktop attention while retaining the
      // paired workspace partition for every workspace-level source.
      harnessSlug: operatorHomeHarnessSlug(),
      role: 'operator',
      runId: globalThis.crypto.randomUUID(),
      spawnId: globalThis.crypto.randomUUID(),
      transport: 'in_process',
      uiClientId: null,
    };

    // 1. Canonical attention groups (plan items + coord + smoke + reviews).
    type InboxGroup = {
      key?: string; planSlug?: string | null; harnessSlug?: string | null; items: unknown[];
      _meta?: { hasMore?: boolean; nextOffset?: number | null; total?: number; returned?: number };
      [key: string]: unknown;
    };
    const groups: InboxGroup[] = [];
    const attentionTool = lookupByMcpName('plans:attention');
    if (!attentionTool) return unavailableAttention('canonical_tool_missing');
    try {
      let offset = 0;
      let expectedTotal: number | undefined;
      let received = 0;
      const byKey = new Map<string, InboxGroup>();
      do {
        if (ctx.signal.aborted) return unavailableAttention('canonical_request_aborted');
        const dispatched = await dispatchProjectedTool(attentionTool, 'plans:attention', {
          limit: 100, offset, payloadTier: 'full',
        }, toolCtx, {});
        if (!dispatched.ok || !dispatched.result || dispatched.result.isError) {
          return unavailableAttention('canonical_dispatch_failed', { code: dispatched.error?.code });
        }
        const parsed = JSON.parse((dispatched.result?.content[0] as { text?: string })?.text ?? '{}') as {
          ok?: boolean; groups?: InboxGroup[]; _projection?: { truncated?: boolean };
        };
        if (parsed.ok === false || parsed._projection?.truncated || !Array.isArray(parsed.groups)) {
          return unavailableAttention('canonical_page_unavailable', {
            offset, keys: Object.keys(parsed), truncated: parsed._projection?.truncated === true,
          });
        }
        const meta = parsed.groups.find(g => g._meta)?._meta;
        let pageItems = 0;
        for (const group of parsed.groups) {
          if (!Array.isArray(group.items)) return unavailableAttention('canonical_group_invalid', { offset });
          pageItems += group.items.length;
          // Empty groups carry no actionable content. Keep their page metadata
          // for the completeness checks below, but do not add an Inbox entry.
          if (group.items.length === 0) continue;
          const { _meta: _pageMeta, ...completeGroup } = group;
          const key = group.key ?? `${group.harnessSlug ?? ''}#${group.planSlug ?? 'alerts'}`;
          const prior = byKey.get(key);
          if (prior) prior.items.push(...group.items);
          else {
            const copy = { ...completeGroup, items: [...group.items] };
            byKey.set(key, copy);
            groups.push(copy);
          }
        }
        if (meta?.returned !== undefined && meta.returned !== pageItems) {
          return unavailableAttention('canonical_returned_mismatch', { offset, returned: meta.returned, pageItems });
        }
        if (meta?.total !== undefined) {
          if (expectedTotal !== undefined && expectedTotal !== meta.total) {
            return unavailableAttention('canonical_snapshot_changed', { offset, expectedTotal, total: meta.total });
          }
          expectedTotal = meta.total;
        }
        received += pageItems;
        if (!meta?.hasMore) {
          if (expectedTotal !== undefined && expectedTotal !== received) {
            return unavailableAttention('canonical_total_mismatch', { expectedTotal, received });
          }
          break;
        }
        if (!Number.isInteger(meta.nextOffset) || meta.nextOffset! <= offset || pageItems === 0) {
          return unavailableAttention('canonical_page_cannot_advance', { offset, nextOffset: meta.nextOffset, pageItems });
        }
        offset = meta.nextOffset!;
      } while (true);
    } catch (e) {
      console.warn('[device/attention] plans:attention failed:', (e as Error)?.message ?? e);
      return unavailableAttention('canonical_source_failed');
    }

    // 2. Work-items-native layer — attention-worthy items across the workspace.
    let workItems: WorkItemsListRow[];
    try {
      const harnesses = await listHarnessesFor(principal.workspaceId, { includeHiveHomes: true });
      const harnessSlugs = [...new Set([operatorHomeHarnessSlug(), ...harnesses.map(h => h.slug)])];
      workItems = await withWorkspace(principal.workspaceId, async sql => {
        const items: WorkItemsListRow[] = [];
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        do {
          if (ctx.signal.aborted) throw new Error('Attention request aborted');
          const predicate = buildWorkItemsPredicate(normalizeWorkItemsListArgs({
            harnessSlugs, limit: 200, cursor,
            filters: { states: [...FEATURE_ATTENTION_STATES, 'open'] },
          }));
          const page = await readWorkItemsPageFromStore(sql, principal.workspaceId, predicate, { includeDetails: true });
          items.push(...page.rows.filter(isAttentionWorkItem));
          if (!page.hasMore) return items;
          if (!page.nextCursor || seenCursors.has(page.nextCursor) || page.rows.length === 0) {
            throw new Error('Incomplete work-item attention page');
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        } while (true);
      });
    } catch (e) {
      console.warn('[device/attention] work-item pages failed:', (e as Error)?.message ?? e);
      return unavailableAttention('work_item_source_failed');
    }

    // 3. System-health attention producers (P-007): release red-gate and
    //    inference-pool exhaustion are owner-attention conditions the fleet
    //    escalations / owner-questions above don't cover. Both tiles are
    //    return null on an unavailable measurement. Only measured healthy
    //    conditions may produce an empty system-alert section.
    let systemAlertsOut: SystemAlert[] = [];
    try {
      const [gate, pool] = await Promise.all([releaseGateTile(), poolTile(principal.workspaceId)]);
      if (!gate || !pool) return unavailableAttention('system_source_unmeasured', { gateMeasured: !!gate, poolMeasured: !!pool });
      systemAlertsOut = systemAlerts({ gate, pool });
    } catch (e) {
      console.warn('[device/attention] systemAlerts failed:', (e as Error)?.message ?? e);
      return unavailableAttention('system_source_failed');
    }

    return Response.json({
      groups,
      workItems,
      systemAlerts: systemAlertsOut,
      counts: {
        groups: groups.length,
        workItems: workItems.length,
        systemAlerts: systemAlertsOut.length,
      },
    });
  },
});

export default [attention];
