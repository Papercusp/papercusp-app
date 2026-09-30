/**
 * Mockup-to-implementation validation: binding the verbs to real dependencies.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-006, D-017).
 *
 * `verbs.ts` is host-agnostic and `host-registry.ts` is a slot. This is the one
 * place that knows what the production dependencies actually are — Postgres,
 * lost-pixel's pixelmatch comparator, the filesystem — and it is called from
 * plugin discovery so the design-phase plugin finds its surface installed.
 *
 * ─── EVERYTHING HERE IS LAZY, ON PURPOSE ─────────────────────────────────────
 *
 * Boot installs a surface per harness, and a host serves many. Building the
 * dependencies eagerly would open a Postgres connection and resolve lost-pixel
 * for every harness at startup, whether or not anyone ever ratifies a design.
 * So construction is deferred to the first call and then memoised.
 *
 * The one thing NOT deferred is engine resolution INSIDE a call:
 * `createPixelmatchProvider` throws at construction when lost-pixel is missing,
 * which is deliberate (a provider that cannot name its engine version cannot
 * stamp a result), and that throw surfaces as a refusal from the verb rather
 * than as a comparison that silently used something else.
 */
import { createReadStream, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { getLongLivedAdminPool } from '../long-lived-admin-pool';
import { installDesignCompareVerbs } from './host-registry';
import { createPgReferenceStore, type SqlTag } from './reference-store-pg';
import { createPixelmatchProvider } from './provider';
import type { ReferenceImageRef } from './reference-store';
import {
  type DesignCompareVerbs,
  type ReferenceImageMaterializer,
  type VerbDeps,
  createDesignCompareVerbs,
} from './verbs';

/**
 * Turn a stored locator into a path an engine can read.
 *
 * Three forms are accepted, and an unrecognised one is REPORTED rather than
 * guessed at: a locator we cannot resolve must become a `reference-unreadable`
 * refusal, never a comparison against some path we invented.
 */
export const filesystemReferenceMaterializer: ReferenceImageMaterializer = async (
  image: ReferenceImageRef,
) => {
  const { locator } = image;

  if (locator.startsWith('data:')) {
    const comma = locator.indexOf(',');
    const header = comma === -1 ? '' : locator.slice(0, comma);
    if (comma === -1 || !header.includes(';base64')) {
      return {
        error:
          'a data: locator must be base64-encoded; a percent-encoded one cannot be decoded to the exact ' +
          'bytes that were hashed at ratification, and comparing anything else would compare a different image',
      };
    }
    try {
      const bytes = Buffer.from(locator.slice(comma + 1), 'base64');
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-design-ref-'));
      const path = join(dir, 'reference.png');
      writeFileSync(path, bytes);
      return {
        path, contentSha256: createHash('sha256').update(bytes).digest('hex'),
        release: () => rm(dir, { recursive: true, force: true }),
      };
    } catch (error) {
      return { error: `failed to decode data: locator — ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (locator.startsWith('file://')) {
    const path = locator.slice('file://'.length);
    return existsSync(path) ? measuredFile(path) : { error: `file:// locator does not exist on this host: ${path}` };
  }

  if (locator.startsWith('/')) {
    return existsSync(locator) ? measuredFile(locator) : { error: `path does not exist on this host: ${locator}` };
  }

  return {
    error:
      `unrecognised locator form '${locator.slice(0, 40)}…': expected an absolute path, a file:// URL, ` +
      'or a base64 data: URL. A relative path is refused because it would resolve against whatever ' +
      'working directory the host happens to have.',
  };
};

async function measuredFile(path: string) {
  try {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return { path, contentSha256: hash.digest('hex') };
  } catch (error) {
    return { error: `reference bytes could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Per-harness cache of the production dependency bundle.
 *
 * Pinned rather than a module-level `Map` for the reason spelled out in
 * `host-registry.ts`: this package is reachable by several loader paths, and a
 * split module record would silently give each one its OWN postgres pool. The
 * cache exists precisely to stop that, so it must not be the thing that
 * duplicates.
 */
const DESIGN_COMPARE_DEPS_SLOT = '@papercusp/operator-core.design-compare.deps';

interface DepsSlot {
  byHarness: Map<string, Promise<VerbDeps>>;
}

function depsSlot(): DepsSlot {
  return pinModuleState<DepsSlot>(DESIGN_COMPARE_DEPS_SLOT, () => ({ byHarness: new Map() }));
}

/**
 * The production verb dependencies for one harness, built once and reused.
 *
 * Exported for the P-007 completion gate, which must read design evidence
 * through exactly the same store and the same reader an agent uses. A second,
 * privately-constructed bundle would be a second source of truth about
 * staleness and coverage — free to drift, and drifting toward "current" is the
 * direction that lets work through it should have stopped. It also opens a
 * second connection pool per completion, which is its own problem.
 */
export function designCompareDepsFor(harnessSlug: string): Promise<VerbDeps> {
  const slot = depsSlot();
  const existing = slot.byHarness.get(harnessSlug);
  if (existing) return existing;
  const built = buildDeps(harnessSlug);
  slot.byHarness.set(harnessSlug, built);
  return built;
}

/** Build the production dependency bundle for one harness. */
async function buildDeps(harnessSlug: string): Promise<VerbDeps> {
  // WI-1202547. This used to build its own pool — `postgres(getHarnessAdminUrl(), …)`
  // — and hand the HANDLE to the store, which `designCompareDepsFor` then memoised
  // per harness for the process lifetime. The URL was therefore asked exactly once,
  // at operator start, and never again.
  //
  // That is why deleting `~/.papercusp/embedded-pg.json` (which correctly restores
  // the healthy native :5432) took the design-evidence gate down on 2026-08-30 while
  // every other database path was fine: the captured binding could not follow the
  // endpoint. It surfaced as `password authentication failed for user
  // "harness_admin"`, which reads as a credential rotation and nearly got one
  // (EI-21891790341114171).
  //
  // A FUNCTION, not a handle: getLongLivedAdminPool re-resolves per call and rebinds
  // when the endpoint moves, so the memoisation above is now safe — what is cached is
  // the way to reach the pool, not a pool.
  const db = (): SqlTag => getLongLivedAdminPool('design-compare', { max: 2 }) as unknown as SqlTag;
  return {
    harnessSlug,
    store: createPgReferenceStore({ getSql: db }),
    now: () => Date.now(),
    clock: () => new Date().toISOString(),
    materializeReferenceImage: filesystemReferenceMaterializer,
    comparison: { provider: createPixelmatchProvider() },
  };
}

/**
 * Install a lazily-bound verb surface for one harness.
 *
 * Idempotent: `installDesignCompareVerbs` replaces by harness, so a dev-mode
 * plugin reload does not accumulate surfaces holding closed handles.
 */
export function installDesignCompareForHarness(harnessSlug: string): void {
  // Shares the per-harness cache with the completion gate, so the verbs an
  // agent calls and the gate that judges the result read the same store.
  const deps = (): Promise<VerbDeps> => designCompareDepsFor(harnessSlug);

  const verbs: DesignCompareVerbs = {
    async ratifyReference(input, caller) {
      return createDesignCompareVerbs(await deps()).ratifyReference(input, caller);
    },
    async compareRender(input, caller) {
      return createDesignCompareVerbs(await deps()).compareRender(input, caller);
    },
    async getDesignEvidence(input, caller) {
      return createDesignCompareVerbs(await deps()).getDesignEvidence(input, caller);
    },
  };

  installDesignCompareVerbs(harnessSlug, verbs);
}
