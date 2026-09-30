/**
 * Materialize a Cupboard app-template into a fresh harness (WI-3198 — the write
 * half behind `templates:new-app`).
 *
 * A `kind=template` listing is GitHub-repo-backed, exactly like a `kind=blueprint`
 * listing (see install-blueprint-core.ts): the template's app skeleton + GUIDE.md
 * live in the public mirror (`github_url`, e.g. Papercusp/templates), one subdir
 * per template keyed by `listing_ref`. Materializing = git-clone the mirror,
 * locate `<clone>/<ref>/`, create the harness (a coding blueprint), then OVERLAY
 * the template's files onto that freshly-created dir.
 *
 * The core is dependency-injected (clone / tmp dir / the create-harness step) so
 * it is unit-testable without real git, network, or the tool dispatcher — mirrors
 * `installBlueprintFromCupboardCore`. The `templates:new-app` tool wires the real
 * impls (gitCloneShallow + an in-process `harness:create`).
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep, relative } from 'node:path';

// Mirrors install-blueprint-core's GITHUB_URL_RE — the clone target is a repo URL.
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;
// listing_ref becomes a within-repo path segment we join into the clone dir — a
// safe SINGLE segment (mirrors templates.ts SAFE_REF_RE). `..` slips this charset
// gate but is caught by assertInside below (defense in depth).
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export class MaterializeTemplateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MaterializeTemplateError';
  }
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new MaterializeTemplateError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/**
 * Locate the template's source dir within a freshly-cloned mirror: `<clone>/<ref>/`.
 * Unlike a blueprint (which may live at the repo root), a template ALWAYS lives in
 * a per-ref subdir (the mirror is one-subdir-per-template), so a missing subdir is
 * a hard 422 rather than a root fallback.
 */
export function locateTemplateDir(cloneDir: string, ref: string): string {
  if (!SAFE_REF_RE.test(ref)) {
    throw new MaterializeTemplateError(`unsafe template ref ${JSON.stringify(ref)}`, 400);
  }
  const dir = join(cloneDir, ref);
  assertInside(cloneDir, dir, `template ref "${ref}"`);
  if (!existsSync(dir)) {
    throw new MaterializeTemplateError(`template subdir "${ref}/" not found in the mirror repo`, 422);
  }
  return dir;
}

// harness:create writes these into the new dir — the template overlay must NOT
// clobber the harness identity (blueprint.yaml) or the git repo (.git).
const PROTECTED_REL = new Set([join('.papercusp', 'blueprint.yaml')]);

/**
 * Overlay a template's files onto an EXISTING harness dir — a MERGE, not a replace
 * (unlike install-blueprint's copyBlueprintDir, which rm's the target first). Copies
 * `src`'s tree into `targetDir`, overwriting on conflict, EXCLUDING any `.git` and
 * the harness's own `.papercusp/blueprint.yaml` (so `harness:create`'s identity
 * survives). Returns the top-level entries copied (`.git` filtered out).
 */
export async function overlayTemplateFiles(src: string, targetDir: string): Promise<string[]> {
  await fs.cp(src, targetDir, {
    recursive: true,
    force: true,
    filter: (s) => {
      const rel = relative(src, s);
      if (rel.split(sep).includes('.git')) return false;
      if (PROTECTED_REL.has(rel)) return false;
      return true;
    },
  });
  const entries = await fs.readdir(src);
  return entries.filter((e) => e !== '.git');
}

/**
 * A resolved template source: the `<ref>/` dir ready to overlay onto a new harness,
 * plus a cleanup for any scratch it allocated. The remote path clones the mirror into
 * tmp (cleanup = rm); the LOCAL path (v1 bundled first-party templates) points straight
 * at the on-disk dir (cleanup = noop) — the seam that skips the clone for local templates
 * and is the same source abstraction a v2 marketplace install reuses.
 */
export interface TemplateSourceDir {
  srcDir: string;
  cleanup: () => Promise<void>;
}

export interface MaterializeTemplateInput {
  ref: string;
  /**
   * Produce the `<ref>/` source dir to overlay. Runs BEFORE createHarness so a
   * source failure (bad clone / missing subdir) leaves NO durable side effect.
   */
  acquireSourceDir: () => Promise<TemplateSourceDir>;
  /**
   * Create the harness dir + registration, returning its slug + path. Runs AFTER
   * the source is acquired and BEFORE the overlay (so the template files land on the
   * just-created dir).
   */
  createHarness: () => Promise<{ slug: string; path: string }>;
  /**
   * COMPENSATION for a failure AFTER createHarness committed (WI-37768). Optional:
   * omit it and the pre-existing behaviour is unchanged (the pot is left behind).
   *
   * createHarness is the first DURABLE step — it writes a registry row and an on-disk
   * dir. Anything that throws after it used to strand that pot, and because the slug
   * is now taken, the caller's natural recovery (retry with identical args) is the one
   * path that provably CANNOT work: pot:create answers slug_exists forever. Measured
   * 2026-08-10 when a PgBouncer `write CONNECTION_CLOSED` landed mid-call.
   *
   * So: roll the pot back and let the retry succeed. Rollback is best-effort BY
   * DESIGN — the failure that triggered it is frequently the very thing that makes
   * the rollback fail too (a dropped PG connection cannot be used to un-write). Its
   * outcome is therefore REPORTED on the rethrown error rather than swallowed, so the
   * caller can tell "retry will now work" from "the slug is still taken".
   */
  rollbackHarness?: (created: { slug: string; path: string }) => Promise<void>;
}

export interface CloneSourceDeps {
  githubUrl: string;
  ref: string;
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
}

export interface MaterializeTemplateResult {
  slug: string;
  path: string;
  /** Top-level entries copied from the template into the harness. */
  filesCopied: string[];
}

/**
 * A source-acquire that CLONES the public mirror into a tmp dir and locates the
 * `<clone>/<ref>/` subdir. Validates the url+ref up front (before any clone). The
 * returned cleanup removes the tmp clone; a locate failure cleans up + rethrows so
 * no scratch leaks.
 */
export function cloneSourceAcquire(deps: CloneSourceDeps): () => Promise<TemplateSourceDir> {
  return async () => {
    const url = (deps.githubUrl ?? '').trim();
    if (!GITHUB_URL_RE.test(url)) {
      throw new MaterializeTemplateError(
        `invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`,
        400,
      );
    }
    if (!SAFE_REF_RE.test(deps.ref ?? '')) {
      throw new MaterializeTemplateError(`unsafe template ref ${JSON.stringify(deps.ref)}`, 400);
    }
    const cloneDir = join(
      deps.tmpDir(),
      `cupboard-template-${Date.now()}-${Math.floor(performance.now())}`,
    );
    try {
      await deps.cloneRepo(url, cloneDir);
      const srcDir = locateTemplateDir(cloneDir, deps.ref);
      return {
        srcDir,
        cleanup: async () => {
          await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch (e) {
      await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  };
}

/**
 * A source-acquire for an ON-DISK template dir (the v1 bundled local store). No
 * clone, no scratch — the dir IS the `<ref>/` overlay source, so cleanup is a noop.
 */
export function localSourceAcquire(dir: string): () => Promise<TemplateSourceDir> {
  return async () => ({ srcDir: dir, cleanup: async () => {} });
}

export async function materializeTemplateCore(
  input: MaterializeTemplateInput,
): Promise<MaterializeTemplateResult> {
  if (!SAFE_REF_RE.test(input.ref ?? '')) {
    throw new MaterializeTemplateError(`unsafe template ref ${JSON.stringify(input.ref)}`, 400);
  }
  const { srcDir, cleanup } = await input.acquireSourceDir();
  try {
    // Source acquired (no durable side effect yet) → now create the harness, then
    // overlay the template onto it.
    const created = await input.createHarness();
    // From here on the pot EXISTS. Every later failure must compensate, or it
    // strands the slug and blocks its own retry (WI-37768).
    try {
      const filesCopied = await overlayTemplateFiles(srcDir, created.path);
      return { slug: created.slug, path: created.path, filesCopied };
    } catch (e) {
      throw await compensateCreatedHarness(e, created, input.rollbackHarness);
    }
  } finally {
    await cleanup().catch(() => {});
  }
}

/**
 * Roll back a committed harness after a later step failed, and fold the rollback's
 * OUTCOME into the error the caller sees (WI-37768).
 *
 * Exported because `templates:new-app` needs the identical treatment for the steps it
 * runs after materializeTemplateCore returns — one implementation, so the two call
 * sites cannot drift into reporting the same situation differently.
 *
 * Never throws a rollback failure over the original error: the original is the cause,
 * the rollback outcome is context. Reporting it the other way round would hide why the
 * call failed behind a secondary symptom.
 */
export async function compensateCreatedHarness(
  cause: unknown,
  created: { slug: string; path: string },
  rollbackHarness?: (created: { slug: string; path: string }) => Promise<void>,
): Promise<Error> {
  const base = cause instanceof Error ? cause.message : String(cause);
  const status = cause instanceof MaterializeTemplateError ? cause.status : 500;

  if (!rollbackHarness) {
    return new MaterializeTemplateError(
      `${base} — the pot "${created.slug}" WAS created before this failure and has NOT been rolled back ` +
        `(no rollback was wired), so retrying with the same slug will fail with slug_exists. ` +
        `Recover with pot:obliterate { slug: "${created.slug}", confirm: true }, or retry under a different slug.`,
      status,
    );
  }

  try {
    await rollbackHarness(created);
    return new MaterializeTemplateError(
      `${base} — the pot "${created.slug}" was created before this failure and HAS BEEN ROLLED BACK, ` +
        `so retrying with the same slug is safe.`,
      status,
    );
  } catch (rollbackError) {
    const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    return new MaterializeTemplateError(
      `${base} — the pot "${created.slug}" was created before this failure and ROLLBACK ALSO FAILED ` +
        `(${detail.slice(0, 200)}), so the slug is still taken and retrying with it will fail with slug_exists. ` +
        `Recover with pot:obliterate { slug: "${created.slug}", confirm: true }, or retry under a different slug.`,
      status,
    );
  }
}
