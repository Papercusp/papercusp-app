import { createFileRoute } from '@tanstack/react-router';
import DevPage from '@/app/dev/page';

/**
 * /dev — cross-harness developer console. Translated from
 * `apps/operator/app/dev/page.tsx`. The page uses `next/dynamic` for its
 * 14 tab components; the alias shim resolves that to `React.lazy` so the
 * source file works unchanged.
 */
export const Route = createFileRoute('/dev/')({
  component: DevPage,
});
