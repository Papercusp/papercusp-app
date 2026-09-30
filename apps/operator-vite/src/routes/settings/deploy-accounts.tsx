import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/deploy-accounts/page';

/**
 * /settings/deploy-accounts — the provider account pool used by inference gateway
 * routing: Claude Max accounts for Anthropic-compatible fleet egress, and Codex
 * accounts for the OpenAI-compatible Codex route. Moved here from the /admin tabs;
 * the /settings layout supplies the surrounding chrome. Client page; re-exported
 * via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/deploy-accounts')({
  component: Page,
});
