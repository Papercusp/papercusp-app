/**
 * operator:preview_prompt — build the operator's full system prompt
 * for a given request without actually running it. Useful for debug
 * + plugin-author validation of how their card affects prompt
 * assembly.
 *
 * `userId` defaults to a debug placeholder so callers don't need a
 * real session. `showFirstRun: true` forces the first-run intro
 * regardless of marker state.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildOperatorPrompt } from '../../operator-prompt';

export default defineTool({
  name: 'operator:preview_prompt',
  profile: 'engineer',
  description: 'Build the operator scanner prompt for a request without running it. Useful for debug + plugin-author validation.',
  capability: 'operator:read',
  guidance: {
    when: `Render the operator's assembled prompt for a given trigger — debug tool to verify what the model sees.`,
    notWhen: `Production code shouldn't depend on this; it's diagnostic only.`,
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    request: z.string(),
    userId: z.string().optional(),
    showFirstRun: z.boolean().optional(),
  }),
  async handler(args) {
    const result = await buildOperatorPrompt({
      request: args.request,
      userId: args.userId ?? 'debug-preview',
      showFirstRun: args.showFirstRun,
    });
    return { data: result };
  },
});
