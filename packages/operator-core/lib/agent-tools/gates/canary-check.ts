/**
 * gates:canary-check — run a self-checking gate canary ON DEMAND and return
 * the bifurcated verdict (fleet-reliability-verification-2026-07-10 P-011,
 * after P-010/WI-3812's probe:emit).
 *
 * Today's only wired canary is the federation-probe apparatus check (a
 * stamped canary probe through the fed pipeline's stamping+persistence
 * layer). See `gates/canary.ts` for the general substrate any future gate
 * canary plugs into, and `gates/gate-canary-sweep-action.ts` for the
 * scheduled (system:gate-canary-sweep) counterpart of this same check.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { isRegisteredHive } from '../../harness-registry';
import { insertProbe } from '../../sync/pot-git/federation-probe-store';
import { buildFederationProbeCanary } from '../../gates/federation-probe-canary';
import { runGateCanary } from '../../gates/canary';

export default defineTool({
  name: 'gates:canary-check',
  description:
    'Run a self-checking gate canary RIGHT NOW and return the bifurcated verdict: healthy | gate-broken (a KNOWN-GOOD sample failed the gate\'s own apparatus — green is unreachable by construction, the 2026-07-10 cause #10 class) | system-broken (the apparatus works, a real red is trustworthy) | unknown (the canary itself could not be determined — treated as gate-suspect). Today checks the federation-probe stamping apparatus.',
  guidance: {
    when:
      'Before trusting a "still red" reading on the federation/fed-pipeline surface, OR when diagnosing whether a perpetually-red gate is a REAL system failure vs the checker itself being broken. Also useful as a quick "is probe:emit even working right now" smoke check.',
    notWhen:
      'You want to prove a REAL cross-machine round trip completed — use probe:emit + probe:get directly against your actual work (this canary only proves the stamping apparatus, not a live peer round trip). Routine harness health — dev:service_health.',
    chaining: 'gates:canary-check → if alarm:"gate", treat any concurrent federation red as UNTRUSTWORTHY and escalate the apparatus itself, not the system under test.',
    seeAlso: ['probe:emit', 'probe:get', 'dev:service_health'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Harness to canary-check federation for. Defaults to the session harness (ctx.harnessSlug) when omitted.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? activeWorkspaceId();
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness = typeof ctxHarnessRaw === 'string' && ctxHarnessRaw ? ctxHarnessRaw : undefined;
    const resolved = args.harnessSlug ?? ctxHarness;

    // '*' is a workspace SCOPE SELECTOR, not a concrete harness — it must NEVER
    // reach the fed-probe stamping apparatus. stampProbe correctly rejects '*'
    // as invalid_harness_slug, and the canary would then mislabel that
    // self-inflicted refusal as the most-severe 'gate-broken' verdict on a
    // perfectly healthy gate (EI-11574). An argless canary in a workspace-
    // scoped (superuser) session resolves ctx.harnessSlug to '*', so this is
    // the natural first call. A missing / wildcard / ambiguous harness is
    // canary-INDETERMINATE (verdict 'unknown'), never 'gate-broken'.
    const harnessSlug = resolved && resolved !== '*' ? resolved : undefined;

    if (!harnessSlug) {
      const canaryDetail =
        resolved === '*'
          ? "harness resolved to the scope-selector '*', not a concrete harness — pass a concrete harnessSlug to canary-check"
          : 'no concrete session harness to canary-check — pass harnessSlug';
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              id: 'federation-probe:(no-concrete-harness)',
              ranAt: new Date().toISOString(),
              canaryOk: null,
              canaryDetail,
              // Indeterminate, NOT gate-broken: the canary could not even run
              // (no concrete target), so it is not evidence the gate apparatus
              // is broken — do not manufacture a critical false alarm.
              verdict: 'unknown' as const,
              alarm: 'none' as const,
              detail:
                'canary indeterminate: no concrete harness resolved to check — this is NOT a gate failure. ' +
                "Pass harnessSlug (a concrete slug, not the '*' scope selector).",
            }),
          },
        ],
      };
    }

    const canary = buildFederationProbeCanary({
      workspaceId,
      harnessSlug,
      emittedBy: identity.ownerId,
      harnessIsFederated: () => isRegisteredHive(workspaceId, harnessSlug),
      insertProbe,
    });
    // No live systemGreen signal wired here (this is an on-demand apparatus check,
    // not a probe-backlog sweep) — a healthy apparatus reads 'unknown'/alarm:'none'
    // rather than a false 'healthy', per classifyGateCanary's contract.
    const report = await runGateCanary(canary, null);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: report.id,
            describe: report.describe,
            ranAt: new Date(report.ranAtMs).toISOString(),
            canaryOk: report.canaryOk,
            canaryDetail: report.canaryDetail,
            verdict: report.classification.verdict,
            alarm: report.classification.alarm,
            detail: report.classification.detail,
          }),
        },
      ],
    };
  },
});
