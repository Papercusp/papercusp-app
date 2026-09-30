import { createFileRoute } from '@tanstack/react-router';
import PluginPermissionsPage from '@/app/installed/plugins/[slug]/permissions/page';

/**
 * /installed/plugins/$slug/permissions — per-plugin capability grants.
 * Translated from `apps/operator/app/installed/plugins/[slug]/permissions/page.tsx`.
 *
 * `PluginPermissionsPage` was authored for Next 15+ async route props
 * (`{ params: Promise<{slug}> }`, unwrapped with `React.use`). TSR params
 * are synchronous; wrap with `Promise.resolve()` to preserve the
 * component's existing signature without editing it (same as B-6's
 * snapshots/$id/fork).
 */
export const Route = createFileRoute('/installed/plugins/$slug/permissions')({
  component: PluginPermissions,
});

function PluginPermissions() {
  const { slug } = Route.useParams();
  return <PluginPermissionsPage params={Promise.resolve({ slug })} />;
}
