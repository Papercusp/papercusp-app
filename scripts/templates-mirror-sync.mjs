#!/usr/bin/env node
// templates-mirror-sync — anti-rot guard for the PUBLIC content mirror
// (plan app-templates-2026-07-04 P-027; RECOVERED + re-wired by
// template-supply-chain-repair-2026-08-10 P-006 / WI-37775).
//
// PROVENANCE — read this before assuming the file is new. It was written
// 2026-07-05 and really did run (it is what vendored the seam package into the
// live mirror), but it was auto-committed in a SIDE CLONE that sat 141 commits
// ahead of its own origin and was never pushed — so it never entered the
// canonical repo, `git log --all` here could not see it, and templates/README.md
// went on advertising a drift guard that did not exist. It is restored here,
// canonically, with the hive->pot rename applied.
//
// Official template/rubric listings and the workspace-host bundle publish from the public mirror repo
// (Papercusp/templates) because the Cupboard worker rejects private repos;
// this monorepo's templates/ tree stays canonical. This script diffs the
// canonical tree against a local clone of the mirror and either reports
// drift (default: exit 1) or applies + commits + pushes the sync (--push),
// so the published mirror can never silently trail the canonical tree.
//
// Sync map (mirror uses a FLAT layout — template dirs at repo root):
//   templates/<id>/**                      -> <mirror>/<id>/**
//   templates/README.md                    -> <mirror>/README.md
//   rubrics/<id>/**                        -> <mirror>/<id>/**
//   content-bundles/workspace-host/**      -> <mirror>/bundles/workspace-host/**
//   and for each VENDORED package (template-kit, pot-app-seam — WI-2891):
//   libs/generic/<pkg>/src/**              -> <mirror>/<pkg>/src/**   (minus *.test.ts)
//   libs/generic/<pkg>/package.json        -> <mirror>/<pkg>/package.json
//   libs/generic/<pkg>/tsconfig.json       -> <mirror>/<pkg>/tsconfig.json
// Mirror-OWNED (never synced, never flagged): root package.json /
// package-lock.json / vitest.config.ts etc. (the runnable-harness plumbing,
// including its file: deps), each vendored <pkg>/README.md, node_modules,
// .git.
//
// Usage:
//   npm run mirror:check                  # drift report, exit 1 on ANY drift
//   npm run mirror:push                   # apply + commit + push the sync
//   node scripts/templates-mirror-sync.mjs [--mirror <path>] [--push] [--message <msg>]
//   mirror path default: $PC_TEMPLATES_MIRROR or /tmp/pc-templates-mirror
//   exit codes: 0 in sync (or pushed clean) · 1 drift (check mode) · 2 usage/env error

import { promises as fs } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIRROR_REMOTE = "github.com/Papercusp/templates";
const MIRROR_OWNER = "Papercusp";
const MIRROR_REPO = "templates";

/**
 * Parse a canonical GitHub HTTPS or SSH remote into its repository identity.
 *
 * Git accepts both `https://github.com/Owner/repo.git` and the scp-shaped
 * `git@github.com:Owner/repo.git` form. Comparing the parsed owner/repo keeps
 * the push guard fail-closed for every other host or repository without
 * rejecting equivalent transport forms.
 *
 * @param {string} remote
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubRemote(remote) {
  const owner = "([A-Za-z0-9][A-Za-z0-9_.-]{0,38})";
  const repo = "([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)";
  const https = new RegExp(`^https://github\\.com/${owner}/${repo}(?:\\.git)?/?$`);
  const ssh = new RegExp(`^(?:git@github\\.com:|ssh://git@github\\.com/)${owner}/${repo}(?:\\.git)?/?$`);
  const match = https.exec(remote.trim()) ?? ssh.exec(remote.trim());
  if (!match) return null;
  const [, parsedOwner, parsedRepo] = match;
  return parsedOwner && parsedRepo ? { owner: parsedOwner, repo: parsedRepo } : null;
}

/**
 * Compare the parsed GitHub identity, rather than the spelling of its remote.
 * GitHub repository names are case-insensitive, while the parser remains
 * deliberately strict about host and URL shape.
 *
 * @param {string} remote
 * @returns {boolean}
 */
export function isMirrorRemote(remote) {
  const parsed = parseGithubRemote(remote);
  return Boolean(
    parsed &&
      parsed.owner.toLowerCase() === MIRROR_OWNER.toLowerCase() &&
      parsed.repo.toLowerCase() === MIRROR_REPO.toLowerCase(),
  );
}

// Source-shippable packages vendored into the mirror (zero runtime deps,
// `main: ./src/index.ts`) so builders outside papercup can file:-link them.
// NOTE: `hive-app-seam` was renamed to `pot-app-seam`; the live mirror still
// carries the OLD dir, which is precisely the drift this guard now reports.
export const VENDORED = ["template-kit", "pot-app-seam"];

const exists = (p) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/**
 * Recursively list files under dir as dir-relative paths (posix slashes).
 *
 * @param {string} dir
 * @param {{ exclude?: (rel: string) => boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function walk(dir, { exclude = () => false } = {}) {
  const out = [];
  const entries = await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const rel = relative(dir, abs).split(sep).join("/");
    if (rel.split("/").includes("node_modules") || rel.startsWith(".git/"))
      continue;
    if (exclude(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

/**
 * Build the expected manifest: mirror-relative path -> canonical source abs path.
 * Exported so a test can drive it against a synthetic tree without touching the
 * shared checkout.
 *
 * Throws (with `exitCode: 2`) when a vendored package's source is missing —
 * an empty canonical source would otherwise flag every vendored mirror file
 * extraneous, and `--push` would delete them.
 *
 * @param {string} [root]
 * @param {string[]} [vendored]
 * @returns {Promise<{ expected: Map<string, string>, templateIds: string[], rubricIds: string[] }>}
 */
export async function buildExpected(root = ROOT, vendored = VENDORED) {
  const expected = new Map();

  const templatesDir = join(root, "templates");
  const templateIds = (await fs.readdir(templatesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => e.name)
    .sort();
  for (const id of templateIds) {
    for (const rel of await walk(join(templatesDir, id))) {
      expected.set(`${id}/${rel}`, join(templatesDir, id, rel));
    }
  }
  expected.set("README.md", join(templatesDir, "README.md"));

  // Rubrics share this EXISTING public content mirror rather than introducing a
  // second distribution repository. Their ids do not overlap template refs, so
  // both self-describing kinds can remain at the mirror root — the single-segment
  // listing_ref shape their standard Cupboard installers require.
  const rubricsDir = join(root, "rubrics");
  const rubricIds = (await fs.readdir(rubricsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => e.name)
    .sort();
  for (const id of rubricIds) {
    if (templateIds.includes(id)) {
      const err = new Error(`template/rubric mirror ref collision: ${id}`);
      err.exitCode = 2;
      throw err;
    }
    for (const rel of await walk(join(rubricsDir, id))) {
      expected.set(`${id}/${rel}`, join(rubricsDir, id, rel));
    }
  }

  const workspaceHostBundle = join(
    root,
    "content-bundles",
    "workspace-host",
    "bundle.yaml",
  );
  if (!(await exists(workspaceHostBundle))) {
    const err = new Error(
      `workspace-host content bundle missing: ${workspaceHostBundle}`,
    );
    err.exitCode = 2;
    throw err;
  }
  expected.set("bundles/workspace-host/bundle.yaml", workspaceHostBundle);

  for (const pkg of vendored) {
    const pkgDir = join(root, "libs/generic", pkg);
    if (!(await exists(join(pkgDir, "package.json")))) {
      // An uninitialized submodule reads as an EMPTY canonical source, which
      // would flag every vendored mirror file extraneous (and --push would
      // delete them) — refuse instead.
      const err = new Error(`vendored package source missing: ${pkgDir}`);
      err.hint = `submodule not initialized? git submodule update --init libs/generic/${pkg}`;
      err.exitCode = 2;
      throw err;
    }
    for (const rel of await walk(join(pkgDir, "src"), {
      exclude: (r) => r.endsWith(".test.ts"),
    })) {
      expected.set(`${pkg}/src/${rel}`, join(pkgDir, "src", rel));
    }
    // Only expect a top-level file the canonical package ACTUALLY has. tsconfig.json
    // used to be added unconditionally, which was wrong in both directions for
    // pot-app-seam (which ships none): `mirror:check` reported a permanent
    // `missing pot-app-seam/tsconfig.json` that no push could ever satisfy, and
    // `--push` then threw ENOENT out of fs.copyFile mid-apply — breaking the one
    // command the templates README documents for repairing the mirror.
    for (const meta of ["package.json", "tsconfig.json"]) {
      if (await exists(join(pkgDir, meta)))
        expected.set(`${pkg}/${meta}`, join(pkgDir, meta));
    }
  }

  return { expected, templateIds, rubricIds };
}

/**
 * Enumerate the mirror's ACTUAL state over the SYNCED surface only.
 *
 * @param {string} mirror
 * @param {string[]} [vendored]
 * @returns {Promise<Set<string>>}
 */
export async function buildActual(mirror, vendored = VENDORED) {
  const actual = new Set();
  const mirrorRootEntries = await fs.readdir(mirror, { withFileTypes: true });
  const ownedTopDirs = new Set(["node_modules", ".git", ".github"]);
  for (const e of mirrorRootEntries) {
    if (
      e.isDirectory() &&
      !ownedTopDirs.has(e.name) &&
      !vendored.includes(e.name)
    ) {
      for (const rel of await walk(join(mirror, e.name)))
        actual.add(`${e.name}/${rel}`);
    }
  }
  if (await exists(join(mirror, "README.md"))) actual.add("README.md");
  for (const pkg of vendored) {
    if (await exists(join(mirror, pkg))) {
      for (const rel of await walk(join(mirror, pkg), {
        exclude: (r) => r === "README.md",
      })) {
        actual.add(`${pkg}/${rel}`);
      }
    }
  }
  return actual;
}

/**
 * Diff expected vs actual. Byte-compares every file present on both sides.
 *
 * @param {Map<string, string>} expected
 * @param {Set<string>} actual
 * @param {string} mirror
 * @returns {Promise<{ missing: string[], changed: string[], extraneous: string[] }>}
 */
export async function computeDrift(expected, actual, mirror) {
  const drift = { missing: [], changed: [], extraneous: [] };
  for (const [rel, src] of expected) {
    if (!actual.has(rel)) {
      drift.missing.push(rel);
      continue;
    }
    const [a, b] = await Promise.all([
      fs.readFile(src),
      fs.readFile(join(mirror, rel)),
    ]);
    if (!a.equals(b)) drift.changed.push(rel);
  }
  for (const rel of actual) if (!expected.has(rel)) drift.extraneous.push(rel);
  return drift;
}

/**
 * @param {{ missing: string[], changed: string[], extraneous: string[] }} drift
 * @returns {number}
 */
export const driftTotal = (drift) =>
  drift.missing.length + drift.changed.length + drift.extraneous.length;

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : (args.splice(i, 1), true);
  };
  const opt = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const [, v] = args.splice(i, 2);
    return v;
  };
  const push = flag("--push") ?? false;
  const mirror =
    opt("--mirror") ??
    process.env.PC_TEMPLATES_MIRROR ??
    "/tmp/pc-templates-mirror";
  const message =
    opt("--message") ??
    "sync templates mirror from monorepo (templates-mirror-sync)";
  if (args.length) {
    console.error("unknown args:", args.join(" "));
    return 2;
  }

  if (!(await exists(join(mirror, ".git")))) {
    console.error(`mirror clone not found at ${mirror}`);
    console.error(
      `  git clone https://github.com/Papercusp/templates.git ${mirror}`,
    );
    console.error(
      `  then re-run with --mirror ${mirror} (or set PC_TEMPLATES_MIRROR)`,
    );
    return 2;
  }

  let expected;
  let templateIds;
  let rubricIds;
  try {
    ({ expected, templateIds, rubricIds } = await buildExpected(
      ROOT,
      VENDORED,
    ));
  } catch (err) {
    console.error(err.message);
    if (err.hint) console.error(`  ${err.hint}`);
    return err.exitCode ?? 2;
  }

  const actual = await buildActual(mirror, VENDORED);
  const drift = await computeDrift(expected, actual, mirror);

  for (const kind of ["missing", "changed", "extraneous"]) {
    for (const rel of drift[kind].sort())
      console.log(`${kind.padEnd(10)} ${rel}`);
  }
  console.log(
    `[templates-mirror-sync] ${templateIds.length} template dirs + ${rubricIds.length} rubric dirs + workspace-host bundle + ${VENDORED.length} vendored packages + README · ` +
      `${expected.size} files expected · drift: ${drift.missing.length} missing, ` +
      `${drift.changed.length} changed, ${drift.extraneous.length} extraneous`,
  );

  if (driftTotal(drift) === 0) {
    console.log(
      "[templates-mirror-sync] mirror is IN SYNC with the canonical tree",
    );
    return 0;
  }

  if (!push) {
    console.error(
      "[templates-mirror-sync] DRIFT — the published mirror trails the canonical tree.",
    );
    console.error("  apply + push with: npm run mirror:push");
    return 1;
  }

  // ---- --push: apply, commit, push
  let failed = false;
  const git = (...a) => {
    const r = spawnSync("git", ["-C", mirror, ...a], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`git ${a.join(" ")} failed:\n${r.stderr || r.stdout}`);
      failed = true;
      return "";
    }
    return r.stdout.trim();
  };

  const origin = git("remote", "get-url", "origin");
  if (failed) return 2;
  if (!isMirrorRemote(origin)) {
    console.error(
      `refusing to push: origin '${origin}' is not ${MIRROR_REMOTE}`,
    );
    return 2;
  }

  for (const rel of [...drift.missing, ...drift.changed]) {
    const dst = join(mirror, rel);
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.copyFile(expected.get(rel), dst);
  }
  for (const rel of drift.extraneous) await fs.rm(join(mirror, rel));

  if (git("status", "--porcelain") === "") {
    if (failed) return 2;
    console.log("[templates-mirror-sync] nothing to commit after apply");
    return 0;
  }
  git("add", "-A");
  git("commit", "-m", message);
  git("push", "origin", "HEAD");
  if (failed) return 2;
  console.log(
    `[templates-mirror-sync] pushed ${git("rev-parse", "--short", "HEAD")} to ${origin}`,
  );
  return 0;
}

// Run only when executed directly, so the helpers above stay importable.
const invoked = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => process.argv[1])
  : "";
if (invoked === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv));
}
