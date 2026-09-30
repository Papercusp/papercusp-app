/**
 * mock-import-coverage.ts — assert a PARTIAL `vi.mock` factory still covers every
 * name the handlers under test import from the mocked module (EI-19362106022997577).
 *
 * ## The trap this closes
 *
 * A suite that DRIVES a real handler through a partial mock factory is making a
 * silent promise: the factory stands in for the module's whole *used* surface. When
 * production later adds an import to that module, nothing re-checks the promise. The
 * suite goes stale and reds as an opaque
 *
 *     [vitest] No "<x>" export is defined on the mock
 *
 * in whichever test first walks the new branch — which is usually NOT the test that
 * covers the change, and often not even the same file. Worse, if no test walks that
 * branch yet, the factory is simply wrong and *passes*, arming the failure for some
 * unrelated future edit.
 *
 * `events/await/store` alone has now produced FOUR of these, three of them found only
 * downstream: EI-17276 (PRESENCE_STALE_MS), EI-18676056143796303 (probeKeyFireEvidence),
 * EI-19332682533219755 (probePatternMatchScope), plus cancelAwaitsForSubscribersOnKeys
 * found latent. The third is the instructive one: its author DID update the sibling
 * suite that mocked the same module and simply did not know a second suite mocked it
 * too — which is exactly why "remember to grep" is not a fix.
 *
 * ## Why not just spread `importOriginal()`?
 *
 * Because for these suites the partial mock is CORRECT and deliberate: the real
 * `events/await/store` imports `@papercusp/db-org`, so a full spread would cost them
 * their hermeticity. The problem is not that the mock is partial — it is that nothing
 * asserts the partial set still covers what is actually imported.
 *
 * ## Why this is opt-in per suite, not a lint
 *
 * "Does this suite DRIVE the mocked module, or merely import it to satisfy a
 * dependency?" is not statically decidable, and most suites mocking a given module are
 * in the second, perfectly safe category (38 suites mock `events/await/store`; only 3
 * drive a handler through it). A blanket rule requiring complete mocks would fight the
 * intentional partial-mock pattern everywhere it is correct. So: one line, opted into
 * by the suites that actually make the promise.
 *
 * ## Usage
 *
 *   import * as storeMock from '../../events/await/store';
 *   import { assertMockCoversImports } from '../../testing/mock-import-coverage';
 *
 *   it('mocks every store export the handlers under test import', () => {
 *     assertMockCoversImports(storeMock, {
 *       importerUrl: import.meta.url,
 *       sources: ['./await.ts', './emit.ts'],
 *       moduleSpecifier: 'events/await/store',
 *       expectNames: ['probePatternMatchScope'],
 *     });
 *   });
 *
 * `importerUrl` is REQUIRED and must be the calling suite's own `import.meta.url`:
 * `sources` are resolved relative to the SUITE, not to this helper.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Thrown when the guard cannot do its job, as distinct from finding a real gap. */
export class MockCoverageGuardError extends Error {}

export interface MockImportCoverageQuery {
  /** The calling suite's own `import.meta.url`. `sources` resolve relative to it. */
  importerUrl: string;
  /** Source files that import the mocked module, relative to `importerUrl`. */
  sources: string[];
  /**
   * The module specifier as it appears in those imports. Matched as a SUFFIX, so
   * 'events/await/store' matches both '../../events/await/store' and './store'
   * spelled relatively from different depths.
   */
  moduleSpecifier: string;
  /**
   * Names that MUST appear in the parsed import list — a positive control proving the
   * parse found the real statement rather than merely matching something. Strongly
   * recommended: pick a name unlikely to be removed casually.
   */
  expectNames?: string[];
}

export interface MockImportCoverage {
  /** Value-imported names the sources pull from `moduleSpecifier`, deduped. */
  required: string[];
  /** Keys the mock namespace actually exposes. */
  provided: string[];
  /** `required` entries absent from `provided` — non-empty means the factory is stale. */
  missing: string[];
}

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip comments so a commented import line cannot be parsed as a name. */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Extract the VALUE-imported names for `moduleSpecifier` from TypeScript source text.
 *
 * Pure — takes source text, not a path — so the parse itself is directly testable
 * without touching the filesystem.
 *
 * Deliberately excludes type-only imports (both `import type { A }` and an inline
 * `{ type A }`): those are erased at runtime and a mock need not provide them.
 * For an aliased import (`{ real as local }`) the ORIGINAL name is what the mock must
 * expose, so that is what is returned.
 */
export function importedNamesFrom(source: string, moduleSpecifier: string): string[] {
  const spec = escapeForRegex(moduleSpecifier);
  const names: string[] = [];
  // `[^}]*` spans newlines, matching both multi-line import blocks and single-line ones.
  // A leading `import type {` is intentionally NOT matched: `import\s*\{` requires the
  // brace to follow `import` directly.
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${spec}['"]`, 'g');
  for (const m of source.matchAll(re)) {
    for (const raw of stripComments(m[1] ?? '').split(',')) {
      const entry = raw.trim();
      if (!entry || entry.startsWith('type ')) continue;
      const name = (entry.split(/\s+as\s+/)[0] ?? '').trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Read `sources` relative to `importerUrl` and aggregate their imported names. */
export function requiredImportNames(query: MockImportCoverageQuery): string[] {
  const { importerUrl, sources, moduleSpecifier } = query;
  if (!sources.length) {
    throw new MockCoverageGuardError('assertMockCoversImports: `sources` is empty — the guard would check nothing.');
  }
  const found: string[] = [];
  for (const rel of sources) {
    let text: string;
    try {
      text = readFileSync(fileURLToPath(new URL(rel, importerUrl)), 'utf8');
    } catch (err) {
      // A moved/renamed source must fail LOUDLY: silently skipping it would leave the
      // guard passing forever while checking nothing.
      throw new MockCoverageGuardError(
        `assertMockCoversImports: cannot read source '${rel}' relative to ${importerUrl}. ` +
          `If the file moved, update the \`sources\` list. (${(err as Error).message})`,
      );
    }
    found.push(...importedNamesFrom(text, moduleSpecifier));
  }
  return [...new Set(found)];
}

/** Compute coverage without asserting — useful for reporting on several suites at once. */
export function analyzeMockCoverage(
  mockNamespace: object,
  query: MockImportCoverageQuery,
): MockImportCoverage {
  const required = requiredImportNames(query);
  const provided = Object.keys(mockNamespace);
  return { required, provided, missing: required.filter((n) => !(n in mockNamespace)) };
}

/**
 * Assert the mock factory covers every name the driven sources import.
 *
 * Throws `MockCoverageGuardError` when the guard cannot do its job (no imports parsed,
 * unreadable source, a `expectNames` control missing) and a plain assertion-style Error
 * when it CAN and finds a genuine gap. The distinction matters: a guard that silently
 * finds nothing to check would pass forever and is worse than no guard at all, so
 * "found nothing" is an error rather than a pass.
 */
export function assertMockCoversImports(mockNamespace: object, query: MockImportCoverageQuery): void {
  const { required, missing } = analyzeMockCoverage(mockNamespace, query);

  if (required.length === 0) {
    throw new MockCoverageGuardError(
      `assertMockCoversImports: parsed ZERO imports of '${query.moduleSpecifier}' from ` +
        `[${query.sources.join(', ')}]. The guard is checking nothing — the specifier or the ` +
        `source list is probably wrong.`,
    );
  }

  for (const control of query.expectNames ?? []) {
    if (!required.includes(control)) {
      throw new MockCoverageGuardError(
        `assertMockCoversImports: positive control '${control}' is not in the parsed import ` +
          `list [${required.join(', ')}]. Either the parse matched the wrong statement, or that ` +
          `import was genuinely removed — if the latter, update \`expectNames\`.`,
      );
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Mock of '${query.moduleSpecifier}' is stale: missing ${missing.length} export(s) that ` +
        `[${query.sources.join(', ')}] import — ${missing.join(', ')}. ` +
        `Add them to the vi.mock factory. (Production added an import; this factory stands in ` +
        `for the module's whole used surface because this suite drives the real handler.)`,
    );
  }
}
