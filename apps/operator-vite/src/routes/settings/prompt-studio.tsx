import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/prompt-studio/page';

/**
 * /settings/prompt-studio — the Prompt Studio: edit the renderSuPlaybook SOURCES
 * (base playbooks / per-client overlays / project guide) with a live assembled-prompt
 * preview (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-011). Flag-gated
 * (PROMPT_STUDIO) in the settings nav; the /api/prompt-studio/* routes are gated on the
 * same flag. Client page; re-exported via the page-import pattern.
 */
export const Route = createFileRoute('/settings/prompt-studio')({
  component: Page,
});
