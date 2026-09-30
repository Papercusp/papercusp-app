import { redirect } from '@/lib/router-compat/navigation';
import { readOperatorState } from '@papercusp/operator-core/lib/operator-state-pg';

/**
 * Root page — gateways the desktop's first-run experience.
 *
 *   - If the Setup Wizard has never been finished (no `finished_at` on
 *     `setup_wizard_state`), redirect to `/setup` so the user lands on
 *     the wizard rather than an empty `/harness`.
 *   - Otherwise, fall through to the operator's main surface at
 *     `/harness`.
 *
 * The check is async + cheap (single PG read on a single-row table).
 * Once `finished_at` is set the wizard never reappears unless the user
 * explicitly opens `/setup?force=1` or visits `/settings/setup-wizard`.
 */
export default async function Page() {
  const state = await readOperatorState<{ finished_at?: string }>('setup_wizard_state');
  if (!state?.finished_at) redirect('/setup');
  redirect('/adv?tab=harnesses');
}
