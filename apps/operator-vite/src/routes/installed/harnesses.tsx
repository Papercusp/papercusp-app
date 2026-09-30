import { createFileRoute } from '@tanstack/react-router';
import InstalledHarnessesPage from '@/app/installed/harnesses/page';

/**
 * /installed/harnesses — locally-installed harnesses. Translated from
 * `apps/operator/app/installed/harnesses/page.tsx` ('use client', clean).
 */
export const Route = createFileRoute('/installed/harnesses')({
  component: InstalledHarnessesPage,
});
