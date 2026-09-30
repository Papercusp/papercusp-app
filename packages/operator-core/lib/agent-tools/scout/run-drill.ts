/** blender:run-drill — deployed, provenance-isolated P-013 release probe. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { runCapacityStormDrill } from '../../scout/capacity-storm-drill';
import { runBlenderRubricDrill } from '../../scout/rubric-live-drill';

export const runDrillArgs = z
  .object({
    harnessSlug: z
      .string()
      .min(1)
      .default('papercusp')
      .describe('harness whose deployed Blender composition to exercise'),
    mode: z
      .enum(['rubric-seeding', 'capacity-storm'])
      .default('rubric-seeding')
      .describe(
        "which drill: 'rubric-seeding' (default, the P-013 digest→ideation→routing vaccination) or 'capacity-storm' (P-006 — three synthetic failure legs through the deployed scheduler proving the timeout-vs-capacity classifier's red path on the live tick ledger)",
      ),
    sourceHive: z
      .string()
      .min(1)
      .optional()
      .describe('source-hive tag for the planted rubric ref (rubric-seeding only; default: harnessSlug)'),
  })
  .strict();

export default defineTool({
  name: 'blender:run-drill',
  description:
    "Run a deployed, provenance-isolated Blender health drill now. mode 'rubric-seeding' (default, P-013): plant an origin='drill' broken-criterion scorecard and drive the production digest→ideation→routing composition with a bounded deterministic model seam, persisting + grading origin='drill' routes. mode 'capacity-storm' (P-006): storm the deployed scheduler with three synthetic failure legs (typed rate-limit-blocked → must gate 'no-capacity'; a real cycle timeout and a no-free-slot admission defect → must stay errors), then read the persisted rows back proving the write/read capacity classifiers agree live. Both modes prove no organic-origin route or tick carries the drill's cycle ids; synthetic artifacts stay out of organic learning and work queues. Returns ok only when every causal live assertion passes.",
  capability: 'harness:write',
  guidance: {
    when:
      'Before a public release, after a Blender pipeline or capacity-classifier change, or when blender-release-readiness requires fresh deployed origin=drill evidence.',
    notWhen:
      'Measuring organic idea quality or generating a real proposal — use blender:success-metrics / the normal Scout cadence. These are synthetic, provenance-isolated health probes.',
    chaining:
      "blender:run-drill → require ok:true and evidence.organicMetricsUnchanged:true → score blender-release-readiness → scorecards:list/rubrics:trend.",
    seeAlso: [
      'blender:success-metrics (organic program done-check)',
      'blender:grade-idea (grade a real routed idea)',
      'scorecards:list (release scorecard evidence)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: runDrillArgs,
  async handler(args) {
    const { mode, ...rest } = args;
    const result =
      mode === 'capacity-storm'
        ? await runCapacityStormDrill({ harnessSlug: rest.harnessSlug })
        : await runBlenderRubricDrill(rest);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
