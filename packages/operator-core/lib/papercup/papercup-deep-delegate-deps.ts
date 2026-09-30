/**
 * sentinel-deep-delegate-deps — the real-substrate wiring of DeepDelegateDeps
 * (voice-unified-sentinel-pipeline-2026-07-01 P-006; live-deep lane added by
 * voice-public-release-readiness-2026-07-12 P-019 per its D-003). Kept SEPARATE
 * from the dispatch core (sentinel-deep-delegate.ts) so the core unit-tests
 * against injected deps with no PG/spawn/coord machinery — the same split the
 * handoff lane uses (operator-sentinel-handoff-deps.ts).
 *
 * Each dep maps onto an EXISTING substrate primitive — reuse, don't rebuild:
 *   - createWorkItem       → work-items.createWorkItem (kind=`task`, tagged
 *                            tagged `deep-delegation` (the landing gate) +
 *                            stamped payload.deep_delegation, landing ALREADY
 *                            claimed by the assignee (deep ownerId / spawn id).
 *   - findLiveDeepSession  → coordination/presence.listPresence filtered to a
 *                            fresh agentRole='papercup-deep' row (D-006: the
 *                            persistent parked deep pane).
 *   - deliverToDeep        → coordination/messages.sendMessage (directed, the
 *                            brief as body) + inbox-wake.wakeRecipients — the
 *                            modern coord/wake channel (D-003).
 *   - releaseClaim         → work-items.releaseWorkItem (delivery-miss cleanup).
 *   - spawn                → fleet/operator-spawn.spawnAgentInHarness with a
 *                            pre-minted spawn id, role `papercup-deep` (the
 *                            registered deep-brain role) at the `deep` tier; if launch
 *                            is refused before the nursery takes ownership, the
 *                            reserved claim is released back to the pool.
 */
import type { DeepDelegateDeps } from './papercup-deep-delegate';
import { DEEP_DELEGATION_LABEL } from './papercup-deep-delegate';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/** The system identity deep-delegation coord messages are sent AS. Not a live
 *  session — the deep session must answer via the work-item completion (the
 *  brief says so), never a coord reply to this sender. */
const DEEP_DELEGATE_IDENTITY: AgentIdentity = {
  ownerId: 'system:papercup-deep-delegate',
  ownerLabel: 'papercup-deep-delegate',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Default harness the background agent spawns into when the caller gave none:
 *  the operator HOME harness (where the sentinel itself lives) via the canonical
 *  resolver — env PAPERCUSP_POT_HOME_SLUG when set, else the standing default.
 *  Raw-env-only resolution left the staging process (no env) unable to mint the
 *  deep-delegation task at all ("no harness resolved", live 2026-07-01). */
function defaultSpawnHarness(): string | null {
  return operatorHomeHarnessSlug() || null;
}

export function defaultDeepDelegateDeps(): DeepDelegateDeps {
  return {
    async createWorkItem(input) {
      try {
        const { createWorkItem } = await import('../work-items');
        const harness = input.harness ?? defaultSpawnHarness();
        if (!harness) {
          console.warn('[deep-delegate] no harness resolved for deep-delegation task create');
          return null;
        }
        const wi = await createWorkItem({
          kind: 'task',
          title: input.title,
          summary: input.summary,
          harness,
          workspaceId: input.workspaceId,
          topics: [DEEP_DELEGATION_LABEL],
          createdBy: 'sentinel-deep',
          payload: { deep_delegation: true },
          assignee: input.assignee,
        });
        return { id: wi.id, harness };
      } catch (err) {
        console.warn('[deep-delegate] work_item create failed:', (err as Error).message);
        return null;
      }
    },

    async findLiveDeepSession(workspaceId) {
      try {
        const { listPresence } = await import('../agent-tools/coordination/presence');
        // Unscoped list + filter: a deep pane launched before its workspace stamp
        // resolves would be invisible to a workspace-scoped read; prefer a
        // workspace match, then the freshest activity.
        const rows = await listPresence({});
        const candidates = rows.filter(
          (r) => r.agentRole === 'papercup-deep' && !r.stale && !r.revoked,
        );
        if (candidates.length === 0) return null;
        const ts = (r: { lastActiveAt: string | null; heartbeatAt: string }) =>
          Date.parse(r.lastActiveAt ?? r.heartbeatAt) || 0;
        candidates.sort((a, b) => {
          const aWs = a.workspaceId === workspaceId ? 1 : 0;
          const bWs = b.workspaceId === workspaceId ? 1 : 0;
          if (aWs !== bWs) return bWs - aWs;
          return ts(b) - ts(a);
        });
        return { ownerId: candidates[0].ownerId };
      } catch (err) {
        console.warn('[deep-delegate] live-deep presence read failed:', (err as Error).message);
        return null;
      }
    },

    async deliverToDeep({ ownerId, workItemId, harness, question, brief }) {
      try {
        const [{ sendMessage }, { wakeRecipients }] = await Promise.all([
          import('../agent-tools/coordination/messages'),
          import('../agent-tools/coordination/inbox-wake'),
        ]);
        const headline = question.length > 140 ? `${question.slice(0, 139)}…` : question;
        // Durable inbox row first (the truth), then the wake (the delivery).
        await sendMessage(DEEP_DELEGATE_IDENTITY, {
          to: [ownerId],
          summary: `[deep-delegation ${workItemId}] ${headline}`,
          body: brief,
          harnessSlug: harness,
        });
        const wake = await wakeRecipients([ownerId], {
          summary: `deep delegation ${workItemId}`,
          source: 'papercup-deep-delegate',
        });
        if (wake.woken > 0) return true;
        // staged (manual wake-mode) or missed (no live session watching the key):
        // the D-007 trap — a staged wake never fires by itself, so treat both as
        // NOT delivered and let the core degrade honestly.
        console.warn(
          `[deep-delegate] wake for ${workItemId} did not land on ${ownerId} ` +
            `(woken=${wake.woken}, staged=${wake.staged}) — falling back`,
        );
        return false;
      } catch (err) {
        console.warn('[deep-delegate] coord delivery failed:', (err as Error).message);
        return false;
      }
    },

    async releaseClaim(workItemId, harness) {
      const { releaseWorkItem } = await import('../work-items');
      await releaseWorkItem(workItemId, { harness }).catch(() => {});
    },

    async spawn({ spawnId, workItemId, harness, brief, timeoutMs }) {
      try {
        const [{ spawnAgentInHarness }, { activeWorkspaceId }, { releaseWorkItem }] =
          await Promise.all([
            import('../fleet/operator-spawn'),
            import('../workspace-registry'),
            import('../work-items'),
          ]);
        const out = await spawnAgentInHarness({
          // Descriptive attribution for the observe-only governor receipt (D-011).
          spawnCaller: 'papercup/papercup-deep-delegate-deps',
          workspaceId: activeWorkspaceId(),
          harness,
          role: 'papercup-deep',
          spawnId,
          brief,
          tier: 'deep',
          timeoutMs,
          featureId: workItemId,
          itemId: workItemId,
        });
        if (!out.ok) {
          await releaseWorkItem(workItemId, { harness }).catch(() => {});
          return { ok: false, spawnId: out.spawnId ?? spawnId, error: out.error ?? 'spawn failed' };
        }
        return { ok: true, spawnId: out.spawnId ?? spawnId };
      } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
      }
    },

    log: (msg) => console.log(`[deep-delegate] ${msg}`),
  };
}
