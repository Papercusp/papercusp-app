/**
 * boot-check-timeout-coherence — the guard logic for EI-22025223570144566.
 *
 * WHAT WENT WRONG, so the next reader knows what this is defending:
 * `templates/*​/checks/boot-e2e.test.ts` spawns a REAL production build inside
 * the test. Its budgets were two independent hardcoded literals — a 600s
 * `spawnSync` timeout for `buildCommand`, nested inside a 780s vitest test
 * timeout that ALSO had to cover boot + ready + shutdown. Measured builds on
 * this box spend 8–10min in the compile phase alone (462–582s), before the
 * TypeScript pass even starts, so both numbers sat inside the real
 * build-time distribution and the check went red as a function of machine load
 * rather than of code correctness.
 *
 * Two hardcoded budgets in a nesting relationship is the actual defect: raising
 * only the inner one moves the failure to the outer one, and nothing keeps the
 * pair coherent. So the fix DERIVES the vitest timeout from the named per-leg
 * budgets (`buildTimeoutMs` + `readyTimeoutMs` + `shutdownGraceMs` + slack), and
 * the guard in `boot-check-timeout-coherence.test.ts` pins that derivation: a
 * boot check may not express either budget as a bare numeric literal again.
 *
 * WHY THIS IS ITS OWN MODULE (WI-212675, gate red 2026-09-03T19:26Z): these
 * helpers used to be exported FROM the test file, and a sibling guard
 * (`boot-e2e-pg-lock-guard.test.ts`) imported them from there. Under the gate's
 * PURE lane vitest runs with `isolate: false`, so files in one fork SHARE a
 * module registry: whichever of the two files loaded second got the CACHED
 * module, its `describe` never re-executed, vitest collected 0 tests, and the
 * `--no-passWithNoTests` re-run failed with "No test suite found" — a flake
 * that passed 7/7 in an isolated re-run and red-pinned the gate anyway. A test
 * file must never be an import target; shared logic lives here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: walk up from this file until the root package.json (the one with `workspaces`). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('boot-check-timeout-coherence: could not locate the monorepo root');
}

export const TEMPLATES_DIR = join(repoRoot(), 'templates');
export const BOOT_CHECK = 'boot-e2e.test.ts';

/**
 * The vitest per-test option object, e.g. `{ timeout: 780_000 }`. A bare number
 * here is the OUTER budget, hand-maintained beside the inner one.
 */
const LITERAL_TEST_TIMEOUT = /\{\s*timeout:\s*[\d_]+\s*\}/;

/**
 * A `timeout:` passed to spawn/spawnSync options with a bare number — the INNER
 * budget. Matched on the option rather than the call so a reformatted call still
 * trips it.
 */
const LITERAL_SPAWN_TIMEOUT = /encoding:\s*"utf8",\s*timeout:\s*[\d_]+/;

/** Every `templates/<ref>/checks/boot-e2e.test.ts` present in a templates tree. */
export function listBootChecks(templatesDir: string): string[] {
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir)
    .filter((e) => statSync(join(templatesDir, e)).isDirectory())
    .map((ref) => join(templatesDir, ref, 'checks', BOOT_CHECK))
    .filter((p) => existsSync(p))
    .sort();
}

/**
 * Boot checks whose build/test budgets are hardcoded numeric literals rather
 * than derived from the named per-leg budgets. Returns one human-readable
 * violation per offending file, `[]` when the tree is clean.
 */
export function findHardcodedBootTimeouts(templatesDir: string): string[] {
  const violations: string[] = [];
  for (const file of listBootChecks(templatesDir)) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(templatesDir, file);
    if (LITERAL_TEST_TIMEOUT.test(src)) {
      violations.push(
        `${rel}: the vitest test timeout is a bare literal — derive it from the per-leg budgets ` +
          `(spawnTestTimeoutMs) so it cannot drift below the build budget it must contain.`,
      );
    }
    if (LITERAL_SPAWN_TIMEOUT.test(src)) {
      violations.push(
        `${rel}: the buildCommand spawn timeout is a bare literal — read it from ` +
          `boot.buildTimeoutMs so a slow-building app can raise it via config.`,
      );
    }
  }
  return violations;
}
