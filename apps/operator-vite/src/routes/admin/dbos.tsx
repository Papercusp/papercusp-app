import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import DbosClient from '@/app/admin/dbos/DbosClient';

/**
 * /admin/dbos — operator-vite mirror of the SSR page at
 * `apps/operator/app/admin/dbos/page.tsx` (dbos-durable-jobs-2026-05-31, P-007).
 *
 * The live Tauri shell renders operator-vite admin routes on :3070, so the Next
 * SSR page was UNREACHABLE in the desktop until this route existed (the DBOS tab
 * was wired into the Next AdminShell but the desktop loads the operator-vite one).
 * Found while live-testing via the Tauri bridge — see the agent-insight
 * `project_adv_live_in_operator_vite`. Thin composition: reuse the self-fetching
 * `DbosClient` (it hits `/api/admin/dbos/status`) via the `@/app` alias, exactly
 * like `dogfood-substrate` reuses the insights clients.
 */
export const Route = createFileRoute('/admin/dbos')({
  component: DbosPage,
});

function DbosPage() {
  return (
    <AdminShell title="DBOS">
      <DbosClient />
    </AdminShell>
  );
}
