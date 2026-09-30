import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/storage/page';

/**
 * /settings/storage — the owner storage control surface
 * (storage-settings-page-2026-06-15 P-002). Client page re-exported via the
 * page-import pattern.
 */
export const Route = createFileRoute('/settings/storage')({
  component: Page,
});
