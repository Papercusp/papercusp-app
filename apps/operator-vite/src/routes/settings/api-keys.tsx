import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/api-keys/page';

/**
 * /settings/api-keys — translated from `apps/operator/app/settings/api-keys/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/api-keys')({
  component: Page,
});
