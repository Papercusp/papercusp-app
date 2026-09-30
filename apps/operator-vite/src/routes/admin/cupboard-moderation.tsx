import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import CupboardModerationClient from '@/app/admin/cupboard-moderation/CupboardModerationClient';
import { useLexicon } from '@/lib/useLexicon';

/**
 * /admin/cupboard-moderation — operator moderation surface for the Cupboard
 * registry (Phase 9 D-002). The live Tauri shell renders operator-vite admin
 * routes on :3070; this is the reachable home for the abuse-report queue +
 * takedown actions. Thin composition: reuse the self-fetching
 * `CupboardModerationClient` (it hits `/api/cupboard/admin/*`, which proxies to
 * the Cupboard worker with the maintainer's gh-token added server-side) via the
 * `@/app` alias — exactly like `dbos` reuses `DbosClient`.
 */
export const Route = createFileRoute('/admin/cupboard-moderation')({
  component: CupboardModerationPage,
});

function CupboardModerationPage() {
  const t = useLexicon();
  return (
    <AdminShell title={t('cupboard')}>
      <CupboardModerationClient />
    </AdminShell>
  );
}
