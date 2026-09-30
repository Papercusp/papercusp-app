/**
 * GET  /api/desktop/setup-wizard-state — read the Setup Wizard state.
 * PATCH /api/desktop/setup-wizard-state — merge-update it.
 *
 * Ported from app/api/desktop/setup-wizard-state/route.ts. `auth: {}` —
 * the route's prior `gatePrincipal` helper is gone; the route-stack
 * runs the gate.
 */
import { readOperatorState, writeOperatorState } from '../../../operator-state-pg';
import { ensureInstallId } from '../../../setup-wizard-install-id';
import { defineTool } from '@papercusp/agent-mcp';

const KEY = 'setup_wizard_state';

/**
 * The update LANE a user has chosen — deliberately excludes `nightly`, which is
 * a side-by-side install (own bundle id, own data home) rather than a lane this
 * app can switch to. Persisting it here would feed `resolveChannel`, which
 * refuses it for the same reason.
 */
export type UpdateChannel = 'alpha' | 'beta' | 'stable';

/** Onboarding-tutor progress (agent-first-onboarding-2026-07-03 P-012/P-013).
 *  Lives INSIDE setup_wizard_state (reuse-first: no parallel table) — written
 *  by the tutor via `setup:set_tutorial_progress`, read at handoff by
 *  /desktop/onboarding-launch-context to resume a re-opened tutorial. */
export interface TutorialProgress {
  /** Pack section id (e.g. `ch2-01-plans`) the tutorial last delivered. */
  last_section_id?: string;
  completed_ids?: string[];
  updated_at?: string;
}

export interface SetupWizardState {
  step_status: Record<string, 'dismissed' | 'completed'>;
  last_visited_step?: string;
  finished_at?: string;
  update_channel?: UpdateChannel;
  telemetry_enabled?: boolean;
  install_id?: string;
  /** macOS-only client-side probe result. The server can't read TCC
   *  from Node, so StepOsPermissions PATCHes this when its
   *  navigator.permissions probes return granted. Read by setup-status
   *  to drive the sidebar's os-permissions badge on darwin. */
  os_permissions_ok?: boolean;
  tutorial_progress?: TutorialProgress;
  updated_at?: string;
}

const ALLOWED_STATUSES = new Set(['dismissed', 'completed']);
const ALLOWED_CHANNELS = new Set<UpdateChannel>(['alpha', 'beta', 'stable']);

function defaults(): SetupWizardState {
  return { step_status: {} };
}

const get = defineTool({
  method: 'GET',
  path: '/desktop/setup-wizard-state',
  auth: {},
  async handler() {
    // Mint install_id if missing — shared with telemetry-config so the
    // first event after a fresh boot always has a stable distinct id.
    await ensureInstallId();
    const state = (await readOperatorState<SetupWizardState>(KEY)) ?? defaults();
    return Response.json(state);
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/desktop/setup-wizard-state',
  auth: {},
  async handler(req) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'invalid body' }, { status: 400 });
    }
    return Response.json(await mergeSetupWizardState(body as Record<string, unknown>));
  },
});

/**
 * Validated merge-write of the Setup Wizard state — the ONE write path,
 * shared by the PATCH route above and the `setup:*` agent tools
 * (agent-first-onboarding-2026-07-03 P-004), so both surfaces keep identical
 * validation + merge semantics. Unknown keys are ignored; `null` deletes
 * where supported (finished_at, step_status entries).
 */
export async function mergeSetupWizardState(
  body: Record<string, unknown>,
): Promise<SetupWizardState> {
  const current = (await readOperatorState<SetupWizardState>(KEY)) ?? defaults();
  const next: SetupWizardState = { ...current };

  if (typeof body.last_visited_step === 'string') {
    next.last_visited_step = body.last_visited_step;
  }
  if (body.finished_at === null) {
    delete next.finished_at;
  } else if (typeof body.finished_at === 'string') {
    next.finished_at = body.finished_at;
  }
  if (typeof body.update_channel === 'string' && ALLOWED_CHANNELS.has(body.update_channel as UpdateChannel)) {
    next.update_channel = body.update_channel as UpdateChannel;
  }
  if (typeof body.telemetry_enabled === 'boolean') {
    next.telemetry_enabled = body.telemetry_enabled;
  }
  if (typeof body.os_permissions_ok === 'boolean') {
    next.os_permissions_ok = body.os_permissions_ok;
  }
  if (body.tutorial_progress === null) {
    delete next.tutorial_progress;
  } else if (body.tutorial_progress && typeof body.tutorial_progress === 'object') {
    const tp = body.tutorial_progress as Record<string, unknown>;
    const merged: TutorialProgress = { ...current.tutorial_progress };
    if (typeof tp.last_section_id === 'string') merged.last_section_id = tp.last_section_id;
    if (Array.isArray(tp.completed_ids) && tp.completed_ids.every((x) => typeof x === 'string')) {
      merged.completed_ids = tp.completed_ids as string[];
    }
    merged.updated_at = new Date().toISOString();
    next.tutorial_progress = merged;
  }
  if (body.step_status && typeof body.step_status === 'object') {
    const merged = { ...current.step_status };
    for (const [k, v] of Object.entries(body.step_status as Record<string, unknown>)) {
      if (v === null) {
        delete merged[k];
        continue;
      }
      if (typeof v === 'string' && ALLOWED_STATUSES.has(v)) {
        merged[k] = v as 'dismissed' | 'completed';
      }
    }
    next.step_status = merged;
  }
  next.updated_at = new Date().toISOString();
  await writeOperatorState(KEY, next);
  return next;
}

export default [get, patch];
