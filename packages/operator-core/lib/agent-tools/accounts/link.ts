/**
 * accounts:link-start / accounts:link-complete — the one-click OAuth add-account flow
 * (accounts-pool-tab-2026-06-15 P-002 / D-016). The agent-surface twin of the
 * /api/admin/deploy-accounts/link-* HTTP routes the SPA calls. Wrappers over
 * deployment/account-link-cli, which DRIVES the real provider CLI in a pty
 * (`claude setup-token` or `codex login --device-auth`).
 * accounts:register (the setup-token paste) remains the manual alternative.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { startCliLink, completeCliLink, getCliLinkStatus } from '../../deployment/account-link-cli';

const json = (o: unknown) => ({ data: o });

export const accountsLinkStartTool = defineTool({
  name: 'accounts:link-start',
  profile: 'engineer',
  description:
    "One-click Max-account link (accounts-pool-tab P-002): spawns the real `claude setup-token` CLI server-side and returns the claude.ai authorize URL IT prints + an opaque linkId for the held process. The owner opens the URL in a browser logged into the TARGET Max account, authorizes, then pastes the shown code into accounts:link-complete with this linkId. (Driving the real CLI is required — claude.ai rejects a hand-built URL.) accounts:register (setup-token paste) is the manual alternative. Returns {ok, authorizeUrl, linkId}.",
  guidance: {
    when: 'Linking a new Max subscription into the pool via the one-click OAuth beta (vs the setup-token paste). Pair with accounts:link-complete.',
    notWhen: 'The reliable path — accounts:register with a `claude setup-token` (token:<path>) or a .credentials.json bundle. Inspecting the pool — accounts:list / accounts:status.',
    chaining: 'accounts:link-start { id } → owner authorizes the URL → accounts:link-complete { linkId, code } → registered.',
    seeAlso: [
      'accounts:link-complete (finish the OAuth link this started)',
      'accounts:register (the reliable setup-token / credentials path)',
      'accounts:list (verify the newly linked account)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('Stable account id (A-Za-z0-9 . _ - only)'),
    label: z.string().min(1).optional().describe('Optional human label'),
    provider: z.enum(['claude', 'codex']).optional().describe('Provider to link. Defaults to claude.'),
    workspace: z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)'),
  }),
  async handler(args) {
    return json(await startCliLink({ accountId: args.id, label: args.label, provider: args.provider }));
  },
});

export const accountsLinkCompleteTool = defineTool({
  name: 'accounts:link-complete',
  profile: 'engineer',
  description:
    "Complete the one-click account link (accounts-pool-tab P-002): feed the pasted claude.ai code into the held `claude setup-token` process (keyed by linkId) → it mints the token → write it server-side + register the account. The token NEVER appears in the response. Returns {ok, account} (the registered account row, no token).",
  guidance: {
    when: 'Finishing an accounts:link-start flow — paste the `code` claude.ai showed after the owner authorized, with the linkId from link-start.',
    notWhen: 'Starting the flow — accounts:link-start. The reliable path — accounts:register.',
    seeAlso: [
      'accounts:link-start (begin the OAuth link first)',
      'accounts:list (verify the newly linked account)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    linkId: z.string().min(1).describe('The opaque linkId from accounts:link-start'),
    code: z.string().min(1).optional().describe('The code claude.ai showed after authorizing (may be `code#state`). Not needed for Codex device auth.'),
    workspace: z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)'),
  }),
  async handler(args) {
    return json(await completeCliLink({ linkId: args.linkId, code: args.code, workspace: args.workspace }));
  },
});

export const accountsLinkStatusTool = defineTool({
  name: 'accounts:link-status',
  profile: 'engineer',
  description:
    "Poll a held accounts:link-start flow. claude CLI ≥2.1.200 auto-delivers the OAuth code to the held CLI when the approving browser is on the operator's own machine (the owner sees \"You're all set up\" and NO code) — the server finalizes on its own and THIS reports it. Returns {ok, status: pending|completed|failed|unknown, account?, error?}.",
  guidance: {
    when: 'After accounts:link-start, while the owner approves in the browser — poll until completed/failed instead of demanding a code that may never be shown.',
    notWhen: 'You have a pasted code — accounts:link-complete. Inspecting the pool — accounts:list.',
    seeAlso: ['accounts:link-start (begin the OAuth link)', 'accounts:link-complete (finish with a pasted code)'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    linkId: z.string().min(1).describe('The opaque linkId from accounts:link-start'),
  }),
  async handler(args) {
    return json({ ok: true, ...getCliLinkStatus(args.linkId) });
  },
});
