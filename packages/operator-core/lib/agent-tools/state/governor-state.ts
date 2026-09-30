/** Resolver lens shared by the five resource-governor state cells. */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  GOVERNOR_STATE_MAX_AGE_MS,
  readGovernorStateSnapshot,
  type GovernorStateSnapshot,
} from '../../resource-governor/state-snapshot';

export function unavailableGovernorStatePayload(): {
  ok: true;
  snapshot: null;
  unknown: readonly string[];
  assessments: GovernorStateSnapshot['assessments'];
  health: null;
  admission: null;
  queue: null;
  resources: null;
  recovery: null;
  freshness: null;
} {
  return {
    ok: true,
    snapshot: null,
    unknown: ['health', 'admission', 'queue', 'resources', 'recovery'],
    assessments: {
      health: 'unknown',
      admission: 'unknown',
      queue: 'unknown',
      resources: 'unknown',
      recovery: 'unknown',
    },
    health: null,
    admission: null,
    queue: null,
    resources: null,
    recovery: null,
    freshness: null,
  };
}

export async function buildGovernorStatePayload(
  workspaceId = activeWorkspaceId(),
  read = readGovernorStateSnapshot,
) {
  const result = await read(workspaceId, GOVERNOR_STATE_MAX_AGE_MS);
  if (!result) return unavailableGovernorStatePayload();
  const snapshot = result.payload;
  return {
    ok: true,
    snapshot,
    unknown: snapshot.unknown,
    assessments: snapshot.assessments,
    health: snapshot.health,
    admission: snapshot.admission,
    queue: snapshot.queue,
    resources: snapshot.resources,
    recovery: snapshot.recovery,
    freshness: { ...snapshot.freshness, ageMs: result.ageMs },
  };
}

export default defineTool({
  name: 'governor:state_snapshot',
  description: 'Read the canonical bounded resource-governor snapshot used by state:read governor.* cells.',
  guidance: {
    when: 'As the resolver behind governor.health/admission/queue/resources/recovery.',
    notWhen: 'To mutate governor state or inspect individual queue rows.',
    chaining: 'state:read { cell:"governor.health" } is the ordinary entry point.',
  },
  // @cell-lens governor.health
  // This tool IS the registered resolver behind governor.health/admission/queue/
  // resources/recovery — its own description says so. One marker names the family
  // (CELL_LENS_RE captures a single id), matching how dev/pipeline_position.ts
  // declares git.pipelinePosition for the five cells it resolves.
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({}),
  async handler() {
    const payload = await buildGovernorStatePayload();
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
