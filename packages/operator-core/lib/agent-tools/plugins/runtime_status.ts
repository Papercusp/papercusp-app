/**
 * plugins:runtime_status — read the in-process plugin host's status
 * (loaded plugins, registered actions, mounted api routes, etc.).
 *
 * Mirrors GET /api/plugins/runtime/status (without the `?reset=1`
 * test-mode side effect — that's UI-only diagnostic and shouldn't
 * leak to agents).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { pluginHostStatus } from '../../plugin-host-runtime';

export default defineTool({
  name: 'plugins:runtime_status',
  profile: 'engineer',
  guidance: {
    when: 'You need to know which plugins are loaded + healthy in the current operator process (per-harness or workspace-level).',
    notWhen: 'For the plugin CATALOG (everything installable), use the marketplace endpoints. plugins:runtime_status is the runtime view.',
    seeAlso: [
      'plugins:invoke_action (invoke an action a plugin exposes)',
      'plugins:tui_panes (the plugin\'s TUI pane contributions)',
      'plugins:fire_event (replay a hook event)',
    ],
  },
  description: 'Read the plugin host runtime status (loaded plugins, registered actions, mounted api routes).',
  capability: 'plugins:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    const status = await pluginHostStatus();
    return { data: status };
  },
});
