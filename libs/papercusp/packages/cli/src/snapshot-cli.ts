/**
 * `papercusp snapshot <subcommand>` — publish frozen harness state to the
 * marketplace so others can browse / fork.
 *
 * Subcommands (current MVP):
 *   publish <harness-slug>            Bundle .papercusp/ + manifest, POST to
 *                                     marketplace as kind=snapshot.
 *
 * Storage: same flow as `papercusp publish` (plugins/harnesses), only the
 * tarball contents and manifest.kind differ. The marketplace API is
 * kind-agnostic on /publish.
 */
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { papercuspRoot } from './papercusp-root.ts';
const PAPERCUSP_ROOT = papercuspRoot();
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');
const CREDENTIALS_PATH = join(PAPERCUSP_ROOT, 'credentials.json');
const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'https://api.papercuspai.com';

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function die(msg: string): never {
  console.error(red(msg));
  process.exit(1);
}

interface Registry {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

async function readRegistry(): Promise<Registry> {
  return (await readJson<Registry>(REGISTRY_PATH))
    ?? (await readJson<Registry>(LEGACY_REGISTRY_PATH))
    ?? { projects: [] };
}

function isValidSlug(s: string): boolean {
  return /^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/i.test(s)
    || /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);
}

/** Best-effort: read iteration count and feature counts from .papercusp/. */
async function inspectHarnessState(harnessDir: string): Promise<{
  iteration: number;
  featureCounts: Record<string, number>;
  takenAt: string;
}> {
  let iteration = 0;
  const featureCounts: Record<string, number> = {};

  // Iteration: scan run.log tail for last `── iteration N ──`.
  const runLog = join(harnessDir, 'logs', 'run.log');
  if (existsSync(runLog)) {
    try {
      const stat = await fs.stat(runLog);
      const start = Math.max(0, stat.size - 16 * 1024);
      const fh = await fs.open(runLog, 'r');
      const buf = Buffer.alloc(stat.size - start);
      await fh.read(buf, 0, buf.length, start);
      await fh.close();
      const tail = buf.toString('utf8');
      const matches = [...tail.matchAll(/── iteration (\d+) ──/g)];
      if (matches.length) iteration = Number(matches[matches.length - 1][1]);
    } catch { /* best-effort */ }
  }

  // Feature counts: read features.json (legacy) or fall back to empty.
  const featuresJson = await readJson<{ features?: Array<{ status: string }> }>(
    join(harnessDir, 'features.json'),
  );
  if (featuresJson?.features) {
    for (const f of featuresJson.features) {
      featureCounts[f.status] = (featureCounts[f.status] ?? 0) + 1;
    }
  }

  return { iteration, featureCounts, takenAt: new Date().toISOString() };
}

function defaultSnapshotName(harnessSlug: string, iteration: number): string {
  // Bare default. User can override with --name @owner/<custom>.
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${harnessSlug}-snapshot-${date}-iter${iteration || 0}`;
}

function snapshotVersion(iteration: number): string {
  // Marketplace version validator accepts only [a-z0-9._-] — no '+'.
  // Use "<iter>.0.0-ts<unix>" so each publish is monotonic.
  return `${iteration || 0}.0.0-ts${Math.floor(Date.now() / 1000)}`;
}

export async function cmdSnapshot(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'publish': return cmdSnapshotPublish(rest);
    case 'fork':    return cmdSnapshotFork(rest);
    case 'list':
    case 'ls':      return cmdSnapshotList(rest);
    case 'info':
    case 'show':    return cmdSnapshotInfo(rest);
    case 'delete':
    case 'rm':      return cmdSnapshotDelete(rest);
    case 'publish-id': return cmdSnapshotPublishId(rest);
    case 'help':
    case '--help':
    case undefined:
      return cmdSnapshotHelp();
    default:
      console.error(red(`unknown snapshot subcommand: ${sub}`));
      console.error('run `papercusp snapshot help` for usage');
      process.exit(2);
  }
}

function cmdSnapshotHelp(): void {
  console.log(`${cyan('papercusp snapshot')} — publish + fork frozen harness state from the marketplace

${cyan('publish <harness-slug>')} ${dim('[--name <slug>] [--note "<text>"] [--icon <Lucide>] [--include-project]')}
                                 ${dim('Bundle the harness\'s .papercusp/ directory (features, decisions, audit history)')}
                                 ${dim('and push to the marketplace as kind=snapshot.')}

${cyan('fork <snapshot-slug>')} ${dim('[<new-harness-slug>] [--path <dir>]')}
                                 ${dim('Download a published snapshot and scaffold a new harness from it.')}
                                 ${dim('Registers the new harness in ~/.papercusp/registry.json.')}

${cyan('list')} ${dim('[--harness <slug>] [--json]')}
                                 ${dim('List local snapshots captured by the operator under each registered')}
                                 ${dim('harness\'s .papercusp/snapshots/. Same data as the /snapshots UI.')}

${cyan('info <snap-id>')} ${dim('[--json]')}
                                 ${dim('Inspect a local snapshot\'s manifest: source harness, files, plugins,')}
                                 ${dim('redactions, capture options. Useful before forking.')}

${cyan('delete <snap-id>')} ${dim('[-f]')}
                                 ${dim('Delete a local snapshot tarball. Pass -f to skip confirmation.')}

${cyan('publish-id <snap-id>')} ${dim('[--slug <name>] [--version <ver>]')}
                                 ${dim('Upload an already-captured local snapshot to the marketplace.')}
                                 ${dim('Differs from `publish`, which re-captures from the live project.')}

${cyan('Options')}
  ${cyan('publish:')}
  --name <slug>      Override the published name (default: <harness>-snapshot-<date>-iter<N>).
                     Use @<owner>/<name> for scoped names (requires \`papercusp login\`).
  --note "<text>"    Description shown on the marketplace listing (default: auto from state).
  --icon <Lucide>    Icon name (Lucide React) for the marketplace card. Default: inherit from
                     source template's manifest, falling back to "Layers".
  --include-project  Also include the project source tree (off by default — snapshots are
                     state-only by default; the source code lives in the parent harness or
                     git remote).
  --include-logs     Include .papercusp/logs/ + pi-sessions/ + screenshots/. Off by default
                     because logs balloon the tarball (often 100x larger) and are derived
                     from agent_runs in Postgres anyway. Turn on for debug-reproduction snapshots.

  ${cyan('fork:')}
  <new-harness-slug> Project slug to register. Default: <sourceHarness>-fork-<n> (auto-incremented).
  --path <dir>       Where to extract. Default: $HOME/<new-harness-slug>.

${cyan('Examples')}
  ${dim('# Publish current state of "sheets" harness')}
  papercusp snapshot publish sheets

  ${dim('# Fork an existing snapshot into ~/sheets-fork')}
  papercusp snapshot fork sheets-snapshot-20260429-iter1
`);
}

async function cmdSnapshotFork(args: string[]): Promise<void> {
  const positional: string[] = [];
  let path: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--path' && args[i + 1]) { path = args[i + 1]; i++; continue; }
    if (a.startsWith('--')) die(`snapshot fork: unknown flag "${a}"`);
    positional.push(a);
  }
  const snapshotSlug = positional[0];
  if (!snapshotSlug) die('snapshot fork: usage: papercusp snapshot fork <snapshot-slug> [<new-harness-slug>] [--path <dir>]');
  if (!isValidSlug(snapshotSlug)) die(`snapshot fork: invalid snapshot slug "${snapshotSlug}"`);
  const requestedHarnessSlug = positional[1] ?? null;

  // 1. Fetch the snapshot manifest from the marketplace.
  console.log(`fetching ${cyan(snapshotSlug)} from ${MARKETPLACE_URL}...`);
  const detailUrl = `${MARKETPLACE_URL}/catalog/${encodeURIComponent(snapshotSlug)}`;
  const r = await fetch(detailUrl);
  if (!r.ok) die(`snapshot fork: ${detailUrl} → HTTP ${r.status}`);
  const detail = await r.json() as {
    versions?: string[];
    latest?: { version: string; kind?: string; snapshot?: { sourceHarness?: string } };
  };
  if (!detail.latest) die(`snapshot fork: ${snapshotSlug} has no published versions`);
  const latest = detail.latest;
  if (latest.kind !== 'snapshot') {
    die(`snapshot fork: "${snapshotSlug}" is kind="${latest.kind ?? 'unknown'}", not "snapshot". Use \`papercusp install\` for plugins/harnesses.`);
  }
  const sourceHarness = latest.snapshot?.sourceHarness ?? snapshotSlug;
  const version = latest.version;

  // 2. Resolve target slug + path. Auto-increment if collision.
  const reg = await readRegistry();
  let newSlug = requestedHarnessSlug ?? `${sourceHarness}-fork`;
  if (!isValidSlug(newSlug)) die(`snapshot fork: derived/given new-harness-slug "${newSlug}" is not a valid slug`);
  if (!requestedHarnessSlug) {
    let n = 1;
    while (reg.projects.some((p) => p.slug === newSlug)) {
      n += 1;
      newSlug = `${sourceHarness}-fork-${n}`;
    }
  } else if (reg.projects.some((p) => p.slug === newSlug)) {
    die(`snapshot fork: harness "${newSlug}" already registered. Pick a different slug or remove the existing one with \`papercusp uninstall ${newSlug}\`.`);
  }

  const targetPath = path ?? join(homedir(), newSlug);
  if (existsSync(targetPath)) {
    die(`snapshot fork: target path ${targetPath} already exists. Pick a fresh dir with --path or remove the existing one.`);
  }

  console.log(`  source:  ${dim(sourceHarness)}`);
  console.log(`  new:     ${cyan(newSlug)}`);
  console.log(`  path:    ${dim(targetPath)}`);

  // 3. Download tarball.
  const safeName = snapshotSlug.replace(/[/@]/g, '_');
  const tarballUrl = `${MARKETPLACE_URL}/download/${encodeURIComponent(snapshotSlug)}/${encodeURIComponent(version)}`;
  const tarballPath = join('/tmp', `papercusp-fork-${safeName}-${Date.now()}.tar.gz`);
  console.log(`  downloading...`);
  const tarRes = await fetch(tarballUrl);
  if (!tarRes.ok) die(`snapshot fork: tarball ${tarballUrl} → HTTP ${tarRes.status}`);
  const arrayBuf = await tarRes.arrayBuffer();
  await fs.writeFile(tarballPath, Buffer.from(arrayBuf));
  const stat = await fs.stat(tarballPath);
  console.log(`  ${green('✓')} ${stat.size} bytes`);

  // 4. Extract.
  await fs.mkdir(targetPath, { recursive: true });
  const tarExtract = spawnSync('tar', ['xzf', tarballPath, '-C', targetPath], { encoding: 'utf8' });
  await fs.unlink(tarballPath).catch(() => {});
  if (tarExtract.status !== 0) {
    // Cleanup the half-extracted dir to keep state consistent.
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
    die(`snapshot fork: tar extract failed: ${tarExtract.stderr}`);
  }

  // 5. Register in ~/.papercusp/registry.json. Re-use sourceHarness's harness_kind
  //    if known; otherwise default to 'coding' (most common).
  const sourceProject = reg.projects.find((p) => p.slug === sourceHarness);
  const harnessKind = sourceProject?.harnessKind ?? 'coding';
  reg.projects.push({
    slug: newSlug,
    path: targetPath,
    harnessKind,
    addedAt: new Date().toISOString(),
  });
  await writeJson(REGISTRY_PATH, reg);
  await writeJson(LEGACY_REGISTRY_PATH, reg);

  console.log('');
  console.log(green(`✓ forked ${snapshotSlug}@${version} as ${newSlug}`));
  console.log(`  ${dim('open in operator: http://localhost:3055/harness (pick "' + newSlug + '")')}`);
  console.log(`  ${dim('run from cli:    papercusp run ' + newSlug)}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function readCredentials() {
  return (await readJson<Record<string, string | undefined>>(CREDENTIALS_PATH)) ?? {};
}

/**
 * Best-effort lookup of a template's icon so a published snapshot inherits
 * a meaningful glyph instead of falling back to the generic "Layers"
 * shape. Sources tried, in order:
 *   1. Project's own papercusp.json (`<projectDir>/papercusp.json` icon field)
 *   2. Marketplace catalog entry for the same slug as the source harness
 * Returns null if neither has an icon (caller picks a default).
 */
async function fetchTemplateIcon(harnessSlug: string): Promise<string | null> {
  const reg = await readRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (project) {
    const local = await readJson<{ icon?: string }>(join(project.path, 'papercusp.json'));
    if (typeof local?.icon === 'string' && local.icon) return local.icon;
  }
  try {
    const r = await fetch(`${MARKETPLACE_URL}/catalog/${encodeURIComponent(harnessSlug)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    const d = await r.json() as { latest?: { icon?: string | null } };
    return typeof d.latest?.icon === 'string' ? d.latest.icon : null;
  } catch {
    return null;
  }
}

async function cmdSnapshotPublish(args: string[]): Promise<void> {
  const positional: string[] = [];
  let name: string | null = null;
  let note: string | null = null;
  let icon: string | null = null;
  let includeProject = false;
  let includeLogs = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' && args[i + 1]) { name = args[i + 1]; i++; continue; }
    if (a === '--note' && args[i + 1]) { note = args[i + 1]; i++; continue; }
    if (a === '--icon' && args[i + 1]) { icon = args[i + 1]; i++; continue; }
    if (a === '--include-project') { includeProject = true; continue; }
    if (a === '--include-logs') { includeLogs = true; continue; }
    if (a.startsWith('--')) {
      die(`snapshot publish: unknown flag "${a}"`);
    }
    positional.push(a);
  }

  const harnessSlug = positional[0];
  if (!harnessSlug) die('snapshot publish: usage: papercusp snapshot publish <harness-slug> [--name <slug>] [--note "..."]');

  const reg = await readRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) die(`snapshot publish: no registered harness "${harnessSlug}". Run \`papercusp list\` to see registered harnesses.`);

  const harnessDir = join(project.path, '.papercusp');
  if (!existsSync(harnessDir)) die(`snapshot publish: ${harnessDir} does not exist (is the harness initialized?)`);

  console.log(`inspecting ${cyan(harnessSlug)} at ${dim(project.path)}...`);
  const state = await inspectHarnessState(harnessDir);
  const totalFeatures = Object.values(state.featureCounts).reduce((a, b) => a + b, 0);
  console.log(`  iteration ${state.iteration}, ${totalFeatures} features (${Object.entries(state.featureCounts).map(([k, v]) => `${k}=${v}`).join(' ') || 'no features.json'})`);

  const finalName = name ?? defaultSnapshotName(harnessSlug, state.iteration);
  if (!isValidSlug(finalName)) die(`snapshot publish: derived/given name "${finalName}" is not a valid slug`);
  const version = snapshotVersion(state.iteration);

  const passed = state.featureCounts.passed ?? 0;
  const desc = note ?? `Snapshot of "${harnessSlug}" at iteration ${state.iteration}` +
    (totalFeatures > 0 ? ` (${passed}/${totalFeatures} features passed)` : '');

  // Inherit the source template's icon by default. --icon overrides;
  // anything not declared falls back to "Layers".
  const sourceIcon = icon ?? await fetchTemplateIcon(harnessSlug) ?? 'Layers';

  const manifest = {
    name: finalName,
    version,
    kind: 'snapshot' as const,
    papercusp: '^0.1.0',
    description: desc,
    license: 'MIT',
    icon: sourceIcon,
    snapshot: {
      sourceHarness: harnessSlug,
      sourceProjectPath: project.path,
      iteration: state.iteration,
      takenAt: state.takenAt,
      featureCounts: state.featureCounts,
      includesProject: includeProject,
    },
  };

  console.log(`publishing ${cyan(`${finalName}@${version}`)} to ${MARKETPLACE_URL}`);

  // Pack tarball. Default = .papercusp/ only. With --include-project, the entire project root.
  const safeName = finalName.replace(/[/@]/g, '_');
  const tarballPath = join('/tmp', `papercusp-snapshot-${safeName}-${Date.now()}.tar.gz`);

  const tarSourceDir = includeProject ? project.path : project.path;
  const includeArgs = includeProject
    ? ['.']
    : ['.papercusp'];
  // Exclude transient/derived data by default. `.papercusp/logs/` is the worst
  // offender (often hundreds of MB; sheets snapshot was 32MB tarball, ~99%
  // logs). Logs are derived from agent_runs which are PG-canonical anyway,
  // so a fork doesn't lose anything by missing them. `--include-logs` is
  // available for debugging/reproduction snapshots.
  const transientExcludes = includeLogs
    ? []
    : [
        '--exclude=.papercusp/logs',
        '--exclude=.papercusp/pi-sessions',
        '--exclude=.papercusp/screenshots',
        '--exclude=.papercusp/pending-reviews',
      ];
  const tarArgs = [
    'czf',
    tarballPath,
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=.next',
    '--exclude=*.tar.gz',
    ...transientExcludes,
    '-C', tarSourceDir,
    ...includeArgs,
  ];
  const contentLabel = [
    includeProject ? 'project + .papercusp' : '.harness only',
    includeLogs ? 'with logs' : 'no logs',
  ].join(', ');
  console.log(`  packing tarball (${contentLabel})...`);
  const tar = spawnSync('tar', tarArgs, { encoding: 'utf8' });
  if (tar.status !== 0) die(`snapshot publish: tar failed: ${tar.stderr}`);
  const stat = await fs.stat(tarballPath);
  console.log(`  ${green('✓')} packed (${stat.size} bytes)`);

  // Build a README that describes the snapshot.
  const readme = `# ${finalName}

${desc}

## Snapshot details

- **Source harness:** \`${harnessSlug}\`
- **Iteration:** ${state.iteration}
- **Taken at:** ${state.takenAt}
- **Feature counts:** ${Object.entries(state.featureCounts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none recorded)'}
- **Includes project source:** ${includeProject ? 'yes' : 'no — \`.papercusp/\` state only'}

## Forking this snapshot

\`\`\`bash
papercusp install ${finalName}
# Extracts to ~/.papercusp/marketplace-storage/${finalName.replace(/[/@]/g, '_')}/${version}/
# Copy .papercusp/ into a new project directory to fork the run.
\`\`\`
`;

  // Multipart upload.
  const tarballBuf = await fs.readFile(tarballPath);
  const tarballBlob = new Blob([new Uint8Array(tarballBuf)], { type: 'application/gzip' });
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('tarball', tarballBlob, `${safeName}-${version}.tar.gz`);
  form.append('readme', readme);

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
  const r = await fetch(
    `${MARKETPLACE_URL}/publish/${encodeURIComponent(finalName)}/${encodeURIComponent(version)}`,
    { method: 'POST', body: form, headers },
  );

  await fs.unlink(tarballPath).catch(() => {});

  if (!r.ok) {
    const text = await r.text();
    die(`snapshot publish: HTTP ${r.status}: ${text.slice(0, 400)}`);
  }
  const result = await r.json().catch(() => ({}));
  console.log('');
  console.log(green(`✓ snapshot published: ${finalName}@${version}`));
  console.log(`  ${dim('view at: ' + (MARKETPLACE_URL.replace('api.', '') || 'http://localhost:3060') + '/marketplace/' + finalName + '/')}`);
  console.log(`  ${dim('fork:   papercusp install ' + finalName)}`);
  if ((result as any).manifestUrl) {
    console.log(`  ${dim('manifest: ' + (result as any).manifestUrl)}`);
  }
}

interface LocalSnapshotRow {
  id: string;
  harnessSlug: string;
  tarballPath: string;
  bytes: number;
  name: string | null;
  description: string | null;
  createdAtMs: number;
}

async function readManifestFromTarballSync(tarballPath: string, id: string): Promise<unknown | null> {
  // Manifest is at `<id>/manifest.json` inside the tarball (the lib's
  // stage layout uses the snapshot id as the top-level dir).
  const r = spawnSync('tar', ['-xzOf', tarballPath, `${id}/manifest.json`], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

async function cmdSnapshotList(args: string[]): Promise<void> {
  let filterSlug: string | null = null;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--harness' && args[i + 1]) { filterSlug = args[i + 1]; i++; continue; }
    if (a === '--json') { asJson = true; continue; }
    if (a.startsWith('--')) die(`snapshot list: unknown flag "${a}"`);
  }

  const reg = await readRegistry();
  const rows: LocalSnapshotRow[] = [];
  for (const project of reg.projects) {
    if (filterSlug && project.slug !== filterSlug) continue;
    const dir = join(project.path, '.papercusp', 'snapshots');
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.startsWith('snap_') || !name.endsWith('.tar.gz')) continue;
      const tarballPath = join(dir, name);
      let stat;
      try { stat = await fs.stat(tarballPath); } catch { continue; }
      const id = name.replace(/\.tar\.gz$/, '');
      const m = (await readManifestFromTarballSync(tarballPath, id)) as
        | { name?: string; description?: string; createdAt?: number } | null;
      rows.push({
        id,
        harnessSlug: project.slug,
        tarballPath,
        bytes: stat.size,
        name: m?.name ?? null,
        description: m?.description ?? null,
        createdAtMs: m?.createdAt ?? stat.mtimeMs,
      });
    }
  }
  rows.sort((a, b) => b.createdAtMs - a.createdAtMs);

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(dim(filterSlug
      ? `no local snapshots for harness "${filterSlug}".`
      : 'no local snapshots found across registered harnesses.'));
    console.log(dim('capture one from the harness dashboard\'s "save snapshot" button.'));
    return;
  }

  for (const r of rows) {
    const date = new Date(r.createdAtMs).toISOString().replace('T', ' ').slice(0, 16);
    const mb = (r.bytes / 1e6).toFixed(1);
    console.log(`${cyan(r.id)}  ${dim(date)}  ${r.harnessSlug}  ${dim(`${mb} MB`)}`);
    if (r.name) console.log(`  ${r.name}`);
    if (r.description) console.log(`  ${dim(r.description)}`);
  }
  console.log('');
  console.log(dim(`${rows.length} snapshot${rows.length === 1 ? '' : 's'}`));
}

async function findLocalSnapshotById(id: string): Promise<{ harnessSlug: string; tarballPath: string; bytes: number; manifest: any } | null> {
  const reg = await readRegistry();
  for (const project of reg.projects) {
    const tarballPath = join(project.path, '.papercusp', 'snapshots', `${id}.tar.gz`);
    if (!existsSync(tarballPath)) continue;
    const stat = await fs.stat(tarballPath);
    const m = await readManifestFromTarballSync(tarballPath, id);
    if (!m) continue;
    return { harnessSlug: project.slug, tarballPath, bytes: stat.size, manifest: m };
  }
  return null;
}

async function cmdSnapshotInfo(args: string[]): Promise<void> {
  let asJson = false;
  let id: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { asJson = true; continue; }
    if (a.startsWith('--')) die(`snapshot info: unknown flag "${a}"`);
    if (id === null) { id = a; continue; }
    die(`snapshot info: unexpected argument "${a}"`);
  }
  if (!id) die('snapshot info: usage: papercusp snapshot info <snap-id> [--json]');

  const found = await findLocalSnapshotById(id);
  if (!found) die(`snapshot info: no local snapshot "${id}" found across registered harnesses.`);

  if (asJson) {
    console.log(JSON.stringify({
      id,
      harnessSlug: found.harnessSlug,
      tarballPath: found.tarballPath,
      bytes: found.bytes,
      manifest: found.manifest,
    }, null, 2));
    return;
  }

  const m = found.manifest as {
    name?: string;
    description?: string;
    license?: string;
    createdAt?: number;
    template?: { name?: string; version?: string };
    files?: unknown[];
    excluded?: unknown[];
    plugins?: Array<{
      name?: string;
      version?: string;
      capabilities?: string[];
      shapeJson?: string;
      pluginVersionPinned?: boolean;
      versionPin?: { mode: 'semver' | 'exact' | 'hash'; allowOverride?: string };
    }>;
    redactions?: { blockedSecretsTier?: string; verifiedHits?: number; highRecallHits?: number };
    partial?: boolean;
  };
  const date = m.createdAt ? new Date(m.createdAt).toISOString().replace('T', ' ').slice(0, 19) : '?';
  const mb = (found.bytes / 1e6).toFixed(2);

  console.log(`${cyan(id)}`);
  console.log(`  ${dim('name:        ')}${m.name ?? dim('(unset)')}`);
  if (m.description) console.log(`  ${dim('description: ')}${m.description}`);
  console.log(`  ${dim('harness:     ')}${found.harnessSlug}`);
  if (m.template?.name) console.log(`  ${dim('template:    ')}${m.template.name}@${m.template.version ?? '?'}`);
  console.log(`  ${dim('captured:    ')}${date}`);
  console.log(`  ${dim('size:        ')}${mb} MB`);
  console.log(`  ${dim('license:     ')}${m.license ?? '(unset)'}`);
  console.log(`  ${dim('files:       ')}${m.files?.length ?? 0} (${m.excluded?.length ?? 0} excluded)`);
  if (m.partial) console.log(`  ${dim('partial:     ')}yes`);

  const r = m.redactions ?? {};
  const redactSummary =
    (r.verifiedHits ?? 0) === 0 && (r.highRecallHits ?? 0) === 0
      ? 'clean'
      : `${r.verifiedHits ?? 0} verified, ${r.highRecallHits ?? 0} warnings (tier=${r.blockedSecretsTier ?? '?'})`;
  console.log(`  ${dim('redactions:  ')}${redactSummary}`);

  if (m.plugins && m.plugins.length > 0) {
    console.log(`  ${dim('plugins:')}`);
    for (const p of m.plugins) {
      // Prefer v2 versionPin; fall back to v1 pluginVersionPinned for legacy snapshots.
      const mode = p.versionPin?.mode
        ?? (p.pluginVersionPinned === false ? 'semver'
          : p.pluginVersionPinned === true ? 'exact'
          : 'exact');
      const pinned = mode === 'exact' ? dim(' pinned')
        : mode === 'hash' ? dim(' hash-pinned')
        : dim(' floating');
      const caps = p.capabilities?.length ? dim(`  [${p.capabilities.length} caps]`) : '';
      console.log(`    - ${p.name}@${p.version ?? '?'}${pinned}${caps}`);

      // Surface share-semantics if the snapshot was captured under V1+.
      if (p.shapeJson) {
        try {
          const shape = JSON.parse(p.shapeJson) as {
            fields?: Record<string, { reason?: string; oauth?: { provider: string }; description?: string }>;
            warnings?: string[];
          };
          const fields = Object.entries(shape.fields ?? {});
          if (fields.length > 0) {
            console.log(`      ${dim('redacted fields:')}`);
            for (const [name, f] of fields) {
              const tag =
                f.reason === 'shareable-false' ? 'publisher-specific' :
                f.reason === 'secret-strip' ? 'secret' :
                f.reason === 'secret-warn' ? 'secret (warned)' :
                f.reason === 'secret-include' ? 'INCLUDED (publisher confirmed)' :
                f.reason === 'pattern-fallback' ? 'pattern-fallback' :
                'unknown';
              const oauth = f.oauth ? dim(` → oauth:${f.oauth.provider}`) : '';
              console.log(`        · ${name}  ${dim('[' + tag + ']')}${oauth}`);
            }
          }
          if (shape.warnings && shape.warnings.length > 0) {
            console.log(`      ${dim('warnings:')}`);
            for (const w of shape.warnings) console.log(`        ⚠ ${w}`);
          }
        } catch {
          // ignore malformed shape
        }
      }
    }
  }

  console.log('');
  console.log(`  ${dim('tarball:  ' + found.tarballPath)}`);
}

async function cmdSnapshotDelete(args: string[]): Promise<void> {
  let force = false;
  let id: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--force') { force = true; continue; }
    if (a.startsWith('-')) die(`snapshot delete: unknown flag "${a}"`);
    if (id === null) { id = a; continue; }
    die(`snapshot delete: unexpected argument "${a}"`);
  }
  if (!id) die('snapshot delete: usage: papercusp snapshot delete <snap-id> [-f]');

  const found = await findLocalSnapshotById(id);
  if (!found) die(`snapshot delete: no local snapshot "${id}" found.`);

  if (!force) {
    const m = found.manifest as { name?: string };
    const label = m.name ? `"${m.name}" (${id})` : id;
    process.stdout.write(`Delete ${label} from ${found.harnessSlug}? [y/N] `);
    const answer = await new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) { process.stdin.pause(); resolve(buf.trim()); }
      });
      process.stdin.resume();
    });
    if (!/^y(es)?$/i.test(answer)) {
      console.log(dim('cancelled.'));
      return;
    }
  }

  await fs.unlink(found.tarballPath);
  await fs.unlink(found.tarballPath + '.sha256').catch(() => {});
  console.log(green(`✓ deleted ${id}`));
}

async function cmdSnapshotPublishId(args: string[]): Promise<void> {
  let id: string | null = null;
  let slug: string | null = null;
  let version: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--slug' && args[i + 1]) { slug = args[i + 1]; i++; continue; }
    if (a === '--version' && args[i + 1]) { version = args[i + 1]; i++; continue; }
    if (a.startsWith('--')) die(`snapshot publish-id: unknown flag "${a}"`);
    if (id === null) { id = a; continue; }
    die(`snapshot publish-id: unexpected argument "${a}"`);
  }
  if (!id) die('snapshot publish-id: usage: papercusp snapshot publish-id <snap-id> [--slug <name>] [--version <ver>]');

  const found = await findLocalSnapshotById(id);
  if (!found) die(`snapshot publish-id: no local snapshot "${id}" found.`);
  const m = found.manifest as { name?: string; description?: string; license?: string; harnessSlug?: string; createdAt?: number };

  const date = new Date(m.createdAt ?? Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
  const finalSlug = slug ?? `${found.harnessSlug}-snapshot-${date}`;
  if (!isValidSlug(finalSlug)) die(`snapshot publish-id: derived/given slug "${finalSlug}" is not valid.`);
  const finalVersion = version ?? `1.0.0-ts${Date.now()}`;

  const sourceIcon = (m as { icon?: string }).icon ?? await fetchTemplateIcon(found.harnessSlug) ?? 'Layers';

  const manifestPayload = {
    name: finalSlug,
    version: finalVersion,
    kind: 'snapshot' as const,
    papercusp: '^0.1.0',
    description: m.description ?? m.name ?? `Snapshot ${id}`,
    license: m.license ?? 'MIT',
    icon: sourceIcon,
    snapshot: {
      sourceHarness: found.harnessSlug,
      capturedSnapshotId: id,
      original: m,
    },
  };

  const tarballBuf = await fs.readFile(found.tarballPath);
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifestPayload));
  form.append('tarball', new Blob([new Uint8Array(tarballBuf)], { type: 'application/gzip' }), `${finalSlug}-${finalVersion}.tar.gz`);

  const creds = await readCredentials();
  const headers: Record<string, string> = {};
  if (process.env.PAPERCUSP_SERVICE_TOKEN) {
    headers['authorization'] = `Bearer ${process.env.PAPERCUSP_SERVICE_TOKEN}`;
  } else if (creds.sessionToken) {
    headers['authorization'] = `Bearer ${creds.sessionToken}`;
  } else if (creds.github_pat) {
    headers['authorization'] = `Bearer ${creds.github_pat}`;
  }

  const url = `${MARKETPLACE_URL}/publish/${encodeURIComponent(finalSlug)}/${encodeURIComponent(finalVersion)}`;
  console.log(`uploading ${cyan(id)} → ${cyan(`${finalSlug}@${finalVersion}`)} to ${MARKETPLACE_URL}...`);
  const r = await fetch(url, { method: 'POST', body: form, headers });
  if (!r.ok) {
    const text = await r.text();
    die(`snapshot publish-id: HTTP ${r.status}: ${text.slice(0, 400)}`);
  }
  const result = await r.json().catch(() => ({}));
  console.log('');
  console.log(green(`✓ published ${finalSlug}@${finalVersion}`));
  if ((result as any).manifestUrl) {
    console.log(`  ${dim('manifest: ' + (result as any).manifestUrl)}`);
  }
}
