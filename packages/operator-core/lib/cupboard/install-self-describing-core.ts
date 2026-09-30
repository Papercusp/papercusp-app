/**
 * install-self-describing-core — the ONE generic "install a self-describing dir
 * from a Cupboard mirror repo into a writable user layer" core
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004, D-003).
 *
 * WHY THIS EXISTS
 * ---------------
 * `install-template-core.ts` already implemented this shape, but hard-wired to
 * templates in exactly four places: the manifest filename it requires
 * (`template.yaml`), the reader it parses with (`readTemplateDir`), the user layer
 * it writes into (`userTemplatesDir`), and its error/label strings. Everything
 * else — the GitHub-URL guard, the safe-ref guard, the clone-to-tmp, the
 * `<clone>/<ref>/` location, the path-escape assertion, the .git-excluding copy,
 * the guaranteed tmp cleanup — is kind-agnostic.
 *
 * Adding `rubric` and `recipe` listings (each ALSO a self-describing dir in a
 * mirror repo, installed into its own writable user layer) would have meant
 * copying those ~100 lines twice, including the two SECURITY guards
 * (`assertInside` path-escape and `SAFE_REF_RE`) — the exact duplication where a
 * later fix lands in one copy and silently misses the others.
 *
 * This is the WRITE-half sibling of `self-describing-store.ts`, which already
 * shares the READ half across the template and rubric stores on the same
 * reasoning (its header records that as the Q2 consult outcome: "share the read
 * half, keep the write halves separate" — that ruling was about the SEED vs
 * OVERLAY write paths, which genuinely differ, not about this clone-and-place
 * path, which does not).
 *
 * The core stays dependency-injected (clone / user dir / tmp dir) so it is
 * unit-testable without real git, network, or the host filesystem layout.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalTreeDigest,
  GIT_OBJECT_ID_RE,
  HEX_SHA256_RE,
  type TreeDigestEntry,
} from '@papercusp/artifact-registry';

// A mirror-repo clone target. Mirrors install-blueprint-core / install-template-core.
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;
// A ref becomes BOTH a directory name under the user layer AND a within-repo path
// segment, so it must be a safe SINGLE segment. UNTRUSTED (from the listing/caller).
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

/** Machine-readable refusal codes a caller can map without parsing the message. */
export type InstallSelfDescribingCode =
  | 'malformed_pin'
  | 'content-address-mismatch'
  | 'listing_ref_missing';

export class InstallSelfDescribingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: InstallSelfDescribingCode,
  ) {
    super(message);
    this.name = 'InstallSelfDescribingError';
  }
}

/**
 * The content pin a self-describing listing carries once the Cupboard Worker has
 * pinned it at publish (cupboard-release-pipeline-content-trust-2026-09-16 P-001,
 * D-003: `pinned_commit_sha` + `pinned_tree_digest`). The installer fetches
 * EXACTLY `commitSha`, recomputes the digest of `<ref>/` and refuses on any
 * difference — so the bytes an operator approved are the bytes every install
 * receives (P-002).
 */
export interface ContentPinRef {
  /** The default-branch head the Worker pinned — a 40-hex (or 64-hex) git object id. */
  commitSha: string;
  /** `canonicalTreeDigest` over every blob under `<ref>/` at that commit — 64-hex sha256. */
  treeDigest: string;
}

/** What the install verified about the content it placed. `null` ⇒ the input carried
 *  no pin (a pre-028 listing, an offline bundle unit, or a direct github_url install),
 *  so the tip of the default branch was cloned UNVERIFIED — the caller should say so. */
export interface VerifiedContentPin extends ContentPinRef {
  /** Blobs under `<ref>/` that went into the recomputed digest. */
  fileCount: number;
}

/** What makes one installable KIND different from another. Everything a caller
 *  must supply to turn the generic core into a concrete installer. */
export interface SelfDescribingKindSpec<TMeta> {
  /** Human label used in error messages ('template', 'rubric', 'recipe'). */
  label: string;
  /** The manifest file that MUST be present for the dir to be that kind
   *  ('template.yaml', 'rubric.json', 'recipe.json'). Checked before anything
   *  lands in the user store, so a wrong-kind subdir 422s rather than installing. */
  manifestFile: string;
  /** Parse the source dir with the SAME reader the store enumeration uses, so the
   *  metadata reported here matches what the corresponding `*:list` will show once
   *  installed. Return null ⇒ the dir does not parse (422). */
  readDir: (dir: string, ref: string) => TMeta | null;
  /** Absolute path of the writable user layer for this kind. */
  userDir: () => string;
}

export interface InstallSelfDescribingInput {
  /** The mirror repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo discriminator — REQUIRED (content always lives in a per-ref subdir). */
  listingRef: string;
  /** Optional source-qualified local directory name. The source is still read
   * from listingRef; this only changes the user-layer destination. */
  targetRef?: string;
  /** Explicit update path. Default installs remain create-only. */
  replaceExisting?: boolean;
  /** The listing's content pin (P-002). Present ⇒ the install fetches exactly
   *  `pin.commitSha` and refuses `content-address-mismatch` unless the recomputed
   *  digest of `<listingRef>/` equals `pin.treeDigest`. Absent ⇒ unverified tip clone. */
  pin?: ContentPinRef;
}

export interface InstallSelfDescribingDeps {
  /** Shallow-clone the default-branch TIP of `url` into `dest` (which does not yet
   *  exist). Throws on failure. Used ONLY when the input carries no pin. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** Fetch exactly commit `sha` of `url` into `dest` (which does not yet exist) and
   *  check it out — never the branch tip. Throws on failure (an unreachable sha
   *  included). Real: `git init` + `fetch --depth 1 origin <sha>` + checkout. */
  fetchAtSha: (url: string, dest: string, sha: string) => Promise<void>;
  /** Every BLOB under `<ref>/` at commit `sha` of the checkout at `cloneDir`, as
   *  repo-relative paths (the `<ref>/` prefix KEPT) with their git blob ids — the
   *  same (path, sha) pairs the publisher digested from GitHub's tree API, so the
   *  two digests compare as plain strings. Real: `git ls-tree -r -z <sha> -- <ref>`. */
  listTreeBlobs: (cloneDir: string, sha: string, ref: string) => Promise<TreeDigestEntry[]>;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
}

export interface InstallSelfDescribingResult<TMeta> {
  ok: true;
  /** The installed ref (its user-layer subdir name). */
  ref: string;
  /** Whatever the kind's own reader produced — the caller shapes its response from this. */
  meta: TMeta;
  /** The clone source (the mirror repo URL). */
  source: string;
  installedTo: string;
  /** The pin this install VERIFIED, or `null` when the input carried none and the
   *  branch tip was placed unverified. Never absent: a caller that forgets to look
   *  still gets an explicit "unverified" rather than a missing field. */
  pin: VerifiedContentPin | null;
}

/** Validate a caller-supplied pin's SHAPE before spending a fetch on it. */
function assertWellFormedPin(pin: ContentPinRef, label: string): void {
  if (!GIT_OBJECT_ID_RE.test(pin.commitSha ?? '')) {
    throw new InstallSelfDescribingError(
      `malformed ${label} pin: commitSha must be a git object id`,
      400,
      'malformed_pin',
    );
  }
  if (!HEX_SHA256_RE.test(pin.treeDigest ?? '')) {
    throw new InstallSelfDescribingError(
      `malformed ${label} pin: treeDigest must be a 64-hex sha256`,
      400,
      'malformed_pin',
    );
  }
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallSelfDescribingError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/**
 * Locate `<cloneDir>/<ref>/`, hard-422ing a missing subdir and re-guarding the ref
 * against path escape (belt-and-braces: the ref already passed SAFE_REF_RE, but this
 * dir is attacker-influenced content and the check is nearly free).
 */
function locateRefDir(cloneDir: string, ref: string, label: string): string {
  const dir = join(cloneDir, ref);
  assertInside(cloneDir, dir, `${label} ref "${ref}"`);
  if (!existsSync(dir)) {
    throw new InstallSelfDescribingError(`"${ref}/" not found in the mirror repo`, 422);
  }
  return dir;
}

/** Recursively copy a content dir into a new `target`, excluding any .git. */
async function copyContentDir(src: string, target: string): Promise<void> {
  await fs.cp(src, target, {
    recursive: true,
    // The caller rejects an existing target before reaching this helper. Keep the
    // copy itself create-only too, so a target that appears between that check and
    // fs.cp cannot be overwritten by a concurrent install.
    force: false,
    errorOnExist: true,
    filter: (s) => !s.split(/[/\\]/).includes('.git'),
  });
}

/**
 * Clone a Cupboard mirror repo, validate `<clone>/<ref>/` is a self-describing dir
 * of the given kind, and place it in that kind's writable user layer.
 *
 * Ordering is deliberate and load-bearing: BOTH validations (manifest present, and
 * the dir parses with the kind's own reader) run BEFORE the create-only
 * `copyContentDir`, so a bad publish can never clobber an already-installed good
 * ref of the same name. Existing refs are a conflict; an explicit update path must
 * be separate from this install path. The tmp clone is removed in `finally` on every
 * path.
 */
export async function installSelfDescribingFromCupboard<TMeta>(
  input: InstallSelfDescribingInput,
  spec: SelfDescribingKindSpec<TMeta>,
  deps: InstallSelfDescribingDeps,
): Promise<InstallSelfDescribingResult<TMeta>> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallSelfDescribingError(
      `invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`,
      400,
    );
  }
  const ref = (input.listingRef ?? '').trim();
  if (!SAFE_REF_RE.test(ref)) {
    throw new InstallSelfDescribingError(
      `unsafe ${spec.label} ref ${JSON.stringify(input.listingRef)}`,
      400,
    );
  }
  const targetRef = (input.targetRef ?? ref).trim();
  if (!SAFE_REF_RE.test(targetRef)) {
    throw new InstallSelfDescribingError(
      `unsafe local ${spec.label} ref ${JSON.stringify(input.targetRef)}`,
      400,
    );
  }

  const cloneDir = join(
    deps.tmpDir(),
    `cupboard-${spec.label}-install-${process.pid}-${randomUUID()}`,
  );
  // Validate the pin's SHAPE before the clone dir exists, so a malformed pin costs no
  // network and leaves nothing to clean up.
  if (input.pin) assertWellFormedPin(input.pin, spec.label);

  try {
    let verifiedPin: VerifiedContentPin | null = null;
    if (input.pin) {
      // P-002: fetch EXACTLY the pinned commit — never the branch tip — and refuse
      // unless `<ref>/` still hashes to what the Worker pinned at publish. Verification
      // runs BEFORE manifest/parse validation and before anything touches the user
      // layer, so tampered bytes never even get parsed.
      await deps.fetchAtSha(url, cloneDir, input.pin.commitSha);
      const entries = await deps.listTreeBlobs(cloneDir, input.pin.commitSha, ref);
      if (entries.length === 0) {
        throw new InstallSelfDescribingError(
          `"${ref}/" has no blobs at pinned commit ${input.pin.commitSha}`,
          422,
          'listing_ref_missing',
        );
      }
      const digest = await canonicalTreeDigest(entries);
      if (digest !== input.pin.treeDigest) {
        throw new InstallSelfDescribingError(
          `content-address-mismatch: "${ref}/" at ${input.pin.commitSha} digests to ${digest}, listing pinned ${input.pin.treeDigest} — refusing to install content that differs from what was approved`,
          422,
          'content-address-mismatch',
        );
      }
      verifiedPin = { ...input.pin, fileCount: entries.length };
    } else {
      await deps.cloneRepo(url, cloneDir);
    }
    const srcDir = locateRefDir(cloneDir, ref, spec.label);

    if (!existsSync(join(srcDir, spec.manifestFile))) {
      throw new InstallSelfDescribingError(
        `"${ref}/" in the mirror repo is not a ${spec.label} dir (no ${spec.manifestFile})`,
        422,
      );
    }
    const meta = spec.readDir(srcDir, targetRef);
    if (!meta) {
      throw new InstallSelfDescribingError(
        `${spec.label} "${ref}" failed to parse its ${spec.manifestFile}`,
        422,
      );
    }

    const userDir = spec.userDir();
    const target = join(userDir, targetRef);
    assertInside(userDir, target, `${spec.label} ref "${targetRef}"`);
    const targetExists = existsSync(target);
    if (targetExists && input.replaceExisting !== true) {
      throw new InstallSelfDescribingError(
        `${spec.label} "${targetRef}" is already installed at ${target}; refusing to overwrite`,
        409,
      );
    }
    await fs.mkdir(userDir, { recursive: true });
    if (!targetExists) {
      await copyContentDir(srcDir, target);
    } else {
      const suffix = `${process.pid}-${randomUUID()}`;
      const incoming = `${target}.incoming-${suffix}`;
      const backup = `${target}.backup-${suffix}`;
      try {
        await copyContentDir(srcDir, incoming);
        await fs.rename(target, backup);
        try {
          await fs.rename(incoming, target);
        } catch (error) {
          await fs.rename(backup, target).catch(() => {});
          throw error;
        }
        await fs.rm(backup, { recursive: true, force: true });
      } finally {
        await fs.rm(incoming, { recursive: true, force: true }).catch(() => {});
        if (!existsSync(target) && existsSync(backup)) {
          await fs.rename(backup, target).catch(() => {});
        }
      }
    }

    return { ok: true, ref: targetRef, meta, source: url, installedTo: target, pin: verifiedPin };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
