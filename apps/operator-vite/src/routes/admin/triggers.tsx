import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import TriggersClient from '@/app/admin/triggers/TriggersClient';

/**
 * /admin/triggers — owner-local external-trigger control in the desktop SPA.
 * Reuse the canonical client and its API/model directly; the Vite root already
 * provides the TanStack nuqs adapter that backs its URL state.
 */
export const Route = createFileRoute('/admin/triggers')({
  component: AdminTriggersPage,
});

function AdminTriggersPage() {
  return (
    <AdminShell title="Triggers">
      <TriggersClient />
    </AdminShell>
  );
}
