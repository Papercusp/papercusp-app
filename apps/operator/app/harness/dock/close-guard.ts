/**
 * Close-guard seam — a generic "veto before a panel closes" registry.
 *
 * Data-agnostic + UI-agnostic: the dock consults a registered predicate
 * before removing a panel and, when the predicate says the panel is NOT
 * safe to close silently (e.g. an editor with unsaved edits), asks the
 * user via an injectable `confirm`. The dock never knows the predicate is
 * about form-dirtiness — that stays in whatever renders inside the panel.
 *
 * This replaces PlansClient's bespoke `leaveGuard()` once the Create tab
 * becomes a set of dock panels: the plan-editor panel registers
 * `() => !dirty`, and the dock's close path calls `canClosePanel`.
 *
 * Written here under app/harness/dock so it lifts cleanly into the shared
 * dock library when the dock shell itself is extracted (out of scope now).
 */

/** Returns true when the panel is safe to close WITHOUT prompting. */
export type CanCloseSilently = () => boolean | Promise<boolean>;

/** Prompt shown when a guard reports the panel is not safe to close. */
export type ConfirmClose = (panelId: string) => boolean | Promise<boolean>;

const guards = new Map<string, CanCloseSilently>();

let confirmClose: ConfirmClose = async () => false;

/** Override the confirm prompt (e.g. a project's own modal). */
export function configureCloseGuard(opts: { confirm?: ConfirmClose }): void {
  if (opts.confirm) confirmClose = opts.confirm;
}

/**
 * Register a guard for a panel. `canCloseSilently` returns true when the
 * panel can close with no prompt (e.g. not dirty). Returns an unsubscribe
 * that only removes THIS registration (idempotent across re-registers).
 */
export function registerCloseGuard(panelId: string, canCloseSilently: CanCloseSilently): () => void {
  guards.set(panelId, canCloseSilently);
  return () => {
    if (guards.get(panelId) === canCloseSilently) guards.delete(panelId);
  };
}

export function hasCloseGuard(panelId: string): boolean {
  return guards.has(panelId);
}

/**
 * Decide whether a panel may close. No guard → yes. Guard says safe → yes.
 * Guard says not-safe → defer to the confirm prompt. A throwing guard is
 * treated as "safe" (never trap the user in a panel because a predicate
 * errored).
 */
export async function canClosePanel(panelId: string): Promise<boolean> {
  const guard = guards.get(panelId);
  if (!guard) return true;
  let safe: boolean;
  try {
    safe = await guard();
  } catch {
    safe = true;
  }
  if (safe) return true;
  try {
    return await confirmClose(panelId);
  } catch {
    return false;
  }
}

/** Test-only: clear registry + restore the default confirm. */
export function _resetCloseGuardsForTests(): void {
  guards.clear();
  confirmClose = async () => false;
}
