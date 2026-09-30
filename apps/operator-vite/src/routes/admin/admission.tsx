import { createFileRoute } from "@tanstack/react-router";
import AdmissionRunsClient from "@/app/admin/admission/AdmissionRunsClient";
import AdminShell from "../../components/admin/AdminShell";

/**
 * /admin/admission — the existing owner-facing admission/readiness ledger in
 * the desktop SPA. The Next-style page alone is not a Tauri route; keep this
 * wrapper thin so both shells consume the same client and sync contract.
 */
export const Route = createFileRoute("/admin/admission")({
  component: AdminAdmissionPage,
});

function AdminAdmissionPage() {
  return (
    <AdminShell title="Admission">
      <AdmissionRunsClient />
    </AdminShell>
  );
}
