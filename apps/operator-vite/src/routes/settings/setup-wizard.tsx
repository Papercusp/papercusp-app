import { createFileRoute } from '@tanstack/react-router';
import { SetupWizard } from '@/app/_components/SetupWizard/SetupWizard';

/**
 * /settings/setup-wizard — the Setup Wizard in "settings" mode. Translated
 * from `apps/operator/app/settings/setup-wizard/page.tsx`. SetupWizard's
 * `useRouter` (next/navigation) resolves via the shim.
 */
export const Route = createFileRoute('/settings/setup-wizard')({
  component: SettingsSetupWizardPage,
});

function SettingsSetupWizardPage() {
  return <SetupWizard mode="settings" />;
}
