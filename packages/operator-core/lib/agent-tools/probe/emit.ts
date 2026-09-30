/**
 * probe:emit — self-verifying federation probe (fleet-reliability-verification-
 * 2026-07-10 P-010, WI-3812).
 *
 * Root lesson (2026-07-10 cause #10): every prior ad-hoc "v2t" liveness probe
 * was UNSTAMPED — nothing forced it to carry the keys required to prove it
 * actually rode the real federation pipeline, so "green" was unreachable by
 * construction for ~6h and nothing said so. This tool makes a probe
 * correct-by-construction: it stamps the required federation keys and REFUSES
 * loudly (a typed reason, in the response AND persisted) when the target
 * harness cannot possibly federate — never a silent no-op.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { isRegisteredHive } from '../../harness-registry';
import { buildProbeKey, PROBE_HOPS, stampProbe } from '../../sync/pot-git/federation-probe';
import { insertProbe, insertRefusedProbe } from '../../sync/pot-git/federation-probe-store';

export default defineTool({
  name: 'probe:emit',
  description:
    'Emit a captured-only federation diagnostic declaration: stamp the required workspace_id and harness_slug and REFUSE LOUDLY (never silently) when the target harness cannot federate. A successful receipt proves local capture of a correctly stamped declaration; it is NOT proof of drain, replication, merge, member-guard, projection, or end-to-end federation health.',
  guidance: {
    when:
      'Proving a federation/replication claim is REAL, not just "looks green" — verifying a fresh 2-machine rig federates content, diagnosing a "rosters but no content" stall, or replacing an ad-hoc marker write (the v2t convention) with something that cannot be emitted unstamped.',
    notWhen:
      'Routine coord messaging or an ordinary content write (features/issues/plans) — a probe is diagnostic, not a deliverable. Not a substitute for events:emit/events:await (in-process wake, not a federation-pipeline check).',
    chaining: 'probe:emit → probe:get { probeKey } to read the captured/refused receipt; use real outbox/merge/remote-origin evidence for federation health.',
    seeAlso: ['probe:get'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Harness to probe federation for. Defaults to the session harness (ctx.harnessSlug) when omitted.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? activeWorkspaceId();
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness = typeof ctxHarnessRaw === 'string' && ctxHarnessRaw ? ctxHarnessRaw : undefined;
    const harnessSlug = args.harnessSlug ?? ctxHarness;
    const nowMs = Date.now();

    let harnessIsFederated = false;
    if (workspaceId && workspaceId !== '*' && harnessSlug && harnessSlug !== '*') {
      try {
        harnessIsFederated = await isRegisteredHive(workspaceId, harnessSlug);
      } catch {
        // fail-closed: an unresolvable registry read means we cannot PROVE
        // this harness federates, so refuse (never assume federated).
        harnessIsFederated = false;
      }
    }

    const result = stampProbe({
      workspaceId,
      harnessSlug,
      emittedBy: identity.ownerId,
      harnessIsFederated,
      nowMs,
    });

    if (!result.ok) {
      // Best-effort durable record of the refusal (only when we have enough
      // to scope it — a structurally-missing workspace/harness/identity has
      // nowhere meaningful to persist against).
      if (workspaceId && workspaceId !== '*' && harnessSlug && harnessSlug !== '*' && identity.ownerId) {
        try {
          await insertRefusedProbe({
            workspaceId,
            harnessSlug,
            emittedBy: identity.ownerId,
            probeKey: buildProbeKey(harnessSlug, identity.ownerId, nowMs),
            reason: result.reason,
            nowMs,
          });
        } catch {
          // persistence of the refusal is best-effort — the refusal itself
          // is still returned to the caller either way.
        }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, refused: true, reason: result.reason, detail: result.detail }),
          },
        ],
      };
    }

    const receipt = await insertProbe(result.stamped);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            probeKey: receipt.probeKey,
            harnessSlug: receipt.harnessSlug,
            workspaceId: receipt.workspaceId,
            emittedAt: new Date(receipt.emittedAtMs).toISOString(),
            // Captured-only by design (WI-3962): later federation stages are
            // observed in different processes/stores and cannot truthfully be
            // inferred from this emitter-local receipt.
            hopsExpected: PROBE_HOPS,
            hopsCaptured: ['captured'],
            next: 'probe:get { probeKey } confirms this captured receipt; inspect substrate_outbox, substrate_merge_cursor, and fresh origin=remote rows for federation health',
          }),
        },
      ],
    };
  },
});
