import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/autonomy/page';

/**
 * /settings/autonomy — the Queen autonomy policy owner control surface
 * (queen-autonomy-policy-2026-06-13 B-15). Client page re-exported via the
 * page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/autonomy')({
  component: Page,
});
