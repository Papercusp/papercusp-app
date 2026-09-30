import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/backups/page';

/**
 * /settings/backups — translated from `apps/operator/app/settings/backups/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/backups')({
  component: Page,
});
