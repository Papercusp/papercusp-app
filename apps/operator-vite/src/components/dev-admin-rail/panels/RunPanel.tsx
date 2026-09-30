/**
 * Run section (P-003) — the existing /admin/run console lifted into the rail as
 * an embeddable panel. AdminOps is already self-contained (no props, fetches the
 * /api/admin/commands registry, run/stop + live SSE output per CommandCard), so
 * this just constrains it to the narrow rail (see .pcdar-embed).
 */
import AdminOps from '@/app/admin/_components/AdminOps';

export default function RunPanel() {
  return (
    <div className="pcdar-embed">
      <AdminOps />
    </div>
  );
}
