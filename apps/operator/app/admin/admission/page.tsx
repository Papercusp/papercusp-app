import AdminShell from "../_components/AdminShell";
import AdmissionRunsClient from "./AdmissionRunsClient";

/** Owner-facing work-item admission run ledger and queue-health rollups. */
export default function AdminAdmissionPage() {
  return (
    <AdminShell title="Admission">
      <AdmissionRunsClient />
    </AdminShell>
  );
}
