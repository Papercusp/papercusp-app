/**
 * POST /api/desktop/agent-login-envelope — minimal ConsoleEnvelope for
 * the Setup Wizard's "Sign in to Claude / OpenAI / GitHub" buttons.
 *
 * Ported from app/api/desktop/agent-login-envelope/route.ts. `auth: {}`.
 */
import { homedir } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';

const PROVIDER_COMMANDS: Record<string, string> = {
  claude: 'claude /login',
  codex: 'codex login',
  openai: 'omp /login',
  omp: 'omp /login',
  // `gh auth login` is the GitHub CLI's interactive OAuth flow.
  github: 'gh auth login',
};

export default defineTool({
  method: 'POST',
  path: '/desktop/agent-login-envelope',
  auth: {},
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as { provider?: string };
    const provider = body.provider ?? '';
    const cmd = PROVIDER_COMMANDS[provider];
    if (!cmd) {
      return Response.json({ error: `unknown provider: ${provider}` }, { status: 400 });
    }
    return Response.json({
      cwd: homedir(),
      env: {},
      mcpJsonContents: '',
      greetingCmd: cmd,
      needsSuperuserBootstrap: false,
    });
  },
});
