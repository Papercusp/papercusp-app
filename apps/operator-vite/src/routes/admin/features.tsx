import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import FeaturesAdmin from '@/app/admin/features/FeaturesAdmin';

/**
 * /admin/features — admin features console. Intentionally not flag-gated;
 * reachable by URL only. Translated from
 * `apps/operator/app/admin/features/page.tsx`.
 */
export const Route = createFileRoute('/admin/features')({
  component: AdminFeaturesPage,
});

function AdminFeaturesPage() {
  return (
    <AdminShell title="Features">
      <FeaturesAdmin />
    </AdminShell>
  );
}
