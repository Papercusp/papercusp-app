/**
 * Where THIS install's `libs/generic/*` component packages actually live — the
 * real path a materialized app can `file:`-link (P-005 / WI-37791, plan
 * template-supply-chain-repair-2026-08-10).
 *
 * THE BUG THIS CLOSES. Every app-scope template tells its builder to depend on
 * the first-party component packages (`@papercusp/sync`, `ui-primitives`,
 * `grid-core`, …) with a `file:` link, and `templates/README.md` documents the
 * mechanism with the worked example
 *
 *     "@papercusp/sync": "file:../papercusp/libs/generic/sync"
 *
 * That path is DEV-CHECKOUT-RELATIVE: it presumes a sibling `papercusp/` git
 * checkout next to the app. On a real install there is no such sibling, so a
 * builder agent following the GUIDE writes a dependency that resolves to
 * nothing, and `npm install` fails on a package that also 404s on npm (every
 * one of these is `private: true`). Nothing in the product ever told the builder
 * where the tree really is — the extracted location IS published, as
 * PAPERCUSP_DEV_SOURCE_ROOT, but `dev-source-extract.ts` deliberately confines
 * it to the dev/local env-operator children, and its only consumers are the
 * launcher, dev-operators and host-bootstrap. No template verb, no GUIDE, and
 * no materialized app ever saw it.
 *
 * So this module resolves the root ONCE, honestly, and the template verbs
 * surface it. It does not invent a second detector: the resolution order is
 * `defaultDetectSourceRoot()` (PAPERCUSP_DEV_SOURCE_ROOT marker-checked, then
 * `detectPapercupRoot()`), which is the same answer the env-operator launcher
 * runs the dev/local children from.
 *
 * THE `null` ANSWER IS A REAL ANSWER, NOT A FAILURE. Several shipping
 * configurations genuinely have no tree — the macOS GUI app stashes the archive
 * out so the DMG stays small (the macOS Server app DOES ship it), and a
 * cross-built macOS bundle ships none by default because Linux-native
 * node_modules are the wrong architecture (P-004/WI-37790). In those installs
 * these packages CANNOT be linked at all, and the right thing to hand a builder
 * is that stated plainly — never a plausible-looking path that fails at
 * `npm install`. `pending` separates "none, and none is coming" from "not
 * extracted YET" (first boot, ~minutes), because those demand opposite
 * reactions from the caller.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  defaultDetectSourceRoot,
  defaultDetectSourceArchivePending,
} from '../harness/env-operator-launcher';

/** Which leg of the resolution answered — so a caller can report provenance. */
export type GenericLibsRootSource =
  /** An extracted bundled source tree (PAPERCUSP_DEV_SOURCE_ROOT) — a real install. */
  | 'dev-source-tree'
  /** A papercusp repo checkout found by marker walk — dev boxes and CI. */
  | 'integration-root'
  /** No tree resolves; the packages are unreachable on this install. */
  | 'none';

/**
 * Packages that DO NOT come from `libs/generic` on a materialized app, because
 * they are VENDORED into the template dir itself and ride `sidecar/templates` to
 * every platform (plan decision D-001). A builder must link these as
 * `file:./<name>` — pointing them at `libs/generic` would reintroduce exactly the
 * dependency on a tree that may not exist, for the two packages that were
 * deliberately made independent of it.
 */
export const VENDORED_IN_TEMPLATE: readonly string[] = ['template-kit', 'pot-app-seam'];

export interface GenericLibsRootVerdict {
  /** Absolute path to `<sourceRoot>/libs/generic`, or null when none resolves. */
  root: string | null;
  /** The papercusp source root `root` hangs off. Null iff `root` is null. */
  sourceRoot: string | null;
  /** Which leg answered. */
  source: GenericLibsRootSource;
  /**
   * TRUE only when `root` is null AND this build shipped a source archive that
   * has not been extracted yet — i.e. the absence is TRANSIENT (first boot).
   * FALSE with a null root is the real gap: no tree, and none coming.
   */
  pending: boolean;
  /** Component package dir names present under `root`, sorted. `[]` when null. */
  available: string[];
  /** Prose for an agent: what this means and what to do about it. */
  explanation: string;
}

export interface ResolveGenericLibsRootDeps {
  /** Default: `defaultDetectSourceRoot` (the launcher's own resolver). */
  detectSourceRoot?: () => string | null;
  /** Default: `defaultDetectSourceArchivePending`. */
  detectArchivePending?: () => boolean;
  /** Default: `existsSync`. Injected so tests need no real tree. */
  exists?: (p: string) => boolean;
  /** Default: a `readdirSync` that lists real subdirectories. */
  listPackages?: (dir: string) => string[];
}

/** List the package dirs under a `libs/generic` root. Never throws. */
function defaultListPackages(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name !== 'node_modules' && !name.startsWith('.'))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve this install's `libs/generic` root.
 *
 * Never throws: every filesystem probe is guarded, because this runs on the
 * template/materialize path where a probe failure must degrade to "I could not
 * determine it" rather than fail the materialization.
 */
export function resolveGenericLibsRoot(
  deps: ResolveGenericLibsRootDeps = {},
): GenericLibsRootVerdict {
  const detectSourceRoot = deps.detectSourceRoot ?? defaultDetectSourceRoot;
  const detectArchivePending = deps.detectArchivePending ?? defaultDetectSourceArchivePending;
  const exists = deps.exists ?? existsSync;
  const listPackages = deps.listPackages ?? defaultListPackages;

  let sourceRoot: string | null = null;
  try {
    sourceRoot = detectSourceRoot();
  } catch {
    sourceRoot = null;
  }

  if (sourceRoot) {
    const root = join(resolve(sourceRoot), 'libs', 'generic');
    let present = false;
    try {
      present = exists(root);
    } catch {
      present = false;
    }
    if (present) {
      // Which leg found it: an extracted bundle root is the one the env var names.
      const extracted = process.env.PAPERCUSP_DEV_SOURCE_ROOT?.trim();
      const source: GenericLibsRootSource =
        extracted && resolve(extracted) === resolve(sourceRoot)
          ? 'dev-source-tree'
          : 'integration-root';
      const available = listPackages(root);
      return {
        root,
        sourceRoot: resolve(sourceRoot),
        source,
        pending: false,
        available,
        explanation:
          `This install's first-party component packages are at ${root} ` +
          `(resolved from the ${
            source === 'dev-source-tree'
              ? 'extracted bundled source tree'
              : 'papercusp repo checkout'
          }). Link one with an ABSOLUTE file: dependency, e.g. ` +
          `"@papercusp/sync": "file:${join(root, 'sync')}" — a RELATIVE path like ` +
          `"file:../papercusp/libs/generic/sync" only works inside a dev checkout and is ` +
          `not what this install looks like. ` +
          `${VENDORED_IN_TEMPLATE.join(' and ')} are the exception: each is vendored INTO the ` +
          `template(s) that use it (template-kit into the app-scope roots, pot-app-seam into ` +
          `papercusp-ops-pots), so when your template ships one, link it as "file:./<name>" ` +
          `rather than from here — the vendored copy is the one that reaches a materialized app.`,
      };
    }
  }

  let pending = false;
  try {
    pending = detectArchivePending();
  } catch {
    pending = false;
  }

  return {
    root: null,
    sourceRoot: null,
    source: 'none',
    pending,
    available: [],
    explanation: pending
      ? 'This build SHIPPED a source archive but it has not finished extracting yet, so ' +
        'libs/generic is not on disk at this moment. The absence is transient — re-read this ' +
        'after first-boot extraction completes (minutes, proportional to archive size) and the ' +
        'real path will be reported.'
      : 'This install has NO libs/generic tree, so the first-party component packages ' +
        '(@papercusp/sync, ui-primitives, …) CANNOT be file:-linked here — and none of them is ' +
        'published to npm (every one is private), so there is no fallback. Do NOT write a ' +
        '"file:../papercusp/libs/generic/<pkg>" dependency: it will resolve to nothing and fail ' +
        'npm install. Build with what the template itself vendors (template-kit, pot-app-seam), ' +
        'or install a papercusp build that ships the source archive. Known configurations with ' +
        'no tree: the macOS GUI app (the archive is stashed out for the gui role to keep the DMG ' +
        'small — the macOS SERVER app does ship it), and cross-built macOS bundles (Linux-native ' +
        'node_modules are the wrong architecture) — WI-37790.',
  };
}

/**
 * The `file:` dependency spec for one component package, or null when this
 * install cannot provide it.
 *
 * Returns an ABSOLUTE path on purpose. npm accepts absolute `file:` specifiers,
 * and the materialized app's location is not knowable relative to the source
 * tree (the app goes under the pot parent dir, the tree under the app's shared
 * state dir) — so a relative spec is the thing that cannot be made correct here.
 */
export function genericLibsDependencySpec(
  pkg: string,
  verdict: GenericLibsRootVerdict,
): string | null {
  if (VENDORED_IN_TEMPLATE.includes(pkg)) return `file:./${pkg}`;
  if (!verdict.root) return null;
  // Only claim a package we can actually see, when we were able to enumerate.
  if (verdict.available.length > 0 && !verdict.available.includes(pkg)) return null;
  return `file:${join(verdict.root, pkg)}`;
}

/**
 * A short block for a builder agent's kickoff — the supply-chain fact the GUIDE
 * cannot carry, because the GUIDE is written once and this answer is per-install.
 *
 * Deliberately states the NEGATIVE case at the same volume as the positive one:
 * a builder told nothing assumes the README example works, which is the exact
 * failure this whole work-item exists to remove.
 */
export function describeSupplyChain(verdict: GenericLibsRootVerdict): string {
  const head = '## Component packages on THIS install (read before writing dependencies)';
  if (!verdict.root) {
    return `${head}\n\n⚠ ${verdict.explanation}`;
  }
  const sample = verdict.available.includes('sync') ? 'sync' : verdict.available[0];
  const example = sample
    ? `\n\nExample: "@papercusp/${sample}": "${genericLibsDependencySpec(sample, verdict)}"`
    : '';
  return (
    `${head}\n\n${verdict.explanation}` +
    example +
    `\n\n${verdict.available.length} package(s) are available under that root.`
  );
}
