import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import WorkScopeAdmin from '@/app/admin/work-scope/WorkScopeAdmin';

/**
 * /admin/work-scope — the owner's control for the workspace WORK-SCOPE policy: which
 * harnesses agents may be launched into or pull work from (plan
 * workspace-work-scope-policy-2026-09-04; WI-2145092 is the /admin door D-003 deferred).
 *
 * Thin composition, exactly like /admin/tasks: reuse `WorkScopeAdmin` (reads the
 * `workScope.policy` sync query — the same status lens `state:read { cell:
 * 'workspace.workScope' }` answers with — and writes through POST /api/work-scope/set|clear,
 * the same audited mutation as `workspace:work_scope`) via the `@/app` alias inside the
 * operator-vite AdminShell the live Tauri shell renders. The page under
 * `apps/operator/app/admin/work-scope/` is the retired-Next twin; THIS file is what makes
 * the pane reachable in the desktop (EI-46 is the class: a Next page + Next tab with no
 * Vite route renders the SPA fallback).
 */
export const Route = createFileRoute('/admin/work-scope')({
  component: WorkScopePage,
});

function WorkScopePage() {
  return (
    <AdminShell title="Work scope">
      <WorkScopeAdmin />
    </AdminShell>
  );
}
