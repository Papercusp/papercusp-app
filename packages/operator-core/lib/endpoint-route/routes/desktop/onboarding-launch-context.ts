/**
 * GET /api/desktop/onboarding-launch-context — render the onboarding-tutor
 * prompt with live state and return the launch-context file path the
 * concierge passes to `psu --launch-context=…`
 * (plan agent-first-onboarding-2026-07-03, P-005).
 *
 * Query: ?agent=<claude|codex|omp> (required) · ?mode=<first-run|tutorial>
 * (default first-run).
 */
import { platform } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import { collectSetupStatus } from './setup-status';
import type { SetupWizardState } from './setup-wizard-state';
import { readOperatorState } from '../../../operator-state-pg';
import { activeWorkspaceId, workspaceDir } from '../../../workspace-registry';
import {
  resolveTutorPromptSource,
  writeTutorLaunchContext,
} from '../../../onboarding/launch-context';
import {
  loadTutorialPack,
  packIndexMarkdown,
  resolvePackRoot,
} from '../../../onboarding/tutorial-pack';
import { guiTabTourMarkdown } from '../../../onboarding/gui-tab-tour';

const AGENTS = new Set(['claude', 'codex', 'omp']);

export default defineTool({
  method: 'GET',
  path: '/desktop/onboarding-launch-context',
  auth: {},
  async handler(req: Request) {
    const q = new URL(req.url).searchParams;
    const agent = q.get('agent') ?? '';
    if (!AGENTS.has(agent)) {
      return Response.json({ error: `agent must be one of ${[...AGENTS].join('|')}` }, { status: 400 });
    }
    const mode = q.get('mode') === 'tutorial' ? 'tutorial' : 'first-run';

    const source = resolveTutorPromptSource();
    if (!source) {
      return Response.json({ error: 'onboarding-tutor.md prompt source not found' }, { status: 500 });
    }

    // Tutorial progress lives INSIDE setup_wizard_state (P-012 — reuse-first;
    // a bare 'tutorial_progress' StateTable does not exist and never did).
    const [status, wizard] = await Promise.all([
      collectSetupStatus().catch(() => null),
      readOperatorState<SetupWizardState>('setup_wizard_state').catch(() => null),
    ]);

    let workspacePath = '';
    try {
      workspacePath = workspaceDir(activeWorkspaceId());
    } catch {
      /* fresh installs may have no workspace yet */
    }

    // Content-pack index (P-012). A broken pack must not break onboarding —
    // fall back to the docs:search-grounded path with an honest note.
    let tutorialPackIndex: string;
    try {
      const packRoot = resolvePackRoot();
      tutorialPackIndex = packIndexMarkdown(packRoot ? loadTutorialPack(packRoot) : []);
    } catch (e) {
      tutorialPackIndex = `(tutorial content pack failed to load: ${
        e instanceof Error ? e.message : String(e)
      } — ground sections with \`docs:search\` instead)`;
    }

    const path = writeTutorLaunchContext(source, {
      os: platform(),
      agent,
      workspacePath,
      appVersion: process.env.npm_package_version ?? process.env.PAPERCUSP_VERSION ?? 'dev',
      mode,
      setupStatusJson: JSON.stringify(status ?? {}, null, 2),
      tutorialProgressJson: JSON.stringify(wizard?.tutorial_progress ?? {}, null, 2),
      tutorialPackIndex,
      guiTabTour: guiTabTourMarkdown(),
    });
    return Response.json({ path, mode, agent });
  },
});
