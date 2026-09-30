import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import GitClient from '../../components/admin/GitClient';

/**
 * /admin/git — the git-sync → green-checkpoint → release pipeline console.
 * Routine schedules, windowed stats (merge conflicts, resolver success, main-green
 * rate), current state, the deploy gap, and a recent event timeline. Reads the
 * `dev.gitPipeline` sync query (backed by harness_shared.pipeline_events, mig 177).
 */
export const Route = createFileRoute('/admin/git')({
  component: AdminGitPage,
});

function AdminGitPage() {
  return (
    <AdminShell title="Git pipeline">
      <GitClient />
    </AdminShell>
  );
}
