/**
 * Synthetic superproject for the source-preview tests (plan
 * dhh-source-preview-2026-09-28). Everything lives under a tmpdir: no test ever
 * mutates the shared checkout (house rule — git-sync would commit it).
 *
 * The fixture is shaped like the real monorepo where it matters to the shared
 * selection: the two marker package.json files source-tree-select.sh requires,
 * one real git submodule at libs/papercusp, a tracked node_modules, and one
 * member of each exclusion class the installer cut drops (privacy excludes
 * derived from audit-release-bundle.py, heavy excludes, non-allowlisted tops).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GIT_ID = ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

/**
 * The owner-name literal the audit requires, and the release host README.md links;
 * set on every child env, so neither is ever read from the real box.
 */
export const FIXTURE_ENV = {
  PAPERCUSP_RELEASE_OWNER_NAME: 'Zelda Quuxington',
  PAPERCUSP_RELEASE_OWNER_EMAIL: 'zelda.quuxington@example.invalid',
  PAPERCUSP_UPDATE_BASE_URL: 'https://releases.example.invalid/fixture/',
};

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...FIXTURE_ENV, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

export function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', [...GIT_ID, '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', env: childEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

export function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** Paths the preview must ship (relative to the export root). */
export const SHIPPED = [
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  'apps/operator/package.json',
  'apps/operator/src/index.ts',
  'packages/core/index.ts',
  'docs/architecture.md',
  'libs/papercusp/package.json',
  'libs/papercusp/libs/db/sql/001-init.sql',
  'libs/papercusp/plugins/markdown-preview/papercusp.json', // a sibling plugin still ships
];

/** Desktop-shell paths only the PUBLIC target ships (P-004); the preview drops the whole shell. */
/** A desktop-shell file that names the fixture owner; it ships in the public cut, scrubbed. */
export const DESKTOP_OWNER_NAMING_FILE = 'papercusp-desktop/bin/rig-notes.sh';
export const PUBLIC_DESKTOP_SHIPPED = ['papercusp-desktop/README.md', 'papercusp-desktop/src-tauri/Cargo.toml'];

/** Desktop-shell paths the public target still leaves out (generated, local state, internal rigs). */
export const PUBLIC_DESKTOP_DROPPED = [
  'papercusp-desktop/src-tauri/env-sidecars/staging/serve.mjs',
  'papercusp-desktop/bin/vm-rig/deploy.sh',
  'papercusp-desktop/bin/deb-hetzner-matrix.sh',
  'papercusp-desktop/.papercusp/state/lock.json',
  'papercusp-desktop/test/release-identity.test.js', // gate's test-files class (P-020 re-export)
];

/** Tracked paths the shared selection must drop, each for a different reason. */
export const DROPPED = [
  'apps/operator/.env', //                 privacy exclude (from the gate)
  'docs/plans/internal-plan.md', //        privacy exclude (from the gate)
  'scratch/notes.md', //                   not on the allowlist
  '.papercusp/pi-sessions/s1.jsonl', //    not on the allowlist + privacy exclude
  'papercusp-desktop/README.md', //        heavy exclude (the Tauri shell)
  'node_modules/leftpad/index.js', //      preview never ships dependencies
  'apps/operator/node_modules/x/index.js', // …at any depth
  'apps/operator/.next/cache.bin', //      heavy exclude
  'libs/papercusp/plugins/gitnexus-bridge/index.ts', // license exclude (GitNexus is noncommercial)
  '.gitmodules', //                        not on the allowlist: names private submodule repos
  'apps/papercusp-publish/src/worker.ts', // closed-layer workspace (open-source-release P-005)
  'apps/the-swarm-site/index.html', //     closed-layer workspace
  'libs/marketplace-public-ui/index.ts', // closed-layer workspace
  'libs/generic/prospect-contract/index.ts', // closed-layer workspace
  'docs/briefs/brief.html', //             internal content
  'docs/evidence/run.json', //             internal content
  'docs/reports/report.md', //             internal content
  'libs/generic/papergrid/grid-core/storybook-static/index.html', // built output
  'packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json', // real session/plan text
  'packages/operator-core/lib/memory/bench/fixtures/prose-gold-set.v1.json', // …and its gold set
  ...PUBLIC_DESKTOP_SHIPPED.filter((p) => p !== 'papercusp-desktop/README.md'), // preview: whole shell
  ...PUBLIC_DESKTOP_DROPPED, //                    …and so every path under it
];

export interface Superproject {
  repo: string;
  subSrc: string;
  commit: string;
  subCommit: string;
}

/** Build the superproject + one submodule; returns the pinned commits. */
export function makeSuperproject(root: string): Superproject {
  const subSrc = join(root, 'core-src');
  mkdirSync(subSrc, { recursive: true });
  git(subSrc, ['init', '-q', '-b', 'main']);
  write(subSrc, 'package.json', JSON.stringify({ name: '@papercusp/core', description: 'core platform libraries' }, null, 2));
  write(subSrc, 'libs/db/sql/001-init.sql', 'CREATE TABLE t (id int);\n');
  write(subSrc, 'plugins/markdown-preview/papercusp.json', '{"name":"markdown-preview"}\n');
  write(subSrc, 'plugins/gitnexus-bridge/index.ts', "spawn('npx', ['gitnexus', 'mcp']);\n");
  git(subSrc, ['add', '-A']);
  git(subSrc, ['commit', '-q', '-m', 'core']);
  const subCommit = git(subSrc, ['rev-parse', 'HEAD']);

  const repo = join(root, 'super');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, 'package.json', JSON.stringify({ name: 'fixture-mono', private: true }, null, 2));
  write(repo, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(repo, 'CLAUDE.md', '# guide\n');
  write(repo, '.gitignore', 'node_modules\n.next\n');
  write(repo, 'apps/operator/package.json', JSON.stringify({ name: 'operator', description: 'the operator host' }, null, 2));
  write(repo, 'apps/operator/src/index.ts', 'export const x = 1;\n');
  write(repo, 'packages/core/index.ts', 'export const y = 2;\n');
  write(repo, 'docs/architecture.md', '# architecture\n');
  write(repo, 'apps/operator/.env', 'DATABASE_URL=postgres://local\n');
  write(repo, 'docs/plans/internal-plan.md', '# internal plan\n');
  write(repo, 'scratch/notes.md', 'scratch\n');
  write(repo, '.papercusp/pi-sessions/s1.jsonl', '{"turn":1}\n');
  write(repo, 'papercusp-desktop/README.md', '# desktop shell\n');
  // A shipped desktop dev script naming the owner: the public export must redact it,
  // because the shell is copied after the shared selection's scrub (P-004/P-013).
  write(repo, DESKTOP_OWNER_NAMING_FILE, `#!/bin/sh\n# rig maintained by ${FIXTURE_ENV.PAPERCUSP_RELEASE_OWNER_NAME}\necho ok\n`);
  write(repo, 'papercusp-desktop/src-tauri/Cargo.toml', '[package]\nname = "papercusp-desktop"\nlicense = "Elastic-2.0"\n');
  for (const p of PUBLIC_DESKTOP_DROPPED) write(repo, p, 'internal\n');
  write(repo, 'packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json', '{"entries":[]}\n');
  write(repo, 'packages/operator-core/lib/memory/bench/fixtures/prose-gold-set.v1.json', '{"queries":[]}\n');
  write(repo, 'node_modules/leftpad/index.js', 'module.exports = 1;\n');
  write(repo, 'apps/operator/node_modules/x/index.js', 'module.exports = 2;\n');
  write(repo, 'apps/operator/.next/cache.bin', 'cache\n');
  write(repo, 'apps/papercusp-publish/src/worker.ts', 'export default {};\n');
  write(repo, 'apps/the-swarm-site/index.html', '<html></html>\n');
  write(repo, 'libs/marketplace-public-ui/index.ts', 'export {};\n');
  write(repo, 'libs/generic/prospect-contract/index.ts', 'export {};\n');
  write(repo, 'docs/briefs/brief.html', '<p>brief</p>\n');
  write(repo, 'docs/evidence/run.json', '{}\n');
  write(repo, 'docs/reports/report.md', '# report\n');
  write(repo, 'libs/generic/papergrid/grid-core/storybook-static/index.html', '<html></html>\n');
  git(repo, ['add', '-A', '-f']);
  git(repo, ['submodule', 'add', '-q', subSrc, 'libs/papercusp']);
  git(repo, ['commit', '-q', '-m', 'fixture superproject']);
  return { repo, subSrc, commit: git(repo, ['rev-parse', 'HEAD']), subCommit };
}
