import { createFileRoute } from '@tanstack/react-router';
import DesktopWorkspacePage from '@/app/cloud-workspaces/DesktopWorkspacePage';

/**
 * /desktops — the Desktops page in the desktop app (plan
 * agent-multi-desktops-grid-2026-10-06, P-007 / D-015): "This computer" beside the
 * cloud workspaces, every agent desktop as a tile. The portal mounts the same page
 * through the `desktops` operator surface; this file is only the Vite/TanStack route
 * bridge, so both shells render one component.
 *
 *   /desktops?desktopHost=local   this computer's agent desktops
 *   /desktops?desktopHost=<id>    one cloud workspace's desktops
 */
export const Route = createFileRoute('/desktops')({
  component: DesktopWorkspacePage,
});
