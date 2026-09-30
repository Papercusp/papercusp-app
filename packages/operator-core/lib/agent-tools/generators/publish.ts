/**
 * generators:publish — a producing feature's worker publishes the item-set it
 * discovered, as first-class typed data (P-043 / D-019).
 *
 * This is the typed replacement for the abandoned `jq`-over-an-opaque-artifact
 * sketch: a "scan→fix" / "enumerate→migrate" feature does its discovery work,
 * then calls this tool with the concrete list it found. The items land in
 * `harness_generator_items` and any completion-time generative wave declared
 * `for_each: { from_feature: <this feature> }` is expanded immediately — one
 * child feature per item, each `blocked_by` this feature, so the P-042 frontier
 * dispatches them only once this feature is terminal. Idempotent: re-publishing
 * replaces the set and re-expands to the same deterministic child ids.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { expandGeneratorsForFeature } from '../plans/expand-generators';

export default defineTool({
  name: 'generators:publish',
  description:
    "Publish the item-set your feature discovered (a scan/enumerate/audit result) so a completion-time generative wave (`for_each: { from_feature: <your feature> }`) can mint one child feature per item — each blocked_by your feature, so they run only after you finish. Idempotent (re-publishing replaces the set).",
  guidance: {
    when: 'Your feature is the discovery half of a discover-then-act generative wave (the plan declares a `for_each: { from_feature: <you> }` wave) and you have produced the concrete list of items the downstream wave should fan out over.',
    notWhen:
      'Your work has no downstream generative wave, or the item-set is already known at promote time (use a promote-time `items`/`glob`/`sql` resolver instead).',
    chaining:
      'Call once near the end of your run, after the scan/enumeration is complete and verified.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: ['worker', 'architect', 'scoper'],
  args: z.object({
    harness_slug: z.string().min(1).describe('The harness your feature belongs to.'),
    feature_id: z.string().min(1).describe('Your own feature id (the producer the wave sources from).'),
    items: z
      .array(z.string().min(1))
      .describe('The discovered item-set; one child feature is minted per (deduped, non-empty) item.'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? activeWorkspaceId();
    const items = [...new Set(args.items.map((s) => s.trim()).filter(Boolean))];

    // Store the published set (typed PG, idempotent upsert).
    const { sql } = getOrgPg();
    const now = Date.now();
    await sql`
      INSERT INTO harness_shared.harness_generator_items
        (workspace_id, harness_slug, feature_id, items, updated_ts)
      VALUES (${workspaceId}, ${args.harness_slug}, ${args.feature_id}, ${JSON.stringify(items)}::text::jsonb, ${now})
      ON CONFLICT (workspace_id, harness_slug, feature_id)
      DO UPDATE SET items = EXCLUDED.items, updated_ts = EXCLUDED.updated_ts
    `;

    // Expand any completion-time generative wave sourced by this feature now —
    // children are blocked_by this feature, so they wait for it via the frontier.
    const expansion = await expandGeneratorsForFeature({
      harnessSlug: args.harness_slug,
      featureId: args.feature_id,
      workspaceId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            published: items.length,
            waves: expansion.waves,
            expanded: expansion.expanded,
            childIds: expansion.childIds,
            ...(expansion.escalations.length > 0 && { escalations: expansion.escalations }),
          }),
        },
      ],
    };
  },
});
