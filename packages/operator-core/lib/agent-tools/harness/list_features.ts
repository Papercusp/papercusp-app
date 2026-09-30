/**
 * harness:list_features — list features for a harness slug (with phase
 * variant). Read-only projection of harness-features.
 *
 * Calls listFeaturesForHarness() in lib/harness-readers.ts directly.
 * The hono /:slug/status route returns a superset of fields including
 * features; this tool returns just the features array since that's what
 * the registry-residual command exposes.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { phasePhaseLabel } from '../../harness-phases';
import { listFeaturesForHarness } from '../../harness-readers';
import { getBlockedFeatures, featureRef } from '../../issue-blocks-merge';

export default defineTool({
  name: 'harness:list_features',
  profile: 'engineer',
  description: 'List features for a harness slug (optionally for a specific phase: staging, testing, production).',
  guidance: {
    when: 'User asks "what features does sheets have?" or you need a feature id before calling `features:get`. Pass a phase to scope (staging = upcoming, testing = in-flight, production = done).',
    notWhen: 'For ONE feature\'s detail, use `features:get`. For the harness as a whole, use `harness:list`/`harness:get`.',
    chaining: 'Pair with `features:get` for body, `features:history` for change log.',
    seeAlso: [
      'features:get (a feature\'s body)',
      'features:history (a feature\'s change log)',
      'harness:phase_path (the phase directory path)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1),
    status: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    phase: z.enum(['staging', 'testing', 'production']).optional(),
  }),
  async handler(args) {
    const result = await listFeaturesForHarness(args.slug, phasePhaseLabel(args.phase ?? 'staging'));
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    let features = result.data.features as Array<Record<string, unknown>>;
    if (args.status) features = features.filter((f) => f.status === args.status);
    features = features.slice(0, args.limit ?? 50);

    // engineer-issues D-006 #2: annotate each feature with the OPEN engineer-issues
    // blocking it (coord_links rel='blocks', dst=feature, keyed by the harness-qualified
    // featureRef). Makes blocking a feature visible at the reader rather than a no-op.
    // Non-fatal — degrades to no annotation on a coord_links/issues error.
    let blocked = new Map<string, string[]>();
    try {
      blocked = await getBlockedFeatures();
    } catch {
      // Non-fatal — no block annotation.
    }

    const projected = features.map((f) => {
      const blockedByIssues = blocked.get(featureRef(args.slug, String(f.id)));
      return {
        id: f.id,
        title: f.title,
        status: f.status,
        claims: f.claims,
        attempts: f.attempts,
        ...(blockedByIssues ? { blockedByIssues } : {}),
      };
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ slug: args.slug, count: projected.length, features: projected }),
        },
      ],
    };
  },
});
