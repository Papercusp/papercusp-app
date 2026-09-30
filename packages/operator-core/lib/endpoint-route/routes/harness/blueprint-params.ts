/**
 * GET /api/harness/:slug/blueprint-params — the declared, UI-introspectable
 * settings schema for a harness, resolved from its blueprint
 * (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-008 — the spine of the
 * schema-driven settings panel; consumes the P-006 `params` declaration).
 *
 * Returns `{ blueprintId, params, identity }` where `params` is the blueprint's
 * declared `BlueprintParams` (base universal ∪ blueprint-specific, keyed by
 * config.json instance path) and `identity` projects the already-resolved blueprint
 * sections identities may contribute: `lexicon`, `retired`, `knobs.aiBackend`, and
 * both rubric homes. The client (`BlueprintSettingsPanel`) combines `params` with the
 * harness's `config.json`; the harness workspace consumes `identity.lexicon` through
 * its existing UI resolver. This is one resolved-blueprint read, not a parallel
 * identity store or endpoint (identities-v1-2026-08-30 P-025).
 *
 * Resolution mirrors the runtime (orchestrator-runner `harnessBlueprintKnobs`): the
 * harness's git-canonical `.papercusp/blueprint.yaml` (base merged via `extends`).
 * A harness with no blueprint file (pre-blueprint legacy) returns `{ params: {} }` —
 * the panel then shows the no-declared-params state (the legacy hardcoded panel stays
 * available behind its own flag).
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { defineTool } from '@papercusp/agent-mcp';

const EMPTY_IDENTITY_SECTIONS = {
  lexicon: {},
  retired: null,
  knobs: { aiBackend: null },
  gym: { rubric: null },
  acceptance: { rubric: null },
};

function identitySections(blueprint: ReturnType<typeof loadBlueprintFromFile>['blueprint']) {
  return {
    lexicon: blueprint.lexicon ?? {},
    retired: blueprint.retired ?? null,
    knobs: { aiBackend: blueprint.knobs.aiBackend ?? null },
    gym: { rubric: blueprint.gym?.rubric ?? null },
    acceptance: { rubric: blueprint.acceptance?.rubric ?? null },
  };
}

const getBlueprintParams = defineTool({
  method: 'GET',
  path: '/harness/:slug/blueprint-params',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const f = join(harnessDir(project), 'blueprint.yaml');
    if (!existsSync(f)) {
      return Response.json({ blueprintId: null, params: {}, identity: EMPTY_IDENTITY_SECTIONS });
    }
    try {
      const { blueprint } = loadBlueprintFromFile(f);
      return Response.json({
        blueprintId: blueprint.id,
        params: blueprint.params,
        identity: identitySections(blueprint),
      });
    } catch (e) {
      // A bad blueprint never strands the settings panel — surface empty params + the error.
      return Response.json({
        blueprintId: null,
        params: {},
        identity: EMPTY_IDENTITY_SECTIONS,
        error: String((e as Error)?.message ?? e),
      });
    }
  },
});

export default [getBlueprintParams];
