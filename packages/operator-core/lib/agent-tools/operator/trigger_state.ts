/**
 * operator:trigger_state — read the workspace's trigger-state
 * fingerprint (background scanner uses this to decide when to re-scan).
 *
 * Read-only; cached 1s per process via the underlying lib.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { fingerprint, readTriggerState } from '../../operator-trigger-state';

export default defineTool({
  name: 'operator:trigger_state',
  profile: 'engineer',
  description: 'Read the workspace trigger-state fingerprint + raw state (used by background scanner to decide rescans).',
  capability: 'operator:read',
  guidance: {
    when: `Read scanner trigger state — when the next scan fires, what's pending.`,
    notWhen: `For LIVE scan findings and their current triage state, use \`improvements:digest\`.`,
    seeAlso: [
      'improvements:digest (live scan findings)',
      'operator:dedup_check (dedup a scan candidate)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    const state = await readTriggerState();
    return { data: { fingerprint: fingerprint(state), state } };
  },
});
