#!/usr/bin/env node
/**
 * `papercusp` CLI — single-binary entrypoint.
 *
 * Subcommands:
 *   init <slug> [--from <harness>]   Scaffold a new project directory.
 *   install <slug>[@version]          Fetch a published harness template from the marketplace.
 *   list                              Show installed harnesses.
 *   publish                           Pack current dir + upload to the marketplace.
 *   run [project-slug]                Delegate to the harness substrate's run.sh.
 *   scaffold-schema <slug>            Provision the per-harness Postgres schema.
 *   doctor                            Check prerequisites (Postgres, claude, env).
 *   plugin <subcmd>                   Plugin management (install/enable/disable/...).
 *   snapshot <subcmd>                 Snapshot management (create/list/info/install).
 *   project-history generate          Generate a portable Project History v2 artifact.
 *   help                              Show this help.
 *
 * Storage layout:
 *   ~/.papercusp/
 *     credentials.json                 API keys (Anthropic, OpenAI, GitHub PAT)
 *     profile.json                     Display name, default project dir, model prefs
 *     registry.json                    Installed harnesses (also used by the legacy
 *                                      ~/.restart-harness-projects.json — kept in sync)
 *     harnesses/<slug>/                Templates downloaded from the marketplace
 *     projects/<slug>/                 Active project state (.papercusp/* lives here)
 *     marketplace-storage/             Local marketplace tarball storage (dev)
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  makeComposedResolveExtends,
  makeChildBlueprint,
  serializeBlueprint,
  resolveAndValidateBlueprint,
  validateBlueprintDependencies,
} from '@papercusp/blueprint-distribution';
import { normalizeSchemaField } from './normalize-schema.ts';
import { papercuspPath, papercuspRoot } from './papercusp-root.ts';
export { normalizeSchemaField } from './normalize-schema.ts';
const PAPERCUSP_ROOT = papercuspRoot();
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');
const GLOBAL_PLUGINS_DIR = join(PAPERCUSP_ROOT, 'global-plugins');
const PROJECTS_DIR = join(PAPERCUSP_ROOT, 'projects');
/** Installed/global blueprints (`~/.papercusp/blueprints/<id>/blueprint.yaml`) — the middle `extends` tier. */
const INSTALLED_BLUEPRINTS_DIR = join(PAPERCUSP_ROOT, 'blueprints');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');
const CREDENTIALS_PATH = join(PAPERCUSP_ROOT, 'credentials.json');

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';

function colorize(s: string, code: string): string {
  if (process.stdout.isTTY === false) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s: string) => colorize(s, '2');
const red = (s: string) => colorize(s, '31');
const green = (s: string) => colorize(s, '32');
const yellow = (s: string) => colorize(s, '33');
const cyan = (s: string) => colorize(s, '36');
const bold = (s: string) => colorize(s, '1');

function die(msg: string, exit = 1): never {
  console.error(red(`error: ${msg}`));
  process.exit(exit);
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(PAPERCUSP_ROOT, { recursive: true, mode: 0o700 });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeJson(path: string, value: unknown, mode = 0o644): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
}

interface Registry {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

async function readRegistry(): Promise<Registry> {
  const r = await readJson<Registry>(REGISTRY_PATH);
  if (r) return r;
  // Legacy fallback.
  const legacy = await readJson<Registry>(LEGACY_REGISTRY_PATH);
  return legacy ?? { projects: [] };
}

async function writeRegistry(reg: Registry): Promise<void> {
  await writeJson(REGISTRY_PATH, reg);
  // Mirror to legacy path so older code that reads ~/.restart-harness-projects.json
  // keeps working during the transition.
  await writeJson(LEGACY_REGISTRY_PATH, reg);
}

async function readCredentials(): Promise<Record<string, string | undefined>> {
  return (await readJson<Record<string, string | undefined>>(CREDENTIALS_PATH)) ?? {};
}

function isValidSlug(s: string): boolean {
  // Bare or scoped (@owner/pkg). Used for cmdInstall/cmdInit/etc.
  return /^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/i.test(s)
    || /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s);
}

// ─── Subcommands ──────────────────────────────────────────────────────────

async function cmdHelp(): Promise<void> {
  console.log(`${bold('papercusp')} — autonomous-harness framework CLI

${bold('Usage:')}
  papercusp <command> [args]

${bold('Commands:')}
  ${cyan('init <slug>')} [--from <harness>]    Scaffold a new project directory at ~/.papercusp/projects/<slug>/.
                                       --from defaults to a blank template; use a marketplace slug to
                                       seed from a published harness.

  ${cyan('install <slug>[@version]')}          Fetch a published harness template from the marketplace into
                                       ~/.papercusp/harnesses/<slug>/. Latest version if not specified.

  ${cyan('uninstall <slug>')}                  Remove an installed harness template (does not affect projects
                                       you initialised from it).

  ${cyan('list')}                              Show registered projects + installed harness templates.

  ${cyan('publish')}                           Pack the current directory's harness template + manifest and
                                       upload to the marketplace. Requires a papercusp.json in cwd.
                                       Auto-compiles index.ts → index.js (CommonJS) for plugin
                                       publishes if .js is missing or stale; pass --no-compile to skip.

  ${cyan('run')} [project-slug]                Run the harness loop. If no slug, uses cwd's harness state.

  ${cyan('scaffold-schema <slug>')}            Provision the per-harness Postgres schema for an existing project.

  ${cyan('doctor')}                            Check prerequisites (Postgres, claude CLI, marketplace reachable).

  ${cyan('plugin <subcommand>')}              Per-harness plugin lifecycle. \`papercusp plugin help\` for details.
                                       Subcommands: list, enable, disable, config, invoke.

  ${cyan('snapshot publish <slug>')}          Bundle a harness's frozen state (.papercusp/) and publish it
                                       to the marketplace as kind=snapshot. Others can browse + fork.
                                       \`papercusp snapshot help\` for details.

  ${cyan('upgrade-pin <slug>')}              Re-pin a withdrawn/quarantined plugin in the harness lockfile to its latest active version.

  ${cyan('lock check')} [--harness <slug>]   Inspect papercusp.lock entries against the registry; flag retracted/missing.
  ${cyan('lock upgrade-all')} [--harness …]  Run upgrade-pin on every entry that's withdrawn or quarantined.

  ${cyan('migrate-tabs')} [--harness <slug>]  Install + enable the 3 default tab plugins (vscode-server / pi-coding / starlight)
                                       and remind you to set PAPERCUSP_TABS_FROM_PLUGINS=1 (P7 cutover).

  ${cyan('operator audit-prefs')}             List operator preferences.md entries (workspace-scoped). Pass
                                       --remove <N> to drop one, --filter <user-typed|operator-proposed|all>
                                       to restrict, --workspace <id> to override the active workspace.

  ${cyan('project-history generate')}         Generate a validated JSON or TypeScript History artifact from
                                       Papercusp plan/work-item ledgers and the current project's Git repo.
                                       Run \`papercusp project-history help\` for details.

  ${cyan('help')}                              Show this help.

${bold('Environment:')}
  PAPERCUSP_MARKETPLACE_URL    Catalog server (default: http://localhost:3057)
  PAPERCUSP_HARNESS_DIR        Substrate dir (default: ~/autonomous-harness, symlinked to packages/papercusp-harness)
  PAPERCUSP_PROJECTS_ROOT      Where 'init' creates new projects (default: ~/.papercusp/projects)

${dim('See also: ' + REGISTRY_PATH)}`);
}

async function cmdDoctor(): Promise<void> {
  console.log(bold('papercusp doctor\n'));
  let ok = true;

  // Node version
  const node = process.versions.node;
  console.log(`  ${green('✓')} node ${node}`);

  // Postgres reachability via psql -c 'SELECT 1'
  const pgUser = process.env.PGUSER ?? 'harness_app';
  const pgHost = process.env.PGHOST ?? 'localhost';
  const pgDb = process.env.HARNESS_PG_DB ?? 'papercusp';
  const pgPwd = process.env.PGPASSWORD ?? 'harness_app_pwd';
  const psql = spawnSync('psql', ['-U', pgUser, '-h', pgHost, '-d', pgDb, '-tAc', 'SELECT 1'], {
    env: { ...process.env, PGPASSWORD: pgPwd },
    encoding: 'utf8',
    timeout: 3000,
  });
  if (psql.status === 0 && psql.stdout.trim() === '1') {
    console.log(`  ${green('✓')} postgres @ ${pgUser}@${pgHost}/${pgDb}`);
  } else {
    console.log(`  ${red('✗')} postgres unreachable @ ${pgUser}@${pgHost}/${pgDb}`);
    console.log(`    ${dim('try: bin/papercusp-init-db.sh')}`);
    ok = false;
  }

  // Agent CLI — claude (default) or omp (oh-my-pi). At least one must
  // be on PATH; AGENT_BACKEND env selects which the operator drives.
  const claudePath = spawnSync('which', ['claude'], { encoding: 'utf8' });
  const ompPath = spawnSync('which', ['omp'], { encoding: 'utf8' });
  const haveClaude = claudePath.status === 0 && claudePath.stdout.trim();
  const haveOmp = ompPath.status === 0 && ompPath.stdout.trim();
  if (haveClaude) {
    console.log(`  ${green('✓')} claude CLI @ ${claudePath.stdout.trim()}`);
  }
  if (haveOmp) {
    console.log(`  ${green('✓')} omp CLI @ ${ompPath.stdout.trim()}`);
  }
  if (!haveClaude && !haveOmp) {
    console.log(`  ${red('✗')} no agent CLI on PATH (need claude or omp)`);
    console.log(`    ${dim('claude: https://docs.claude.com/en/docs/claude-code/setup')}`);
    console.log(`    ${dim('omp:    bun add -g @oh-my-pi/pi-coding-agent')}`);
    ok = false;
  }
  const backend = (process.env.AGENT_BACKEND ?? 'claude-code').toLowerCase();
  console.log(`  ${dim(`active backend: ${backend === 'omp' ? 'omp' : 'claude-code'} (override with AGENT_BACKEND)`)}`);

  // Credentials
  const creds = await readCredentials();
  if (creds.anthropic_api_key) {
    console.log(`  ${green('✓')} Anthropic API key set`);
  } else {
    console.log(`  ${red('✗')} Anthropic API key missing in ${CREDENTIALS_PATH}`);
    console.log(`    ${dim('open http://localhost:3055/settings/api-keys')}`);
    ok = false;
  }

  // Marketplace reachability
  try {
    const r = await fetch(`${MARKETPLACE_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      console.log(`  ${green('✓')} marketplace @ ${MARKETPLACE_URL}`);
    } else {
      console.log(`  ${red('✗')} marketplace returned HTTP ${r.status}`);
      ok = false;
    }
  } catch {
    console.log(`  ${dim('—')} marketplace @ ${MARKETPLACE_URL} unreachable (optional in offline mode)`);
  }

  // Substrate
  const substrate = process.env.PAPERCUSP_HARNESS_DIR ?? join(homedir(), 'autonomous-harness');
  if (existsSync(join(substrate, 'run.sh'))) {
    console.log(`  ${green('✓')} substrate @ ${substrate}`);
  } else {
    console.log(`  ${red('✗')} substrate missing run.sh @ ${substrate}`);
    ok = false;
  }

  // ── Plugin ecosystem health ──────────────────────────────────────────
  console.log('');
  console.log(bold('plugin ecosystem'));

  // Marketplace operator-secrets file
  const opSecrets = papercuspPath('marketplace-secrets.env');
  if (existsSync(opSecrets)) {
    const raw = await fs.readFile(opSecrets, 'utf8').catch(() => '');
    const hasOpToken = /^PAPERCUSP_MARKETPLACE_OPERATOR_TOKEN=/m.test(raw);
    const hasSvcToken = /^PAPERCUSP_MARKETPLACE_SERVICE_TOKENS=/m.test(raw);
    console.log(`  ${hasOpToken ? green('✓') : dim('—')} operator token ${hasOpToken ? 'configured' : 'absent'} (marketplace-ops dashboard)`);
    console.log(`  ${hasSvcToken ? green('✓') : dim('—')} service token ${hasSvcToken ? 'configured' : 'absent'} (papercusp publish for CI)`);
  } else {
    console.log(`  ${dim('—')} ${opSecrets} not present`);
    console.log(`    ${dim('only needed if you run the marketplace locally + dashboard ops')}`);
  }

  // P7 cutover flag
  const tabsFromPlugins = process.env.PAPERCUSP_TABS_FROM_PLUGINS === '1';
  console.log(`  ${tabsFromPlugins ? green('✓') : dim('—')} PAPERCUSP_TABS_FROM_PLUGINS=${tabsFromPlugins ? '1' : '<unset>'} (P7 plugin-tab cutover)`);

  // audit schema migrations
  if (psql.status === 0) {
    const checkAuditTables = spawnSync('psql', [
      '-U', pgUser, '-h', pgHost, '-d', pgDb, '-tAc',
      "SELECT tablename FROM pg_tables WHERE schemaname='audit' AND tablename IN ('action_executions','operator_actions') ORDER BY tablename",
    ], { env: { ...process.env, PGPASSWORD: pgPwd }, encoding: 'utf8', timeout: 3000 });
    const found = checkAuditTables.stdout.trim().split('\n').filter(Boolean);
    const hasActions = found.includes('action_executions');
    const hasOps = found.includes('operator_actions');
    console.log(`  ${hasActions ? green('✓') : red('✗')} audit.action_executions ${hasActions ? 'migrated' : 'missing'} (006-action-executions.sql)`);
    console.log(`  ${hasOps ? green('✓') : red('✗')} audit.operator_actions ${hasOps ? 'migrated' : 'missing'} (007-operator-actions.sql)`);
    if (!hasActions || !hasOps) ok = false;
  }

  // Installed plugins
  try {
    const globalPluginsDir = papercuspPath('global-plugins');
    if (existsSync(globalPluginsDir)) {
      const top = await fs.readdir(globalPluginsDir, { withFileTypes: true });
      let count = 0;
      for (const entry of top) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('@')) {
          const inner = await fs.readdir(join(globalPluginsDir, entry.name), { withFileTypes: true }).catch(() => []);
          count += inner.filter((i) => i.isDirectory()).length;
        } else {
          count++;
        }
      }
      console.log(`  ${green('✓')} ${count} plugin${count === 1 ? '' : 's'} installed under ${dim(globalPluginsDir)}`);
    } else {
      console.log(`  ${dim('—')} no plugins installed yet (${dim(globalPluginsDir)} doesn't exist)`);
    }
  } catch {}

  console.log('');
  console.log(ok ? green('all good — ready to run a harness') : red('fix the above before continuing'));
  process.exit(ok ? 0 : 1);
}

async function cmdList(): Promise<void> {
  await ensureRoot();
  const reg = await readRegistry();
  const harnesses: string[] = [];
  try {
    const entries = await fs.readdir(HARNESSES_DIR, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory()) harnesses.push(e.name);
  } catch {}

  console.log(bold('Registered projects:'));
  if (reg.projects.length === 0) {
    console.log(`  ${dim('(none — use `papercusp init <slug>`)')}`);
  } else {
    for (const p of reg.projects) {
      console.log(`  ${cyan(p.slug.padEnd(24))} ${dim(p.path)}`);
    }
  }
  console.log('');
  console.log(bold('Installed harnesses:'));
  if (harnesses.length === 0) {
    console.log(`  ${dim('(none — use `papercusp install <slug>`)')}`);
  } else {
    for (const h of harnesses) {
      console.log(`  ${cyan(h)}`);
    }
  }
}

async function fetchToFile(url: string, destPath: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  if (!r.body) throw new Error(`empty response body: ${url}`);
  await fs.mkdir(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(destPath));
}

async function cmdInstall(args: string[]): Promise<void> {
  // --from-lock rehydrates from a harness's lockfile.
  const fromLockIdx = args.indexOf('--from-lock');
  if (fromLockIdx >= 0) {
    return cmdInstallFromLock(args);
  }

  // Strip flag tokens out of args; remaining positionals are the install arg.
  const flags = new Set([
    '--harness',
    '--accept-capabilities',
    '--accept-capabilities=all',
    '--accept-capabilities=current',
  ]);
  let harnessSlug: string | null = null;
  let acceptCapabilities: 'current' | 'all' | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--harness' && args[i + 1]) {
      harnessSlug = args[i + 1];
      i++;
      continue;
    }
    if (a === '--accept-capabilities') {
      acceptCapabilities = 'current';
      continue;
    }
    if (a === '--accept-capabilities=all') {
      acceptCapabilities = 'all';
      continue;
    }
    if (a === '--accept-capabilities=current') {
      acceptCapabilities = 'current';
      continue;
    }
    if (a.startsWith('-') && flags.has(a.split('=')[0])) continue;
    positional.push(a);
  }

  const arg = positional[0];
  if (!arg) die('install: usage: papercusp install <slug>[@version] [--harness <slug>] [--accept-capabilities[=current|=all]]');
  const { slug, version } = parseSlugAtVersion(arg);
  if (!isValidSlug(slug)) die(`install: invalid slug "${slug}"`);

  return installOne(slug, version, { harnessSlug, requiredBy: 'user', acceptCapabilities });
}

/** Split a `slug[@version]` string. Handles scoped names (`@owner/pkg`) whose
 *  leading '@' is part of the slug, not the version separator. */
function parseSlugAtVersion(arg: string): { slug: string; version: string | undefined } {
  if (arg.startsWith('@')) {
    // Scoped: slug is `@owner/pkg`, version (if any) is after the *next* '@'.
    const rest = arg.slice(1);
    const at = rest.indexOf('@');
    if (at < 0) return { slug: arg, version: undefined };
    return { slug: '@' + rest.slice(0, at), version: rest.slice(at + 1) };
  }
  const at = arg.indexOf('@');
  if (at < 0) return { slug: arg, version: undefined };
  return { slug: arg.slice(0, at), version: arg.slice(at + 1) };
}

interface InstallOpts {
  harnessSlug: string | null;
  requiredBy: string;          // 'user' or the slug of the plugin that pulled this in
  acceptCapabilities?: 'current' | 'all' | null;
}

/**
 * Core single-package install. Downloads, extracts, branches by `kind`:
 *   - `template` (default) → ~/.papercusp/harnesses/<slug>/  (existing behavior)
 *   - `plugin`             → ~/.papercusp/global-plugins/<slug>/
 *
 * For plugins: if a target harness is known, write/update the lockfile with the
 * pinned (slug, version, integrity, requiredBy) tuple and recurse into the
 * manifest's `requires`.
 */
async function installOne(slug: string, version: string | undefined, opts: InstallOpts): Promise<void> {
  await ensureRoot();
  console.log(`fetching ${cyan(slug + (version ? `@${version}` : ' (latest)'))} from ${MARKETPLACE_URL}`);

  // Fetch catalog detail first so we can probe kind + capabilities before
  // downloading anything. This is what powers the install-time consent prompt.
  let probedKind: 'plugin' | 'template' = 'template';
  let probedManifest: any = null;
  let resolvedVersion = version;
  try {
    const r = await fetch(`${MARKETPLACE_URL}/catalog/${encodeURIComponent(slug)}`);
    if (!r.ok) die(`install: ${slug} not found in marketplace (HTTP ${r.status})`);
    const d = await r.json() as { versions: string[]; kind?: string; latest?: { kind?: string } };
    if (!resolvedVersion) {
      if (!d.versions?.length) die(`install: ${slug} has no published versions`);
      resolvedVersion = d.versions[0];
      console.log(`  resolved latest = ${resolvedVersion}`);
    }
    // Per-slug catalog returns kind on the `latest` manifest; the catalog index
    // returns it at the top level. Honor either.
    if (d.kind === 'plugin' || d.latest?.kind === 'plugin') probedKind = 'plugin';
    if (d.latest) probedManifest = d.latest;
  } catch (e: any) {
    if (!resolvedVersion) die(`install: catalog probe failed: ${e?.message ?? e}`);
  }

  // ── Consent prompt (plugins, harness known) ─────────────────────────────
  if (probedKind === 'plugin' && opts.harnessSlug && probedManifest) {
    const { promptConsent, isAlreadyExtended, diffCapabilitiesSinceGrant } = await import('./consent.ts');
    const newCaps = Array.isArray(probedManifest.capabilities) ? probedManifest.capabilities : [];
    // Show a diff vs the most recent prior grant for this plugin in this harness.
    const diff = await diffCapabilitiesSinceGrant(slug, opts.harnessSlug, newCaps);
    if (diff && (diff.added.length > 0 || diff.removed.length > 0)) {
      console.log('');
      console.log(bold(`Capabilities diff since last install (v${diff.priorVersion} → v${resolvedVersion}):`));
      if (diff.added.length > 0) {
        console.log(`  ${green('+')} ${diff.added.length} new capabilit${diff.added.length === 1 ? 'y' : 'ies'}:`);
        for (const c of diff.added) console.log(`    ${green('+')} ${c}`);
      }
      if (diff.removed.length > 0) {
        console.log(`  ${dim('-')} ${diff.removed.length} removed capabilit${diff.removed.length === 1 ? 'y' : 'ies'}:`);
        for (const c of diff.removed) console.log(`    ${dim('-')} ${c}`);
      }
    }
    const alreadyExtended = await isAlreadyExtended(slug, resolvedVersion!);
    if (!alreadyExtended) {
      const result = await promptConsent({
        manifest: {
          name: probedManifest.name ?? slug,
          version: probedManifest.version ?? resolvedVersion!,
          kind: 'plugin',
          description: probedManifest.description,
          capabilities: newCaps,
        },
        harnessSlug: opts.harnessSlug,
        acceptCurrentHarness: opts.acceptCapabilities === 'current',
        acceptAllHarnesses: opts.acceptCapabilities === 'all',
      });
      if (!result.granted) {
        die(`install: capability consent refused for ${slug}@${resolvedVersion}`, 4);
      }
    } else {
      console.log(green(`  ✓ capabilities auto-granted (extended-to-all in extended-grants.json)`));
    }
  }

  const baseDir = probedKind === 'plugin' ? GLOBAL_PLUGINS_DIR : HARNESSES_DIR;
  const installDir = join(baseDir, slug);

  // Atomic install — download + extract into a sibling temp dir first,
  // then swap into place. Without this, a failed download or bad
  // tarball leaves the user with no install at all (the previous
  // working version was already removed). This footgun is most painful
  // on plugin update: a transient marketplace 503 destroys the working
  // copy.
  const safeName = slug.replace(/[/@]/g, '_');
  const stagingDir = join(baseDir, `.${safeName}-staging-${process.pid}-${Date.now()}`);
  await fs.mkdir(stagingDir, { recursive: true });

  // Track whether we mutated installDir so failure handlers can clean up.
  let stagingPromoted = false;
  try {
    // Download tarball.
    const tarballPath = join(stagingDir, `${safeName}-${resolvedVersion}.tar.gz`);
    console.log(`  downloading tarball...`);
    await fetchToFile(
      `${MARKETPLACE_URL}/download/${encodeURIComponent(slug)}/${encodeURIComponent(resolvedVersion!)}`,
      tarballPath,
    );
    console.log(`  ${green('✓')} ${dim(tarballPath)}`);

    // Compute integrity hash.
    const tarballBytes = await fs.readFile(tarballPath);
    var integrity = 'sha256-' + (await import('node:crypto'))
      .createHash('sha256')
      .update(tarballBytes)
      .digest('hex');

    // Extract into staging.
    console.log(`  extracting...`);
    const extract = spawnSync('tar', ['xzf', tarballPath, '-C', stagingDir], { encoding: 'utf8' });
    if (extract.status !== 0) die(`install: tar failed: ${extract.stderr}`);
    console.log(`  ${green('✓')} extracted to ${dim(stagingDir)}`);

    // Validate the staged manifest BEFORE swapping. Validating after the
    // swap would leave a broken install in place if the manifest fails
    // checks — same footgun the staging strategy is trying to fix.
    const stagedManifestPath = join(stagingDir, 'papercusp.json');
    const stagedManifest = await readJson<any>(stagedManifestPath);
    if (!stagedManifest) die(`install: tarball missing papercusp.json`);
    if (stagedManifest.name !== slug) die(`install: manifest name "${stagedManifest.name}" doesn't match install slug "${slug}"`);

    // Swap staging → installDir. Remove old install last so a failed
    // mkdir(parent) above doesn't lose the previous working copy.
    if (existsSync(installDir)) {
      console.log(`  ${dim('replacing previous install at')} ${installDir}`);
      await fs.rm(installDir, { recursive: true, force: true });
    }
    await fs.mkdir(dirname(installDir), { recursive: true });
    await fs.rename(stagingDir, installDir);
    stagingPromoted = true;
  } finally {
    if (!stagingPromoted) {
      try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }

  // Manifest re-read from the now-promoted installDir (re-binds for the
  // existing downstream code that references `manifest`/`manifestPath`).
  const manifestPath = join(installDir, 'papercusp.json');
  const manifest = await readJson<any>(manifestPath);
  if (!manifest) die(`install: tarball missing papercusp.json`);
  // Authoritative kind from the on-disk manifest. If our probe was wrong (older
  // marketplace deploy that didn't include kind), move the dir to the right place.
  const finalKind: 'plugin' | 'template' = manifest.kind === 'plugin' ? 'plugin' : 'template';
  if (finalKind === 'plugin' && baseDir !== GLOBAL_PLUGINS_DIR) {
    const realDir = join(GLOBAL_PLUGINS_DIR, slug);
    // Scoped slugs need the @owner subdir; recursive mkdir of the parent.
    await fs.mkdir(dirname(realDir), { recursive: true });
    if (existsSync(realDir)) await fs.rm(realDir, { recursive: true, force: true });
    await fs.rename(installDir, realDir);
  } else if (finalKind === 'template' && baseDir !== HARNESSES_DIR) {
    const realDir = join(HARNESSES_DIR, slug);
    if (existsSync(realDir)) await fs.rm(realDir, { recursive: true, force: true });
    await fs.rename(installDir, realDir);
  }

  // If the manifest declared a `schema` field, run the DDL against Postgres
  // so per-plugin tables are ready before the user enables the plugin.
  //
  // Two accepted shapes:
  //   1. Canonical (matches SDK's `PluginSchemaDef`):
  //        "schema": { "schemaName": "myplugin", "ddlPath": "sql/init.sql" }
  //      OR an array of those objects when the plugin owns multiple schemas.
  //   2. Legacy: a bare string array of DDL paths.
  //        "schema": ["sql/001.sql", "sql/002.sql"]
  //
  // Both forms are normalized to a list of `{ schemaName?, ddlPath }` rows
  // and run in declared order, ON_ERROR_STOP=1 for each.
  const schemaRows = normalizeSchemaField(manifest.schema);
  if (schemaRows.length > 0) {
    console.log(`  applying ${schemaRows.length} schema DDL file(s)...`);
    const pgUser = process.env.PGUSER ?? 'postgres_app';
    const pgPwd = process.env.PGPASSWORD ?? 'postgres';
    const pgDb = process.env.HARNESS_PG_DB ?? 'papercusp';
    const pgHost = process.env.PGHOST ?? 'localhost';
    let applied = 0;
    for (const row of schemaRows) {
      const ddlPath = join(installDir, row.ddlPath);
      const label = row.schemaName ? `${row.ddlPath} (schema=${row.schemaName})` : row.ddlPath;
      if (!existsSync(ddlPath)) {
        console.log(`  ${dim(`skip (missing): ${label}`)}`);
        continue;
      }
      const psql = spawnSync('psql', [
        '-v', 'ON_ERROR_STOP=1', '-q',
        '-U', pgUser, '-h', pgHost, '-d', pgDb, '-f', ddlPath,
      ], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pgPwd }, timeout: 30_000 });
      if (psql.status === 0) {
        console.log(`  ${green('✓')} applied ${dim(label)}`);
        applied++;
      } else {
        console.log(`  ${red('✗')} ${label}: ${psql.stderr.trim().slice(0, 200)}`);
      }
    }
    if (applied === 0) {
      console.log(`  ${dim('(no schemas applied — Postgres unreachable or DDLs missing)')}`);
    }
  }

  // ── Lockfile + transitive requires (plugins only, harness known) ──────────
  if (finalKind === 'plugin' && opts.harnessSlug) {
    const { addToLock } = await import('./lockfile.ts');
    const { capsHash } = await import('./consent.ts');
    const grantedCapsHash = Array.isArray(manifest.capabilities)
      ? capsHash(manifest.capabilities as string[])
      : null;
    await addToLock(opts.harnessSlug, slug, {
      version: resolvedVersion!,
      integrity,
      kind: 'plugin',
      grantedCapsHash,
      requiredBy: opts.requiredBy,
      addedAt: new Date().toISOString(),
    });
    console.log(`  ${green('✓')} pinned in ${cyan(opts.harnessSlug)} papercusp.lock`);

    // Recurse into requires.
    const requires: string[] = Array.isArray(manifest.requires) ? manifest.requires : [];
    for (const dep of requires) {
      if (!isValidSlug(dep)) {
        console.log(`  ${red('✗')} skipping invalid required slug "${dep}"`);
        continue;
      }
      const depManifestPath = join(GLOBAL_PLUGINS_DIR, dep, 'papercusp.json');
      if (existsSync(depManifestPath)) {
        // Already installed; just pin into the lockfile under requiredBy=this slug.
        try {
          const m = JSON.parse(await fs.readFile(depManifestPath, 'utf8')) as { version: string };
          await addToLock(opts.harnessSlug, dep, {
            version: m.version,
            integrity: 'sha256-already-installed',
            kind: 'plugin',
            grantedCapsHash: null,
            requiredBy: slug,
            addedAt: new Date().toISOString(),
          });
          console.log(`  ${dim(`already installed: ${dep}@${m.version} (pinned via ${slug})`)}`);
        } catch {
          // Manifest unreadable — re-fetch.
          await installOne(dep, undefined, { harnessSlug: opts.harnessSlug, requiredBy: slug });
        }
      } else {
        console.log(`  ${dim(`recursive install: ${dep} (required by ${slug})`)}`);
        await installOne(dep, undefined, { harnessSlug: opts.harnessSlug, requiredBy: slug });
      }
    }

    // Surface recommends (do NOT install — spec §14.9.7 transitivity rule).
    const recommends: string[] = Array.isArray(manifest.recommends) ? manifest.recommends : [];
    if (recommends.length > 0) {
      console.log('');
      console.log(yellow(`  recommends: ${recommends.join(', ')}`));
      console.log(dim(`  (not auto-installed; run \`papercusp install <slug> --harness ${opts.harnessSlug}\` to accept)`));
    }
  }

  console.log('');
  console.log(green(`installed ${slug}@${resolvedVersion}`));
  if (finalKind === 'plugin') {
    if (opts.harnessSlug) {
      console.log(`next: ${cyan(`papercusp plugin enable ${slug} --harness ${opts.harnessSlug}`)}`);
    } else {
      console.log(`next: ${cyan(`papercusp plugin enable ${slug} --harness <harness-slug>`)}`);
    }
  } else {
    console.log(`next: ${cyan(`papercusp init my-project --from ${slug}`)}`);
  }
}

async function cmdInstallFromLock(args: string[]): Promise<void> {
  // --from-lock requires a harness slug; default to detection.
  let harnessSlug: string | null = null;
  const harnessIdx = args.indexOf('--harness');
  if (harnessIdx >= 0 && args[harnessIdx + 1]) harnessSlug = args[harnessIdx + 1];
  if (!harnessSlug) {
    // Detect from cwd's registered harness.
    const reg = await readRegistry();
    const found = reg.projects.find((p) => p.path === process.cwd());
    if (found) harnessSlug = found.slug;
  }
  if (!harnessSlug) {
    die('install --from-lock: pass --harness <slug> or run from inside a registered harness project');
  }

  const { readLock, validateLockAgainstInstalled } = await import('./lockfile.ts');
  const lock = await readLock(harnessSlug);
  const slugs = Object.keys(lock.entries);
  if (slugs.length === 0) {
    console.log(dim(`papercusp.lock for ${harnessSlug} is empty — nothing to do`));
    return;
  }
  console.log(`installing ${cyan(String(slugs.length))} pinned plugin(s) for ${cyan(harnessSlug)}`);
  const validation = await validateLockAgainstInstalled(harnessSlug);
  const toInstall = validation.missing.length > 0
    ? validation.missing.map((m) => m.split('@')[0])
    : [];
  if (toInstall.length === 0) {
    console.log(green('  ✓ all pinned plugins already installed'));
    return;
  }
  for (const slug of toInstall) {
    const entry = lock.entries[slug];
    if (!entry) continue;
    console.log('');
    await installOne(slug, entry.version, { harnessSlug, requiredBy: entry.requiredBy });
  }
  console.log('');
  console.log(green(`✓ rehydrated ${toInstall.length} plugin(s) from lockfile`));
}

async function copyDir(src: string, dst: string): Promise<void> {
  // node 22 has fs.cp; use it.
  await fs.cp(src, dst, { recursive: true });
}

async function cmdUninstall(slug: string | undefined): Promise<void> {
  if (!slug) die('uninstall: usage: papercusp uninstall <slug>');
  if (!isValidSlug(slug)) die(`uninstall: invalid slug "${slug}"`);
  const dir = join(HARNESSES_DIR, slug);
  if (!existsSync(dir)) {
    console.log(`${dim(`${slug} is not installed (${dir} does not exist)`)}`);
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
  console.log(green(`✓ removed ${dir}`));
  console.log(`${dim('(projects you initialised from this template are untouched)')}`);
}

interface SubprojectSpec {
  suffix: string;
  kind: 'org' | 'department' | 'coding';
  department_slug?: string;
  dir: string;
}

async function scaffoldSubproject(opts: {
  slug: string;
  path: string;
  kind: SubprojectSpec['kind'];
  department_slug?: string;
  templateDir: string;
}): Promise<void> {
  await fs.mkdir(opts.path, { recursive: true });
  await fs.mkdir(join(opts.path, '.papercusp'), { recursive: true });

  // Copy template files (excluding tarball + top-level manifest)
  if (existsSync(opts.templateDir)) {
    const entries = await fs.readdir(opts.templateDir);
    for (const e of entries) {
      if (e.endsWith('.tar.gz')) continue;
      if (e === 'papercusp.json') continue;
      await copyDir(join(opts.templateDir, e), join(opts.path, e));
    }
  }

  // Default .papercusp/config.json if the template didn't bundle one.
  const configPath = join(opts.path, '.papercusp', 'config.json');
  if (!existsSync(configPath)) {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          phase: opts.kind === 'org' ? 'org' : opts.kind === 'department' ? 'department' : 'staging',
          harness_kind: opts.kind,
          ...(opts.kind === 'department' && opts.department_slug ? { dept: opts.department_slug } : {}),
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  // Register
  const reg = await readRegistry();
  if (!reg.projects.find((p) => p.slug === opts.slug)) {
    const entry: Record<string, unknown> = {
      slug: opts.slug,
      path: opts.path,
      addedAt: new Date().toISOString(),
    };
    if (opts.kind !== 'coding') entry.harness_kind = opts.kind;
    if (opts.kind === 'department' && opts.department_slug) entry.department_slug = opts.department_slug;
    reg.projects.push(entry as any);
    await writeRegistry(reg);
  }

  const tag = opts.kind === 'org'
    ? dim('(org parent)')
    : opts.kind === 'department' && opts.department_slug
    ? dim(`(dept=${opts.department_slug})`)
    : '';
  console.log(`  ${green('✓')} ${cyan(opts.slug)} ${tag}`);
}

async function cmdInit(args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) die('init: usage: papercusp init <slug> [--from <harness>] [--target <path>]');
  if (!isValidSlug(slug)) die(`init: invalid slug "${slug}"`);
  const fromIdx = args.indexOf('--from');
  const fromHarness = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const targetIdx = args.indexOf('--target');
  const targetArg = targetIdx >= 0 ? args[targetIdx + 1] : null;

  await ensureRoot();

  // Detect multi-topology by reading the bundled manifest of --from <harness>.
  let topology: 'single' | 'multi' = 'single';
  let subprojects: SubprojectSpec[] = [];
  if (fromHarness) {
    const manifestPath = join(HARNESSES_DIR, fromHarness, 'papercusp.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (manifest?.topology === 'multi' && Array.isArray(manifest.subprojects)) {
          topology = 'multi';
          subprojects = manifest.subprojects as SubprojectSpec[];
        }
      } catch {}
    }
  }

  if (topology === 'multi') {
    if (targetArg) die('init: --target is not supported with multi-topology templates');
    if (!fromHarness) die('init: multi-topology requires --from <harness>');
    const templateRootDir = join(HARNESSES_DIR, fromHarness);

    const projectsRoot = process.env.PAPERCUSP_PROJECTS_ROOT ?? PROJECTS_DIR;

    // Validate all derived slugs + paths up front so we fail before partial scaffolding.
    for (const sp of subprojects) {
      const childSlug = slug + sp.suffix;
      if (!isValidSlug(childSlug)) die(`init: derived slug "${childSlug}" is invalid`);
      const childPath = join(projectsRoot, childSlug);
      if (existsSync(childPath)) die(`init: ${childPath} already exists`);
    }

    console.log(
      `multi-topology install: ${cyan(fromHarness)} → ${cyan(slug)} ` +
      `(${subprojects.length} sub-harnesses)`,
    );

    for (const sp of subprojects) {
      const childSlug = slug + sp.suffix;
      const childPath = join(projectsRoot, childSlug);
      const subTemplateDir = join(templateRootDir, sp.dir);
      await scaffoldSubproject({
        slug: childSlug,
        path: childPath,
        kind: sp.kind,
        department_slug: sp.department_slug,
        templateDir: subTemplateDir,
      });
    }

    console.log('');
    console.log(green(`✓ ${slug} initialized — ${subprojects.length} sub-harnesses registered`));
    console.log(`next steps:`);
    for (const sp of subprojects) {
      console.log(`  ${cyan(`papercusp scaffold-schema ${slug}${sp.suffix}`)}`);
    }
    console.log(`  ${cyan(`papercusp run ${slug}`)}                (start the parent loop)`);
    return;
  }

  // -- Single-project path --
  let projectPath: string;
  let isExistingRepo = false;
  if (targetArg) {
    projectPath = resolve(targetArg);
    if (!existsSync(projectPath)) die(`init: target path "${projectPath}" does not exist`);
    if (existsSync(join(projectPath, '.papercusp'))) {
      die(`init: target "${projectPath}" already has a .papercusp/ directory — already initialized?`);
    }
    isExistingRepo = true;
  } else {
    const projectsRoot = process.env.PAPERCUSP_PROJECTS_ROOT ?? PROJECTS_DIR;
    projectPath = join(projectsRoot, slug);
    if (existsSync(projectPath)) die(`init: ${projectPath} already exists`);
    await fs.mkdir(projectPath, { recursive: true });
  }

  const writeIfAbsent = async (relPath: string, contents: string) => {
    const full = join(projectPath, relPath);
    if (isExistingRepo && existsSync(full)) {
      console.log(`  ${dim('keeping existing')} ${relPath}`);
      return;
    }
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, contents, 'utf8');
  };

  // ── Resolve `--from` as a BLUEPRINT first: local → installed → built-in. ──
  // A blueprint id (a built-in like `coding`/`research`, an installed
  // `~/.papercusp/blueprints/<id>`, or a project-local
  // `<project>/.papercusp/blueprints/<id>`) → blueprint-instantiation, the path
  // that MIRRORS `harness:create`: it writes the git-canonical thin-child
  // `.papercusp/blueprint.yaml` (the loader resolves `extends` lazily —
  // D-006/D-021), NOT a directory copy. Only when `--from` is NOT a blueprint do
  // we fall back to the legacy installed-template-directory copy (sheets-clone,
  // multi-topology), pending their migration to blueprints (D-002).
  const resolveExtendsPath = makeComposedResolveExtends({
    localDirs: [join(projectPath, '.papercusp', 'blueprints')],
    installedDir: INSTALLED_BLUEPRINTS_DIR,
  });
  const blueprintFile = fromHarness ? resolveExtendsPath(fromHarness) : null;

  if (fromHarness && blueprintFile) {
    // ═══ Blueprint instantiation (init --from <blueprint>) ═══
    const child = makeChildBlueprint(slug, fromHarness);
    const res = resolveAndValidateBlueprint(child, resolveExtendsPath);
    if (res.parseError) die(`init: blueprint "${fromHarness}" failed to resolve: ${res.parseError}`);
    if (!res.ok) {
      const errs = (res.validation?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
      die(`init: blueprint "${fromHarness}" is invalid: ${errs}`);
    }
    const blueprint = res.blueprint!;
    console.log(`instantiating blueprint ${cyan(fromHarness)} → ${dim(projectPath)}`);

    // Import-time dependency validation (E2 — P-003/P-004). Declared plugin
    // deps must resolve UPFRONT, not surface as a call-time `unknown_tool`. The
    // CLI can't enumerate the live tool catalog (that's the operator's
    // harness:create check, E2b-ii), so here we resolve the PLUGIN deps:
    // already installed → ok; otherwise install them below and FAIL if an
    // install fails ("needs plugin X").
    const declaredPlugins = blueprint.dependencies?.plugins ?? [];
    const pluginSpec = normalizeTemplatePlugins(declaredPlugins);
    if (declaredPlugins.length > 0) {
      const installed = await scanInstalledPlugins();
      const depCheck = validateBlueprintDependencies(
        { plugins: declaredPlugins },
        { availableTools: new Set(), installedPlugins: installed },
      );
      // `missing` here = declared plugins not yet installed (no Cupboard
      // enumeration in the CLI); init installs them next and a FAILED install
      // is the upfront "needs plugin X".
      if (depCheck.missing.plugins.length > 0) {
        console.log(`  blueprint declares ${depCheck.missing.plugins.length} plugin(s) to install: ${depCheck.missing.plugins.join(', ')}`);
      }
    }

    // Write the git-canonical thin child + an AGENTS.md conventions stub. SPEC.md
    // is retired (D-002 — the blueprint, not a SPEC file, is the harness shape).
    await writeIfAbsent(join('.papercusp', 'blueprint.yaml'), serializeBlueprint(child));
    await writeIfAbsent('AGENTS.md', `# Conventions for ${slug}\n\n(write coding conventions, libraries to prefer, etc.)\n`);

    const reg = await readRegistry();
    if (!reg.projects.find((p) => p.slug === slug)) {
      reg.projects.push({ slug, path: projectPath, addedAt: new Date().toISOString() } as any);
      await writeRegistry(reg);
    }

    // Install + enable the blueprint's declared plugin deps. FATAL on failure: a
    // declared dependency that can't be installed fails `init` upfront.
    if (pluginSpec.length > 0) {
      console.log('');
      console.log(`resolving blueprint plugin dependencies (${pluginSpec.length})...`);
      await installAndEnableHarnessPlugins(pluginSpec, slug, { fatalOnFailure: true });
    }

    console.log('');
    console.log(green(`✓ ${slug} initialized from blueprint ${cyan(fromHarness)}`));
    console.log(`next steps:`);
    console.log(`  ${cyan(`papercusp scaffold-schema ${slug}`)}    (provision Postgres schema)`);
    console.log(`  ${cyan(`papercusp run ${slug}`)}                (start the harness)`);
    return;
  }

  // ═══ Legacy template-directory copy / blank scaffold ═══
  await fs.mkdir(join(projectPath, '.papercusp'), { recursive: true });
  if (fromHarness) {
    const templateDir = join(HARNESSES_DIR, fromHarness);
    if (!existsSync(templateDir)) {
      die(`init: "${fromHarness}" is neither a blueprint (built-in/installed/local) nor an installed template — try \`papercusp install ${fromHarness}\` first, or pass a blueprint id like \`coding\``);
    }
    console.log(`seeding from ${cyan(fromHarness)} → ${dim(projectPath)}`);
    const entries = await fs.readdir(templateDir);
    for (const e of entries) {
      if (e.endsWith('.tar.gz')) continue;
      if (e === 'papercusp.json') continue;
      const targetEntryPath = join(projectPath, e);
      if (isExistingRepo && existsSync(targetEntryPath)) {
        console.log(`  ${dim('keeping existing')} ${e}`);
        continue;
      }
      await copyDir(join(templateDir, e), targetEntryPath);
    }
    // Also copy the template manifest to .papercusp/papercusp.json so the
    // substrate's /api/harness/:slug/manifest endpoint can read this
    // harness instance's `configFiles` declaration without needing to
    // walk the installed-templates directory. Skip if absent (legacy
    // templates without a manifest can't expose configFiles anyway).
    const tmplManifest = join(templateDir, 'papercusp.json');
    if (existsSync(tmplManifest)) {
      await fs.copyFile(tmplManifest, join(projectPath, '.papercusp', 'papercusp.json'));
    }
  } else {
    console.log(
      isExistingRepo
        ? `attaching harness skeleton to ${dim(projectPath)}`
        : `creating blank project at ${dim(projectPath)}`,
    );
    await writeIfAbsent('AGENTS.md', `# Conventions for ${slug}\n\n(write coding conventions, libraries to prefer, etc.)\n`);
  }

  // .papercusp/config.json comes from the template (every template that
  // declares its `configFiles` ships one). Templates without --from
  // (the blank-project path) get a minimal default written below as a
  // last-resort fallback only when no template was used.
  const configPath = join(projectPath, '.papercusp', 'config.json');
  if (!fromHarness && !existsSync(configPath)) {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          phase: 'staging',
          models: { scoper: 'claude-opus-5', worker: 'claude-opus-5', validator: 'claude-opus-5', orchestrator: 'claude-opus-5', reviewer: 'claude-opus-5' },
          timeouts: { worker: 900, validator: 600, scoper: 600, reviewer: 300, orchestrator: 120 },
          maxCostUsd: 10,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  const reg = await readRegistry();
  if (!reg.projects.find((p) => p.slug === slug)) {
    reg.projects.push({ slug, path: projectPath, addedAt: new Date().toISOString() } as any);
    await writeRegistry(reg);
  }

  // ── Template-declared plugins ─────────────────────────────────────────
  // If the template manifest declares `plugins`, auto-install missing ones and
  // auto-enable each in this new harness (non-fatal — a template plugin that
  // fails to install is reported, not fatal, preserving legacy behavior). The
  // blueprint path above installs declared deps the same way (fatalOnFailure).
  if (fromHarness) {
    const templateManifestPath = join(HARNESSES_DIR, fromHarness, 'papercusp.json');
    const templateManifest = (await readJson<{ plugins?: unknown }>(templateManifestPath)) ?? {};
    const pluginSpec = normalizeTemplatePlugins(templateManifest.plugins);
    if (pluginSpec.length > 0) {
      console.log('');
      console.log(`installing template plugins (${pluginSpec.length})...`);
      await installAndEnableHarnessPlugins(pluginSpec, slug, { fatalOnFailure: false });
    }
  }

  console.log('');
  console.log(green(`✓ ${slug} initialized`));
  console.log(`next steps:`);
  console.log(`  edit ${cyan(join(projectPath, 'AGENTS.md'))}`);
  console.log(`  ${cyan(`papercusp scaffold-schema ${slug}`)}    (provision Postgres schema)`);
  console.log(`  ${cyan(`papercusp run ${slug}`)}                (start the harness)`);
}

interface TemplatePluginSpec {
  slug: string;
  version?: string;
  autoEnable?: boolean;
  config?: Record<string, unknown>;
}

/**
 * Coerce a template manifest's `plugins` field into the structured form.
 * Accepts:
 *   - undefined / [] → []
 *   - string[]      → [{slug, autoEnable: true}]  (legacy back-compat)
 *   - object[]      → [{slug, version?, autoEnable?, config?}]  (current)
 *
 * Strips entries that lack a parseable slug — never throws.
 */
function normalizeTemplatePlugins(raw: unknown): TemplatePluginSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplatePluginSpec[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      // Legacy `string[]` form: "slug" or "slug@version".
      const m = /^(@?[a-z0-9][a-z0-9._/-]*)(?:@(.+))?$/i.exec(entry.trim());
      if (m) out.push({ slug: m[1]!, version: m[2], autoEnable: true });
    } else if (typeof entry === 'object' && entry !== null) {
      const e = entry as { slug?: unknown; version?: unknown; autoEnable?: unknown; config?: unknown };
      if (typeof e.slug === 'string' && /^@?[a-z0-9][a-z0-9._/-]*$/i.test(e.slug)) {
        out.push({
          slug: e.slug,
          version: typeof e.version === 'string' ? e.version : undefined,
          autoEnable: typeof e.autoEnable === 'boolean' ? e.autoEnable : true,
          config: typeof e.config === 'object' && e.config !== null ? (e.config as Record<string, unknown>) : undefined,
        });
      }
    }
  }
  return out;
}

/** `@papercupai/starlight` → `starlight`. The CLI keys enabled state by dir basename. */
function pluginDirBasename(slug: string): string {
  const idx = slug.indexOf('/');
  return idx === -1 ? slug : slug.slice(idx + 1);
}

/** Replace `${KEY}` placeholders in any string value of a config object. */
function interpolateTemplateConfig(
  cfg: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string') {
      out[k] = v.replace(/\$\{(\w+)\}/g, (_, key: string) => vars[key] ?? `\${${key}}`);
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = interpolateTemplateConfig(v as Record<string, unknown>, vars);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Install (if missing) + enable a set of plugins in a harness — shared by the
 * blueprint-instantiation path (declared plugin deps; `fatalOnFailure: true`)
 * and the legacy template path (manifest `plugins`; non-fatal). When
 * `fatalOnFailure`, a failed install/enable is the upfront "needs plugin X"
 * (`die`); otherwise failures are reported and tolerated.
 */
async function installAndEnableHarnessPlugins(
  pluginSpec: TemplatePluginSpec[],
  slug: string,
  opts: { fatalOnFailure: boolean },
): Promise<void> {
  const successes: string[] = [];
  const failures: Array<{ slug: string; reason: string }> = [];
  for (const p of pluginSpec) {
    const dirSlug = pluginDirBasename(p.slug);
    const flatPluginDir = join(GLOBAL_PLUGINS_DIR, dirSlug);
    const scopedPluginDir = join(GLOBAL_PLUGINS_DIR, p.slug);
    const installedFlat = existsSync(join(flatPluginDir, 'papercusp.json'));
    const installedScoped = existsSync(join(scopedPluginDir, 'papercusp.json'));
    if (!installedFlat && !installedScoped) {
      console.log(`  ${cyan('install')} ${p.slug}${p.version ? '@' + p.version : ''}`);
      const installArgs = ['install', p.version ? `${p.slug}@${p.version}` : p.slug, '--accept-capabilities'];
      const r = spawnSync(process.argv[0], [process.argv[1] ?? fileURLToPath(import.meta.url), ...installArgs], {
        stdio: 'inherit',
        env: { ...process.env, PAPERCUSP_ACCEPT_CAPABILITIES: '1' },
      });
      if (r.status !== 0) {
        failures.push({ slug: p.slug, reason: `install exit code ${r.status}` });
        continue;
      }
    } else {
      console.log(`  ${dim('already installed')} ${p.slug}`);
    }
    // Bridge: scoped installs (`~/.papercusp/global-plugins/@scope/name/`)
    // — symlink to the flat name so `cmdPluginEnable` (which keys by
    // basename) finds it. Idempotent. Replace empty stub dirs and
    // stale (broken-target) symlinks that would otherwise mask it.
    if (existsSync(scopedPluginDir) && !existsSync(join(flatPluginDir, 'papercusp.json'))) {
      const lst = await fs.lstat(flatPluginDir).catch(() => null);
      if (lst) {
        if (lst.isSymbolicLink()) {
          await fs.unlink(flatPluginDir);
        } else {
          await fs.rm(flatPluginDir, { recursive: true, force: true });
        }
      }
      await fs.symlink(scopedPluginDir, flatPluginDir).catch(() => { /* ignore EEXIST race */ });
    }
    if (p.autoEnable === false) {
      console.log(`  ${dim('not auto-enabling')} ${p.slug} (autoEnable: false)`);
      continue;
    }
    // Seed plugin-configs/<dir>.json with template defaults (with
    // ${PROJECT_NAME} interpolation).
    if (p.config && typeof p.config === 'object') {
      const interpolated = interpolateTemplateConfig(p.config, { PROJECT_NAME: slug });
      await fs.mkdir(join(HARNESSES_DIR, slug, 'plugin-configs'), { recursive: true });
      await fs.writeFile(
        join(HARNESSES_DIR, slug, 'plugin-configs', `${dirSlug}.json`),
        JSON.stringify(interpolated, null, 2),
        'utf8',
      );
    }
    // Enable in this harness.
    const enableArgs = ['plugin', 'enable', dirSlug, '--harness', slug, '--accept-defaults'];
    const r = spawnSync(process.argv[0], [process.argv[1] ?? fileURLToPath(import.meta.url), ...enableArgs], {
      stdio: 'inherit',
      env: process.env,
    });
    if (r.status !== 0) {
      failures.push({ slug: p.slug, reason: `enable exit code ${r.status}` });
      continue;
    }
    successes.push(p.slug);
  }
  if (successes.length > 0) {
    console.log(`  ${green('✓')} ${successes.length} plugin(s) enabled: ${successes.join(', ')}`);
  }
  if (failures.length > 0) {
    console.log(`  ${red('✗')} ${failures.length} plugin(s) failed:`);
    for (const f of failures) console.log(`    ${f.slug} — ${f.reason}`);
    if (opts.fatalOnFailure) {
      die(
        `init: required plugin(s) could not be installed: ` +
          failures.map((f) => `needs plugin ${f.slug} (${f.reason})`).join('; '),
      );
    }
  }
}

/** Scan `~/.papercusp/global-plugins` for installed plugin names (flat + scoped). */
async function scanInstalledPlugins(): Promise<Set<string>> {
  const out = new Set<string>();
  let entries;
  try {
    entries = await fs.readdir(GLOBAL_PLUGINS_DIR, { withFileTypes: true });
  } catch {
    return out; // no global-plugins dir yet
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = join(GLOBAL_PLUGINS_DIR, e.name);
    if (existsSync(join(dir, 'papercusp.json'))) {
      out.add(e.name);
      continue;
    }
    if (e.name.startsWith('@')) {
      const sub = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const s of sub) {
        if (existsSync(join(dir, s.name, 'papercusp.json'))) out.add(`${e.name}/${s.name}`);
      }
    }
  }
  return out;
}

async function cmdPublish(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const manifestPath = join(cwd, 'papercusp.json');
  if (!existsSync(manifestPath)) die(`publish: no papercusp.json in ${cwd}`);
  const manifest = await readJson<any>(manifestPath);
  if (!manifest?.name || !manifest?.version) die('publish: manifest must have name + version');
  if (!isValidSlug(manifest.name)) die(`publish: invalid manifest.name "${manifest.name}"`);

  const acknowledgeSecrets = args.includes('--acknowledge-secrets');
  const skipCompile = args.includes('--no-compile');
  const skipSbom = args.includes('--no-sbom');
  const sbomFile = (() => {
    const ix = args.findIndex((a) => a === '--sbom' || a.startsWith('--sbom='));
    if (ix < 0) return null;
    if (args[ix].startsWith('--sbom=')) return args[ix].slice(7);
    return args[ix + 1] ?? null;
  })();

  console.log(`publishing ${cyan(`${manifest.name}@${manifest.version}`)} to ${MARKETPLACE_URL}`);

  // ── Auto-compile TypeScript plugin entry ────────────────────────────
  // Plugins must ship CommonJS index.js for the substrate's plugin loader
  // (see distribution.mdx §11.1.1: Turbopack rejects bundler-opaque
  // dynamic ESM imports; we use createRequire which is CJS-only).
  //
  // If the publish dir has index.ts but no sibling index.js (or .js is
  // older than .ts), compile it now via `npx tsc --module commonjs`.
  // Skipped with --no-compile or when index.ts is absent.
  const tsEntry = join(cwd, 'index.ts');
  const jsEntry = join(cwd, 'index.js');
  if (!skipCompile && existsSync(tsEntry)) {
    let needsCompile = false;
    if (!existsSync(jsEntry)) {
      needsCompile = true;
    } else {
      const tsStat = await fs.stat(tsEntry);
      const jsStat = await fs.stat(jsEntry);
      if (tsStat.mtimeMs > jsStat.mtimeMs) needsCompile = true;
    }
    if (needsCompile) {
      console.log(`  compiling ${cyan('index.ts → index.js')} (CommonJS for substrate loader)...`);
      const tsc = spawnSync(
        'npx',
        [
          '--quiet',
          '-p', 'typescript',
          'tsc',
          '--target', 'es2022',
          '--module', 'commonjs',
          '--moduleResolution', 'node',
          '--skipLibCheck',
          '--noEmit', 'false',
          '--declaration', 'false',
          '--allowJs', 'false',
          '--outDir', cwd,
          tsEntry,
        ],
        { encoding: 'utf8', cwd },
      );
      // tsc returns nonzero on type errors but still emits .js; we accept
      // emit success by checking the file mtime moved forward.
      const newJsExists = existsSync(jsEntry);
      if (!newJsExists) {
        if (tsc.error?.message?.includes('ENOENT')) {
          die(`publish: TypeScript compiler not found. Install it (npm i -g typescript) or run \`tsc --module commonjs index.ts\` manually then re-publish with --no-compile.`);
        }
        die(`publish: tsc failed to emit index.js. Stderr:\n${tsc.stderr || tsc.stdout || '(no output)'}`);
      }
      if (tsc.status !== 0) {
        // Type errors but emit succeeded — warn loudly and continue.
        console.log(`  ${dim('⚠ tsc reported type errors but index.js was emitted; publishing anyway')}`);
        console.log(`  ${dim('  (run with --no-compile to skip; fix types in index.ts to clear the warning)')}`);
      } else {
        console.log(`  ${green('✓')} compiled cleanly`);
      }
    } else {
      console.log(`  ${dim('index.js up-to-date with index.ts; skipping compile')}`);
    }
  }

  // ── Secret scrub ────────────────────────────────────────────────────
  // Scan the source tree BEFORE packing. Hard-reject paths fail
  // unconditionally; soft findings fail unless --acknowledge-secrets,
  // in which case they're replaced with ${PLACEHOLDER} substitutions
  // (only in the packed tarball — your working tree is untouched).
  console.log(`  scanning for secrets...`);
  const { scanFilesForSecrets, replaceSecretsWithPlaceholders, formatFindings } =
    await import('./secret-scrubber.ts');

  // Walk the tree (mirror the tar exclusions).
  async function walk(dir: string, base = ''): Promise<{ path: string; abs: string }[]> {
    const out: { path: string; abs: string }[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = base ? join(base, e.name) : e.name;
      if (
        e.name === 'node_modules' ||
        e.name === '.git' ||
        e.name === '.next' ||
        e.name === '.papercusp' ||
        rel.endsWith('.tar.gz')
      ) continue;
      if (e.isDirectory()) {
        out.push(...(await walk(join(dir, e.name), rel)));
      } else if (e.isFile()) {
        out.push({ path: rel, abs: join(dir, e.name) });
      }
    }
    return out;
  }

  const allFiles = await walk(cwd);
  const filesForScan = await Promise.all(
    allFiles.map(async (f) => {
      // Skip files >1MB to keep scanning fast (mostly catches binary/embedded data).
      const st = await fs.stat(f.abs);
      if (st.size > 1_048_576) return { path: f.path, contents: null };
      try {
        const content = await fs.readFile(f.abs, 'utf8');
        return { path: f.path, contents: content };
      } catch {
        return { path: f.path, contents: null };  // binary
      }
    })
  );

  const scanResult = scanFilesForSecrets(filesForScan);
  if (scanResult.hardReject.length > 0) {
    console.error(red(formatFindings(scanResult)));
    die(`publish: ${scanResult.hardReject.length} hard-reject path(s) detected. Fix the source tree and retry.`);
  }
  if (scanResult.findings.length > 0) {
    if (!acknowledgeSecrets) {
      console.error(red(formatFindings(scanResult)));
      die(`publish: ${scanResult.findings.length} secret(s) detected. Either remove them or pass --acknowledge-secrets to substitute placeholders.`);
    }
    console.log(`  ${dim(`${scanResult.findings.length} secret(s) detected; replacing with placeholders…`)}`);
  } else {
    console.log(`  ${green('✓')} no secrets found`);
  }

  // Pack a tarball of cwd (excluding bloat). Write the tarball to /tmp so
  // it doesn't end up self-including, which tar would race on.
  // Scoped names contain '/' which is illegal in filenames — flatten to '__'.
  const safeName = String(manifest.name).replace(/[/@]/g, '_');
  const tarballPath = join('/tmp', `papercusp-publish-${safeName}-${manifest.version}-${Date.now()}.tar.gz`);

  // If we have findings to scrub, stage the cwd into a temp dir with
  // placeholder substitutions, then tar that. Otherwise tar the cwd directly.
  let stagingDir: string | null = null;
  if (scanResult.findings.length > 0 && acknowledgeSecrets) {
    stagingDir = await fs.mkdtemp(join('/tmp', `papercusp-stage-${safeName}-`));
    const replaced = replaceSecretsWithPlaceholders(filesForScan, scanResult.findings);
    for (const f of allFiles) {
      const dest = join(stagingDir, f.path);
      await fs.mkdir(dirname(dest), { recursive: true });
      const newContent = replaced.get(f.path);
      if (newContent !== undefined) {
        await fs.writeFile(dest, newContent, 'utf8');
      } else {
        // Copy file as-is
        await fs.copyFile(f.abs, dest);
      }
    }
  }

  const tarSourceDir = stagingDir ?? cwd;
  const tarArgs = [
    'czf',
    tarballPath,
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=.next',
    '--exclude=.papercusp',
    '--exclude=*.tar.gz',
    '-C',
    tarSourceDir,
    '.',
  ];
  console.log(`  packing tarball...`);
  const tar = spawnSync('tar', tarArgs, { encoding: 'utf8' });
  if (tar.status !== 0) die(`publish: tar failed: ${tar.stderr}`);

  const stat = await fs.stat(tarballPath);
  console.log(`  ${green('✓')} packed (${stat.size} bytes)`);

  // Cleanup staging dir if we used one (on success path; failure path falls through to die() which exits process)
  const cleanupStaging = async () => {
    if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  };

  // Build multipart form.
  const tarballBuf = await fs.readFile(tarballPath);
  const tarballBlob = new Blob([new Uint8Array(tarballBuf)], { type: 'application/gzip' });
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('tarball', tarballBlob, `${manifest.name}-${manifest.version}.tar.gz`);
  // Optional README.md
  if (existsSync(join(cwd, 'README.md'))) {
    form.append('readme', await fs.readFile(join(cwd, 'README.md'), 'utf8'));
  }

  // Auth header (if configured). Priority:
  //   1. PAPERCUSP_SERVICE_TOKEN env (CI / seed scripts) — non-interactive
  //   2. credentials.json sessionToken (set by `papercusp login`, OAuth Device Flow)
  //   3. credentials.json github_pat (legacy; backward compat)
  const creds = await readCredentials();
  const headers: Record<string, string> = {};
  if (process.env.PAPERCUSP_SERVICE_TOKEN) {
    headers['authorization'] = `Bearer ${process.env.PAPERCUSP_SERVICE_TOKEN}`;
  } else if (creds.sessionToken) {
    headers['authorization'] = `Bearer ${creds.sessionToken}`;
  } else if (creds.github_pat) {
    headers['authorization'] = `Bearer ${creds.github_pat}`;
  }

  console.log(`  uploading...`);
  // Scoped names (@owner/pkg) contain a '/' — encode so Hono's :slug param
  // matches a single path segment.
  const r = await fetch(
    `${MARKETPLACE_URL}/publish/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`,
    {
      method: 'POST',
      body: form,
      headers,
    },
  );

  // Cleanup tarball + staging dir regardless.
  await fs.unlink(tarballPath).catch(() => {});
  await cleanupStaging();

  if (!r.ok) {
    const text = await r.text();
    die(`publish: HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const result = await r.json();
  console.log('');
  console.log(green(`✓ published ${manifest.name}@${manifest.version}`));
  console.log(`  ${dim(JSON.stringify(result))}`);

  // ── M14: SBOM upload ────────────────────────────────────────────────
  // Either upload --sbom <file> or auto-generate via cyclonedx-npm if a
  // package-lock.json is present. Best-effort: failures don't fail the
  // publish (which already succeeded). Skip with --no-sbom.
  if (skipSbom) {
    console.log(`  ${dim('SBOM upload skipped (--no-sbom)')}`);
    return;
  }
  let sbomBytes: Buffer | null = null;
  let sbomSource = '';
  if (sbomFile) {
    if (!existsSync(sbomFile)) {
      console.warn(yellow(`  warn: --sbom ${sbomFile} not found; skipping SBOM upload`));
    } else {
      sbomBytes = await fs.readFile(sbomFile);
      sbomSource = `from ${sbomFile}`;
    }
  } else if (existsSync(join(cwd, 'package-lock.json'))) {
    console.log(`  ${dim('generating CycloneDX SBOM via cyclonedx-npm…')}`);
    const cdx = spawnSync(
      'npx',
      ['--quiet', '--package=@cyclonedx/cyclonedx-npm', 'cyclonedx-npm',
       '--output-format=JSON', '--output-reproducible', '--spec-version=1.5'],
      { cwd, encoding: 'utf8' },
    );
    if (cdx.status === 0 && cdx.stdout) {
      sbomBytes = Buffer.from(cdx.stdout, 'utf8');
      sbomSource = 'auto-generated (CycloneDX 1.5)';
    } else {
      console.warn(yellow(`  warn: cyclonedx-npm failed; skipping SBOM (rerun with --sbom <file> to upload manually)`));
      if (cdx.stderr) console.warn(dim(`    ${cdx.stderr.split('\n').slice(0, 3).join('\n    ')}`));
    }
  }
  if (!sbomBytes) return;
  const sbomUrl = `${MARKETPLACE_URL}/v1/packages/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}/sbom`;
  const sbomRes = await fetch(sbomUrl, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: new Uint8Array(sbomBytes),
  }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as Response);
  if (!sbomRes.ok) {
    const text = await sbomRes.text().catch(() => '');
    console.warn(yellow(`  warn: SBOM upload failed (HTTP ${sbomRes.status}): ${text.slice(0, 200)}`));
    return;
  }
  const sbomJson = await sbomRes.json().catch(() => ({})) as { format?: string; status?: string };
  console.log(`  ${green('✓')} SBOM uploaded ${dim(`(${sbomSource}, ${sbomBytes.length} bytes${sbomJson.format ? `, ${sbomJson.format}` : ''})`)}`);
  if (sbomJson.status === 'pending-scan') {
    console.log(`  ${dim('vulnerability scan queued; results at: ' + MARKETPLACE_URL.replace('api.', '') + `/marketplace/${encodeURIComponent(manifest.name)}`)}`);
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const allowWithdrawn = args.includes('--allow-withdrawn');
  const skipRetractionCheck = args.includes('--skip-retraction-check');
  const slug = args.find((a) => !a.startsWith('-'));
  let projectPath = process.cwd();
  let harnessSlug: string | null = slug ?? null;

  if (slug) {
    const reg = await readRegistry();
    const found = reg.projects.find((p) => p.slug === slug);
    if (!found) die(`run: project "${slug}" not registered (try \`papercusp list\`)`);
    projectPath = found.path;
  } else {
    // Detect from cwd's registered project so we can run the retraction check.
    const reg = await readRegistry();
    const found = reg.projects.find((p) => p.path === projectPath);
    if (found) harnessSlug = found.slug;
  }

  if (!existsSync(join(projectPath, '.papercusp'))) {
    die(`run: ${projectPath} is not a harness project (no .papercusp/ dir)`);
  }

  // Retraction-aware lockfile load (spec §14.9.6).
  if (harnessSlug && !skipRetractionCheck) {
    const { checkRetractionStates } = await import('./lockfile.ts');
    const result = await checkRetractionStates(harnessSlug, MARKETPLACE_URL, { allowWithdrawn });
    for (const note of result.notes) {
      const colored = note.startsWith('[QUARANTINED]')
        ? red(note)
        : note.startsWith('[withdrawn]') && !allowWithdrawn
        ? red(note)
        : yellow(note);
      console.error(colored);
    }
    if (result.status === 'block') {
      die(`run: ${result.blocked.length} retracted plugin(s) blocking startup`, 2);
    }
  }

  const substrate = process.env.PAPERCUSP_HARNESS_DIR ?? join(homedir(), 'autonomous-harness');
  const runScript = join(substrate, 'run.sh');
  if (!existsSync(runScript)) die(`run: substrate run.sh missing at ${runScript}`);

  // Inject API key from credentials.json into the env.
  const creds = await readCredentials();
  const env = { ...process.env };
  if (creds.anthropic_api_key && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = creds.anthropic_api_key;
  }
  if (creds.openai_api_key && !env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = creds.openai_api_key;
  }

  console.log(green(`running harness in ${projectPath}`));
  const child = spawn('bash', [runScript], {
    cwd: projectPath,
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function locateScaffoldScript(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  let candidate = __dirname;
  for (let i = 0; i < 6; i++) {
    const probe = join(candidate, 'bin', 'scaffold-harness-schema.sh');
    if (existsSync(probe)) return probe;
    candidate = dirname(candidate);
  }
  die('scaffold-schema: could not locate bin/scaffold-harness-schema.sh');
}

function runScaffold(scaffoldScript: string, slug: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bash', [scaffoldScript, slug], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function cmdScaffoldSchema(args: string[]): Promise<void> {
  const recursive = args.includes('--recursive') || args.includes('-r');
  const slug = args.find((a) => !a.startsWith('-'));
  if (!slug) die('scaffold-schema: usage: papercusp scaffold-schema <slug> [--recursive]');
  if (!isValidSlug(slug)) die(`scaffold-schema: invalid slug "${slug}"`);

  const scaffoldScript = locateScaffoldScript();

  let slugs: string[];
  if (recursive) {
    const reg = await readRegistry();
    const children = reg.projects
      .filter((p) => p.slug.startsWith(`${slug}-`))
      .map((p) => p.slug)
      .sort();
    slugs = [slug, ...children];
    if (children.length === 0) {
      console.log(`${dim('--recursive: no children of')} ${slug} ${dim('— scaffolding parent only')}`);
    } else {
      console.log(`scaffolding ${cyan(String(slugs.length))} schemas: ${slugs.map((s) => cyan(s)).join(', ')}`);
    }
  } else {
    slugs = [slug];
    console.log(`scaffolding Postgres schema for ${cyan(slug)}`);
  }

  let firstFailure = 0;
  for (const s of slugs) {
    if (slugs.length > 1) console.log(`\n${dim('—')} ${cyan(s)}`);
    const code = await runScaffold(scaffoldScript, s);
    if (code !== 0 && firstFailure === 0) firstFailure = code;
  }

  if (slugs.length > 1) {
    console.log('');
    console.log(firstFailure === 0 ? green(`✓ ${slugs.length} schemas scaffolded`) : red(`✗ at least one schema failed (exit ${firstFailure})`));
  }
  process.exit(firstFailure);
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const args = argv.slice(1);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    case 'init':
      return cmdInit(args);
    case 'install':
      return cmdInstall(args);
    case 'uninstall':
      return cmdUninstall(args[0]);
    case 'list':
      return cmdList();
    case 'publish':
      return cmdPublish(args);
    case 'run':
      return cmdRun(args);
    case 'scaffold-schema':
      return cmdScaffoldSchema(args);
    case 'doctor':
      return cmdDoctor();
    case 'migrate-config':
      return cmdMigrateConfig(args[0]);
    case 'plugin': {
      const { cmdPlugin } = await import('./plugin-cli.ts');
      return cmdPlugin(args);
    }
    case 'snapshot': {
      const { cmdSnapshot } = await import('./snapshot-cli.ts');
      return cmdSnapshot(args);
    }
    case 'project-history': {
      const { cmdProjectHistory } = await import('./project-history-cli.ts');
      return cmdProjectHistory(args);
    }
    case 'upgrade-pin': {
      const { cmdUpgradePin } = await import('./plugin-cli.ts');
      return cmdUpgradePin(args);
    }
    case 'lock': {
      const { cmdLock } = await import('./plugin-cli.ts');
      return cmdLock(args);
    }
    case 'migrate-tabs': {
      const { cmdMigrateTabs } = await import('./plugin-cli.ts');
      return cmdMigrateTabs(args);
    }
    case 'operator': {
      const { cmdOperator } = await import('./operator-cli.ts');
      return cmdOperator(args);
    }
    default:
      console.error(red(`unknown command: ${cmd}`));
      console.error(`run \`papercusp help\` for usage`);
      process.exit(2);
  }
}

async function cmdMigrateConfig(slug: string | undefined): Promise<void> {
  if (!slug) die('migrate-config: usage: papercusp migrate-config <slug>');
  const reg = await readRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) die(`migrate-config: no registered project "${slug}"`);

  const configPath = join(project.path, '.papercusp', 'config.json');
  if (!existsSync(configPath)) die(`migrate-config: no config.json at ${configPath}`);

  const raw = await fs.readFile(configPath, 'utf8');
  let config: any;
  try { config = JSON.parse(raw); } catch (e) { die(`migrate-config: invalid JSON at ${configPath}`); }

  const changes: string[] = [];
  const before = JSON.stringify(config);

  // 1. Rename models.planner → models.scoper.
  if (config.models?.planner && !config.models?.scoper) {
    config.models.scoper = config.models.planner;
    delete config.models.planner;
    changes.push('models.planner → models.scoper');
  }
  // 2. Add models.reviewer default if missing (scoper/reviewer were split out).
  if (config.models && !config.models.reviewer) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const defaults = require('./harness-defaults.json');
    config.models.reviewer = defaults.models.reviewer;
    changes.push(`added models.reviewer (${defaults.models.reviewer})`);
  }
  // 3. Add timeouts defaults if missing.
  if (!config.timeouts) {
    config.timeouts = { scoper: 600, worker: 900, validator: 600, reviewer: 300, orchestrator: 120 };
    changes.push('added timeouts');
  } else {
    if (!config.timeouts.scoper && config.timeouts.planner) {
      config.timeouts.scoper = config.timeouts.planner;
      delete config.timeouts.planner;
      changes.push('timeouts.planner → timeouts.scoper');
    }
    if (!config.timeouts.reviewer) {
      config.timeouts.reviewer = 300;
      changes.push('added timeouts.reviewer (300s)');
    }
  }
  // 4. Add maxCostUsd default if missing.
  if (config.maxCostUsd == null) {
    config.maxCostUsd = 10;
    changes.push('added maxCostUsd (10)');
  }
  // 5. promptOverrides — rename planner→scoper if present.
  if (config.promptOverrides?.planner && !config.promptOverrides?.scoper) {
    config.promptOverrides.scoper = config.promptOverrides.planner;
    delete config.promptOverrides.planner;
    changes.push('promptOverrides.planner → promptOverrides.scoper');
  }

  if (JSON.stringify(config) === before) {
    console.log(`${green('✓')} ${slug} config already current — no changes`);
    return;
  }

  // Backup + write.
  const backupPath = `${configPath}.bak.${Date.now()}`;
  await fs.writeFile(backupPath, raw, 'utf8');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  console.log(`${green('✓')} ${slug} config migrated:`);
  for (const c of changes) console.log(`  ${dim('•')} ${c}`);
  console.log(`  ${dim('backup at')} ${backupPath}`);
}

main().catch((e) => {
  console.error(red(`fatal: ${e?.message ?? e}`));
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
