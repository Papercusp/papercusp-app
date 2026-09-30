/**
 * Install an app-template FROM the Cupboard into the LOCAL template store
 * (cupboard-full-dogfood-2026-07-10 P-003).
 *
 * A `kind=template` listing is GitHub-repo-backed exactly like a blueprint (see
 * install-blueprint-core.ts): the listing points at a mirror repo (e.g.
 * `Papercusp/templates`) whose `<listing_ref>/` subdir is a SELF-DESCRIBING
 * template dir — `template.yaml` (the manifest the materializer reads) +
 * `GUIDE.md` (+ `listing.json` / `COMPONENT_CATALOG.md`). Installing it =
 * git-clone the repo, locate `<clone>/<ref>/`, validate it parses as a template
 * dir, and place the whole dir under the WRITABLE user template layer
 * (`<papercuspRoot>/templates/<ref>/`) — the tier the layered store resolves
 * OVER the bundled first-party floor (template-store.ts: user shadows bundled).
 *
 * This is the install-into-store seam that template-store.ts calls out as the
 * dormant v2 marketplace path: "install a template" = "drop a self-describing
 * dir into the user layer", after which `templates:new-app` materializes it via
 * the same local resolution as a bundled template. The bundle stays the offline
 * floor; an installed ref simply shadows it (resolve local→installed).
 *
 * Distinct from materialize-template-core.ts, which OVERLAYS a `<ref>/` onto a
 * freshly-created harness (the `templates:new-app` write half). This core only
 * populates the store; materialize is the subsequent, unchanged step.
 *
 * The core is dependency-injected (clone / user dir / tmp dir) so it is
 * unit-testable without real git, network, or the host filesystem layout —
 * mirrors `installBlueprintFromCupboardCore`. The route wires the real impls.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { locateTemplateDir } from './materialize-template-core';
import { readTemplateDir } from './template-store';

// Mirrors install-blueprint-core / materialize-template-core: the clone target is
// a repo URL.
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;
// A template ref becomes a directory under the user templates dir AND a within-repo
// path segment — a safe SINGLE segment (mirrors templates.ts / materialize's
// SAFE_REF_RE). It is UNTRUSTED (from the listing / caller).
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export class InstallTemplateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'InstallTemplateError';
  }
}

export interface InstallTemplateCoreInput {
  /** The template mirror repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo template discriminator — REQUIRED (a template always lives in a
   *  per-ref subdir; unlike a blueprint there is no repo-root fallback). */
  listingRef: string;
}

export interface InstallTemplateCoreResult {
  ok: true;
  /** The installed template's ref (its user-store subdir name). */
  ref: string;
  /** The template id (from listing.json / template.yaml `id`, else the ref). */
  id: string;
  title: string;
  version: string;
  source: string;
  installedTo: string;
}

export interface InstallTemplateCoreDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** Absolute path of the writable user templates dir (`<papercuspRoot>/templates`). */
  userTemplatesDir: () => string;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallTemplateError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/** Recursively copy a template dir into `target`, excluding any .git. */
async function copyTemplateDir(src: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(src, target, {
    recursive: true,
    filter: (s) => !s.split(/[/\\]/).includes('.git'),
  });
}

export async function installTemplateFromCupboardCore(
  input: InstallTemplateCoreInput,
  deps: InstallTemplateCoreDeps,
): Promise<InstallTemplateCoreResult> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallTemplateError(
      `invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`,
      400,
    );
  }
  const ref = (input.listingRef ?? '').trim();
  if (!SAFE_REF_RE.test(ref)) {
    throw new InstallTemplateError(`unsafe template ref ${JSON.stringify(input.listingRef)}`, 400);
  }

  const cloneDir = join(deps.tmpDir(), `cupboard-template-install-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    await deps.cloneRepo(url, cloneDir);
    // locateTemplateDir hard-422s a missing `<clone>/<ref>/` (a template always
    // lives in a per-ref subdir), and re-guards the ref against path escape.
    const srcDir = locateTemplateDir(cloneDir, ref);

    // A real template dir MUST carry a template.yaml — the manifest the store +
    // materializer read. Reject a subdir that is not a template (422) BEFORE it
    // lands in the user store.
    if (!existsSync(join(srcDir, 'template.yaml'))) {
      throw new InstallTemplateError(
        `"${ref}/" in the mirror repo is not a template dir (no template.yaml)`,
        422,
      );
    }
    // Parse with the SAME reader the store enumeration uses, so the metadata we
    // report matches what `templates:list` will show once installed.
    const meta = readTemplateDir(srcDir, ref, 'user');
    if (!meta) {
      throw new InstallTemplateError(`template "${ref}" failed to parse its listing.json/template.yaml`, 422);
    }

    const userDir = deps.userTemplatesDir();
    const target = join(userDir, ref);
    assertInside(userDir, target, `template ref "${ref}"`);
    await fs.mkdir(userDir, { recursive: true });
    await copyTemplateDir(srcDir, target);

    return {
      ok: true,
      ref,
      id: meta.id,
      title: meta.title,
      version: meta.version,
      source: url,
      installedTo: target,
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
