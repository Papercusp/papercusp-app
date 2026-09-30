import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const exec = promisify(execFile);

/**
 * setup:set_git_identity — the conversational replacement for the wizard's
 * Git step (agent-first-onboarding-2026-07-03 P-004). Same write the
 * POST /desktop/git-identity route performs: global git config.
 */
export default defineTool({
  name: 'setup:set_git_identity',
  profile: 'engineer',
  description:
    'Write user.name + user.email to the GLOBAL git config — the identity stamped on every commit the agents make for this user.',
  capability: 'operator:write',
  guidance: {
    when: `Onboarding/tutorial: the user told you the name + email they want on commits. Confirm the exact values out loud first, then verify with setup:status (git flips to ok).`,
    notWhen: `Repo-local identity overrides — this writes --global only.`,
    seeAlso: ['setup:status (verify the git step went ok)'],
  },
  requirePrincipal: false,
  // EI-18803497769946984: shells out to git config and never reads ctx.tx — holding the
  // ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s), surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    name: z.string().min(1).max(200).describe('Commit author name, e.g. "Ada Lovelace"'),
    email: z.string().min(3).max(320).describe('Commit author email'),
  }),
  async handler(args) {
    await exec('git', ['config', '--global', 'user.name', args.name], { timeout: 3000 });
    await exec('git', ['config', '--global', 'user.email', args.email], { timeout: 3000 });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, name: args.name, email: args.email }) }],
    };
  },
});
