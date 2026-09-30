/**
 * scout-code-identity.ts — the RUNNING scout ideation code's content identity
 * (WI-5397: blender:success-metrics runningGeneration.sha reports the DEPLOYED sha,
 * not the code the scout host is actually running).
 *
 * BACKGROUND: the scout bg-host runs `npx tsx bin/hono-host.ts` directly against the
 * SHARED STAGING WORKING TREE (no bundling, no file-watch, WorkingDirectory=apps/operator)
 * — a tree continuously edited unstaged by the whole fleet. A git sha (deployed OR HEAD)
 * therefore never uniquely identifies "the code this process is executing": the tree
 * moves out from under a long-lived process between commits, and the process itself
 * never re-reads a file after tsx first resolves it. The only honest identity is a
 * CONTENT hash of the specific source files this process actually holds in memory.
 *
 * SCOPE: the curated file set is exactly the modules that decide a scout tick's
 * error-vs-capacity classification — the code the cycle-error-rate release bar is
 * judging (WI-4475 / WI-5391). Extend {@link SCOUT_CODE_IDENTITY_FILES} when a future
 * fix changes which code governs that classification; the hash is deliberately narrow
 * (not "every scout file") so an unrelated edit elsewhere doesn't spuriously zero the
 * soak-aggregation denominator (see {@link ./tick-ledger}'s readScoutTicksByCodeHash).
 *
 * COMPUTED EAGERLY AT MODULE EVALUATION (a module-scope value, not a lazy first-call
 * memo) — corrected post-build (design review, WI-5397): this module's own import IS
 * eager (the traced import graph — blueprint-steps/index.ts → ops/scout-cycle.ts →
 * scout/run.ts → scheduler.ts → this module — is fully static, so evaluating this file
 * happens at hono-host BOOT, alongside every other eagerly-loaded scout module). An
 * earlier revision deferred the read to {@link currentScoutCodeHash}'s FIRST CALL
 * (inside scheduler.ts's tick-recording path) reasoning that first-call was "close
 * enough" to load time — but on a continuously fleet-edited shared working tree, the
 * gap between eager-import (boot) and first scout tick was measured at ~32 MINUTES
 * (boot 00:37:45Z → first tick 01:09:56Z). An edit to capacity-errors.ts / scheduler.ts
 * / quality-metrics.ts landing in that window would have been hashed by the lazy
 * first-call read even though this process never actually loaded those bytes — the
 * EXACT "tree moved out from under a long-lived process" failure mode this whole
 * module exists to solve, reintroduced via the memo's own timing. Reading the files at
 * module-evaluation time instead ties the hash to as close to this process's true
 * import instant as a runtime fs read can get — eager imports make that gap NEAR-ZERO,
 * not large; "eager therefore a lazy first-call read is safe" had it backwards.
 */
import { fileURLToPath } from 'node:url';
import { computeCombinedSourceHash } from './src-hash';

/** The modules whose CONTENT determines a scout tick's error/no-capacity
 *  classification — the code {@link ../agent-tools/scout/success-metrics}'s
 *  cycle-error-rate bar is judging. Order is part of the hash's identity; only
 *  ever APPEND, never reorder existing entries (reordering would change every
 *  future hash for byte-identical code, spuriously breaking the soak union). */
export const SCOUT_CODE_IDENTITY_FILES = ['./capacity-errors.ts', './scheduler.ts', './quality-metrics.ts'] as const;

function resolvePaths(): string[] {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  return SCOUT_CODE_IDENTITY_FILES.map((rel) => dir + rel.replace(/^\.\//, ''));
}

/** Computed once, AT THIS MODULE'S OWN EVALUATION (see the module docblock) — not
 *  lazily on first access. `let`, not `const`, only so {@link _resetScoutCodeHashForTest}
 *  can force a fresh read in a long-lived test process; production code never mutates it
 *  again after this line runs. */
let cached: string | null = computeCombinedSourceHash(resolvePaths());

/** The running scout code's identity — sha256(first 16 hex) over
 *  {@link SCOUT_CODE_IDENTITY_FILES}' concatenated bytes AS OF this module's own
 *  evaluation instant (see module docblock for why that beats a first-call memo), fixed
 *  for the rest of the process's lifetime. Null when any file was unreadable at that
 *  instant (a bundled build with no on-disk source, a permissions issue, ...) — never a
 *  partial hash. */
export function currentScoutCodeHash(): string | null {
  return cached;
}

/** Test-only — force a fresh read from disk (simulates re-evaluating this module). */
export function _resetScoutCodeHashForTest(): void {
  cached = computeCombinedSourceHash(resolvePaths());
}
