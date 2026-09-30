/**
 * Onboarding-tutor launch-context rendering
 * (plan agent-first-onboarding-2026-07-03, P-005).
 *
 * The tutor prompt SOURCE lives at apps/operator/prompts/onboarding-tutor.md
 * (never edit rendered copies). At handoff the concierge asks
 * GET /desktop/onboarding-launch-context to render it — {{TOKEN}}s replaced
 * with live state — into ~/.papercusp/launch-context/onboarding-tutor.md,
 * then passes that path to `psu --launch-context=…` (the same wrapper
 * machinery every psu session uses).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TutorTokens {
  os: string;
  agent: string;
  workspacePath: string;
  appVersion: string;
  mode: 'first-run' | 'tutorial';
  setupStatusJson: string;
  tutorialProgressJson: string;
  /** packIndexMarkdown() over the tutorial content pack (P-012). */
  tutorialPackIndex: string;
  /** guiTabTourMarkdown() — the finale's tab-by-tab GUI tour list (P-018). */
  guiTabTour: string;
}

/** Replace every {{TOKEN}} in the template. Pure; exported for tests. */
export function renderTutorTemplate(template: string, t: TutorTokens): string {
  return template
    .replaceAll('{{OS}}', t.os)
    .replaceAll('{{CHOSEN_AGENT}}', t.agent)
    .replaceAll('{{WORKSPACE_PATH}}', t.workspacePath)
    .replaceAll('{{APP_VERSION}}', t.appVersion)
    .replaceAll('{{MODE}}', t.mode)
    .replaceAll('{{SETUP_STATUS_JSON}}', t.setupStatusJson)
    .replaceAll('{{TUTORIAL_PROGRESS_JSON}}', t.tutorialProgressJson)
    .replaceAll('{{TUTORIAL_PACK_INDEX}}', t.tutorialPackIndex)
    .replaceAll('{{GUI_TAB_TOUR}}', t.guiTabTour);
}

/**
 * Locate the prompt source from the operator's cwd (dev: apps/operator;
 * packaged sidecar keeps prompts/ next to its cwd). Same fallback-chain
 * pattern as resolveConciergeScript.
 */
export function resolveTutorPromptSource(
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const candidates = [
    `${cwd}/prompts/onboarding-tutor.md`,
    `${cwd}/../prompts/onboarding-tutor.md`,
    `${cwd}/apps/operator/prompts/onboarding-tutor.md`,
  ];
  return candidates.find((p) => exists(p)) ?? null;
}

/** Render the source file with tokens and write the launch-context copy. */
export function writeTutorLaunchContext(
  sourcePath: string,
  tokens: TutorTokens,
  home: string = homedir(),
): string {
  const rendered = renderTutorTemplate(readFileSync(sourcePath, 'utf8'), tokens);
  const dir = join(home, '.papercusp', 'launch-context');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'onboarding-tutor.md');
  writeFileSync(out, rendered, 'utf8');
  return out;
}
