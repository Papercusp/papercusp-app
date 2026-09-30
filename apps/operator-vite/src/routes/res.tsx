import { createFileRoute } from '@tanstack/react-router';
import ResourcesPage from '@/app/res/page';

/**
 * /res — Resources: workspace-scoped resource → fleet allocation.
 *
 * Thin TSR wrapper over the page component in `apps/operator/app/res/page.tsx`
 * (same reuse pattern as the cupboard/harness routes). The component imports
 * its own `res.css` for side-effect, so nothing else is needed here. The RES
 * nav CTA (ChromeShell, gated by FLAGS.RES_ALLOCATION) links here.
 */
export const Route = createFileRoute('/res')({
  component: ResourcesPage,
});
