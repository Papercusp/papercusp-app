import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/mobile/page';

/**
 * /settings/mobile — translated from `apps/operator/app/settings/mobile/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/mobile')({
  component: Page,
});
