/**
 * policy-view.ts — the OWNER-SURFACE view of a category policy
 * (queen-autonomy-policy-2026-06-13 B-15 / P-030).
 *
 * The settings page (and the `autonomy.policy` sync resolver that feeds it) render
 * each category with its DISPLAY metadata — label, protected flag, default-posture
 * hint, and the human-driving actions it covers — alongside the stored policy and
 * the derived effective ceiling. {@link ./categories} stays the single source of
 * truth for that metadata (D-009); this decorator merges it onto a policy row so
 * the client needs NO operator-core import — it renders purely from the payload.
 *
 * Shared by the read path (resolver) and the write path's response
 * ({@link ../endpoint-route/routes/agent-mcp/autonomy-policy-set}) so both hand the
 * client one shape. Pure — no DB, no IO.
 */
import type { AutonomyCeiling } from '@papercusp/plan-parser';
import { type SuggestedPosture, getCategory } from './categories';
import { type AutonomyCategoryPolicy, effectiveCeiling } from './policy';

/** A stored policy row decorated with its derived effective ceiling + display metadata. */
export interface AutonomyPolicyView extends AutonomyCategoryPolicy {
  /** D-004's `min(ceiling, graduated)` with `locked` ⇒ `never-auto` — what actually applies. */
  effectiveCeiling: AutonomyCeiling;
  /** Human label (categories.ts / D-009). */
  label: string;
  /**
   * The category is in the never-auto PROTECTED set (D-005) — a static attribute,
   * distinct from the row's stored `locked` flag (which the owner can toggle). The
   * UI shows the badge + guards an unlock from this; the gate treats `locked` as
   * the live state.
   */
  protected: boolean;
  /** D-009 default-posture hint for the owner surface (NOT the shipped default). */
  suggestedPosture: SuggestedPosture;
  /** The human-driving actions this category covers (D-009 prose). */
  covers: string;
}

/**
 * Decorate a stored policy row with its derived effective ceiling + the category's
 * display metadata. Falls back to id-as-label / unprotected for an unknown category
 * (defensive; `readAutonomyPolicy` only ever yields canonical ids).
 */
export function decoratePolicyForView(p: AutonomyCategoryPolicy): AutonomyPolicyView {
  const def = getCategory(p.category);
  return {
    ...p,
    effectiveCeiling: effectiveCeiling(p),
    label: def?.label ?? p.category,
    protected: def?.protected ?? false,
    suggestedPosture: def?.suggestedPosture ?? 'mixed',
    covers: def?.covers ?? '',
  };
}
