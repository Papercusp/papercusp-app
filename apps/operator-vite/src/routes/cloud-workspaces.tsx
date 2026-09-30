import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/cloud-workspaces/page';

/**
 * /cloud-workspaces — local, provider-neutral BYOC workspace control.
 * The page stays in apps/operator/app so every shell consumes one component;
 * this file is only the live Vite/TanStack route bridge.
 */
export const Route = createFileRoute('/cloud-workspaces')({
  component: Page,
});
