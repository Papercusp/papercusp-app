/**
 * plans:get-properties — read a plan's typed property surface
 * (work-on-everything-goal-2026-08-23 P-023, migration 923).
 *
 * The structured read complement of plans:set-property, mirroring
 * plans:get-input-schema's shape: one call returns the DECLARATIONS
 * (property_schema), the stored value ENVELOPES (properties — value, version,
 * provenance, edited_at/by per property), and the EFFECTIVE value per declared
 * property (stored value, else the declaration's default) — so no caller
 * re-derives the fallback rule, and a set-property round-trip has the version
 * it needs for the CAS guard. Read-only.
 *
 * (Goals need no sibling: goals:get { detail:'full' } already returns the raw
 * propertySchema/properties columns via its row spread.)
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { derivePropertySurface } from '../../typed-properties-db';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:get-properties',
  description:
    "Read a plan's typed property surface (P-023): { propertySchema, properties, effective }. `properties` carries each stored value's envelope (value, version, provenance, edited_at, edited_by) — `version` is what plans:set-property's CAS guard needs; `effective` is the per-declared-property value (stored, else the declaration default). Read-only.",
  guidance: {
    when: 'Rendering or acting on a plan\'s typed properties — the read before a set-property write (it supplies the CAS version).',
    notWhen:
      'Writing a value — plans:set-property. Declaring properties — plans:new { propertySchema }. Input schemas — plans:get-input-schema.',
    chaining: 'plans:get-properties { slug } → plans:set-property { slug, property, value, expectedVersion }.',
    seeAlso: ['plans:set-property (the write half)', 'goals:get detail:full (the goal read)'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    harness: harnessArg,
    slug: z.string().min(1).describe('Plan slug (filename stem).'),
  }),
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
    const rows = await withWorkspace(workspaceId, (tx) =>
      tx<Array<{ property_schema: unknown; properties: unknown }>>`
        SELECT property_schema, properties
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           AND plan_slug = ${args.slug}
      `,
    );
    if (!rows[0]) return text({ error: 'not_found', slug: args.slug }, true);
    return text({ ok: true, slug: args.slug, ...derivePropertySurface(rows[0]) });
  },
});
