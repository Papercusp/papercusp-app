import AdminShell from '../admin/AdminShell';
import PlansClient from '@/app/admin/plans/PlansClient';
import '@/app/admin/plans/plans.css';

/**
 * `/admin/plans` page body, split out of `routes/admin/plans.tsx` (WI-5502
 * item 2) — see `DevLayoutContent`'s comment for why the bare `plans.css`
 * side-effect import needs a real dynamic-import boundary to stop it being
 * modulepreloaded on every first paint. Same `AdminShell` + `PlansClient`
 * wiring as before; only the location (and therefore the load timing) of
 * the CSS import changed.
 */
export default function AdminPlansPageContent() {
  return (
    <AdminShell title="Plans">
      <PlansClient />
    </AdminShell>
  );
}
