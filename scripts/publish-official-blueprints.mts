#!/usr/bin/env npx tsx
/**
 * Publish the OFFICIAL blueprints through the standard Cupboard process
 * (official-blueprints-cupboard-publish-2026-06-05 P-003 / D-003).
 *
 * Two subcommands:
 *
 *   sync     Mirror the bundled blueprints
 *            (libs/papercusp/packages/harness/blueprints/<id>/) into a scratch
 *            clone of the PUBLIC content repo (github.com/Papercusp/blueprints,
 *            one top-level dir per blueprint — the layout the
 *            /cupboard/install-blueprint route's `listing_ref` lookup expects),
 *            regenerate its README, commit as papercupai, push.
 *
 *   publish  For each blueprint id (default: every dir on disk; --ids a,b to
 *            narrow; --limit N to respect the worker's 5/hour publish cap),
 *            invoke the operator's /cupboard/publish-blueprint route handler
 *            IN-PROCESS — the exact standard path: gh-token (papercupai) +
 *            channel-2 attestation + POST cupboard.papercusp.com/listings,
 *            through the worker's standard gates (rate limit, public-repo
 *            check, dedup per (repo, kind, listing_ref)). Re-publishes dedup
 *            to the existing listing, so the command is idempotent.
 *
 * The bundle stays the bootstrap floor (D-004) — publishing adds the standard
 * distribution channel on top, it does not replace the bundled set.
 */
import { execFileSync } from 'node:child_process';
import {
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { stampMirrorIdentityAttestations } from '@papercusp/operator-core/lib/cupboard/identity-attestation';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLUEPRINTS = join(REPO, 'libs/papercusp/packages/harness/blueprints');
const OPERATOR_PROMPTS = join(REPO, 'apps/operator/prompts');
const CONTENT_REPO = 'Papercusp/blueprints';
const CONTENT_URL = `https://github.com/${CONTENT_REPO}`;
const SCRATCH = join(homedir(), '.papercusp', 'scratch', 'official-blueprints-mirror');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function blueprintIds(): string[] {
  return readdirSync(BLUEPRINTS)
    .filter((d) => existsSync(join(BLUEPRINTS, d, 'blueprint.yaml')))
    .sort();
}

function readManifest(id: string): Record<string, unknown> {
  return parseYaml(readFileSync(join(BLUEPRINTS, id, 'blueprint.yaml'), 'utf8')) as Record<string, unknown>;
}

function regularFiles(root: string, relativeDir = ''): string[] {
  const dir = join(root, relativeDir);
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...regularFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`operator prompt mirror refuses non-file entry: ${relativePath}`);
    }
  }
  return files.sort();
}

/**
 * Project the operator's canonical prompt content into the public base-blueprint
 * mirror. The full collision preflight runs before the first write so a new
 * blueprint-local prompt can never be silently replaced by an app prompt.
 */
export function projectOperatorPromptsIntoBase(
  mirrorRoot: string,
  operatorPromptsDir = OPERATOR_PROMPTS,
): string[] {
  if (!existsSync(operatorPromptsDir)) {
    throw new Error(`operator prompts source missing: ${operatorPromptsDir}`);
  }

  const basePrompts = join(mirrorRoot, 'base', 'prompts');
  const files = regularFiles(operatorPromptsDir);
  const collisions = new Set<string>();
  for (const relativePath of files) {
    const parts = relativePath.split(/[\\/]/u);
    let parent = basePrompts;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      parent = join(parent, part);
      if (existsSync(parent) && !lstatSync(parent).isDirectory()) {
        collisions.add(parts.slice(0, index + 1).join('/'));
        break;
      }
    }
    if (existsSync(join(basePrompts, relativePath))) collisions.add(relativePath.replaceAll('\\', '/'));
  }
  if (collisions.size > 0) {
    throw new Error(
      `operator prompt mirror collision under base/prompts: ${[...collisions].sort().join(', ')}`,
    );
  }

  for (const relativePath of files) {
    const destination = join(basePrompts, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(operatorPromptsDir, relativePath), destination, fsConstants.COPYFILE_EXCL);
  }
  return files.map((relativePath) => relativePath.replaceAll('\\', '/'));
}

async function sync(): Promise<void> {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(dirname(SCRATCH), { recursive: true });
  execFileSync('git', ['clone', '--depth', '1', `git@github.com:${CONTENT_REPO}.git`, SCRATCH], {
    encoding: 'utf8',
  });

  // Mirror each blueprint dir verbatim (blueprint.yaml + any blueprint-local prompts/).
  const ids = blueprintIds();
  for (const entry of readdirSync(SCRATCH)) {
    if (entry === '.git' || entry === 'README.md') continue;
    rmSync(join(SCRATCH, entry), { recursive: true, force: true });
  }
  for (const id of ids) {
    cpSync(join(BLUEPRINTS, id), join(SCRATCH, id), { recursive: true });
  }
  // P-003 / identities-v1 D-124: an installed identity must carry an in-document
  // attestation, or every identity surface refuses it (attestation-missing). Stamp
  // the MIRROR copy only — the listing signature then covers these exact bytes.
  const attested = stampMirrorIdentityAttestations(SCRATCH, ids);
  console.log(`attested ${attested.length} identity document(s): ${attested.map((a) => a.id).join(', ')}`);
  const promptFiles = projectOperatorPromptsIntoBase(SCRATCH);

  const rows = ids
    .map((id) => {
      const m = readManifest(id);
      const desc = String(m.description ?? '').replace(/\s+/g, ' ').trim();
      return `| \`${id}\` | ${desc} |`;
    })
    .join('\n');
  writeFileSync(
    join(SCRATCH, 'README.md'),
    `# Papercusp official blueprints

The official [Papercusp](https://papercusp.com) harness blueprints, published to
the Cupboard as \`kind=blueprint\` listings — one listing per blueprint,
\`listing_ref\` = the blueprint id (the top-level directory name here).

| Blueprint | Description |
|---|---|
${rows}

## Install

Through the Cupboard UI (the listing's **Fork** action), or directly:

\`\`\`
POST /api/cupboard/install-blueprint { "listingId": "<cupboard listing id>" }
POST /api/cupboard/install-blueprint { "githubUrl": "${CONTENT_URL}", "listingRef": "<id>" }
\`\`\`

The install validates the blueprint (schema + semantics + declared
\`dependencies.{tools,plugins}\` against your host) and places it under
\`~/.papercusp/blueprints/<id>/\` — the *installed* tier of the
local → installed → built-in \`extends\` resolution.

## Provenance

Source of truth: the \`papercup\` monorepo
(\`libs/papercusp/packages/harness/blueprints/\` plus
\`apps/operator/prompts/\`, projected under \`base/prompts/\`). This repo is a generated
mirror — synced by \`scripts/publish-official-blueprints.mts sync\`; do not edit
here. Prompt projection refuses every destination collision before writing, so
blueprint-local prompt content cannot be silently overwritten. The same
blueprints also ship bundled inside Papercusp as the bootstrap/offline floor; a
Cupboard-installed copy shadows the bundled one.
`,
  );

  git(['add', '-A'], SCRATCH);
  const status = git(['status', '--porcelain'], SCRATCH).trim();
  if (!status) {
    console.log('mirror already up to date — nothing to push');
    return;
  }
  git(
    ['-c', 'user.name=papercupai', '-c', 'user.email=papercupai@users.noreply.github.com',
      'commit', '-m', `sync official blueprints (${ids.length}) + prompts (${promptFiles.length})`],
    SCRATCH,
  );
  git(['push', 'origin', 'HEAD'], SCRATCH);
  console.log(`pushed mirror: ${ids.length} blueprints + ${promptFiles.length} prompt files → ${CONTENT_URL}`);
}

async function publish(opts: { ids?: string[]; limit?: number }): Promise<void> {
  const { default: route } = await import(
    join(REPO, 'packages/operator-core/lib/endpoint-route/routes/cupboard-publish-blueprint.ts')
  );
  const ids = opts.ids ?? blueprintIds();
  const limit = opts.limit ?? ids.length;
  let published = 0;
  const remaining: string[] = [];
  for (const id of ids) {
    if (published >= limit) {
      remaining.push(id);
      continue;
    }
    const req = new Request('http://localhost/api/cupboard/publish-blueprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        github_url: CONTENT_URL,
        project_ref: CONTENT_REPO,
        title: id,
      }),
    });
    const res: Response = await route.handler(req);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok) {
      const listing = body.listing as Record<string, unknown> | undefined;
      const row = (listing?.listing as Record<string, unknown> | undefined) ?? listing;
      const dedup = (listing as Record<string, unknown> | undefined)?.dedup === true || (row as Record<string, unknown> | undefined)?.dedup === true;
      console.log(`✓ ${id} published${dedup ? ' (dedup — already listed)' : ''}`);
      published++;
    } else if (body.upstream_status === 429 || JSON.stringify(body).includes('rate_limited')) {
      console.log(`⏸ ${id}: rate_limited (worker 5/hour cap) — stop here, retry the rest next window`);
      remaining.push(id, ...ids.slice(ids.indexOf(id) + 1).filter((x) => !remaining.includes(x)));
      break;
    } else {
      console.log(`✗ ${id}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
      remaining.push(id);
    }
  }
  console.log(`published=${published} remaining=[${[...new Set(remaining)].join(', ')}]`);
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = args;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) flags.set(rest[i].slice(2), rest[i + 1] ?? '');
  }
  if (cmd === 'sync') {
    await sync();
  } else if (cmd === 'publish') {
    await publish({
      ids: flags.get('ids')?.split(',').map((s) => s.trim()).filter(Boolean),
      limit: flags.has('limit') ? Number(flags.get('limit')) : undefined,
    });
  } else {
    console.log('usage: npx tsx scripts/publish-official-blueprints.mts <sync|publish> [--ids a,b] [--limit N]');
    process.exitCode = 2;
  }
}

if (isCliEntry(import.meta.url)) {
  await main();
}
