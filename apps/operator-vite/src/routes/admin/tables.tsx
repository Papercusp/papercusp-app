import { createFileRoute } from '@tanstack/react-router';
import TableAdmin from '@/app/admin/_components/TableAdmin';

/**
 * /admin/tables — auto-generated CRUD UI for every drizzle table
 * registered in `lib/admin-tables.ts`. Sibling of /dev/tables (read-only
 * inspection); /admin/tables is the write surface.
 *
 * Translated from `apps/operator/app/admin/tables/page.tsx`. TableAdmin
 * is shared and clean (no next/* imports).
 */
export const Route = createFileRoute('/admin/tables')({
  component: AdminTablesPage,
});

function AdminTablesPage() {
  return <TableAdmin />;
}
