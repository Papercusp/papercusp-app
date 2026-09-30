/**
 * Operator prompt assembly (v5).
 *
 * Composition (top-to-bottom):
 *   1. First-run intro block (only on first interaction in a workspace,
 *      gated by per-(workspace, user) marker).
 *   2. Substrate-owned `prompt-system.md` — tier table, schema, anti-patterns.
 *      Shipped with the substrate; the user CANNOT edit it from settings.
 *   3. User-editable `prompt-user.md` — voice, tone, free-form preferences.
 *   4. `preferences.md` — workspace-scoped learned preferences with
 *      provenance tags.
 *   5. The current request — typically "scan the workspace…" or a
 *      freeform user message.
 */

import { loadPreferences } from './operator-preferences';
import { OPERATOR_SUBSTRATE_PROMPT } from './operator-prompt-system';
import {
  readOperatorState,
  writeOperatorState,
} from './operator-state-pg';

const FIRST_RUN_INTRO = `\
Hi, I'm the Operator. I have full write authority across all harnesses
in this workspace and will work with you to implement your vision.

By default, any far-reaching or underspecified actions I will surface to
you before proceeding. I'll learn your preferences through our
interactions, so please correct me if I behave in a way you didn't like
so I can adjust for next time.

You can edit my voice/tone in prompt-user.md, and I keep a separate
notebook of preferences I've learned about you in this workspace. Both
are editable from my settings page (/settings/operator). My substrate
prompt (tier rules and schema) is read-only.
`;

async function readUserPromptFromPg(): Promise<string> {
  const raw = await readOperatorState<{ content?: string }>('operator_prompt_user');
  return typeof raw?.content === 'string' ? raw.content : '';
}

export interface BuildPromptArgs {
  /** The user's request, or 'scan' for an unprompted scan. */
  request: string;
  /** The active user id (used to gate the first-run intro). */
  userId: string;
  /** Force the first-run intro even if the marker already lists this user. */
  showFirstRun?: boolean;
}

export interface BuildPromptResult {
  promptText: string;
  isFirstRun: boolean;
}

export async function buildOperatorPrompt(args: BuildPromptArgs): Promise<BuildPromptResult> {
  const isFirstRun = args.showFirstRun ?? !(await hasShownFirstRunFor(args.userId));

  const systemPrompt = OPERATOR_SUBSTRATE_PROMPT;
  const userPrompt = (await readUserPromptFromPg()).trim();
  const prefs = (await loadPreferences()).raw.trim();

  const sections: string[] = [];
  if (isFirstRun) sections.push(FIRST_RUN_INTRO);
  sections.push(systemPrompt);
  if (userPrompt) sections.push(`## User-editable prompt\n\n${userPrompt}`);
  if (prefs) sections.push(`## Preferences (workspace-scoped, learned)\n\n${prefs}`);
  try {
    // Lazy-import so missing fs/path in any future client-side bundling
    // doesn't crash. Keeps the prompt compact when no markdown content exists.
    const { loadHarnessMarkdownIndex, renderHarnessMarkdownIndexForPrompt } =
      require('./harness-markdown-index') as typeof import('./harness-markdown-index');
    const indexText = renderHarnessMarkdownIndexForPrompt(loadHarnessMarkdownIndex());
    if (indexText) sections.push(indexText);
  } catch { /* index optional */ }
  sections.push(`## Request\n\n${args.request}`);

  return { promptText: sections.join('\n\n---\n\n'), isFirstRun };
}

interface FirstRunMarker {
  shownAt: string; // ISO of first time intro was shown in this workspace
  shownToUserIds: string[];
}

async function readFirstRunMarker(): Promise<FirstRunMarker | null> {
  const raw = await readOperatorState<Partial<FirstRunMarker>>('operator_first_run');
  if (!raw) return null;
  return {
    shownAt: typeof raw.shownAt === 'string' ? raw.shownAt : new Date().toISOString(),
    shownToUserIds: Array.isArray(raw.shownToUserIds) ? raw.shownToUserIds.filter((u) => typeof u === 'string') : [],
  };
}

export async function hasShownFirstRunFor(userId: string): Promise<boolean> {
  const marker = await readFirstRunMarker();
  return !!marker && marker.shownToUserIds.includes(userId);
}

/** Mark first-run as shown for the given user. Idempotent. */
export async function markFirstRunShown(userId: string): Promise<void> {
  const existing = await readFirstRunMarker();
  const next: FirstRunMarker = existing
    ? {
        shownAt: existing.shownAt,
        shownToUserIds: existing.shownToUserIds.includes(userId)
          ? existing.shownToUserIds
          : [...existing.shownToUserIds, userId],
      }
    : { shownAt: new Date().toISOString(), shownToUserIds: [userId] };
  await writeOperatorState('operator_first_run', next);
}
