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
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { listWorkItems, type WorkItem } from '../../../work-items';
import {
  releaseGateTile,
  poolTile,
  systemAlerts,
  type SystemAlert,
} from '../../../device-monitoring';

/** Feature-family states that mean "needs a human / stuck". */
const FEATURE_ATTENTION_STATES = new Set(['needs-human', 'blocked', 'failing']);

/** Is this work-item worth surfacing in the human's inbox? */
function isAttentionWorkItem(wi: WorkItem): boolean {
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
      role: 'operator',
      runId: globalThis.crypto.randomUUID(),
      spawnId: globalThis.crypto.randomUUID(),
      transport: 'in_process',
      uiClientId: null,
    };

    // 1. Canonical attention groups (plan items + coord + smoke + reviews).
    let groups: unknown[] = [];
    const attentionTool = lookupByMcpName('plans:attention');
    if (attentionTool) {
      try {
        const dispatched = await dispatchProjectedTool(attentionTool, 'plans:attention', {}, toolCtx, {});
        const parsed = JSON.parse((dispatched.result?.content[0] as { text?: string })?.text ?? '{}') as {
          groups?: unknown[];
        };
        groups = Array.isArray(parsed.groups) ? parsed.groups : [];
      } catch (e) {
        console.warn('[device/attention] plans:attention failed:', (e as Error)?.message ?? e);
      }
    }

    // 2. Work-items-native layer — attention-worthy items across the workspace.
    let workItems: WorkItem[] = [];
    try {
      const all = await listWorkItems({ limit: 200 });
      workItems = all.filter(isAttentionWorkItem);
    } catch (e) {
      console.warn('[device/attention] listWorkItems failed:', (e as Error)?.message ?? e);
    }

    // 3. System-health attention producers (P-007): release red-gate and
    //    inference-pool exhaustion are owner-attention conditions the fleet
    //    escalations / owner-questions above don't cover. Both tiles are
    //    fail-soft (null on error) and `systemAlerts` emits nothing when the
    //    conditions are healthy, so this never adds inbox noise.
    let systemAlertsOut: SystemAlert[] = [];
    try {
      const [gate, pool] = await Promise.all([releaseGateTile(), poolTile()]);
      systemAlertsOut = systemAlerts({ gate, pool });
    } catch (e) {
      console.warn('[device/attention] systemAlerts failed:', (e as Error)?.message ?? e);
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
