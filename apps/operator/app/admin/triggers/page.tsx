import AdminShell from "../_components/AdminShell";
import TriggersClient from "./TriggersClient";

export default function AdminTriggersPage() {
  return (
    <AdminShell title="Triggers">
      <TriggersClient />
    </AdminShell>
  );
}
