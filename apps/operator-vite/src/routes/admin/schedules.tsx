import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import SchedulesClient from '@/app/admin/schedules/SchedulesClient';

/**
 * /admin/schedules — central read-only inventory of every scheduled/recurring
 * thing (DBOS crons, system routines, in-process sweeps), regardless of cadence
 * (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-003).
 *
 * Thin composition, exactly like /admin/dbos: reuse the self-fetching
 * `SchedulesClient` (it hits `/api/admin/schedules/inventory`) via the `@/app`
 * alias inside the operator-vite AdminShell that the live Tauri shell renders.
 */
export const Route = createFileRoute('/admin/schedules')({
  component: SchedulesPage,
});

function SchedulesPage() {
  return (
    <AdminShell title="Schedules">
      <SchedulesClient />
    </AdminShell>
  );
}
