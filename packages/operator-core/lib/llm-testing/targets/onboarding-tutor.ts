/**
 * `onboarding-tutor` ChatTarget — in-process behavioral SUT for the
 * ONBOARDING TUTOR launch context (agent-first-onboarding-2026-07-03 P-008).
 *
 * The tutor is not an HTTP chat role: it's a psu-style session launched with
 * a RENDERED apps/operator/prompts/onboarding-tutor.md as its launch context
 * (see lib/onboarding/launch-context.ts). Same D-001 shape as the `su`
 * target, so this is a thin SuTarget instantiation: the system prompt is the
 * REAL tutor source rendered with hermetic tokens (the real content-pack
 * index + the real GUI tab tour — both filesystem/pure), and the tool
 * catalog is the small surface the tutor prompt actually names (setup:*,
 * docs:*, ui:*). Tool results come from the framework's dispatch-override
 * stub — the scenarios measure protocol adherence + tool selection, not
 * results.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTutorTemplate } from '../../onboarding/launch-context';
import { loadTutorialPack, packIndexMarkdown, resolvePackRoot } from '../../onboarding/tutorial-pack';
import { guiTabTourMarkdown } from '../../onboarding/gui-tab-tour';
import { SuTarget } from './su';
import { buildCatalog, SU_CATALOG, type SuCatalogEntry } from './su-catalog';

/** Behaviors under test (mirrors the su target's BEHAVIORS list shape). */
const TUTOR_BEHAVIORS = [
  'section-protocol',
  'progress-checkpointing',
  'question-detour-return',
  'verify-before-claim',
];

const obj = (
  props: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: 'object', properties: props, required });

/** The setup/ui tools the tutor prompt names (not in SU_CATALOG). */
const TUTOR_ONLY_TOOLS: ReadonlyArray<SuCatalogEntry> = [
  {
    name: 'setup:status',
    description:
      'The onboarding/setup state: per-step statuses (llm auth, git identity, telemetry, update channel) + setupFinished. Re-read before trusting any handoff snapshot.',
    input: obj({}),
  },
  {
    name: 'setup:save_key',
    description: 'Save an LLM provider API key the user pasted (llm auth step).',
    input: obj({ provider: { type: 'string' }, key: { type: 'string' } }, ['provider', 'key']),
  },
  {
    name: 'setup:set_git_identity',
    description: 'Set the git author identity (name + email) for the workspace.',
    input: obj({ name: { type: 'string' }, email: { type: 'string' } }, ['name', 'email']),
  },
  {
    name: 'setup:set_telemetry',
    description: 'Record the user\'s telemetry opt-in/out choice.',
    input: obj({ enabled: { type: 'boolean' } }, ['enabled']),
  },
  {
    name: 'setup:set_update_channel',
    description: 'Pick the update channel (alpha = freshest, stable = calmest).',
    input: obj({ channel: { type: 'string', enum: ['alpha', 'stable'] } }, ['channel']),
  },
  {
    name: 'setup:complete',
    description: 'Mark first-run setup finished (flips setupFinished).',
    input: obj({}),
  },
  {
    name: 'setup:set_tutorial_progress',
    description:
      'Checkpoint tutorial progress as you go: { last_section_id, completed_ids } merges; { clear: true } erases (fresh restart).',
    input: obj({
      last_section_id: { type: 'string' },
      completed_ids: { type: 'array', items: { type: 'string' } },
      clear: { type: 'boolean' },
    }),
  },
  {
    name: 'ui:get_state',
    description: 'Read the GUI tab/window state (URL params) before acting on it.',
    input: obj({}),
  },
  {
    name: 'ui:dispatch',
    description:
      "Drive the GUI window. Built-in intents: set_url ({path?:'/route', params:{...}}), snapshot, read_visible_text, focus, scroll_into_view, click.",
    input: obj(
      {
        intent: { type: 'string' },
        args: { type: 'object' },
      },
      ['intent'],
    ),
  },
];

/** docs:* reused verbatim from the su catalog (same live surface). */
const TUTOR_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  ...SU_CATALOG.filter((e) => e.name === 'docs:get' || e.name === 'docs:search'),
  ...TUTOR_ONLY_TOOLS,
];

export function resolveTutorSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/operator-core/lib/llm-testing/targets → repo root (5 up)
  return join(here, '..', '..', '..', '..', '..', 'apps', 'operator', 'prompts', 'onboarding-tutor.md');
}

/**
 * Render the REAL tutor source with hermetic tokens: the real pack index
 * (filesystem-only), the real GUI tab tour (pure), and a plausible
 * finished-setup fixture. Exported for the target's unit test.
 */
export function loadTutorPrompt(mode: 'first-run' | 'tutorial' = 'first-run'): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const packRoot = resolvePackRoot(join(repoRoot, 'apps', 'operator'));
  return renderTutorTemplate(readFileSync(resolveTutorSourcePath(), 'utf8'), {
    os: 'linux',
    agent: 'claude',
    workspacePath: '/home/user/.papercusp-workspaces/ws-1',
    appVersion: 'llm-test',
    mode,
    setupStatusJson: JSON.stringify(
      {
        statuses: { llm_auth: 'done', git_identity: 'done', telemetry: 'done', update_channel: 'done' },
        setupFinished: mode === 'tutorial',
      },
      null,
      2,
    ),
    tutorialProgressJson: '{}',
    tutorialPackIndex: packIndexMarkdown(packRoot ? loadTutorialPack(packRoot) : []),
    guiTabTour: guiTabTourMarkdown(),
  });
}

const TUTOR_FRAMING =
  'You are the Papercusp onboarding tutor (a `psu`-launched session). ' +
  'The following is your launch context — follow it exactly.\n\n';

/** Factory registered in targets/index.ts. */
export function onboardingTutorTarget(): SuTarget {
  return new SuTarget({
    id: 'onboarding-tutor',
    behaviors: [...TUTOR_BEHAVIORS],
    catalog: buildCatalog(TUTOR_CATALOG),
    loadSystemPrompt: () => TUTOR_FRAMING + loadTutorPrompt(),
  });
}
