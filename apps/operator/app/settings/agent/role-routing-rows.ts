/**
 * The operational AI roles that get a Backend / model / tier-ceiling control
 * on /settings/agent (the "AI backend" tab).
 *
 * Extracted from page.tsx so `role-routing-rows.test.ts` can run the CANONICAL
 * retired-tier predicate over this list (WI-39539). A test that imported the
 * page itself would have to load a React client component and its whole UI
 * dependency graph; a test that grepped page.tsx for "mug" could not tell a
 * live config row from a comment mentioning the word. This module is a plain
 * data export precisely so the guard can be an executable assertion.
 *
 * ⚠ EVERY ROW HERE MUST BE A ROLE THAT CAN ACTUALLY SPAWN. Mug and Kettle sat
 * in this list for three days after `retire-mug-kettle-su-only-2026-08-09`
 * shipped, rendering backend pickers and model pins for roles that
 * `fleet/operator-spawn.ts` hard-refuses — settings that looked live, saved
 * cleanly, and could never take effect. The owner found them, not a test.
 * Retiring a role means deleting its row here in the same change.
 *
 * NOTE the Blender row's `role` id is `scanner` — Scout/Blender is deliberately
 * INTACT (retirement plan D-001) and must not be removed alongside the tier.
 */
export const ROLE_ROUTING_ROWS = [
  {
    label: 'Blender',
    role: 'scanner',
    description: 'Runs negative-space scans for missing work, latent issues, and improvement opportunities.',
  },
  {
    label: 'doc-steward',
    role: 'doc-steward',
    description: 'Repairs drifted docs after code changes so documentation matches the current implementation.',
  },
  {
    label: 'merge-resolution',
    role: 'merge-resolver',
    description: 'Resolves git-sync merge conflicts, commits the clean resolution, and leaves push to git-sync.',
  },
  {
    label: 'content-fix',
    role: 'content-fixer',
    description: 'Fixes quarantined files that fail content guards, such as broken MDX or smart quotes in code.',
  },
  {
    label: 'release-fix',
    role: 'release-fixer',
    description: 'Diagnoses red green-checkpoint gates, reproduces failures, and fixes regressions or proven flakes.',
  },
  {
    label: 'deploy',
    role: 'release-manager',
    description: 'Reviews deploy plans, makes the go/no-go call, runs deploy mechanics, and verifies rollback health.',
  },
] as const;

export type RoleRoutingRow = (typeof ROLE_ROUTING_ROWS)[number];
