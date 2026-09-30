/**
 * plans:audit-unshipped — run the deterministic read-only portfolio audit now.
 *
 * This is the manual lever over the same implementation registered as
 * `system:unshipped-plans-audit`. It persists evidence artifacts only; it does
 * not create a schedule and cannot import or invoke plan/blocker lifecycle writers.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { activeWorkspaceId } from '../../workspace-registry';
import { runUnshippedPlansAudit } from '../../unshipped-plans-audit';

export default defineTool({
  name: 'plans:audit-unshipped',
  profile: 'engineer',
  description:
      'FIRE the workspace-wide unshipped-plans audit NOW. Deterministic and read-only with respect to plan lifecycle, items, blockers, claims, assignments, fleets, and agents. It re-reads live ownership, classifies the current nonterminal portfolio with classifier revision 3, and publishes PG-canonical JSON+HTML text artifacts. It does not create or arm a schedule.',
  capability: 'operator:write',
  guidance: {
    when: 'You need a fresh evidence manifest of nonterminal plans, disposition bands, stale/prose-only blockers, and live-owned exclusions. This is the on-demand audit lever.',
    notWhen:
      'To mutate plan status or blockers — use the evidence-gated plans:* lifecycle tools separately. To schedule work — use plans:set-schedule/arm-schedule; this audit is intentionally manual-only.',
    chaining:
      'plans:audit-unshipped → inspect the JSON artifact → re-read live ownership immediately before any separate lifecycle/blocker mutation batch.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 5 } },
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness that owns the published text artifacts (default: operator home harness). The audit scope remains workspace-wide.'),
  }),
  async handler(args) {
    const workspaceId = activeWorkspaceId();
    const artifactHarness = args.harness ?? operatorHomeHarnessSlug();
    const result = await runUnshippedPlansAudit({ workspaceId, artifactHarness });
    const manifest = result.manifest;
    const documentedSupersession = manifest.rows
      .filter((row) => row.category === 'supersede-documented')
      .map((row) => row.slug);
    const staleBlockers = manifest.rows
      .filter((row) => row.category === 'typed-blocker-stale-hint')
      .map((row) => row.slug);
    return {
      data: {
        ok: true,
        manual: true,
        scheduled: false,
        readOnlyLifecycle: true,
        generatedAt: manifest.generatedAt,
        workspace: workspaceId,
        classifierRevision: manifest.scope.classifierRevision,
        rows: manifest.rows.length,
        bands: manifest.bands,
        blockerEvidence: manifest.blockerEvidence,
        documentedSupersession,
        staleBlockers,
        artifacts: result.artifacts,
        next:
          'Read the JSON artifact for per-plan evidence. Before any separate mutation batch, re-read live ownership; this tool intentionally performs no cleanup writes.',
      },
    };
  },
});
