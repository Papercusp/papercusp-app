/**
 * operator:paused — read the operator pause sentinel.
 *
 * Read-only here; the legacy POST/DELETE setters require a session-user
 * (browser cookie) and that auth model doesn't translate to MCP cleanly.
 * If agent-driven pause/resume is needed later, design a separate
 * principal-bound built-in tool instead of bypassing the session check.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { isPaused } from '../../device-operator-actions';

export default defineTool({
  name: 'operator:paused',
  profile: 'engineer',
  description: 'Read the operator pause sentinel — true when scans are suppressed.',
  capability: 'operator:read',
  guidance: {
    when: `Read/set the global operator-pause flag — silences scans + scanner-triggered cards across the workspace.`,
    notWhen: `For per-harness autoloop pause, use \`autoloop:control\`. paused is operator-global; autoloop is harness-scoped.`,
    seeAlso: [
      'autoloop:control (per-harness autoloop pause)',
      'operator:preferences (operator-level config)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    const paused = await isPaused();
    return { data: { paused } };
  },
});
