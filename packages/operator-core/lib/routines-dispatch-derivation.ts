/**
 * EI-19369080695408825 — derive the routinesTick-dispatched sweep set instead of
 * hand-copying it into RUNTIME_OWNERS.
 *
 * ## What was wrong
 *
 * `routinesTickImpl` (lib/dbos/routines-workflow.ts) dispatches ~28 periodic sweeps by
 * direct `await import(...)`, bypassing the `system:<action>` registry. WI-6659 taught
 * `RUNTIME_OWNERS` about them by writing a regex alternation of their names BY HAND. A
 * guard test re-derives the real set and fails on divergence — which works, but it is a
 * DETECTOR, and the thing it detects is somebody forgetting a hand-edit.
 *
 * It fired twice in one day (sweep #25 `learning-loop-health-sweep` -> WI-7103, sweep #26
 * `tsc-red-sweep` -> fixed in 89cd63a13c), and both times the divergence surfaced at the
 * SHARED green-checkpoint, so the whole fleet's promotion path was blocked by a one-line
 * omission.
 *
 * Note the guard IS in the author's affected set — `node scripts/affected-tests.mjs
 * --changed-paths packages/operator-core/lib/dbos/routines-workflow.ts --print-affected`
 * returns `@papercusp/operator-core`, so `npm run test:affected` would have caught both
 * locally. The failure is therefore NOT "the author cannot see it"; it is that noticing
 * requires the author to run a suite they may skip. That is exactly why moving the
 * detection earlier does not help, and why this file removes the hand-edit instead: the
 * only fix robust to a skipped suite is one that needs no human action at all.
 *
 * ## What this does
 *
 * Re-derives the dispatched set from the dispatcher's own source at runtime and exposes it
 * as a matcher. `git-pipeline-position.ts` appends ONE rule built from it, LAST — after
 * every hand-written rule. Because `classifyRuntimeOwners` returns the FIRST match, this
 * changes the answer for exactly one population: a sweep no hand rule covers, which today
 * falls through to DEFAULT_OWNER and is reported as `deployed ✓` for code :3070 never runs
 * (the original WI-6659 lie). Every currently-classified path keeps its existing rule,
 * including the WI-5440 dual-consumer entries that must report BOTH routes.
 *
 * Verified 2026-08-02 before writing this: all 30 currently-dispatched modules already
 * match a hand rule, so this rule is a pure safety net today and changes no live answer.
 *
 * ## Failure direction
 *
 * If the source cannot be read or the idiom is refactored away, the matcher degrades to
 * never-matching — i.e. precisely today's behaviour — and warns once. It must never
 * degrade to matching everything: that would tell an agent editing a shared operator file
 * that a deploy cannot activate their change, which is the opposite lie.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

/** This file lives at packages/operator-core/lib/, so paths under it are expressible. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const LIB_PREFIX = 'packages/operator-core/lib/';
const WORKFLOW_REL = 'dbos/routines-workflow.ts';

/**
 * Dispatched modules deliberately NOT classified bg-host. SHRINK-TO-EMPTY: only a module
 * whose bg-host consumer is a negligible slice of a broadly-shared surface belongs here,
 * and an entry needs a stated reason.
 *
 * Kept in production (not just in the test) on purpose. Today `agent-facts/store.ts`
 * matches an earlier hand rule so the catch-all never sees it — but if that rule is ever
 * reshaped, the catch-all would silently reclassify a file with ~460 operator-served
 * importers as bg-host-only. This makes that impossible rather than unlikely.
 */
export const NOT_BG_HOST_DISPATCHED: ReadonlyMap<string, string> = new Map([
  [
    'packages/operator-core/lib/agent-facts/store.ts',
    'The facts store has ~460 non-test importers and is overwhelmingly operator-served ' +
      '(facts:assert / facts:list / every orient fold). Only sweepExpiredFacts runs in bg-host, ' +
      'so a bg-host classification would mis-route the dominant caller.',
  ],
]);

/**
 * Every relative specifier the workflow pulls in as WORK — the sweep bodies routinesTick
 * executes, not the plumbing it executes them with.
 *
 * The distinction is load-bearing, and is why this cannot simply scan all imports: an
 * earlier cut of the guard demanded bg-host for `workspace-als`, `loopback-fetch` and
 * `operator-api-base` — generic helpers imported all over the operator, for which a
 * bg-host answer would be actively wrong. So:
 *   - dynamic `await import(...)` — the dispatch idiom, always a sweep body;
 *   - static imports ONLY from `harness/routines/`, which is routine-execution code by
 *     construction.
 *
 * Exported for the guard test, which drives it with synthetic sources to prove a NEW
 * sweep is picked up without touching any hand-written list.
 */
export function dispatchedSweepSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)) found.add(m[1]);
  for (const m of source.matchAll(/^\s*import\s[^;]*?\sfrom\s+['"](\.[^'"]+)['"]/gm)) {
    if (m[1].includes('harness/routines/')) found.add(m[1]);
  }
  return [...found];
}

/** Resolve a workflow-relative specifier to a repo-relative .ts path, or null. */
function toRepoRelative(spec: string, existsAt: (abs: string) => boolean): string | null {
  const abs = resolve(LIB_DIR, dirname(WORKFLOW_REL), spec);
  for (const candidate of [`${abs}.ts`, resolve(abs, 'index.ts')]) {
    if (!existsAt(candidate)) continue;
    const rel = relative(LIB_DIR, candidate);
    // A target outside operator-core/lib cannot be expressed as a lib-relative path;
    // skip rather than emit a wrong one.
    if (rel.startsWith('..')) return null;
    return LIB_PREFIX + rel;
  }
  return null;
}

const fileExists = (abs: string): boolean => {
  try {
    readFileSync(abs);
    return true;
  } catch {
    return false;
  }
};

/**
 * The dispatched sweep set as repo-relative paths, minus the explicit allowlist.
 * `source`/`existsAt` are injectable so the guard test can drive a synthetic dispatcher.
 */
export function dispatchedSweepPaths(
  source?: string,
  existsAt: (abs: string) => boolean = fileExists,
): string[] {
  const text = source ?? readFileSync(resolve(LIB_DIR, WORKFLOW_REL), 'utf8');
  const paths = new Set<string>();
  for (const spec of dispatchedSweepSpecifiers(text)) {
    const rel = toRepoRelative(spec, existsAt);
    if (rel && !NOT_BG_HOST_DISPATCHED.has(rel)) paths.add(rel);
  }
  return [...paths].sort();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches nothing — the safe degradation (see "Failure direction" above). */
const NEVER = /(?!)/;

let cached: RegExp | null = null;

/**
 * Memoized matcher over the dispatched sweep set. Lazy: the source read happens on first
 * classification, never at module load, so importing this file can never fail a boot.
 */
export function dispatchedSweepMatcher(): RegExp {
  if (cached) return cached;
  try {
    const paths = dispatchedSweepPaths();
    // A plausibility floor, mirroring the guard test's "guards the guard" assertion: if the
    // dispatch idiom is refactored away the scan would find nothing, and a never-matching
    // matcher is the honest answer — but it must be LOUD, because silently finding nothing
    // is how the original WI-6659 mis-routing looked.
    if (paths.length < 10) {
      console.warn(
        `[routines-dispatch] derived only ${paths.length} dispatched sweeps from ${WORKFLOW_REL} ` +
          `(expected >=10). The dispatch idiom may have changed; new sweeps will fall through to ` +
          `DEFAULT_OWNER and dev:pipeline_position will report them as deploy-activated (WI-6659).`,
      );
      cached = NEVER;
      return cached;
    }
    cached = new RegExp(`^(${paths.map(escapeRe).join('|')})$`);
    return cached;
  } catch (err) {
    console.warn(
      `[routines-dispatch] could not derive the dispatched sweep set from ${WORKFLOW_REL}: ` +
        `${(err as Error).message}. Falling back to hand-written rules only (WI-6659 risk).`,
    );
    cached = NEVER;
    return cached;
  }
}

/**
 * Test seam: drop the memoized matcher, or seed it.
 *
 * Seeding exists for one assertion that cannot otherwise be made: every module the real
 * dispatcher imports today is ALREADY matched by an earlier hand-written rule, so nothing
 * in the live set ever reaches the catch-all. Without a seam, a test can prove the
 * derivation is correct while the rule sits unwired and the whole change is a no-op —
 * which is the failure mode most worth pinning.
 */
export function resetDispatchedSweepCache(seed?: RegExp): void {
  cached = seed ?? null;
}
