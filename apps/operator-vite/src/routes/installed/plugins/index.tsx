import { createFileRoute } from '@tanstack/react-router';
import InstalledPluginsPage from '@/app/installed/plugins/page';

/**
 * /installed/plugins — installed-plugins manager. Translated from
 * `apps/operator/app/installed/plugins/page.tsx` ('use client', clean).
 */
export const Route = createFileRoute('/installed/plugins/')({
  component: InstalledPluginsPage,
});
