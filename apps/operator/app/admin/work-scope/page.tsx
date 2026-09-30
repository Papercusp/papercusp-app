import AdminShell from "../_components/AdminShell";
import WorkScopeAdmin from "./WorkScopeAdmin";

/**
 * Owner-facing control for the workspace WORK-SCOPE policy — which harnesses agents may
 * be launched into or pull work from (plan workspace-work-scope-policy-2026-09-04;
 * WI-2145092 is the /admin door D-003 deferred). Reads the same status lens as
 * `state:read { cell:'workspace.workScope' }`; writes run the same audited mutation as
 * `workspace:work_scope { op:'set'|'clear' }`.
 */
export default function AdminWorkScopePage() {
  return (
    <AdminShell title="Work scope">
      <WorkScopeAdmin />
    </AdminShell>
  );
}
