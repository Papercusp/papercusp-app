/**
 * harness:markdown_index — load the markdown-heading index for every
 * harness in the workspace (filename + heading id + heading text).
 *
 * Used by the operator prompt assembly to give the LLM resolvable
 * anchor ids (papercusp://harness/<slug>/<file>#<anchor>) without
 * having to derive slugs from heading text.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { loadHarnessMarkdownIndex } from '../../harness-markdown-index';

export default defineTool({
  name: 'harness:markdown_index',
  profile: 'engineer',
  description: 'Load the per-harness markdown index (filename + headings + anchor ids) across the workspace.',
  guidance: {
    when: 'User asks "what docs exist?", "where\'s the spec for X?", or you need to navigate to a specific section of the harness\'s markdown.',
    notWhen: 'For the CONTENT of an indexed file (state files in any one harness), use `docs:get` — context-aware: when called inside a harness it serves that harness\'s content. For wiki-style backlinks (`[[name]]` references), use `wiki:backlinks`. This tool\'s unique value is the cross-harness sweep in one call.',
    seeAlso: [
      'docs:get (the CONTENT of an indexed file)',
      'wiki:backlinks (wiki-style [[name]] references)',
      'harness:list_features (features in the phase)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    const index = await loadHarnessMarkdownIndex();
    return { data: { index } };
  },
});
