import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import AdminOps from '@/app/admin/_components/AdminOps';

/**
 * /admin/run — admin runs console. Intentionally not flag-gated; reachable
 * by URL only. Translated from `apps/operator/app/admin/run/page.tsx`.
 */
export const Route = createFileRoute('/admin/run')({
  component: AdminRunPage,
});

function AdminRunPage() {
  return (
    <AdminShell title="Run">
      <AdminOps />
    </AdminShell>
  );
}
