import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/omp/page';

/**
 * /settings/omp — translated from `apps/operator/app/settings/omp/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/omp')({
  component: Page,
});
