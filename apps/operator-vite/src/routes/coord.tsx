import { createFileRoute } from '@tanstack/react-router';
import CoordDashboard from '@/app/coord/CoordDashboard';

/**
 * /coord — multi-agent coordination dashboard. Translated from
 * `apps/operator/app/coord/page.tsx`. CoordDashboard is shared and clean.
 */
export const Route = createFileRoute('/coord')({
  component: CoordPage,
});

function CoordPage() {
  return <CoordDashboard />;
}
