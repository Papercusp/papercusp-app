/**
 * `papercusp plugin init` — scaffold a new plugin from a reference template.
 *
 * Usage:
 *   papercusp plugin init <new-plugin-name>
 *     [--template <slug>]            Source template (default: cloudflare-stack)
 *     [--from-path <local-path>]     Source from a local directory instead of installed global-plugins
 *     [--into <dir>]                 Target dir (default: ./<plugin-name>)
 *     [--publisher <@scope>]         Manifest publisher (default: @local)
 *     [--description <text>]         Manifest description
 *     [--non-interactive]            Don't prompt; use defaults
 *
 * The command:
 *   1. Locates the source plugin (installed globally or via --from-path)
 *   2. Prompts for publisher / description / harness-slug-token (or --non-interactive)
 *   3. Copies all files to the target directory
 *   4. Rewrites the manifest's name/version/publisher/description
 *   5. Replaces references to the source plugin slug across all text files
 *   6. Prints next-steps
 *
 * The default template is `@papercupai/cloudflare-stack` because it
 * exercises every primitive (provision.setup/teardown/verify, share-semantics
 * flags, project-file templating, network policy preset).
 */

import { promises as fs, existsSync } from 'node:fs';
import { join, resolve as pathResolve, basename, dirname } from 'node:path';
import * as readline from 'node:readline';

import { papercuspRoot } from './papercusp-root.ts';

const PAPERCUSP_ROOT = papercuspRoot();
const GLOBAL_PLUGINS_DIR = join(PAPERCUSP_ROOT, 'global-plugins');

function colorize(s: string, code: string): string {
  if (process.stdout.isTTY === false) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s: string) => colorize(s, '2');
const cyan = (s: string) => colorize(s, '36');
const green = (s: string) => colorize(s, '32');
const yellow = (s: string) => colorize(s, '33');
const red = (s: string) => colorize(s, '31');
const bold = (s: string) => colorize(s, '1');

function die(msg: string, exit = 1): never {
  console.error(red(`error: ${msg}`));
  process.exit(exit);
}

async function ask(rl: readline.Interface, prompt: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? dim(` [${def}]`) : '';
  return new Promise((resolve) => {
    rl.question(`${prompt}${suffix}: `, (a) => resolve(a.trim() || def || ''));
  });
}

interface InitOpts {
  newName: string;
  template: string;
  fromPath?: string;
  into?: string;
  publisher?: string;
  description?: string;
  nonInteractive: boolean;
}

function parseArgs(args: string[]): InitOpts {
  const out: InitOpts = {
    newName: '',
    template: 'cloudflare-stack',
    nonInteractive: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--template':
        out.template = args[++i] ?? '';
        break;
      case '--from-path':
        out.fromPath = args[++i];
        break;
      case '--into':
        out.into = args[++i];
        break;
      case '--publisher':
        out.publisher = args[++i];
        break;
      case '--description':
        out.description = args[++i];
        break;
      case '--non-interactive':
      case '--yes':
      case '-y':
        out.nonInteractive = true;
        break;
      default:
        if (a.startsWith('--')) die(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length === 0) {
    die('plugin init: missing new-plugin-name. usage: papercusp plugin init <name> [--template <slug>]');
  }
  if (positional.length > 1) {
    die(`plugin init: unexpected extra argument: ${positional[1]}`);
  }
  out.newName = positional[0];
  return out;
}

function isValidPluginName(n: string): boolean {
  // bare slug or @scope/name; lowercase, hyphens, no spaces
  return /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(n);
}

function isValidPublisher(p: string): boolean {
  return /^@[a-z0-9-]+$/.test(p);
}

interface SourceManifest {
  name?: string;
  version?: string;
  kind?: string;
  publisher?: string;
  description?: string;
}

async function locateSource(opts: InitOpts): Promise<{ path: string; slug: string; manifest: SourceManifest }> {
  let path: string | null = null;

  if (opts.fromPath) {
    const resolved = pathResolve(opts.fromPath);
    if (!existsSync(join(resolved, 'papercusp.json'))) {
      die(`--from-path: no papercusp.json at ${resolved}`);
    }
    path = resolved;
  } else {
    // Try common spellings under GLOBAL_PLUGINS_DIR. The plugin may be
    // installed scoped (`@papercupai/<name>`) or bare (`<name>`) — also
    // accept the user passing a fully-qualified slug.
    const candidates = [
      opts.template,
      `@papercupai/${opts.template}`,
    ];
    for (const c of candidates) {
      const candidatePath = join(GLOBAL_PLUGINS_DIR, c);
      if (existsSync(join(candidatePath, 'papercusp.json'))) {
        path = candidatePath;
        break;
      }
    }
    if (!path) {
      die(
        `template "${opts.template}" not found in ${GLOBAL_PLUGINS_DIR}.\n` +
        `  install it first via: papercusp install ${opts.template}\n` +
        `  or pass --from-path </local/template/dir>`,
      );
    }
  }

  const manifestRaw = await fs.readFile(join(path, 'papercusp.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as SourceManifest;
  return { path, slug: manifest.name ?? basename(path), manifest };
}

/** Walk a directory, applying a string-substitution transform to every text file. */
async function copyDirWithSubstitutions(
  src: string,
  dest: string,
  substitutions: { from: string; to: string }[],
): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.papercusp') continue;
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) {
      await copyDirWithSubstitutions(s, d, substitutions);
      continue;
    }
    if (!e.isFile()) continue;
    // Skip binary-ish files: shell out to `file` is overkill; size+ext heuristic
    const stat = await fs.stat(s);
    const isProbablyText =
      /\.(json|md|sh|toml|yaml|yml|ts|tsx|js|jsx|mjs|cjs|css|html|txt|tmpl|env|sql)$/.test(e.name) ||
      e.name === 'README' || e.name === 'LICENSE' || e.name.startsWith('.');
    if (isProbablyText && stat.size < 10 * 1024 * 1024) {
      let body = await fs.readFile(s, 'utf8');
      for (const sub of substitutions) {
        body = body.split(sub.from).join(sub.to);
      }
      await fs.writeFile(d, body);
      // preserve exec bit if source had one
      if ((stat.mode & 0o111) !== 0) await fs.chmod(d, stat.mode);
    } else {
      await fs.copyFile(s, d);
      if ((stat.mode & 0o111) !== 0) await fs.chmod(d, stat.mode);
    }
  }
}

export async function cmdPluginInit(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  // 1. Resolve source
  const source = await locateSource(opts);
  const sourceSlug = source.slug;
  const sourcePublisher = source.manifest.publisher ?? '@papercupai';
  console.log(dim(`source: ${sourceSlug} v${source.manifest.version ?? '0.0.0'} at ${source.path}`));

  // 2. Validate + collect inputs
  if (!isValidPluginName(opts.newName)) {
    die(
      `invalid plugin name "${opts.newName}".\n` +
      `  must be lowercase, hyphenated, optionally @scoped (e.g. "my-stack" or "@me/my-stack")`,
    );
  }
  // Derive bare slug + scope
  let newScope = '@local';
  let newBare = opts.newName;
  if (opts.newName.startsWith('@')) {
    const [scope, bare] = opts.newName.split('/');
    newScope = scope;
    newBare = bare;
  }
  if (opts.publisher) {
    if (!isValidPublisher(opts.publisher)) die(`invalid --publisher "${opts.publisher}"; expected @scope`);
    newScope = opts.publisher;
  }

  let publisher = newScope;
  let description = opts.description ?? source.manifest.description ?? '';
  let intoDir = opts.into ?? `./${newBare}`;

  if (!opts.nonInteractive && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log();
      console.log(bold(`Scaffolding ${cyan(`${newScope}/${newBare}`)} from ${dim(sourceSlug)}`));
      publisher = await ask(rl, 'Publisher (@scope)', publisher);
      if (!isValidPublisher(publisher)) die(`invalid publisher "${publisher}"`);
      description = await ask(rl, 'Description', description);
      intoDir = await ask(rl, 'Target directory', intoDir);
    } finally {
      rl.close();
    }
  }

  intoDir = pathResolve(intoDir);
  if (existsSync(intoDir)) {
    const entries = await fs.readdir(intoDir);
    if (entries.length > 0) die(`target directory not empty: ${intoDir}`);
  }

  const newSlugFull = `${publisher}/${newBare}`;

  // 3. Substitutions: rewrite the source slug + publisher in all text files.
  // Order matters: scoped form first so we don't double-rewrite.
  const substitutions: { from: string; to: string }[] = [];
  if (sourceSlug.includes('/')) {
    substitutions.push({ from: sourceSlug, to: newSlugFull });
  }
  // Then bare-name occurrences (path references in README, etc.)
  const sourceBare = sourceSlug.includes('/') ? sourceSlug.split('/')[1] : sourceSlug;
  if (sourceBare !== newBare) {
    substitutions.push({ from: sourceBare, to: newBare });
  }
  // Then publisher
  if (sourcePublisher !== publisher) {
    substitutions.push({ from: sourcePublisher, to: publisher });
  }

  // 4. Copy + substitute
  console.log(dim(`writing to ${intoDir}…`));
  await copyDirWithSubstitutions(source.path, intoDir, substitutions);

  // 5. Patch manifest fields the substitutions might have missed
  const newManifestPath = join(intoDir, 'papercusp.json');
  const newManifest = JSON.parse(await fs.readFile(newManifestPath, 'utf8')) as Record<string, unknown>;
  newManifest.name = newSlugFull;
  newManifest.publisher = publisher;
  newManifest.version = '0.1.0';
  if (description) newManifest.description = description;
  await fs.writeFile(newManifestPath, JSON.stringify(newManifest, null, 2) + '\n');

  // 6. Print next-steps
  console.log();
  console.log(green(`✓ Scaffolded ${bold(newSlugFull)} at ${intoDir}`));
  console.log();
  console.log(bold('Next steps:'));
  console.log(`  1. cd ${intoDir}`);
  console.log(`  2. Edit ${cyan('provision/setup.sh')} to provision your platform's resources`);
  console.log(`  3. Edit ${cyan('provision/teardown.sh')} to handle each ${dim('papercusp_record_resource')} kind`);
  console.log(`  4. Edit ${cyan('configSchema')} in ${cyan('papercusp.json')} to declare your fork-time variables`);
  console.log(`  5. Test locally:`);
  console.log(`       ${dim(`papercusp install --from-path ${intoDir}`)}`);
  console.log(`       ${dim(`papercusp plugin enable ${newSlugFull} --harness <slug>`)}`);
  console.log();
  console.log(`Reference docs: ${cyan('https://papercuspai.com/docs/snapshots/build-scripts')}`);
  console.log(`Source template: ${dim(sourceSlug)} — keep it open as you customize.`);
}
