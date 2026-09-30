import AdminShell from '../_components/AdminShell';
import DbosClient from './DbosClient';

/**
 * /admin DBOS tab (dbos-durable-jobs-2026-05-31, P-007) — durable-job +
 * workflow status backed by a local query over the `dbos.*` system schema.
 * Loopback-only like the rest of /admin; not flag-gated (admin surfaces are
 * reachable by URL only).
 */
export default function AdminDbosPage() {
  return (
    <AdminShell title="DBOS">
      <DbosClient />
    </AdminShell>
  );
}
