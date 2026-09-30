import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import TasksClient from '@/app/admin/tasks/TasksClient';

/**
 * /admin/tasks — the Task Manager: every task this operator launched, with the
 * provenance a process table cannot give (task-manager-no-escape-2026-07-27, P-018).
 *
 * Thin composition, exactly like /admin/schedules — which is its sibling by design:
 * that page inventories everything RECURRING, this one everything RUNNING. Reuses
 * `TasksClient` (which reads the `taskManager.inventory` sync query) via the
 * `@/app` alias inside the operator-vite AdminShell the live Tauri shell renders.
 */
export const Route = createFileRoute('/admin/tasks')({
  component: TasksPage,
});

function TasksPage() {
  return (
    <AdminShell title="Tasks">
      <TasksClient />
    </AdminShell>
  );
}
