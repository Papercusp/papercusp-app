import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import DesignDashboard from '@/app/design/[slug]/DesignDashboard';

/**
 * /design/$slug — per-harness design tab. Translated from
 * `apps/operator/app/design/[slug]/page.tsx`.
 *
 * The original wrapped `DesignDashboard` in a server-only
 * `await requireFlag(FLAGS.DESIGN)`. Ported to a TSR `beforeLoad` check —
 * `lib/require-flag.ts` resolves the flag client-side via
 * `@papercusp/flags/client` and `throw notFound()`s when it is off.
 */
export const Route = createFileRoute('/design/$slug')({
  beforeLoad: () => requireFlag(FLAGS.DESIGN),
  component: DesignSlugPage,
});

function DesignSlugPage() {
  const { slug } = Route.useParams();
  return <DesignDashboard slug={slug} />;
}
