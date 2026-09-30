import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /harness/$ — the per-slug dashboard routes, RETIRED
 * (design-simplification-2026-07-09 P-008, owner decision D2). The dock shell,
 * insights page, and projects pages that lived at `/harness/<slug>[/...]` moved
 * to `_retired/harness-dashboard/`; `/adv` is the harness surface.
 *
 * This splat is a translating redirect so old links, bookmarks, and toasts keep
 * working:
 *   - `/harness/<slug>`            → `/adv?tab=harnesses&slug=<slug>`
 *   - `/harness/<slug>/insights`   → `/adv?tab=insights&slug=<slug>`
 *   - `/harness/<slug>/projects/*` → `/adv?tab=harnesses&slug=<slug>` (no /adv
 *     parity for the projects detail pages; the harnesses workspace is the
 *     closest landing)
 */
const SUBPATH_TO_TAB: Record<string, string> = {
  insights: 'insights',
};

export const Route = createFileRoute('/harness/$')({
  beforeLoad: ({ params }) => {
    const parts = ((params as { _splat?: string })._splat ?? '')
      .split('/')
      .filter(Boolean);
    const slug = parts[0];
    const tab = (parts[1] && SUBPATH_TO_TAB[parts[1]]) || 'harnesses';
    throw redirect({
      to: '/adv',
      search: slug ? { tab, slug } : { tab },
    });
  },
});
