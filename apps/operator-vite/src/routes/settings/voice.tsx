import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/voice/page';

/**
 * /settings/voice — translated from `apps/operator/app/settings/voice/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/voice')({
  component: Page,
});
