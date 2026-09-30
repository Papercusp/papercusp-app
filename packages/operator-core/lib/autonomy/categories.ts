/**
 * categories.ts — the CANONICAL Queen-autonomy category taxonomy
 * (queen-autonomy-policy-2026-06-13 B-04 / P-020, taxonomy half; ratified D-009).
 *
 * The autonomy model has THREE orthogonal axes — risk · reversibility · authority
 * ({@link ../harness/improvements/reversibility} owns reversibility; `policy.ts`
 * owns risk; B-01 owns authority) — composed by ONE per-category control: the
 * owner sets a per-category risk **ceiling** (D-003: category is the primary
 * axis; "humans delegate by domain first, risk second"). THIS module is the
 * single source of truth for that category set.
 *
 * ── One source of truth (the shared seam) ───────────────────────────────────
 * Three consumers resolve TO these exact ids and would silently break if they
 * diverged, so they all import from here — none re-declares the list:
 *   • B-03's `autonomy_policy` store seeds + keys its per-category ceiling rows
 *     on {@link AUTONOMY_CATEGORY_IDS} ({@link PROTECTED_CATEGORIES} → locked-zero).
 *   • B-04's {@link ../autonomy/capability-category-map} resolves a tool/verb to
 *     one of these ids.
 *   • B-12's gate + the P-090 coverage invariant assert every human-driving
 *     action maps to a member of this set.
 *
 * ── Default posture vs. the shipped default ceiling ─────────────────────────
 * {@link CategoryDef.suggestedPosture} is the D-009 "default posture" column — a
 * HINT for the owner control surface (B-15) about where a category is *expected*
 * to start once arming begins. It is NOT the shipped default: per D-007 the
 * migration ships behavior-neutral with EVERY category's ceiling at never-auto,
 * so autonomy widens only when the owner deliberately lowers a ceiling (after the
 * P-092 arming gate). The PROTECTED four are locked at never-auto and can never
 * graduate above it (D-005), so their posture is permanent, not a starting point.
 *
 * Pure data + pure predicates — no DB, no IO.
 */

/** Hint for the owner control surface (B-15): where a category is expected to
 *  start once arming begins. NOT the shipped default (every ceiling ships
 *  never-auto, D-007). `protected` = locked at never-auto, never graduates. */
export type SuggestedPosture =
  | 'early-autonomy'
  | 'low-risk'
  | 'risk-graded'
  | 'mixed'
  | 'protected';

/**
 * The 14-category partition of the human-driving action surface (D-009; +schedule-arm,
 * scheduled-recurring-plans-2026-06-16 D-017). Every
 * action a human takes to drive the system maps to exactly one of these via the
 * tool/verb it uses ({@link ../autonomy/capability-category-map}).
 */
export type AutonomyCategory =
  | 'inbox-triage'
  | 'escalations'
  | 'plan-governance'
  | 'work-prioritization'
  | 'ideation-intake'
  | 'implementation'
  | 'review-merge'
  | 'release-deploy'
  | 'spend-budget'
  | 'agent-lifecycle'
  | 'credentials-auth'
  | 'knowledge-curation'
  | 'schedule-arm'
  | 'system-control';

export interface CategoryDef {
  /** Stable machine id (kebab). The contract every consumer keys on. */
  id: AutonomyCategory;
  /** Human label (the D-009 table's category name). */
  label: string;
  /**
   * Locked at never-auto by default and CANNOT graduate above it (D-005). The
   * protected set unifies "never-auto" and "per-category ceiling" into one
   * mechanism: a protected category is just one whose ceiling is locked at zero.
   * Still ACCESSIBLE as propose→owner-ratifies (D-010) — never auto-executed.
   */
  protected: boolean;
  /** D-009 "default posture" column — a UI hint only (see module doc). */
  suggestedPosture: SuggestedPosture;
  /** The human-driving actions this category covers (D-009 prose). */
  covers: string;
}

/**
 * The taxonomy. Order is the D-009 table order (rendered top-to-bottom in the
 * settings page). The four `protected: true` rows are exactly the D-005 never-
 * auto set: release & deploy · spend & budget · credentials & auth · system-control.
 */
export const CATEGORIES: readonly CategoryDef[] = [
  {
    id: 'inbox-triage',
    label: 'Inbox triage',
    protected: false,
    suggestedPosture: 'early-autonomy',
    covers: 'tier / downgrade / dismiss / resolve inbox items',
  },
  {
    id: 'escalations',
    label: 'Escalations & agent-questions',
    protected: false,
    suggestedPosture: 'mixed',
    covers:
      'resolve blocker/question/advisory escalations; answer ctx.askUser cards + the owner-decision-queue',
  },
  {
    id: 'plan-governance',
    label: 'Plan governance',
    protected: false,
    suggestedPosture: 'mixed',
    covers:
      'ratify needs-human plan items & milestone gates; ratify D-NNN plan decisions; set plan status / Now; promote plan → features / waves',
  },
  {
    id: 'work-prioritization',
    label: 'Work prioritization',
    protected: false,
    suggestedPosture: 'early-autonomy',
    covers: 'set work-item priority / importance; reorder the backlog; steer claims',
  },
  {
    id: 'ideation-intake',
    label: 'Ideation & intake',
    protected: false,
    suggestedPosture: 'low-risk',
    covers: 'grade Scout ideas; triage / promote improvements & issues',
  },
  {
    id: 'implementation',
    label: 'Implementation',
    protected: false,
    suggestedPosture: 'risk-graded',
    covers: 'approve / dispatch auto-implement code changes',
  },
  {
    id: 'review-merge',
    label: 'Review & merge',
    protected: false,
    suggestedPosture: 'risk-graded',
    covers: 'approve reviews; approve merges',
  },
  {
    id: 'release-deploy',
    label: 'Release & deploy',
    protected: true,
    suggestedPosture: 'protected',
    covers: 'approve deploys / releases / promotion to green',
  },
  {
    id: 'spend-budget',
    label: 'Spend & budget',
    protected: true,
    suggestedPosture: 'protected',
    covers: 'approve spend, budgets, account scaling',
  },
  {
    id: 'agent-lifecycle',
    label: 'Agent lifecycle',
    protected: false,
    suggestedPosture: 'risk-graded',
    covers: 'spawn / cancel / drain agents; model-tier; fleet admission',
  },
  {
    id: 'credentials-auth',
    label: 'Credentials & auth',
    protected: true,
    suggestedPosture: 'protected',
    covers: 'register / approve credentials; auth-affecting flags',
  },
  {
    id: 'knowledge-curation',
    label: 'Knowledge curation',
    protected: false,
    suggestedPosture: 'low-risk',
    covers:
      'memory approve / forget; docs & insights publish; knowledge-pack / blueprint publish',
  },
  {
    id: 'schedule-arm',
    label: 'Schedule arming',
    protected: false,
    suggestedPosture: 'risk-graded',
    covers:
      "arm / disarm a scheduled plan's recurrence (start/stop it firing runs) — distinct from system-control's SYSTEM loops; non-protected so it can graduate per plan risk (scheduled-recurring-plans-2026-06-16 D-017)",
  },
  {
    id: 'system-control',
    label: 'System control',
    protected: true,
    suggestedPosture: 'protected',
    covers: 'arm / disarm loops; flag flips; routines; the learning loop itself',
  },
];

/** The 14 category ids, in table order. The contract B-03's store seeds on. */
export const AUTONOMY_CATEGORY_IDS: readonly AutonomyCategory[] = CATEGORIES.map((c) => c.id);

/**
 * The never-auto protected set (D-005): release & deploy · spend & budget ·
 * credentials & auth · system-control. These ship locked at never-auto and can
 * never graduate above it. Derived from {@link CATEGORIES} so it can't drift.
 */
export const PROTECTED_CATEGORIES: readonly AutonomyCategory[] = CATEGORIES.filter(
  (c) => c.protected,
).map((c) => c.id);

const CATEGORY_BY_ID: ReadonlyMap<AutonomyCategory, CategoryDef> = new Map(
  CATEGORIES.map((c) => [c.id, c]),
);

/** Type guard: is `s` one of the 14 canonical category ids? */
export function isAutonomyCategory(s: string): s is AutonomyCategory {
  return CATEGORY_BY_ID.has(s as AutonomyCategory);
}

/** Look up a category definition by id (undefined for an unknown id). */
export function getCategory(id: AutonomyCategory): CategoryDef | undefined {
  return CATEGORY_BY_ID.get(id);
}

/**
 * Is this a never-auto protected category (D-005)? A protected category's
 * ceiling is locked at zero and cannot graduate — the gate (B-12) and the
 * P-090 invariants treat it as never-auto regardless of risk/track-record.
 */
export function isProtectedCategory(c: AutonomyCategory): boolean {
  return CATEGORY_BY_ID.get(c)?.protected ?? false;
}
