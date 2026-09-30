/**
 * Shared accessor for the per-install UUID stored on
 * `setup_wizard_state.install_id`. Lazy-minted on first read so any
 * route can call this and get a stable id back, regardless of whether
 * the wizard has been opened yet.
 *
 * Used by:
 *   - GET /api/desktop/setup-wizard-state — surfaces install_id in the
 *     returned state object.
 *   - GET /api/desktop/telemetry-config — used as PostHog distinct_id.
 *   - lib/telemetry-flush.ts — used as PostHog distinct_id for
 *     server-side capture.
 *
 * The mint races safely: two concurrent first-call paths might both
 * generate a UUID, but whichever PG write lands second wins, and from
 * then on every reader sees that one. Worst case: a single transient
 * second-old UUID is in flight for one event.
 */
import { randomUUID } from 'node:crypto';
import { readOperatorState, writeOperatorState } from './operator-state-pg';

interface MinimalWizardState {
  install_id?: string;
  updated_at?: string;
  [k: string]: unknown;
}

const KEY = 'setup_wizard_state';

export async function ensureInstallId(): Promise<string> {
  const state = ((await readOperatorState<MinimalWizardState>(KEY)) ?? {}) as MinimalWizardState;
  if (state.install_id) return state.install_id;
  const minted = randomUUID();
  state.install_id = minted;
  state.updated_at = new Date().toISOString();
  // Preserve step_status shape so PATCH consumers don't observe a
  // missing field — readOperatorState returned an empty object so we
  // need to add it ourselves.
  if (!('step_status' in state)) (state as { step_status: unknown }).step_status = {};
  await writeOperatorState(KEY, state);
  return minted;
}
