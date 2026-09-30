import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/personal-vault/page';

/** Owner-local Personal Vault import, privacy, purge, and grant controls. */
export const Route = createFileRoute('/settings/personal-vault')({
  component: Page,
});
