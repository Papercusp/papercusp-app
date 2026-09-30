import Chromeless from '../_components/Chromeless';
import { SetupWizard } from '../_components/SetupWizard/SetupWizard';

export const metadata = {
  title: 'Setup · Papercusp',
};

/**
 * First-run setup wizard.
 *
 * `/setup` is now a stable, user-entered setup surface: it always renders the
 * wizard landing screen when no step is selected. Deep links like
 * `?step=workspace` still jump straight into that step.
 */
export default function SetupPage() {
  return (
    <div className="pc-shell pc-setup-shell">
      <Chromeless />
      <SetupWizard mode="first-run" />
    </div>
  );
}
