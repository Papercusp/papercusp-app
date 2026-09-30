/**
 * Automation pane categories — the owner-facing grouping and which left-rail
 * pane renders each one.
 *
 * WHY THIS IS ITS OWN MODULE (and must stay dependency-free): the sidebar tabs
 * (BlenderTab / DocsTab / AgentsTab) import these constants as VALUES. Their
 * original home, `./catalog.ts`, top-level-imports `@papercusp/db-org` and the
 * workspace registry — so importing the constants from there drags a Postgres
 * client into the browser bundle. Types were fine (erased at compile time);
 * values are not. Keep this file free of runtime imports.
 *
 * OWNER MANDATE (owner, 2026-07-25, verbatim): "WE NEED ALL ROUTINES SURFACED TO
 * THE USER IN ONE OF THE PANES IN THE LEFT HAND SIDEBAR THERE CAN BE NO
 * ROUTINES THAT DONT GET SURFACED THERE."
 *
 * That mandate is enforced HERE, by construction, plus a test
 * (pane-coverage.test.ts) that fails if it is ever violated.
 *
 * It was previously enforced by a hand-maintained array in AgentsTab.tsx
 * carrying the comment "so no routine can exist without appearing in exactly
 * one of the three panes" — which was FALSE: `infra` was in no pane's list,
 * hiding 40 routines, 39 of them ACTIVE, including git-sync, green-checkpoint
 * and hive-git-gc. A comment cannot keep this invariant; a derived list plus a
 * test can.
 *
 * To add a pane: give it its own exported const here and add it to
 * NAMED_PANE_CATEGORIES. Anything not claimed by a named pane automatically
 * falls to the catch-all pane, so a newly added AutomationCategory is surfaced
 * the moment it exists, without anyone remembering to wire it up.
 */

/** Owner-facing grouping. One pane per category (Blender → learning, Docs → docs). */
export type AutomationCategory =
  | 'learning'
  | 'docs'
  | 'supervision'
  | 'health'
  | 'infra'
  | 'agent-loops';

export const AUTOMATION_CATEGORIES: readonly AutomationCategory[] = [
  'learning',
  'docs',
  'supervision',
  'health',
  'infra',
  'agent-loops',
] as const;

/*
 * ⚠ THE PER-PANE CATEGORY CONSTANTS ARE GONE
 * (agents-system-pane-split-2026-07-26 P-006).
 *
 * `BLENDER_PANE_CATEGORIES` / `DOCS_PANE_CATEGORIES` / `CATCH_ALL_PANE_CATEGORIES`
 * existed because each left-rail pane claimed a set of CATEGORIES, and the mandate
 * above then had to be enforced by keeping those sets exhaustive. The rail no
 * longer works that way: it is two panes — Agents and System — and a row's pane is
 * decided by `spend` (llm/unknown → Agents, none → System) in
 * ./routine-classification. That is a total function, so "every routine reaches a
 * pane" is true by construction instead of by list maintenance — which is the
 * failure this file was created to survive in the first place (`infra` claimed by
 * nobody, 40 routines invisible).
 *
 * `AutomationCategory` itself stays: it still LABELS a row (`AutomationRoutine.category`)
 * and `classifyRoutine` still computes it. It just no longer routes anything.
 *
 * Do not reintroduce per-pane category constants without also re-adding the
 * exhaustiveness check they require. pane-coverage.test.ts now guards the spend
 * partition instead.
 */
