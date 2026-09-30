/**
 * Client-safe phase constants. Split out from harness-phases.ts because
 * that file imports node:fs (server-only) for its phase-resolution helpers.
 * The phase list itself is just a constant, so client components like
 * PhaseTabs.tsx can import from this lightweight module.
 */

/** Harness phase — which worktree the orchestrator is operating on. */
export type Phase = 'staging' | 'testing' | 'production';

/** Canonical phase order. Single source of truth — both client and server
 *  read from here. Adding a new phase touches one file. */
export const ALL_PHASES: readonly Phase[] = ['staging', 'testing', 'production'];
