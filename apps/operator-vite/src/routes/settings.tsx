import { createFileRoute, Outlet } from '@tanstack/react-router';
import SettingsLayout from '@/app/settings/layout';

/**
 * /settings layout — translated from `apps/operator/app/settings/layout.tsx`.
 *
 * `SettingsLayout` is a `'use client'` component taking `{ children }`; we
 * pass TSR's `<Outlet/>` as the children. It uses `usePathname`
 * (next/navigation → shim) and `useTransitionRouter` (next-transition-router,
 * already proven in the build graph via `RouteTransitionProvider` in
 * `__root.tsx`). No edit to the shared layout needed.
 */
export const Route = createFileRoute('/settings')({
  component: SettingsLayoutRoute,
});

function SettingsLayoutRoute() {
  return (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  );
}
