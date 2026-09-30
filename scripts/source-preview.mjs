#!/usr/bin/env node
// scripts/source-preview.mjs — the private source preview (plan dhh-source-preview-2026-09-28).
//
// WHAT IT IS. Invited individuals get READ access to one private GitHub repo,
// Papercusp/papercusp-preview, holding the PUBLIC-SAFE source cut: exactly what every
// desktop installer already ships as sidecar/source.tar.zst (D-003/D-004), minus
// node_modules. It is never the real Papercusp/papercup repo, never its private
// submodule repos, and never git history.
//
// WHAT IT REUSES — there is no second exporter and no second secret list (D-002):
//   selection  papercusp-desktop/bin/lib/source-tree-selection.sh (shared with the
//              installer's bin/stage-source-tree.sh), run through
//              papercusp-desktop/bin/source-tree-select.sh (same GNU tar engine,
//              same audit-owned identity scrub);
//   gate       papercusp-desktop/bin/audit-release-bundle.py — the full bundle audit
//              over a packed copy (forbidden paths + identity + credentials) plus
//              --scan-dir over the directory — with gitleaks and trufflehog as
//              additional detectors. Any finding refuses; a scanner that cannot run
//              refuses (a gate that looked at nothing is not a pass).
//
// WHAT IT ADDS: a CLEAN export of one pinned commit (git archive of the superproject
// and every submodule at its gitlink — no working-tree debris), MANIFEST.json,
// NOTICE, README.md, and a drift-checked, gated, single-commit publish.
//
// Usage:
//   node scripts/source-preview.mjs export [--ref main] [--out <dir>]
//   node scripts/source-preview.mjs gate <dir>
//   node scripts/source-preview.mjs check [--ref main] [--remote <url>]
//   node scripts/source-preview.mjs push  [--ref main] [--remote <url>] [--confirm]
// npm: preview:export · preview:gate · preview:check · preview:push
// Every command takes --target preview|public (default preview). The public target
// (plan open-source-release-2026-09-29) publishes to Papercusp/papercusp-app under the
// Elastic License 2.0, APPEND-ONLY; the preview is replaced wholesale. See TARGETS.
//
// PAPERCUSP_RELEASE_OWNER_NAME (and _EMAIL) must be exported — read at run time, never
// written anywhere — exactly as for a release cut: the scrub and the gate refuse
// without them.
//
// PAPERCUSP_UPDATE_BASE_URL names the release host whose index.html is the releases
// page README.md links to. It is deployment state, never committed here: the CLI fills
// it from ~/.papercusp/release-host.env (the file the release scripts load) when unset,
// and the export refuses without it rather than publish a README with no download link.
//
// Exit: 0 ok / in sync · 1 finding / drift / refused · 2 usage or cannot check.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { NOTICES_FILE, collectThirdPartyNotices } from './check-licenses.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PREVIEW_REPO = 'Papercusp/papercusp-preview';
// NOT 'Papercusp/papercusp': that name is the private libs/papercusp library repo
// (open-source-release-2026-09-29 D-016), and an append push there would stack the export
// on top of the library's own history.
export const PUBLIC_REPO = 'Papercusp/papercusp-app';
export const SOURCE_REPO = 'Papercusp/papercup';
export const DEFAULT_REMOTE = `https://github.com/${PREVIEW_REPO}.git`;
export const DEFAULT_REF = 'main';
/** The public target's license (Elastic License 2.0, plan open-source-release-2026-09-29 D-003). */
export const PUBLIC_LICENSE_PATH = join(ROOT, 'scripts', 'public-release', 'LICENSE');

/**
 * Where an export is published (plan open-source-release-2026-09-29 P-002/P-003).
 * - preview: the private, invite-only evaluation snapshot. Replaced WHOLESALE by one
 *   parentless commit on every push, so no history accumulates there.
 * - public: the open-source repository. APPEND-ONLY: every export is committed on top of
 *   the current public main and pushed without --force, so forks, clones and pull
 *   requests keep a history they can rebase onto. It must never be the preview repo:
 *   the preview's earlier force-pushed snapshots stay fetchable by SHA.
 * @typedef {{ key: 'preview' | 'public', repo: string, history: 'replace' | 'append', purpose: string, email: string }} Target
 * @type {Record<'preview' | 'public', Target>}
 */
export const TARGETS = {
  preview: { key: 'preview', repo: PREVIEW_REPO, history: 'replace', purpose: 'private source preview — public-safe cut (plan dhh-source-preview-2026-09-28)', email: 'source-preview@papercusp.invalid' },
  public: { key: 'public', repo: PUBLIC_REPO, history: 'append', purpose: 'public source release — public-safe cut (plan open-source-release-2026-09-29)', email: 'public-export@papercusp.invalid' },
};

/** @param {string} [name] @returns {Target} */
export function resolveTarget(name = 'preview') {
  const t = TARGETS[/** @type {'preview' | 'public'} */ (name)];
  if (!t) throw new PreviewError(`unknown target ${name} (expected ${Object.keys(TARGETS).join(' | ')})`, 2);
  return t;
}

/** @param {Target} target */
export const defaultRemote = (target) => `https://github.com/${target.repo}.git`;

/**
 * Refuse a remote that names the OTHER target's repository: pushing the public cut into the
 * preview would flip nothing but mislabel it, and the preview's --force replace would erase
 * the public history everyone forked from.
 * @param {Target} target @param {string} remote
 */
export function assertRemoteMatchesTarget(target, remote) {
  const repoOf = (r) => r.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase();
  const named = repoOf(remote);
  // Private repositories no target may ever publish to: the source superproject and the
  // libs/papercusp library repo, which owns the name 'Papercusp/papercusp' (D-016).
  for (const privateRepo of [SOURCE_REPO, 'Papercusp/papercusp']) {
    if (named === privateRepo.toLowerCase()) {
      throw new PreviewError(`remote ${remote} is the private repository ${privateRepo} — refusing to publish the ${target.key} target there`, 2);
    }
  }
  for (const other of Object.values(TARGETS)) {
    if (other.key !== target.key && named === other.repo.toLowerCase()) {
      throw new PreviewError(`remote ${remote} is the ${other.key} repository (${other.repo}) — refusing to publish the ${target.key} target there`, 2);
    }
  }
}
const DESKTOP_BIN = join(ROOT, 'papercusp-desktop', 'bin');
export const SELECT_SCRIPT = join(DESKTOP_BIN, 'source-tree-select.sh');
export const SELECTION_LIB = join(DESKTOP_BIN, 'lib', 'source-tree-selection.sh');
export const AUDIT_SCRIPT = join(DESKTOP_BIN, 'audit-release-bundle.py');
/** Files this script adds at the export root, outside the shared selection. */
export const ADDED_FILES = ['NOTICE', 'README.md', 'MANIFEST.json'];
/** The Tauri desktop shell, shipped only by the public target (P-004). */
export const DESKTOP_DIR = 'papercusp-desktop';
/**
 * What the public target leaves out of the desktop shell (GNU tar patterns, relative to
 * the shell root): generated sidecar copies, build output, local agent state and stray
 * files, and the internal VM/cloud test rigs, which drive the maintainers' own machines.
 */
export const DESKTOP_PUBLIC_EXCLUDES = [
  './src-tauri/env-sidecars',
  './src-tauri/target',
  './node_modules',
  './.papercusp',
  './.papercup-console-active.*',
  './b',
  './bin/vm-rig',
  './bin/deb-hetzner-*',
  './bin/mac-vm-*',
  './scripts/linux-test-vm',
  './scripts/windows-vm',
];
/**
 * Community-health files the public target copies verbatim from scripts/public-release/
 * (plan open-source-release-2026-09-29 P-007). Every one is required: a public repo
 * without a disclosure path or contribution terms is not recoverable once cloned.
 */
export const PUBLIC_COMMUNITY_FILES = [
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  // P-011: the agreement CONTRIBUTING.md promises, and the bot that asks for it.
  'CLA.md',
  '.github/workflows/cla.yml',
  // P-009: the public repository's own CI — the private repo's workflows never ship.
  '.github/workflows/ci.yml',
];
/** The public target also adds its LICENSE, the community files, and THIRD-PARTY-NOTICES.md
 *  (generated from the export's own lockfiles by check-licenses.mjs — P-017 step 5). */
export const PUBLIC_ADDED_FILES = [...ADDED_FILES, 'LICENSE', ...PUBLIC_COMMUNITY_FILES, NOTICES_FILE];
/** Top-level entries the added files create (`.github` for the workflows) — the README's
 *  tree listing describes the development tree, not these. */
const PUBLIC_ADDED_TOPS = new Set(PUBLIC_ADDED_FILES.map((f) => f.split('/')[0]));
/** The env var holding the release host base URL; `${base}/index.html` is the releases page. */
export const RELEASE_BASE_ENV = 'PAPERCUSP_UPDATE_BASE_URL';
/** Where the release scripts keep that value (papercusp-desktop/bin/lib/release-host.sh). */
export const RELEASE_HOST_ENV_PATH = join(homedir(), '.papercusp', 'release-host.env');

/** @typedef {{ name: string, ok: boolean, status: string, detail: string }} GateResult */
/** @typedef {{ detector: string, rule: string, path: string, line: number, sha256: string, allowlisted?: boolean }} GateFinding */
/** @typedef {{ ok: boolean, exitCode: number, results: GateResult[], findings?: GateFinding[] }} GateVerdict */
/** @typedef {(dir: string, opts: { env?: NodeJS.ProcessEnv }) => Promise<GateVerdict>} Gate */
/** @typedef {(message: string) => void} Log */

export class PreviewError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Run a command, returning stdout; throw PreviewError with stderr on failure. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new PreviewError(`${cmd} failed to start: ${r.error.message}`, 2);
  if (r.status !== 0) {
    throw new PreviewError(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  }
  return r.stdout;
}

const git = (repo, args, opts) => run('git', ['-C', repo, ...args], opts);

/** Resolve a ref to a full commit SHA in `repo`. */
export function resolveCommit(repo, ref) {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
}

/** Every gitlink (submodule pin) recorded in `sha`'s tree: [{ path, sha }]. */
export function listGitlinks(repo, sha) {
  const out = git(repo, ['ls-tree', '-r', '-z', sha]);
  const links = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, obj] = entry.slice(0, tab).split(' ');
    if (mode === '160000' && type === 'commit') links.push({ path: entry.slice(tab + 1), sha: obj });
  }
  return links;
}

/** The shared top-level allowlist, read from the selection library itself. */
export function allowlistTops(selectionLib = SELECTION_LIB) {
  const out = run('bash', ['-c', '. "$1"; printf "%s\\n" $SOURCE_TREE_ALLOWLIST', '_', selectionLib]);
  const tops = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (tops.length === 0) throw new PreviewError(`empty allowlist from ${selectionLib}`, 2);
  return new Set(tops);
}

function extractArchive(repo, sha, dest) {
  run('bash', ['-c', 'set -euo pipefail; git -C "$1" archive --format=tar "$2" | tar -xf - -C "$3"', '_', repo, sha, dest]);
}

/**
 * Materialize `sha` of `repo` into `dest` from git objects only (no working-tree
 * files), recursing into every submodule whose top-level entry the allowlist ships.
 * An unresolvable gitlink REFUSES: silently exporting a hole would publish a tree
 * that is not the commit the manifest names.
 * @returns {{ path: string, sha: string }[]} the submodules materialized
 */
export function materializeCommit({ repo, sha, dest, allow, prefix = '' }) {
  extractArchive(repo, sha, prefix ? join(dest, prefix) : dest);
  const subs = [];
  for (const link of listGitlinks(repo, sha)) {
    const full = prefix ? `${prefix}/${link.path}` : link.path;
    if (!allow.has(full.split('/')[0])) continue;
    const subRepo = join(repo, link.path);
    // The submodule must be its OWN checkout: an uninitialised submodule is an
    // empty dir inside the parent, where `git -C` would silently answer for the
    // parent repository instead.
    const known = existsSync(subRepo)
      && spawnSync('git', ['-C', subRepo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() === realpathSync(subRepo)
      && spawnSync('git', ['-C', subRepo, 'cat-file', '-e', `${link.sha}^{commit}`]).status === 0;
    if (!known) {
      throw new PreviewError(`unresolvable gitlink ${full} @ ${link.sha} — its commit is not present in ${subRepo}; run \`git submodule update --init\` or fetch it, then retry`);
    }
    const target = join(dest, full);
    // git archive leaves the gitlink as an empty directory; make sure it exists.
    run('mkdir', ['-p', target]);
    subs.push({ path: full, sha: link.sha });
    subs.push(...materializeCommit({ repo: subRepo, sha: link.sha, dest, allow, prefix: full }));
  }
  return subs;
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

export function noticeText(manifest) {
  if (manifest.target === 'public') {
    return [
      'Papercusp',
      '',
      `Copyright (c) ${manifest.year} Papercusp.`,
      '',
      'Licensed under the Elastic License 2.0 (see LICENSE). Libraries that carry their own',
      'license file or SPDX header (for example the permissively licensed libs/generic/*)',
      'are covered by that license instead.',
      '',
      'Third-party components keep their own licenses.',
      '',
      `Exported from ${manifest.source.repo} @ ${manifest.source.commit}`,
      '',
    ].join('\n');
  }
  return [
    'Papercusp — private source preview',
    '',
    `Copyright (c) ${manifest.year} Papercusp. All rights reserved.`,
    '',
    'This source is shared privately, by invitation, for EVALUATION ONLY.',
    '',
    'You may read it and run it on your own machines to evaluate Papercusp.',
    'You may not redistribute, publish, sublicense or sell it, in whole or in part,',
    'or use it to build or train a competing product or model.',
    '',
    'No license is granted beyond this evaluation permission. Access can be',
    'revoked at any time, and this notice applies to every copy you keep.',
    '',
    `Snapshot: ${manifest.source.repo} @ ${manifest.source.commit}`,
    '',
  ].join('\n');
}

async function describeWorkspaces(dir) {
  const rows = [];
  for (const top of ['apps', 'libs', 'packages']) {
    const base = join(dir, top);
    if (!existsSync(base)) continue;
    const walk = async (rel, depth) => {
      const abs = join(dir, rel);
      const pkg = join(abs, 'package.json');
      if (existsSync(pkg)) {
        let name = rel;
        let description = '';
        try {
          const j = JSON.parse(await fs.readFile(pkg, 'utf8'));
          name = j.name || rel;
          description = typeof j.description === 'string' ? j.description : '';
        } catch { /* unparsable package.json: list the path only */ }
        rows.push({ rel, name, description });
        return;
      }
      if (depth === 0) return;
      for (const ent of await fs.readdir(abs, { withFileTypes: true })) {
        if (ent.isDirectory()) await walk(`${rel}/${ent.name}`, depth - 1);
      }
    };
    for (const ent of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.isDirectory()) await walk(`${top}/${ent.name}`, 1);
    }
  }
  return rows;
}

/**
 * The releases page README.md links to: `${PAPERCUSP_UPDATE_BASE_URL}/index.html`.
 * Reads `env` only — never a file — so a test's verdict cannot depend on the home
 * directory it runs in; the CLI fills `env` first (loadReleaseHost).
 * @param {NodeJS.ProcessEnv} env
 */
export function releasesPageUrl(env) {
  const base = (env[RELEASE_BASE_ENV] ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/\S+$/.test(base)) {
    throw new PreviewError(`${RELEASE_BASE_ENV} is ${base ? `not an https URL (${base})` : 'unset'} — README.md must link the releases page; export it or provide ${RELEASE_HOST_ENV_PATH}`, 2);
  }
  return `${base}/index.html`;
}

/**
 * Fill PAPERCUSP_UPDATE_BASE_URL from the release scripts' own config file when the
 * environment is silent. An exported value always wins, as in release-host.sh.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [path]
 */
export function loadReleaseHost(env = process.env, path = RELEASE_HOST_ENV_PATH) {
  if (env[RELEASE_BASE_ENV] || !existsSync(path)) return;
  const value = parseEnv(readFileSync(path, 'utf8'))[RELEASE_BASE_ENV];
  if (value) env[RELEASE_BASE_ENV] = value;
}

export async function readmeText(dir, manifest, releasesUrl) {
  const tops = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => !PUBLIC_ADDED_TOPS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const ws = await describeWorkspaces(dir);
  const isPublic = manifest.target === 'public';
  const intro = isPublic
    ? [
      '# Papercusp',
      '',
      'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
      'through shared plans, work items, locks and memory. This repository is its source,',
      'licensed under the Elastic License 2.0 (see LICENSE and NOTICE): you may read, run,',
      'modify and self-host it, but not offer it to others as a hosted or managed service.',
      '',
      `- Exported from \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
      `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
      '- It is the same public-safe source cut the Papercusp Server installer carries, without',
      '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`), plus the',
      '  Tauri desktop shell in `papercusp-desktop/`.',
      '- Each update is a new commit on top of the previous one, so `git pull` works and forks',
      '  and pull requests keep a shared history.',
      '',
    ]
    : [
      '# Papercusp — source preview',
      '',
      'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
      'through shared plans, work items, locks and memory. This repository is a private,',
      'read-only snapshot of its source, shared for evaluation (see NOTICE).',
      '',
      `- Snapshot of \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
      `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
      '- It is the same public-safe source cut the Papercusp Server installer carries, without',
      '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`)',
      '  and without the Tauri desktop shell or git history.',
      '- It is replaced wholesale on each update: re-clone or `git fetch && git reset --hard origin/main`.',
      '',
    ];
  const lines = [
    ...intro,
    '## Download Papercusp',
    '',
    `Installers for every published version, with release notes and install instructions, are on`,
    `the **[Papercusp releases page](${releasesUrl})**. Install both apps: **Papercusp Server**`,
    'runs the operator, its embedded database and your agents on your machine, and **Papercusp GUI**',
    'is the desktop window onto it.',
    '',
    ...(isPublic
      ? [
        '## Build and run from source',
        '',
        'You need **Node.js 25** (see `.nvmrc`), **Rust stable** (1.77 or newer) and your platform\'s',
        'webview build libraries (the table under "Prerequisites" in `papercusp-desktop/README.md`).',
        'You also need **pgvector for PostgreSQL 18**: the app runs its own embedded Postgres, and the',
        'schema uses the `vector` extension, which that Postgres does not ship with. On Debian or',
        'Ubuntu, install `postgresql-18-pgvector` from the PostgreSQL apt repository',
        '(https://wiki.postgresql.org/wiki/Apt); on macOS, `brew install pgvector`.',
        '',
        '```sh',
        'npm ci                                               # also copies pgvector into the embedded Postgres',
        'npm --workspace @papercusp/operator-vite run build   # the UI bundle the desktop window loads',
        'cd papercusp-desktop && npm ci && npm run dev        # builds the Rust shell and opens the window',
        '```',
        '',
        'The first `npm run dev` compiles the Rust shell, which takes several minutes. The app then',
        'creates its embedded database, applies the migrations and serves the operator from this',
        'tree. If pgvector was missing during `npm ci`, install it and run',
        '`node scripts/install-embedded-pgvector.mjs`. Release installers are built by',
        '`papercusp-desktop/bin/build-linux-local.sh` and its siblings, which also need signing and',
        'release-identity inputs that development does not.',
        '',
      ]
      : []),
    '## How this source ships inside every release',
    '',
    'The Papercusp Server installer carries this same source tree as one compressed resource,',
    '`sidecar/source.tar.zst`:',
    '',
    '- **What is in it.** The code you are reading plus its already-installed `node_modules`. The',
    '  release build selects it with the same allowlist, and checks it with the same audit, that',
    '  produced this snapshot. Both refuse git history, internal plans, agent transcripts and',
    '  state, and credentials, and both redact personal identity. The only difference here is that',
    '  `node_modules` is left out.',
    '- **Where it goes.** On first launch the app extracts the archive into a writable folder in',
    '  its own data directory (on Windows, inside the `papercup-runtime` WSL distro). Later',
    '  launches skip the extract.',
    '- **What runs from it.** Two of the environments in the app\'s environment switcher run',
    '  Papercusp from that extracted source instead of from the prebuilt server: **dev**',
    '  (port 3270) runs the API host straight from TypeScript (`tsx apps/operator/bin/hono-host.ts`),',
    '  and **local** (port 3055) runs the Vite dev server over the UI in `apps/operator-vite`.',
    '  Both run on the Node.js bundled in the app with the tree\'s own `tsx` and `vite`, because',
    '  an installed machine has no npm.',
    '',
    '## Why the release carries its own source',
    '',
    'So that the Papercusp you installed can run a Papercusp you changed. Papercusp is developed',
    'with Papercusp, and shipping the runnable source means any install can do what the',
    'development machine does: open the tree, edit it (by hand or with agents), and run the edited',
    'build side by side with the installed one, without cloning a repository or installing a',
    'toolchain. Two design choices follow from that:',
    '',
    '- **Extracted to a writable folder, not run in place.** The install directory is read-only,',
    '  and a source tree you cannot edit defeats the purpose.',
    '- **One archive, not loose files.** The tree with its `node_modules` runs to several',
    '  gigabytes of small files. Copying them one by one through the app bundler\'s resource',
    '  pipeline is slow, and the `node_modules/.bin` symlinks survive `tar` but not that copy.',
    '',
    'This repository is the same source without `node_modules`, so you can read it before you install.',
    '',
    ...(isPublic
      ? [
        '## Contributing, security and telemetry',
        '',
        '- **Contributing:** see CONTRIBUTING.md. Code contributions need a signed Contributor',
        '  License Agreement; a bot links it on your first pull request.',
        '- **Security:** report vulnerabilities privately, as described in SECURITY.md.',
        '- **Conduct:** everyone taking part follows CODE_OF_CONDUCT.md.',
        '- **Telemetry is off unless you opt in** during setup, and development builds never send',
        '  any. If you distribute your own build, point opted-in telemetry at your own PostHog',
        '  with `PAPERCUSP_POSTHOG_HOST` and `PAPERCUSP_POSTHOG_KEY` (or `~/.papercusp/posthog.json`);',
        '  otherwise it goes to Papercusp\'s. The in-app support chat loads only on the `/support` page.',
        '',
      ]
      : []),
    '## Where to read first',
    '',
    '- `CLAUDE.md` / `AGENTS.md` — the conventions every agent in this codebase works under.',
    '- `docs/` — design and architecture notes.',
    '- `apps/operator/` — the operator: API host, agent tools, coordination.',
    '- `libs/papercusp/` — the core platform libraries (database schema and migrations live in `libs/papercusp/libs/db/`).',
    '',
    '## Top-level layout',
    '',
    ...tops.map((t) => `- \`${t}\``),
    '',
    '## Workspaces',
    '',
    '| path | package | description |',
    '|---|---|---|',
    ...ws.map((w) => `| \`${w.rel}\` | \`${w.name}\` | ${w.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()} |`),
    '',
  ];
  return lines.join('\n');
}

/**
 * The copyright year of `commit`: the newest commit date in its recent first-parent history.
 * The commit's own date is unusable — repair-queue admission commits carry a fixed 2000-01-01.
 * @param {string} repo
 * @param {string} commit
 */
export function sourceYear(repo, commit) {
  const stamps = git(repo, ['log', '-n', '200', '--first-parent', '--format=%ct', commit]).trim().split('\n').map(Number);
  return new Date(Math.max(...stamps) * 1000).getUTCFullYear();
}

/**
 * Export one pinned commit as the public-safe cut into `out` (must not exist).
 * Deterministic for a given commit — no timestamps — so a drift check compares
 * content, not clock.
 * `thirdPartyNotices(dir)` renders THIRD-PARTY-NOTICES.md for the public target; tests
 * inject a stub so they need no cargo resolve.
 * @param {{ repoRoot?: string, ref?: string, out: string, target?: string, licensePath?: string, selectScript?: string, selectionLib?: string, env?: NodeJS.ProcessEnv, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] } }} opts
 */
export async function exportSnapshot({
  repoRoot = ROOT,
  ref = DEFAULT_REF,
  out,
  target: targetName = 'preview',
  licensePath = PUBLIC_LICENSE_PATH,
  selectScript = SELECT_SCRIPT,
  selectionLib = SELECTION_LIB,
  env = process.env,
  log = () => {},
  thirdPartyNotices = (dir) => collectThirdPartyNotices(dir),
}) {
  if (!out) throw new PreviewError('exportSnapshot: out is required', 2);
  if (existsSync(out)) throw new PreviewError(`refusing to overwrite existing ${out}`, 2);
  const target = resolveTarget(targetName);
  const license = target.key === 'public' ? readLicense(licensePath) : null;
  const community = target.key === 'public' ? readCommunityFiles(dirname(licensePath)) : [];
  const releasesUrl = releasesPageUrl(env);
  const commit = resolveCommit(repoRoot, ref);
  const allow = allowlistTops(selectionLib);
  // The public repository also carries the Tauri desktop shell (P-004), which the shared
  // selection leaves out because the installer never ships it. Materialize it too (a
  // gitlink resolves at its pinned commit) and add it after the selection.
  if (target.key === 'public') allow.add(DESKTOP_DIR);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-'));
  const partial = `${out}.partial-${process.pid}`;
  try {
    const mono = join(work, 'mono');
    await fs.mkdir(mono);
    log(`materializing ${commit} (+ submodules at their gitlinks)`);
    const submodules = materializeCommit({ repo: repoRoot, sha: commit, dest: mono, allow });
    await fs.mkdir(dirname(partial), { recursive: true });
    log('selecting the public-safe cut (shared with the installer)');
    const sel = spawnSync('bash', [selectScript, '--mono', mono, '--into', partial, '--mode', 'preview'], {
      encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024,
    });
    if (sel.status !== 0) {
      throw new PreviewError(`source-tree-select refused (exit ${sel.status}): ${(sel.stderr || sel.stdout).trim().slice(-2000)}`, sel.status === 2 ? 2 : 1);
    }
    if (target.key === 'public') log(`desktop shell: identity scrub redacted ${copyDesktopShell(mono, partial, { env })} file(s)`);
    const files = await listFiles(partial);
    const vcs = files.filter((f) => f === '.git' || f.startsWith('.git/') || f.includes('/.git/') || f.endsWith('/.git'));
    if (vcs.length) throw new PreviewError(`export contains git metadata: ${vcs.slice(0, 5).join(', ')}`);
    const collisions = files.filter((f) => PUBLIC_ADDED_FILES.includes(f));
    if (collisions.length) throw new PreviewError(`the selection already ships ${collisions.join(', ')} — refusing to overwrite`);
    const shipped = submodules.filter((s) => existsSync(join(partial, s.path)));
    const manifest = {
      schema: 1,
      target: target.key,
      purpose: target.purpose,
      year: sourceYear(repoRoot, commit),
      source: { repo: SOURCE_REPO, ref, commit },
      submodules: shipped,
      notShipped: submodules.filter((s) => !shipped.includes(s)).map((s) => s.path),
      fileCount: files.length,
      generatedBy: 'scripts/source-preview.mjs',
    };
    if (license !== null) await fs.writeFile(join(partial, 'LICENSE'), license);
    for (const { name, text } of community) {
      await fs.mkdir(dirname(join(partial, name)), { recursive: true });
      await fs.writeFile(join(partial, name), text);
    }
    if (target.key === 'public') {
      // Generated from the EXPORTED lockfiles, so it lists exactly what ships. A partial
      // measurement must not publish as a complete notices file.
      const notices = thirdPartyNotices(partial);
      if (notices.undetermined.length) {
        throw new Error(`${NOTICES_FILE}: part of the dependency graph was not measured — ${notices.undetermined.join('; ')}`);
      }
      await fs.writeFile(join(partial, NOTICES_FILE), notices.text);
    }
    await fs.writeFile(join(partial, 'NOTICE'), noticeText(manifest));
    await fs.writeFile(join(partial, 'README.md'), await readmeText(partial, manifest, releasesUrl));
    await fs.writeFile(join(partial, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(partial, out);
    return { out, manifest };
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The public target's LICENSE text. Refuses when missing or when it is not the Elastic
 * License 2.0: publishing source under no license, or the wrong one, is not recoverable
 * once cloned.
 * @param {string} path
 */
export function readLicense(path) {
  if (!existsSync(path)) throw new PreviewError(`public target needs its LICENSE at ${path}`, 2);
  const text = readFileSync(path, 'utf8');
  if (!/^Elastic License 2\.0/m.test(text)) throw new PreviewError(`${path} is not the Elastic License 2.0 text`, 2);
  return text;
}

/**
 * Copy the desktop shell from the materialized tree into the public export, minus
 * generated and internal paths. Refuses when the commit has no desktop shell: a public
 * source release without its shell is not the product (P-004). Everything copied is
 * still checked by the same bundle audit as the rest of the export.
 * @param {string} mono the materialized commit
 * @param {string} into the export being assembled
 */
export function copyDesktopShell(mono, into, { env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const from = join(mono, DESKTOP_DIR);
  if (!existsSync(from) || readdirSync(from).length === 0) {
    throw new PreviewError(`public target needs the desktop shell at ${DESKTOP_DIR}/ in the source commit`, 2);
  }
  const dest = join(into, DESKTOP_DIR);
  run('mkdir', ['-p', dest]);
  // The gate's own forbidden-path globs (test files, secrets, VCS, …), exactly as the
  // shared selection derives them (source-tree-selection.sh step 1). Without them the
  // shell's test/ tree shipped and the bundle audit refused the cut (P-020 re-export).
  const gateExcludes = gateTarExcludes({ env, auditScript });
  const excludes = [...DESKTOP_PUBLIC_EXCLUDES, ...gateExcludes].map((p) => `--exclude=${p}`);
  run('bash', ['-c', 'set -euo pipefail; src="$1"; dst="$2"; shift 2; tar -C "$src" -cf - "$@" . | tar -C "$dst" -xf -', '_', from, dest, ...excludes]);
  // Rooted at the shell itself: --source-leakers skips `papercusp-desktop/*` paths (the
  // installer's self-reference), so scanning from `into` would silently find nothing.
  return scrubIdentity(dest, readdirSync(dest), { env, auditScript });
}

/**
 * The bundle audit's forbidden-path tar globs (`--tar-excludes`). Refuses on failure or
 * an empty list: copying an unfiltered tree is the failure this exists to prevent (WI-4419).
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string }} [opts]
 * @returns {string[]}
 */
export function gateTarExcludes({ env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const r = spawnSync('python3', [auditScript, '--tar-excludes'], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new PreviewError(`audit --tar-excludes failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(-1000)}`, 2);
  const globs = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!globs.length) throw new PreviewError('audit --tar-excludes returned nothing — refusing to copy an unfiltered desktop shell', 2);
  return globs;
}

/**
 * The SAME audit-owned identity scrub source-tree-select.sh applies to the shared
 * selection (--source-leakers finds the files, --scrub-text redacts each on the COPY).
 * Anything added to the export after the selection must pass through it too: the desktop
 * shell's own dev scripts and tests name the maintainers, and a bare copy shipped them
 * verbatim until the gate refused (open-source-release P-004/P-013).
 * @param {string} dir the export being assembled
 * @param {string[]} entries top-level entries of `dir` to scan
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string }} [opts]
 * @returns {number} how many files were redacted
 */
export function scrubIdentity(dir, entries, { env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const leak = spawnSync('python3', [auditScript, '--source-leakers', dir, ...entries], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (leak.status !== 0) throw new PreviewError(`identity scrub: --source-leakers failed (exit ${leak.status}): ${(leak.stderr || leak.stdout).trim().slice(-1000)}`, 2);
  const files = leak.stdout.split('\n').map((l) => l.trim()).filter((rel) => rel && existsSync(join(dir, rel)));
  for (const rel of files) {
    const s = spawnSync('python3', [auditScript, '--scrub-text', join(dir, rel)], { encoding: 'utf8', env });
    if (s.status !== 0) throw new PreviewError(`identity scrub: --scrub-text ${rel} failed (exit ${s.status}): ${(s.stderr || s.stdout).trim().slice(-500)}`, 2);
  }
  return files.length;
}

/**
 * The public target's community files, read from `dir` (scripts/public-release/ by
 * default — beside the LICENSE). Refuses when any is missing or empty.
 * @param {string} dir
 * @returns {{ name: string, text: string }[]}
 */
export function readCommunityFiles(dir) {
  return PUBLIC_COMMUNITY_FILES.map((name) => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new PreviewError(`public target needs ${name} at ${path}`, 2);
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) throw new PreviewError(`${path} is empty`, 2);
    return { name, text };
  });
}

function which(bin, env) {
  const r = spawnSync('bash', ['-c', 'command -v "$1"', '_', bin], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The fail-closed gate. Every detector must RUN and come back clean; a finding
 * refuses (exit 1) and a detector that cannot run refuses too (exit 2).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string, allowlistPath?: string }} [opts]
 * @returns {Promise<GateVerdict>}
 */
export async function runGate(dir, { env = process.env, auditScript = AUDIT_SCRIPT, allowlistPath = ALLOWLIST_PATH } = {}) {
  const results = [];
  const allFindings = [];
  const allowlist = await loadAllowlist(allowlistPath);
  const record = (name, status, detail) => results.push({ name, ok: status === 'clean', status, detail: detail.trim().slice(-3000) });
  if (!existsSync(dir)) throw new PreviewError(`gate: ${dir} does not exist`, 2);
  const tools = { python3: which('python3', env), tar: which('tar', env), zstd: which('zstd', env), gitleaks: which('gitleaks', env), trufflehog: which('trufflehog', env) };
  const missing = Object.entries(tools).filter(([, p]) => !p).map(([n]) => n);
  if (missing.length) {
    for (const m of missing) record(m, 'cannot-check', `${m} not found on PATH — the gate refuses rather than skip a detector`);
    return { ok: false, exitCode: 2, results };
  }
  const work = await mkdtemp(join(tmpdir(), 'source-preview-gate-'));
  try {
    // 1. The installer's own audit over a packed copy: forbidden paths, identity, credentials.
    const bundle = join(work, 'preview.tar.zst');
    run('bash', ['-c', 'set -euo pipefail; tar --sort=name --numeric-owner --owner=0 --group=0 -C "$1" -cf - . | zstd -q -3 -f -o "$2"', '_', dir, bundle], { env });
    const a = spawnSync(tools.python3, [auditScript, bundle], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle', a.status === 0 ? 'clean' : a.status === 1 ? 'finding' : 'cannot-check', `${a.stdout}\n${a.stderr}`);
    // 2. Its directory backstop (honors no path-exclude).
    const s = spawnSync(tools.python3, [auditScript, '--scan-dir', dir], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle --scan-dir', s.status === 0 ? 'clean' : s.status === 1 ? 'finding' : 'cannot-check', `${s.stdout}\n${s.stderr}`);
    // 3. gitleaks, default rules. The report holds raw secrets, so it stays in the
    //    temp dir (removed below) and only SHA-256 fingerprints leave this function.
    const report = join(work, 'gitleaks.json');
    const g = spawnSync(tools.gitleaks, ['dir', dir, '--no-banner', '--exit-code', '1', '--report-format', 'json', '--report-path', report], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (g.status === 0 || g.status === 1) {
      let raw = [];
      if (g.status === 1) {
        try { raw = JSON.parse(await fs.readFile(report, 'utf8')); } catch (e) { record('gitleaks', 'cannot-check', `unreadable report: ${e.message}`); raw = null; }
      }
      if (raw) {
        const found = raw.map((f) => fingerprint('gitleaks', f.RuleID, relPath(dir, f.File), f.StartLine, f.Secret ?? f.Match ?? ''));
        if (g.status === 1 && found.length === 0) record('gitleaks', 'cannot-check', 'gitleaks exited 1 but its report lists no findings');
        else recordFindings('gitleaks', found);
      }
    } else {
      record('gitleaks', 'cannot-check', `${g.stdout}\n${g.stderr}`);
    }
    // 4. trufflehog, detection only: --no-verification, because verifying would send
    //    each candidate secret to its provider's API.
    const t = spawnSync(tools.trufflehog, ['filesystem', dir, '--no-update', '--no-verification', '--json', '--fail'], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    if (t.status === 0 || t.status === 183) {
      const found = [];
      let unparsable = 0;
      for (const l of t.stdout.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(l);
          const fsMeta = j.SourceMetadata?.Data?.Filesystem ?? {};
          found.push(fingerprint('trufflehog', j.DetectorName, relPath(dir, fsMeta.file ?? '?'), fsMeta.line ?? 0, j.Raw ?? j.RawV2 ?? ''));
        } catch { unparsable += 1; }
      }
      if (unparsable || (t.status === 183 && found.length === 0)) record('trufflehog', 'cannot-check', `${unparsable} unparsable output line(s); exit ${t.status}`);
      else recordFindings('trufflehog', found);
    } else {
      record('trufflehog', 'cannot-check', `exit ${t.status}: ${t.stderr}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const ok = results.every((r) => r.ok);
  const exitCode = ok ? 0 : results.some((r) => r.status === 'finding') ? 1 : 2;
  return { ok, exitCode, results, findings: allFindings };

  function recordFindings(name, found) {
    const open = found.filter((f) => !isAllowlisted(allowlist, f));
    allFindings.push(...found.map((f) => ({ ...f, allowlisted: !open.includes(f) })));
    const accepted = found.length - open.length;
    const detail = open.slice(0, 60).map((f) => `${f.rule}  ${f.path}:${f.line}  sha256:${f.sha256.slice(0, 12)}`).join('\n')
      + (open.length > 60 ? `\n… ${open.length - 60} more` : '')
      + (accepted ? `\n(${accepted} reviewed false positive(s) accepted by ${relative(ROOT, allowlistPath)})` : '');
    record(name, open.length ? 'finding' : 'clean', detail);
  }
}

function relPath(dir, file) {
  const rel = relative(dir, file);
  return (rel.startsWith('..') ? file : rel).split(sep).join('/');
}

/** A finding without its secret: rule, path, line, and the SHA-256 of the matched value. */
function fingerprint(detector, rule, path, line, secret) {
  return { detector, rule: String(rule), path, line: Number(line) || 0, sha256: createHash('sha256').update(String(secret)).digest('hex') };
}

export const ALLOWLIST_PATH = join(ROOT, 'scripts', 'source-preview-allowlist.json');

/**
 * Reviewed false positives of the ADDITIONAL detectors (gitleaks, trufflehog) —
 * never of the release audit, whose BENIGN_ERE stays the one vendor-key rule.
 * An entry matches one exact (detector, rule, path, secret-hash): a changed or new
 * value in the same file is a new finding. Every entry must carry a reason.
 * @returns {Promise<{ detector: string, rule: string, path: string, sha256: string, reason: string }[]>}
 */
export async function loadAllowlist(path = ALLOWLIST_PATH) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) throw new PreviewError(`${path}: expected { entries: [...] }`, 2);
  for (const e of entries) {
    for (const k of ['detector', 'rule', 'path', 'sha256', 'reason']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) throw new PreviewError(`${path}: every entry needs a non-empty ${k} (${JSON.stringify(e).slice(0, 200)})`, 2);
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new PreviewError(`${path}: sha256 must be 64 hex chars (${e.path})`, 2);
  }
  return entries;
}

export function isAllowlisted(entries, f) {
  return entries.some((e) => e.detector === f.detector && e.rule === f.rule && e.path === f.path && e.sha256 === f.sha256);
}

/**
 * The tree a drift check compares, written into `gitDir` from `tree`: the snapshot with
 * its identity neutralized — MANIFEST.json dropped, and the source commit that NOTICE
 * and README.md name replaced by a placeholder. So a superproject commit that
 * changes nothing the preview ships is not drift (git-sync commits every few minutes),
 * while a changed shipped file, NOTICE or README text, or a hand edit on the
 * preview still is. A tree without a readable MANIFEST.json compares as-is. All three
 * files sit at the root, so only the root tree is rewritten.
 * @returns {{ comparable: string, sourceCommit: string | null }}
 */
function comparableTree(gitDir, tree) {
  const g = (args, opts) => run('git', ['--git-dir', gitDir, ...args], opts);
  const entries = g(['ls-tree', '-z', tree]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha, name: line.slice(tab + 1) };
  });
  const manifest = entries.find((e) => e.name === 'MANIFEST.json' && e.type === 'blob');
  let sourceCommit = null;
  try { sourceCommit = manifest ? JSON.parse(g(['cat-file', 'blob', manifest.sha]))?.source?.commit ?? null : null; } catch { sourceCommit = null; }
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) return { comparable: tree, sourceCommit: null };
  const kept = entries.filter((e) => e !== manifest).map((e) => {
    if (e.type !== 'blob' || !['NOTICE', 'README.md'].includes(e.name)) return e;
    const text = g(['cat-file', 'blob', e.sha]);
    return { ...e, sha: g(['hash-object', '-w', '--stdin'], { input: text.split(sourceCommit).join('<source-commit>') }).trim() };
  });
  const comparable = g(['mktree', '-z'], { input: kept.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('') }).trim();
  return { comparable, sourceCommit };
}

/** The git tree a directory would commit as (every file, ignore rules overridden), and its comparable tree. */
export function exportTrees(dir) {
  const gitDir = join(tmpdir(), `source-preview-tree-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', dir, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const tree = run('git', [...base, 'write-tree']).trim();
    return { tree, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/** The tree at `branch` of `remote` and its comparable tree, or null when the branch does not exist. */
export function remoteTrees(remote, branch = 'main') {
  const gitDir = join(tmpdir(), `source-preview-remote-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const heads = run('git', ['--git-dir', gitDir, 'ls-remote', remote, `refs/heads/${branch}`]).trim();
    if (!heads) return null;
    run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, `refs/heads/${branch}`]);
    const tree = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{tree}']).trim();
    const head = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{commit}']).trim();
    return { tree, head, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/**
 * Compare the remote preview with a fresh export of `ref`.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, target?: string, licensePath?: string, env?: NodeJS.ProcessEnv, selectScript?: string, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] } }} [opts]
 */
export async function checkDrift({ repoRoot = ROOT, ref = DEFAULT_REF, remote, target = 'preview', licensePath, env = process.env, selectScript, log = () => {}, thirdPartyNotices } = {}) {
  const t = resolveTarget(target);
  remote = remote ?? defaultRemote(t);
  assertRemoteMatchesTarget(t, remote);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-check-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), target, licensePath, env, selectScript, log, thirdPartyNotices });
    const expected = exportTrees(out).comparable;
    const current = remoteTrees(remote);
    const actual = current?.comparable ?? null;
    return { inSync: expected === actual, expected, actual, commit: manifest.source.commit, previewCommit: current?.sourceCommit ?? null };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Render `Co-authored-by:` trailers for the public sync commit (open-source-release P-011).
 * Accepted outside pull requests are ported into the private development tree, whose
 * commits are swept under one automation identity, so the contributor's credit has to
 * ride on the public commit that first ships their change. Each entry must be exactly
 * `Name <email>`: one line, no control characters, one angle-bracketed address — anything
 * else is refused rather than written into a commit message verbatim.
 * @param {string[]} [coAuthors]
 * @returns {string} '' when there are none, else a blank line plus one trailer per author
 */
export function coAuthorTrailers(coAuthors = []) {
  const seen = new Set();
  const lines = [];
  for (const raw of coAuthors) {
    const value = String(raw ?? '').trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value) || !/^[^<>@]+ <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(value)) {
      throw new PreviewError(`--co-author must be "Name <email>" on one line (got ${JSON.stringify(value)})`, 2);
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`Co-authored-by: ${value}`);
  }
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

/**
 * Re-export, re-gate, and (with confirm) publish. The preview target is REPLACED by one
 * parentless commit (force push); the public target gets a new commit on top of its current
 * main, pushed without --force, so a concurrent push is refused rather than overwritten.
 * The gate runs before anything is committed; a failing gate pushes nothing.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, target?: string, licensePath?: string, confirm?: boolean, env?: NodeJS.ProcessEnv, selectScript?: string, gate?: Gate, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] }, coAuthors?: string[] }} [opts]
 */
export async function pushSnapshot({
  repoRoot = ROOT, ref = DEFAULT_REF, remote, target = 'preview', licensePath, confirm = false,
  env = process.env, selectScript, gate = runGate, log = () => {}, thirdPartyNotices, coAuthors = [],
} = {}) {
  const t = resolveTarget(target);
  remote = remote ?? defaultRemote(t);
  assertRemoteMatchesTarget(t, remote);
  // Validate credit BEFORE any export work, so a malformed --co-author costs nothing.
  const trailers = coAuthorTrailers(coAuthors);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-push-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), target, licensePath, env, selectScript, log, thirdPartyNotices });
    log('gating the export');
    const verdict = await gate(out, { env });
    if (!verdict.ok) return { pushed: false, reason: 'gate', verdict, commit: manifest.source.commit };
    const { tree, comparable } = exportTrees(out);
    const current = remoteTrees(remote);
    // An append target's main must be export lineage: its head carries MANIFEST.json with a
    // source commit. Anything else is the wrong repository, and appending would publish the
    // export on top of someone else's history (D-016). Checked before the dry-run return so a
    // dry run reports it too.
    if (t.history === 'append' && current && current.sourceCommit === null) {
      throw new PreviewError(`refusing to append to ${remote}: its main (${current.head}) is not an export commit (no MANIFEST.json source.commit) — wrong repository?`, 2);
    }
    if (current?.comparable === comparable) {
      return { pushed: false, reason: 'in-sync', verdict, tree, commit: manifest.source.commit, previewCommit: current.sourceCommit };
    }
    if (!confirm) return { pushed: false, reason: 'dry-run', verdict, tree, commit: manifest.source.commit };
    const gitDir = join(work, 'repo.git');
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', out, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const written = run('git', [...base, 'write-tree']).trim();
    const identity = { GIT_AUTHOR_NAME: 'Papercusp', GIT_AUTHOR_EMAIL: t.email, GIT_COMMITTER_NAME: 'Papercusp', GIT_COMMITTER_EMAIL: t.email };
    const append = t.history === 'append';
    const parentArgs = [];
    if (append && current) {
      // The parent must exist in this object store for commit-tree; a depth-1 fetch is
      // enough, and the push then sends only the new commit and its new objects.
      run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, 'refs/heads/main']);
      const parent = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{commit}']).trim();
      if (parent !== current.head) throw new PreviewError(`public main moved during the push (${current.head} → ${parent}); re-run`);
      parentArgs.push('-p', parent);
    }
    const message = (append
      ? `Sync from ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json, LICENSE and NOTICE.`
      : `Source preview of ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json and NOTICE.`)
      + trailers;
    const commit = run('git', ['--git-dir', gitDir, 'commit-tree', written, ...parentArgs, '-m', message], { env: { ...process.env, ...identity } }).trim();
    run('git', ['--git-dir', gitDir, 'push', '-q', ...(append ? [] : ['--force']), remote, `${commit}:refs/heads/main`]);
    const after = remoteTrees(remote);
    if (after?.tree !== written || after?.head !== commit) throw new PreviewError(`push verification failed: remote main ${after?.head ?? 'missing'} (tree ${after?.tree ?? '-'}) ≠ ${commit} (tree ${written})`);
    return { pushed: true, verdict, tree: written, pushedCommit: commit, parent: parentArgs[1] ?? null, commit: manifest.source.commit };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [], coAuthors: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--confirm') opts.confirm = true;
    else if (a === '--co-author') opts.coAuthors.push(rest[++i]);
    else if (a === '--ref' || a === '--out' || a === '--remote' || a === '--json' || a === '--target') opts[a.slice(2)] = rest[++i];
    else if (a.startsWith('--')) throw new PreviewError(`unknown flag ${a}`, 2);
    else opts._.push(a);
  }
  return { cmd, opts };
}

function printGate(verdict) {
  for (const r of verdict.results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.status}`);
    if (!r.ok && r.detail) console.log(r.detail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

async function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  const log = (m) => console.error(`==> ${m}`);
  loadReleaseHost();
  const target = resolveTarget(opts.target ?? 'preview');
  const remote = opts.remote ?? defaultRemote(target);
  const REPO = target.repo;
  if (cmd === 'export') {
    const out = opts.out ?? join(ROOT, '.papercusp', 'scratch', 'source-preview', `export-${target.key}-${Date.now()}`);
    const { manifest } = await exportSnapshot({ ref: opts.ref ?? DEFAULT_REF, out, target: target.key, log });
    console.log(`exported ${manifest.fileCount} files of ${SOURCE_REPO}@${manifest.source.commit} (+${manifest.submodules.length} submodules) → ${out}`);
    return 0;
  }
  if (cmd === 'gate') {
    const dir = opts._[0];
    if (!dir) throw new PreviewError('usage: gate <dir>', 2);
    const verdict = await runGate(dir);
    printGate(verdict);
    // --json writes every finding (rule, path, line, sha256 — never the secret) for
    // reviewing new false positives into scripts/source-preview-allowlist.json.
    if (opts.json) await fs.writeFile(opts.json, `${JSON.stringify(verdict.findings ?? [], null, 2)}\n`);
    console.log(verdict.ok ? 'GATE: clean' : `GATE: refused (exit ${verdict.exitCode})`);
    return verdict.exitCode;
  }
  if (cmd === 'check') {
    const r = await checkDrift({ ref: opts.ref ?? DEFAULT_REF, remote, target: target.key, log });
    console.log(r.inSync
      ? `in sync: ${REPO} (snapshot of ${r.previewCommit}) ships the same content as a fresh export of ${SOURCE_REPO}@${r.commit}`
      : `DRIFT: ${REPO} ${r.actual ? `(snapshot of ${r.previewCommit ?? 'unknown'})` : '(no main branch)'} differs from a fresh export of ${SOURCE_REPO}@${r.commit} — run npm run preview:push${target.key === 'public' ? ' -- --target public' : ''}`);
    return r.inSync ? 0 : 1;
  }
  if (cmd === 'push') {
    const r = await pushSnapshot({ ref: opts.ref ?? DEFAULT_REF, remote, target: target.key, confirm: Boolean(opts.confirm), log, coAuthors: opts.coAuthors });
    printGate(r.verdict);
    if (r.reason === 'gate') { console.log('REFUSED: the gate found problems — nothing was pushed'); return r.verdict.exitCode; }
    if (r.reason === 'in-sync') { console.log(`already in sync: ${REPO} (snapshot of ${r.previewCommit}) ships the same content as ${SOURCE_REPO}@${r.commit} — nothing to push`); return 0; }
    if (r.reason === 'dry-run') { console.log(`dry run: would ${target.history === 'append' ? 'append a commit to' : 'replace'} ${REPO} main with tree ${r.tree} (${SOURCE_REPO}@${r.commit}). Re-run with --confirm.`); return 0; }
    console.log(`pushed ${r.pushedCommit}${r.parent ? ` (parent ${r.parent})` : ''} (tree ${r.tree}) = ${SOURCE_REPO}@${r.commit} → ${REPO}`);
    return 0;
  }
  console.error('usage: source-preview.mjs export|gate|check|push [--target preview|public] [--ref <ref>] [--out <dir>] [--remote <url>] [--confirm] [--co-author "Name <email>"]...');
  return 2;
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(err instanceof PreviewError ? err.exitCode : 2);
  });
}

export { main as runCli };
