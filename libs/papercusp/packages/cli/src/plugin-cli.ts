/**
 * `papercusp plugin {list,enable,disable,config}` — per-harness plugin lifecycle.
 *
 * Spec §14.7 P3. Plugins are installed globally at
 *   ~/.papercusp/global-plugins/<slug>/
 * and enabled per-harness at
 *   ~/.papercusp/harnesses/<slug>/enabled-plugins.json
 *   ~/.papercusp/harnesses/<slug>/plugin-configs/<plugin-slug>.json
 *
 * `enable` walks the plugin's `configSchema` (JSON Schema 2020-12 strict
 * subset, per spec §14.3.7) prompting for each property; honours `uiSchema`
 * `widget: 'password'` for masked entry. The escape hatch
 * `widget: 'plugin-config-panel'` is GUI-only — falls through to defaults
 * in CLI mode.
 *
 * Capability consent (P4) and the lockfile (P3.5) are owned by sibling
 * modules and are NOT touched here.
 */
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as readline from 'node:readline';

import { papercuspRoot } from './papercusp-root.ts';
// EI-214: resolve these LAZILY — module-init consts pinned the root before a
// test (or any embedder) could point PAPERCUSP_HOME at an isolated dir, which
// is how pcli test fixtures leaked into the user's REAL global-plugins and
// errored every pipeline finalize. papercuspRoot() caches, so this is free.
const globalPluginsDir = () => join(papercuspRoot(), 'global-plugins');
const harnessesDir = () => join(papercuspRoot(), 'harnesses');

function colorize(s: string, code: string): string {
  if (process.stdout.isTTY === false) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s: string) => colorize(s, '2');
const red = (s: string) => colorize(s, '31');
const green = (s: string) => colorize(s, '32');
const cyan = (s: string) => colorize(s, '36');
const yellow = (s: string) => colorize(s, '33');
const bold = (s: string) => colorize(s, '1');

function die(msg: string, exit = 1): never {
  console.error(red(`error: ${msg}`));
  process.exit(exit);
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

interface PluginManifest {
  name: string;
  version: string;
  kind?: 'plugin' | 'template';
  description?: string;
  capabilities?: string[];
  configSchema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  /** §16 — restrict plugin to specific template kinds (e.g. ["coding"]). */
  requiresTemplateKinds?: string[];
}

/**
 * Resolve a harness instance's templateKind. Source order:
 *   1. ~/.papercusp/harnesses/<slug>/papercusp.json `templateKind` field
 *   2. Same manifest's `topology: "multi"` ⇒ "org"
 *   3. ~/.papercusp/registry.json projects[].harness_kind ("coding" | "org" | "department")
 *   4. Default "coding" (back-compat for harnesses without any kind hint)
 */
async function harnessTemplateKind(harness: string): Promise<string> {
  const m = await readJson<Record<string, unknown>>(
    join(harnessesDir(), harness, 'papercusp.json'),
  );
  if (m) {
    if (typeof m.templateKind === 'string') return m.templateKind;
    if (m.topology === 'multi') return 'org';
  }
  const reg = await readJson<{
    projects?: Array<{ slug: string; harness_kind?: string }>;
  }>(join(papercuspRoot(), 'registry.json'));
  const project = reg?.projects?.find((p) => p.slug === harness);
  if (project?.harness_kind) return project.harness_kind;
  return 'coding';
}

interface EnabledPluginsFile {
  /** Map plugin-slug → { version, enabledAt, configHash }. */
  enabled: Record<string, { version: string; enabledAt: string; configHash: string }>;
}

function parseHarnessFlag(args: string[]): { harness: string | null; rest: string[] } {
  const out: string[] = [];
  let harness: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--harness' && args[i + 1]) {
      harness = args[i + 1];
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return { harness, rest: out };
}

/** Detect harness slug from cwd's .papercusp/config.json or registry. */
async function detectHarnessSlug(): Promise<string | null> {
  const harnessConfig = join(process.cwd(), '.papercusp', 'config.json');
  if (!existsSync(harnessConfig)) return null;
  const reg = await readJson<{ projects: Array<{ slug: string; path: string }> }>(
    join(papercuspRoot(), 'registry.json'),
  );
  if (!reg) return null;
  const cwd = process.cwd();
  const found = reg.projects.find((p) => p.path === cwd);
  return found?.slug ?? null;
}

async function resolveHarness(args: string[]): Promise<{ harness: string; rest: string[] }> {
  const parsed = parseHarnessFlag(args);
  if (parsed.harness) return { harness: parsed.harness, rest: parsed.rest };
  const detected = await detectHarnessSlug();
  if (detected) return { harness: detected, rest: parsed.rest };
  die(
    'plugin: could not detect harness — pass --harness <slug> or run from inside a harness project directory',
  );
}

async function loadInstalledManifest(slug: string): Promise<PluginManifest | null> {
  // 1) Direct path — handles bare slugs (`starlight`) and `@scope/<name>` when
  //    the install layout matches. Fastest path; covers the common case.
  const direct = await readJson<PluginManifest>(join(globalPluginsDir(), slug, 'papercusp.json'));
  if (direct) return direct;
  // 2) Fallback — scan top-level plus one level into any `@scope/` dir and
  //    match by manifest `name`. Mirrors the runtime loader's behaviour
  //    (apps/operator/app/api/_hono/plugins.ts > listPluginsIn) so the CLI
  //    can find a plugin even when its dirname doesn't match the manifest
  //    name (e.g. `starlight/` shipping `@papercupai/starlight`).
  if (!existsSync(globalPluginsDir())) return null;
  const entries = await fs.readdir(globalPluginsDir(), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const top = join(globalPluginsDir(), e.name);
    const m = await readJson<PluginManifest>(join(top, 'papercusp.json'));
    if (m?.name === slug) return m;
    if (m?.name) continue; // top-level plugin with a different name; don't recurse
    if (!e.name.startsWith('@')) continue;
    const inner = await fs.readdir(top, { withFileTypes: true }).catch(() => []);
    for (const sub of inner) {
      if (sub.name.startsWith('.')) continue;
      const subM = await readJson<PluginManifest>(join(top, sub.name, 'papercusp.json'));
      if (subM?.name === slug) return subM;
    }
  }
  return null;
}

async function loadEnabledFile(harnessSlug: string): Promise<EnabledPluginsFile> {
  const path = join(harnessesDir(), harnessSlug, 'enabled-plugins.json');
  return (await readJson<EnabledPluginsFile>(path)) ?? { enabled: {} };
}

async function saveEnabledFile(harnessSlug: string, file: EnabledPluginsFile): Promise<void> {
  await writeJson(join(harnessesDir(), harnessSlug, 'enabled-plugins.json'), file);
}

function configHash(config: Record<string, unknown>): string {
  return 'sha256-' + createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 32);
}

// ─── JSON-Schema 2020-12 strict-subset prompt loop ─────────────────────────

interface PromptCtx {
  rl: readline.Interface;
  ui: Record<string, unknown>;
  acceptDefaults: boolean;
}

function uiWidget(uiSchema: Record<string, unknown>, key: string): string | null {
  const node = uiSchema[key] as Record<string, unknown> | undefined;
  const widget = node?.['ui:widget'];
  return typeof widget === 'string' ? widget : null;
}

function uiHelp(uiSchema: Record<string, unknown>, key: string): string | null {
  const node = uiSchema[key] as Record<string, unknown> | undefined;
  const help = node?.['ui:help'] ?? node?.['ui:description'];
  return typeof help === 'string' ? help : null;
}

async function ask(rl: readline.Interface, prompt: string, masked = false): Promise<string> {
  if (!masked) {
    return new Promise((resolve) => rl.question(prompt, (a) => resolve(a)));
  }
  // Masked: write * for each keystroke. process.stdin must be a TTY.
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
    let buffer = '';
    const onData = (chunk: Buffer) => {
      const ch = chunk.toString('utf8');
      if (ch === '\n' || ch === '\r' || ch === '\x04') {
        stdin.removeListener('data', onData);
        if (stdin.isRaw && stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buffer);
      } else if (ch === '\x03') {
        process.exit(130);
      } else if (ch === '' || ch === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        buffer += ch;
        process.stdout.write('*');
      }
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function promptString(
  ctx: PromptCtx,
  key: string,
  prop: Record<string, unknown>,
  defaultValue: unknown,
): Promise<string | null> {
  const widget = uiWidget(ctx.ui, key);
  const masked = widget === 'password';
  const def = typeof defaultValue === 'string' ? defaultValue : (prop.default as string | undefined);
  const enumVals = Array.isArray(prop.enum) ? (prop.enum as string[]) : null;

  if (ctx.acceptDefaults) return def ?? null;

  const help = uiHelp(ctx.ui, key);
  if (help) console.log(`  ${dim(help)}`);
  if (enumVals) console.log(`  ${dim('options: ' + enumVals.join(', '))}`);

  const label = `${cyan(key)}${def !== undefined ? dim(` [${masked ? '••••' : def}]`) : ''}: `;
  const ans = await ask(ctx.rl, label, masked);
  if (ans === '' && def !== undefined) return def;
  if (ans === '') return null;
  if (enumVals && !enumVals.includes(ans)) {
    console.log(red(`  invalid: must be one of ${enumVals.join(', ')}`));
    return promptString(ctx, key, prop, defaultValue);
  }
  if (typeof prop.minLength === 'number' && ans.length < prop.minLength) {
    console.log(red(`  too short: min ${prop.minLength}`));
    return promptString(ctx, key, prop, defaultValue);
  }
  if (typeof prop.pattern === 'string') {
    const re = new RegExp(prop.pattern);
    if (!re.test(ans)) {
      console.log(red(`  doesn't match pattern: ${prop.pattern}`));
      return promptString(ctx, key, prop, defaultValue);
    }
  }
  return ans;
}

async function promptNumber(
  ctx: PromptCtx,
  key: string,
  prop: Record<string, unknown>,
  defaultValue: unknown,
): Promise<number | null> {
  const def = typeof defaultValue === 'number' ? defaultValue : (prop.default as number | undefined);
  if (ctx.acceptDefaults) return def ?? null;
  const help = uiHelp(ctx.ui, key);
  if (help) console.log(`  ${dim(help)}`);
  const ans = await ask(ctx.rl, `${cyan(key)}${def !== undefined ? dim(` [${def}]`) : ''}: `);
  if (ans === '' && def !== undefined) return def;
  if (ans === '') return null;
  const n = Number(ans);
  if (Number.isNaN(n)) {
    console.log(red(`  not a number`));
    return promptNumber(ctx, key, prop, defaultValue);
  }
  if (typeof prop.minimum === 'number' && n < prop.minimum) {
    console.log(red(`  must be >= ${prop.minimum}`));
    return promptNumber(ctx, key, prop, defaultValue);
  }
  if (typeof prop.maximum === 'number' && n > prop.maximum) {
    console.log(red(`  must be <= ${prop.maximum}`));
    return promptNumber(ctx, key, prop, defaultValue);
  }
  return n;
}

async function promptBoolean(
  ctx: PromptCtx,
  key: string,
  prop: Record<string, unknown>,
  defaultValue: unknown,
): Promise<boolean | null> {
  const def = typeof defaultValue === 'boolean' ? defaultValue : (prop.default as boolean | undefined);
  if (ctx.acceptDefaults) return def ?? null;
  const help = uiHelp(ctx.ui, key);
  if (help) console.log(`  ${dim(help)}`);
  const defLabel = def === undefined ? '' : ` [${def ? 'Y/n' : 'y/N'}]`;
  const ans = (await ask(ctx.rl, `${cyan(key)}${dim(defLabel)}: `)).trim().toLowerCase();
  if (ans === '' && def !== undefined) return def;
  if (ans === '') return null;
  if (['y', 'yes', 'true', '1'].includes(ans)) return true;
  if (['n', 'no', 'false', '0'].includes(ans)) return false;
  console.log(red(`  please answer y or n`));
  return promptBoolean(ctx, key, prop, defaultValue);
}

/**
 * Apply schema-evolution aliases declared at `configSchema.aliases`:
 *   { "oldName": "newName" }  → rename oldName → newName (preserves value)
 *   { "oldName": null }       → drop oldName from old configs
 *
 * No-op when the schema declares no aliases or the config has no matching
 * old keys. New keys (already in their canonical form) are untouched.
 */
function applyConfigAliases(
  config: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return config;
  const aliases = (schema as { aliases?: unknown }).aliases;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return config;
  const aliasMap = aliases as Record<string, string | null>;
  if (Object.keys(aliasMap).length === 0) return config;
  const out: Record<string, unknown> = { ...config };
  for (const [oldKey, newKey] of Object.entries(aliasMap)) {
    if (!(oldKey in out)) continue;
    const value = out[oldKey];
    delete out[oldKey];
    if (newKey === null) continue; // removal — drop and move on
    if (newKey in out) continue;   // canonical key already present — keep new, drop old
    out[newKey] = value;
  }
  return out;
}

/**
 * Strip any field whose value equals the manifest's schema default. Such
 * fields are redundant in the per-harness config — the resolver falls back
 * to the manifest default at read time. Pruning lets new manifest defaults
 * take effect when plugins are upgraded, instead of frozen-at-first-enable.
 *
 * Recurses into nested object schemas; arrays compared by JSON equality.
 */
function pruneSchemaDefaults(
  config: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return config;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    const prop = properties[k];
    if (!prop) { out[k] = v; continue; }
    if (prop.type === 'object' && prop.properties && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const pruned = pruneSchemaDefaults(v as Record<string, unknown>, prop);
      if (Object.keys(pruned).length > 0) out[k] = pruned;
      continue;
    }
    if ('default' in prop) {
      const def = prop.default;
      if (Array.isArray(v) && Array.isArray(def)) {
        if (JSON.stringify(v) === JSON.stringify(def)) continue;
      } else if (v === def) {
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

async function promptObject(
  ctx: PromptCtx,
  schema: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const out: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const widget = uiWidget(ctx.ui, key);
    if (widget === 'plugin-config-panel') {
      // Escape hatch — GUI-only. CLI keeps existing or default.
      out[key] = existing[key] ?? prop.default ?? null;
      continue;
    }
    const type = prop.type as string | undefined;
    const existingVal = existing[key];

    let v: unknown = null;
    if (type === 'string') {
      v = await promptString(ctx, key, prop, existingVal);
    } else if (type === 'number' || type === 'integer') {
      v = await promptNumber(ctx, key, prop, existingVal);
      if (type === 'integer' && typeof v === 'number') v = Math.trunc(v);
    } else if (type === 'boolean') {
      v = await promptBoolean(ctx, key, prop, existingVal);
    } else if (type === 'object' && prop.properties) {
      console.log(bold(`  ${key}:`));
      const nestedExisting = (existingVal as Record<string, unknown>) ?? {};
      const nestedUi = (ctx.ui[key] as Record<string, unknown>) ?? {};
      const nested = await promptObject({ ...ctx, ui: nestedUi }, prop, nestedExisting);
      v = nested;
    } else if (type === 'array') {
      // Minimal array support: comma-separated; element type inferred from items.type.
      const def = (existingVal ?? prop.default) as unknown[] | undefined;
      const ans = ctx.acceptDefaults
        ? ''
        : await ask(ctx.rl, `${cyan(key)}${dim(` (comma-separated)${def ? ` [${def.join(',')}]` : ''}`)}: `);
      const trimmed = ans.trim();
      if (trimmed === '' && def !== undefined) v = def;
      else if (trimmed === '') v = null;
      else {
        const items = (prop.items as Record<string, unknown> | undefined) ?? {};
        const itemType = items.type as string | undefined;
        const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
        v = itemType === 'number' || itemType === 'integer'
          ? parts.map(Number).filter((n) => !Number.isNaN(n))
          : itemType === 'boolean'
          ? parts.map((p) => ['true', '1', 'yes', 'y'].includes(p.toLowerCase()))
          : parts;
      }
    } else {
      // Unsupported type — keep existing or default.
      v = existingVal ?? prop.default ?? null;
    }

    if (v === null || v === undefined) {
      if (required.includes(key)) {
        // With --accept-defaults (non-interactive / template-driven init),
        // skip required fields that have no value rather than re-prompt.
        // The plugin won't be runnable until the operator fills these via
        // the UI's plugin-config editor or the CLI, but enabling still
        // succeeds so the plugin shows up as an actionable item.
        if (ctx.acceptDefaults) {
          console.log(dim(`  ${key} is required but unset — fill via the config editor before invoking actions`));
          continue;
        }
        console.log(red(`  ${key} is required`));
        const { [key]: _omit, ...rest } = out;
        const nextOut = await promptObject({ ...ctx }, schema, { ...existing, ...rest });
        return nextOut;
      }
      continue;
    }
    out[key] = v;
  }
  return out;
}

// ─── Subcommands ───────────────────────────────────────────────────────────

async function listInstalledPlugins(): Promise<string[]> {
  try {
    const entries = await fs.readdir(globalPluginsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function cmdPluginList(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const harnessSlug = parsed.harness ?? (await detectHarnessSlug());

  const installed = await listInstalledPlugins();
  const enabled: EnabledPluginsFile = harnessSlug
    ? await loadEnabledFile(harnessSlug)
    : { enabled: {} };

  console.log(bold('Installed plugins') + dim(` (${globalPluginsDir()})`));
  if (installed.length === 0) {
    console.log(`  ${dim('(none — use `papercusp install <slug>`)')}`);
  } else {
    for (const slug of installed) {
      const manifest = await loadInstalledManifest(slug);
      const ver = manifest?.version ?? '?';
      const isEnabled = harnessSlug && enabled.enabled[slug];
      const tag = isEnabled
        ? green(`enabled @ ${harnessSlug}`)
        : harnessSlug
        ? dim(`disabled in ${harnessSlug}`)
        : dim('(no harness selected)');
      console.log(`  ${cyan(slug.padEnd(40))} ${ver.padEnd(10)} ${tag}`);
    }
  }

  if (harnessSlug) {
    console.log('');
    console.log(bold(`Enabled in ${cyan(harnessSlug)}`));
    const keys = Object.keys(enabled.enabled);
    if (keys.length === 0) {
      console.log(`  ${dim('(none)')}`);
    } else {
      for (const k of keys) {
        const e = enabled.enabled[k];
        console.log(`  ${cyan(k.padEnd(40))} ${e.version.padEnd(10)} ${dim(e.enabledAt)}`);
      }
    }
  } else {
    console.log('');
    console.log(dim('pass --harness <slug> or cd into a harness project to see enable status'));
  }
}

export async function cmdPluginEnable(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const slug = parsed.rest[0];
  if (!slug) die('plugin enable: usage: papercusp plugin enable <slug> [--harness <slug>]');

  const acceptDefaults = parsed.rest.includes('--accept-defaults');
  const { harness } = parsed.harness
    ? { harness: parsed.harness }
    : await resolveHarness(args);

  const manifest = await loadInstalledManifest(slug);
  if (!manifest) {
    die(
      `plugin enable: ${slug} not installed in ${globalPluginsDir()}. ` +
        `Run \`papercusp install ${slug}\` first.`,
    );
  }
  if (manifest.kind && manifest.kind !== 'plugin') {
    die(`plugin enable: ${slug} has kind="${manifest.kind}", not "plugin"`);
  }

  if (manifest.requiresTemplateKinds && manifest.requiresTemplateKinds.length > 0) {
    const kind = await harnessTemplateKind(harness);
    if (!manifest.requiresTemplateKinds.includes(kind)) {
      die(
        `plugin enable: ${slug} requires templateKinds=[${manifest.requiresTemplateKinds.join(', ')}]; ` +
          `harness "${harness}" is kind="${kind}"`,
      );
    }
  }

  const enabled = await loadEnabledFile(harness);
  const existing = enabled.enabled[slug];

  // Canonicalise the on-disk config path on the manifest's `name` field so
  // the resolver (which reads `<manifest-name>.json`) and writes agree
  // regardless of which slug form the user typed (`starlight` vs
  // `@papercupai/starlight`).
  const canonicalSlug = manifest.name ?? slug;

  // Ensure the harness dir exists.
  await fs.mkdir(join(harnessesDir(), harness), { recursive: true });
  await fs.mkdir(join(harnessesDir(), harness, 'plugin-configs'), { recursive: true });
  const configPath = join(harnessesDir(), harness, 'plugin-configs', `${canonicalSlug}.json`);
  const legacyPath = join(harnessesDir(), harness, 'plugin-configs', `${slug}.json`);
  // Read existing config from canonical path; fall back to legacy for
  // back-compat with files written before canonicalisation. Apply schema
  // aliases so old field names get migrated forward before re-prompting.
  const rawExisting =
    (await readJson<Record<string, unknown>>(configPath))
    ?? (await readJson<Record<string, unknown>>(legacyPath))
    ?? {};
  const existingConfig = applyConfigAliases(
    rawExisting,
    manifest.configSchema as Record<string, unknown> | undefined,
  );

  let config: Record<string, unknown> = {};
  if (manifest.configSchema) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(
        bold(`enabling ${cyan(slug + '@' + manifest.version)} in harness ${cyan(harness)}`),
      );
      if (manifest.description) console.log(dim(manifest.description));
      console.log('');
      const ctx: PromptCtx = {
        rl,
        ui: (manifest.uiSchema as Record<string, unknown>) ?? {},
        acceptDefaults,
      };
      const seedConfig = {
        ...(manifest.defaultConfig ?? {}),
        ...existingConfig,
      };
      config = await promptObject(ctx, manifest.configSchema as Record<string, unknown>, seedConfig);
    } finally {
      rl.close();
    }
    config = pruneSchemaDefaults(config, manifest.configSchema as Record<string, unknown>);
  } else {
    config = manifest.defaultConfig ?? {};
  }

  await writeJson(configPath, config);
  // Migrate-on-write: if the user typed a non-canonical slug and a legacy
  // file exists at that path, retire it so future reads stay on the
  // canonical path.
  if (canonicalSlug !== slug && existsSync(legacyPath)) {
    try { await fs.unlink(legacyPath); } catch { /* best-effort */ }
  }

  // Canonicalise enabled-plugins.json key too: prefer manifest name, but
  // preserve an existing entry under the legacy slug if one is there.
  const enabledKey = enabled.enabled[canonicalSlug] ? canonicalSlug
    : enabled.enabled[slug] ? slug
    : canonicalSlug;
  if (enabledKey !== canonicalSlug && enabled.enabled[enabledKey]) {
    enabled.enabled[canonicalSlug] = enabled.enabled[enabledKey];
    delete enabled.enabled[enabledKey];
  }
  enabled.enabled[canonicalSlug] = {
    version: manifest.version,
    enabledAt: new Date().toISOString(),
    configHash: configHash(config),
  };
  await saveEnabledFile(harness, enabled);

  console.log('');
  console.log(green(`✓ enabled ${slug}@${manifest.version} in ${harness}`));
  if (existing) {
    console.log(dim(`  (was already enabled at version ${existing.version}; updated)`));
  }
  console.log(dim(`  config: ${configPath}`));
}

export async function cmdPluginDisable(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const slug = parsed.rest[0];
  if (!slug) die('plugin disable: usage: papercusp plugin disable <slug> [--harness <slug>]');
  const { harness } = parsed.harness
    ? { harness: parsed.harness }
    : await resolveHarness(args);

  const enabled = await loadEnabledFile(harness);
  if (!enabled.enabled[slug]) {
    console.log(`${dim(`${slug} is not enabled in ${harness}`)}`);
    return;
  }
  delete enabled.enabled[slug];
  await saveEnabledFile(harness, enabled);
  console.log(green(`✓ disabled ${slug} in ${harness}`));
  console.log(dim(`  (config preserved at ~/.papercusp/harnesses/${harness}/plugin-configs/${slug}.json)`));
}

export async function cmdPluginUninstall(args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) die('plugin uninstall: usage: papercusp plugin uninstall <slug> [--purge-grants]');
  const purgeGrants = args.includes('--purge-grants');

  const pluginDir = join(globalPluginsDir(), slug);
  const dirExists = existsSync(pluginDir);

  // Walk every harness and disable the plugin + delete its config.
  const disabledIn: string[] = [];
  if (existsSync(harnessesDir())) {
    const harnesses = await fs.readdir(harnessesDir(), { withFileTypes: true });
    for (const h of harnesses) {
      if (!h.isDirectory()) continue;
      const enabledFile = join(harnessesDir(), h.name, 'enabled-plugins.json');
      const enabled = await readJson<EnabledPluginsFile>(enabledFile);
      if (enabled?.enabled[slug]) {
        delete enabled.enabled[slug];
        await writeJson(enabledFile, enabled);
        disabledIn.push(h.name);
      }
      const configFile = join(harnessesDir(), h.name, 'plugin-configs', `${slug}.json`);
      if (existsSync(configFile)) await fs.rm(configFile, { force: true });
    }
  }

  if (dirExists) {
    await fs.rm(pluginDir, { recursive: true, force: true });
    console.log(green(`✓ removed ${pluginDir}`));
  } else if (disabledIn.length === 0) {
    console.log(dim(`${slug} is not installed and not enabled in any harness`));
    return;
  } else {
    console.log(dim(`${slug} not in ${pluginDir} (was already removed from disk)`));
  }

  if (disabledIn.length > 0) {
    console.log(dim(`  disabled in ${disabledIn.length} harness(es): ${disabledIn.join(', ')}`));
  }

  if (purgeGrants) {
    const grantedPath = join(papercuspRoot(), 'granted-capabilities.json');
    const extendedPath = join(papercuspRoot(), 'extended-grants.json');
    let purged = 0;
    for (const path of [grantedPath, extendedPath]) {
      const file = await readJson<{ grants?: Record<string, unknown>; extended?: Record<string, unknown> }>(path);
      if (!file) continue;
      const target = file.grants ?? file.extended;
      if (!target) continue;
      for (const key of Object.keys(target)) {
        if (key === slug || key.startsWith(`${slug}@`)) {
          delete (target as Record<string, unknown>)[key];
          purged++;
        }
      }
      await writeJson(path, file);
    }
    if (purged > 0) console.log(dim(`  purged ${purged} grant entry/entries`));
  } else {
    console.log(dim(`  (capability grants preserved; pass --purge-grants to remove)`));
  }
}

/**
 * Rename an installed plugin's on-disk slug across global-plugins,
 * per-harness enable state, per-harness config files, and granted
 * capabilities. The plugin's manifest `name` field is NOT modified —
 * the rename is purely the dir-basename slug used by the operator
 * runtime + state files. Callers who also need the manifest renamed
 * (e.g. when republishing under a new scoped name) edit
 * `papercusp.json` themselves before or after running this command.
 *
 * Two common scenarios:
 *   1. Dev-symlink rename: ~/.papercusp/global-plugins/old → source-dir
 *      gets repointed at the source's new location; this command updates
 *      the slug in every state file the operator reads. (Covered by
 *      moving the symlink itself OR running this command after.)
 *   2. Post-republish migration: user has installed both old and new
 *      from the marketplace; this command consolidates config + grants
 *      onto the new slug while uninstalling the old.
 */
export async function cmdPluginRename(args: string[]): Promise<void> {
  const oldSlug = args[0];
  const newSlug = args[1];
  if (!oldSlug || !newSlug) {
    die(
      'plugin rename: usage: papercusp plugin rename <old-slug> <new-slug>\n' +
        '  Renames the on-disk slug; migrates per-harness enable/config + grants.\n' +
        '  Does not change the manifest name field — edit papercusp.json yourself if needed.',
    );
  }
  if (oldSlug === newSlug) die(`plugin rename: <old-slug> and <new-slug> are the same`);

  const oldDir = join(globalPluginsDir(), oldSlug);
  const newDir = join(globalPluginsDir(), newSlug);
  // Detect symlinks via lstat so we don't follow into the target.
  let oldKind: 'dir' | 'symlink' | 'absent' = 'absent';
  try {
    const st = await fs.lstat(oldDir);
    oldKind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'absent';
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  if (oldKind === 'absent') {
    die(`plugin rename: ${oldDir} does not exist — nothing to rename`);
  }

  let newAlreadyExists = false;
  try {
    await fs.lstat(newDir);
    newAlreadyExists = true;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  if (newAlreadyExists) {
    die(
      `plugin rename: ${newDir} already exists — refusing to clobber. ` +
        `Run \`papercusp plugin uninstall ${newSlug}\` first if you want to replace it.`,
    );
  }

  await fs.rename(oldDir, newDir);
  console.log(`${green('✓')} renamed ${dim(oldDir)} → ${cyan(newDir)} ${dim('(' + oldKind + ')')}`);

  // Walk every harness, migrate enable + config state.
  const migratedHarnesses: string[] = [];
  if (existsSync(harnessesDir())) {
    const harnesses = await fs.readdir(harnessesDir(), { withFileTypes: true });
    for (const h of harnesses) {
      if (!h.isDirectory()) continue;
      let touched = false;

      // enabled-plugins.json — swap old key → new key (keep version/timestamp/hash)
      const enabledFile = join(harnessesDir(), h.name, 'enabled-plugins.json');
      const enabled = await readJson<EnabledPluginsFile>(enabledFile);
      if (enabled?.enabled[oldSlug]) {
        if (enabled.enabled[newSlug]) {
          console.log(
            `  ${yellow('!')} ${h.name}: both ${oldSlug} and ${newSlug} were enabled; ` +
              `keeping ${newSlug}'s entry, dropping ${oldSlug}`,
          );
          delete enabled.enabled[oldSlug];
        } else {
          enabled.enabled[newSlug] = enabled.enabled[oldSlug];
          delete enabled.enabled[oldSlug];
        }
        await writeJson(enabledFile, enabled);
        touched = true;
      }

      // plugin-configs/<slug>.json — rename file
      const oldConfig = join(harnessesDir(), h.name, 'plugin-configs', `${oldSlug}.json`);
      const newConfig = join(harnessesDir(), h.name, 'plugin-configs', `${newSlug}.json`);
      if (existsSync(oldConfig)) {
        if (existsSync(newConfig)) {
          // Don't clobber a hand-authored config under the new slug.
          console.log(
            `  ${yellow('!')} ${h.name}: ${newSlug}.json already exists; ` +
              `leaving ${oldSlug}.json in place — review manually`,
          );
        } else {
          await fs.rename(oldConfig, newConfig);
          touched = true;
        }
      }

      // plugin-data/<slug>/ — invoke-time mirror dir (cmdPluginInvoke writes config.json here)
      const oldDataDir = join(harnessesDir(), h.name, 'plugin-data', oldSlug);
      const newDataDir = join(harnessesDir(), h.name, 'plugin-data', newSlug);
      if (existsSync(oldDataDir) && !existsSync(newDataDir)) {
        await fs.rename(oldDataDir, newDataDir);
        touched = true;
      }

      if (touched) migratedHarnesses.push(h.name);
    }
  }

  // Capability grants — keys are typically `<slug>` or `<slug>@<version>` or
  // `<slug>:<harness>:<cap>`. Rewrite any key whose first colon-separated
  // segment matches the old slug (with or without an @version suffix).
  let grantsRenamed = 0;
  for (const file of ['granted-capabilities.json', 'extended-grants.json']) {
    const path = join(papercuspRoot(), file);
    const data = await readJson<{ grants?: Record<string, unknown>; extended?: Record<string, unknown> }>(path);
    if (!data) continue;
    const target = data.grants ?? data.extended;
    if (!target) continue;
    const updated: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(target)) {
      const head = key.split(':')[0];
      const headSlug = head.split('@')[0];
      if (headSlug === oldSlug) {
        const renamedHead = head.replace(oldSlug, newSlug);
        const newKey = renamedHead + key.slice(head.length);
        updated[newKey] = value;
        grantsRenamed++;
        changed = true;
      } else {
        updated[key] = value;
      }
    }
    if (changed) {
      if (data.grants) data.grants = updated;
      else data.extended = updated;
      await writeJson(path, data);
    }
  }

  console.log('');
  console.log(green(`✓ rename complete: ${oldSlug} → ${newSlug}`));
  if (migratedHarnesses.length > 0) {
    console.log(dim(`  migrated state in ${migratedHarnesses.length} harness(es): ${migratedHarnesses.join(', ')}`));
  }
  if (grantsRenamed > 0) {
    console.log(dim(`  rewrote ${grantsRenamed} grant key(s)`));
  }
  console.log(
    dim(
      `  the operator picks up the rename on its next plugin-runtime probe; ` +
        `restart it (or hit /api/plugins/global) if you want immediate refresh.`,
    ),
  );
}

export async function cmdPluginConfig(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const slug = parsed.rest[0];
  if (!slug) die('plugin config: usage: papercusp plugin config <slug> [--harness <slug>] [--set k=v]');
  const { harness } = parsed.harness
    ? { harness: parsed.harness }
    : await resolveHarness(args);

  const configPath = join(harnessesDir(), harness, 'plugin-configs', `${slug}.json`);
  if (!existsSync(configPath)) {
    die(`plugin config: ${slug} has no config in ${harness}. Run \`papercusp plugin enable ${slug}\` first.`);
  }

  // --set k=v parsing
  const sets: Array<[string, string]> = [];
  for (let i = 0; i < parsed.rest.length; i++) {
    if (parsed.rest[i] === '--set' && parsed.rest[i + 1]) {
      const eqIdx = parsed.rest[i + 1].indexOf('=');
      if (eqIdx > 0) {
        sets.push([parsed.rest[i + 1].slice(0, eqIdx), parsed.rest[i + 1].slice(eqIdx + 1)]);
      }
      i++;
    }
  }

  if (sets.length > 0) {
    const config = (await readJson<Record<string, unknown>>(configPath)) ?? {};
    for (const [k, v] of sets) {
      // Try to coerce booleans + numbers; otherwise keep as string.
      let coerced: unknown = v;
      if (v === 'true') coerced = true;
      else if (v === 'false') coerced = false;
      else if (v !== '' && !Number.isNaN(Number(v))) coerced = Number(v);
      // Support dotted keys: a.b.c
      const parts = k.split('.');
      let cur: Record<string, unknown> = config;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) {
          cur[parts[i]] = {};
        }
        cur = cur[parts[i]] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = coerced;
    }
    await writeJson(configPath, config);

    // Update configHash in enabled-plugins.json
    const enabled = await loadEnabledFile(harness);
    if (enabled.enabled[slug]) {
      enabled.enabled[slug].configHash = configHash(config);
      await saveEnabledFile(harness, enabled);
    }

    console.log(green(`✓ updated ${sets.length} key(s) in ${configPath}`));
    return;
  }

  // Interactive mode: open in $EDITOR if TTY, else cat
  if (process.stdout.isTTY && process.env.EDITOR) {
    await new Promise<void>((resolve) => {
      const child = spawn(process.env.EDITOR!, [configPath], { stdio: 'inherit' });
      child.on('exit', () => resolve());
    });
    // After editor closes, re-hash if changed.
    const newConfig = (await readJson<Record<string, unknown>>(configPath)) ?? {};
    const enabled = await loadEnabledFile(harness);
    if (enabled.enabled[slug]) {
      enabled.enabled[slug].configHash = configHash(newConfig);
      await saveEnabledFile(harness, enabled);
    }
    console.log(green(`✓ saved`));
    return;
  }

  // Fallback: print contents.
  const raw = await fs.readFile(configPath, 'utf8');
  console.log(raw);
  console.log(dim(`\n(set $EDITOR or pass --set k=v to modify; path: ${configPath})`));
}

// ─── plugin invoke (operator-facing manual action trigger) ─────────────────

export async function cmdPluginInvoke(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const slug = parsed.rest[0];
  const actionName = parsed.rest[1];
  if (!slug || !actionName) {
    die('plugin invoke: usage: papercusp plugin invoke <slug> <action> [--harness <slug>] [--params \'<json>\'] [--dry-run]');
  }
  const { harness } = parsed.harness ? { harness: parsed.harness } : await resolveHarness(args);

  // --params '<json>' or --dry-run shortcut
  let params: unknown = {};
  for (let i = 0; i < parsed.rest.length; i++) {
    if (parsed.rest[i] === '--params' && parsed.rest[i + 1]) {
      try {
        params = JSON.parse(parsed.rest[i + 1]);
      } catch (e) {
        die(`plugin invoke: --params is not valid JSON: ${(e as Error).message}`);
      }
      i++;
    }
  }
  if (parsed.rest.includes('--dry-run')) {
    params = { ...(typeof params === 'object' && params ? params : {}), dryRun: true };
  }

  const manifest = await loadInstalledManifest(slug);
  if (!manifest) die(`plugin invoke: ${slug} not installed`);
  if (manifest.kind && manifest.kind !== 'plugin') {
    die(`plugin invoke: ${slug} has kind="${manifest.kind}", not "plugin"`);
  }
  const enabled = await loadEnabledFile(harness);
  if (!enabled.enabled[slug]) {
    die(`plugin invoke: ${slug} not enabled in ${harness} (run \`papercusp plugin enable ${slug} --harness ${harness}\`)`);
  }

  // Resolve plugin entry path (mirrors plugin-loader/locateEntry).
  const candidates = ['index.ts', 'index.js', 'index.mjs', join('dist', 'index.js'), join('src', 'index.ts')];
  const pluginDir = join(globalPluginsDir(), slug);
  let entry: string | null = null;
  for (const c of candidates) {
    if (existsSync(join(pluginDir, c))) {
      entry = join(pluginDir, c);
      break;
    }
  }
  if (!entry) die(`plugin invoke: ${slug} has no entry file (expected one of ${candidates.join(', ')})`);

  // Mirror the per-harness config blob to <pluginDataDir>/config.json so plugins
  // that read from there (e.g. cloudflare-pages) see their config without us
  // having to redesign the config IPC.
  const harnessDir = join(harnessesDir(), harness);
  const pluginDataDir = join(harnessDir, 'plugin-data', slug);
  await fs.mkdir(pluginDataDir, { recursive: true });
  const pluginConfigPath = join(harnessDir, 'plugin-configs', `${slug}.json`);
  if (existsSync(pluginConfigPath)) {
    const cfg = await fs.readFile(pluginConfigPath, 'utf8');
    await fs.writeFile(join(pluginDataDir, 'config.json'), cfg);
  }

  // Run in-process. tsx (the CLI launcher) loads .ts files transparently.
  const { ServerActionRegistry, ActionRegistryError } = await import(
    '../../../../../packages/plugin-loader/src/actions.ts'
  );
  const { InMemoryAuditWriter } = await import(
    '../../../../../packages/plugin-loader/src/audit.ts'
  );
  const mod = await import(entry);
  const plugin = (mod as any).default ?? mod;
  if (!plugin || typeof plugin !== 'object') {
    die(`plugin invoke: ${slug} default export is not a Plugin object`);
  }

  // Action declarations live in the manifest (papercusp.json). The runtime
  // Plugin object only carries the SDK-typed surface (init, hooks, etc).
  const declaredActions = (manifest as { actions?: unknown }).actions;

  const audit = new InMemoryAuditWriter();
  let registry: InstanceType<typeof ServerActionRegistry>;
  try {
    registry = new ServerActionRegistry(declaredActions as never, {
      pluginName: (plugin as any).name ?? manifest.name,
      pluginCapabilities: (plugin as any).capabilities ?? manifest.capabilities,
      audit,
    });
  } catch (e: any) {
    if (e instanceof ActionRegistryError) {
      die(`plugin invoke: ${slug} manifest invalid: ${e.message}`);
    }
    throw e;
  }
  const ctx = {
    installSlug: harness,
    projectDir: harnessDir,
    stateDir: harnessDir,
    pluginDataDir,
    log: () => {},
    actions: registry as any,
  };
  if (typeof (plugin as any).init === 'function') {
    await (plugin as any).init(ctx);
  }
  registry.seal();

  const declaredNames = Array.isArray(declaredActions)
    ? (declaredActions as { name: string }[]).map((a) => a.name)
    : [];
  if (!registry.has(actionName)) {
    const known = registry.registeredNames();
    if (known.length === 0 && declaredNames.length === 0) {
      die(`plugin invoke: ${slug} declares no actions`);
    }
    die(
      `plugin invoke: ${slug} has no action "${actionName}" — try one of: ${(known.length > 0 ? known : declaredNames).join(', ')}`,
    );
  }

  const result = await registry.invoke({
    name: actionName,
    ctx: ctx as any,
    params,
    triggerSource: 'cli',
    triggerId: 'manual-' + Date.now(),
  });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.PAPERCUSP_INVOKE_AUDIT) {
    console.error('--- audit rows ---');
    console.error(JSON.stringify(audit.rowsForInspection(), null, 2));
  }
  // NOT process.exit(): stdout is async on a pipe and exit() does not drain it, so
  // `plugin invoke … | jq` would silently truncate the result printed above.
  // See scripts/check-undrained-stdout-exit.mjs.
  if ((result as { ok?: boolean }).ok === false) process.exitCode = 5;
}

// ─── plugin verify — flag configHash drift in enabled-plugins.json ─────────

export async function cmdPluginVerify(args: string[]): Promise<void> {
  const all = args.includes('--all');
  const fix = args.includes('--fix');
  const parsed = parseHarnessFlag(args.filter((a) => a !== '--all' && a !== '--fix'));

  const targets: string[] = [];
  if (all) {
    const dirs = await fs.readdir(harnessesDir(), { withFileTypes: true }).catch(() => []);
    targets.push(...dirs.filter((d) => d.isDirectory()).map((d) => d.name));
  } else {
    const { harness } = parsed.harness ? { harness: parsed.harness } : await resolveHarness(args);
    targets.push(harness);
  }

  // Build dir-base → canonical-name map from installed manifests so we can
  // detect enabled-plugins.json keys that should be renamed alongside the
  // already-canonicalised config files.
  const canonByBase = new Map<string, string>();
  const walkPlugins = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const sub = join(dir, e.name);
      const manifest = await readJson<{ name?: string }>(join(sub, 'papercusp.json'));
      if (manifest?.name && e.name !== manifest.name) canonByBase.set(e.name, manifest.name);
      else if (e.isDirectory() && e.name.startsWith('@')) await walkPlugins(sub);
    }
  };
  await walkPlugins(globalPluginsDir());

  let totalDrifted = 0;
  let totalChecked = 0;
  let totalFixed = 0;

  for (const harness of targets) {
    const enabled = await loadEnabledFile(harness);
    const slugs = Object.keys(enabled.enabled);
    if (slugs.length === 0) continue;

    type Drift = { slug: string; stored: string; actual: string; reason: 'hash-drift' | 'config-missing' | 'slug-mismatch'; canonicalSlug?: string };
    const drifted: Drift[] = [];
    for (const slug of slugs) {
      totalChecked++;
      const entry = enabled.enabled[slug];
      const configPath = join(harnessesDir(), harness, 'plugin-configs', `${slug}.json`);
      let cfg = await readJson<Record<string, unknown>>(configPath);

      // If config is missing at the legacy slug path, look for it at the
      // canonical scoped path before declaring it gone.
      let canonicalSlug: string | undefined;
      if (cfg === null) {
        const canon = canonByBase.get(slug);
        if (canon) {
          const canonicalPath = join(harnessesDir(), harness, 'plugin-configs', `${canon}.json`);
          const canonCfg = await readJson<Record<string, unknown>>(canonicalPath);
          if (canonCfg !== null) {
            cfg = canonCfg;
            canonicalSlug = canon;
          }
        }
      }

      const actual = configHash(cfg ?? {});
      if (canonicalSlug) {
        drifted.push({ slug, stored: entry.configHash, actual, reason: 'slug-mismatch', canonicalSlug });
      } else if (cfg === null) {
        drifted.push({ slug, stored: entry.configHash, actual, reason: 'config-missing' });
      } else if (actual !== entry.configHash) {
        drifted.push({ slug, stored: entry.configHash, actual, reason: 'hash-drift' });
      }
    }

    if (drifted.length === 0) continue;
    totalDrifted += drifted.length;

    console.log(bold(harness) + dim(` (${slugs.length} enabled, ${drifted.length} drifted)`));
    for (const d of drifted) {
      const tag = d.reason === 'config-missing' ? red('config-missing')
        : d.reason === 'slug-mismatch' ? yellow('slug-mismatch')
        : yellow('hash-drift');
      console.log(`  ${tag}  ${cyan(d.slug)}${d.canonicalSlug ? dim(` → ${d.canonicalSlug}`) : ''}`);
      if (d.reason !== 'slug-mismatch') {
        console.log(`    stored: ${dim(d.stored)}`);
        console.log(`    actual: ${dim(d.actual)}`);
      }
    }

    if (fix) {
      // Process slug-mismatches first (rename keys) before rewriting hashes.
      for (const d of drifted) {
        if (d.reason === 'slug-mismatch' && d.canonicalSlug) {
          enabled.enabled[d.canonicalSlug] = { ...enabled.enabled[d.slug], configHash: d.actual };
          delete enabled.enabled[d.slug];
          totalFixed++;
        } else if (d.reason === 'hash-drift') {
          enabled.enabled[d.slug].configHash = d.actual;
          totalFixed++;
        }
        // config-missing: don't auto-fix (the entry is genuinely orphaned;
        // user should disable+re-enable, or delete the entry manually).
      }
      await saveEnabledFile(harness, enabled);
      const fixedHere = drifted.filter((d) => d.reason !== 'config-missing').length;
      const skipped = drifted.length - fixedHere;
      console.log(green(`  ✓ updated enabled-plugins.json (${fixedHere} fixed${skipped ? `, ${skipped} skipped — see config-missing entries above` : ''})`));
    }
  }

  if (totalDrifted === 0) {
    console.log(green(`✓ no drift across ${totalChecked} enabled-plugin entr${totalChecked === 1 ? 'y' : 'ies'}`));
  } else {
    console.log('');
    console.log(`${totalChecked} checked, ${yellow(`${totalDrifted} drifted`)}${fix ? `, ${green(`${totalFixed} fixed`)}` : ''}`);
    if (!fix) {
      console.log(dim('  re-run with --fix to update enabled-plugins.json hashes from disk'));
      process.exit(1);
    } else if (totalFixed > 0) {
      // The JSON files are now consistent, but the operator's Postgres
      // mirror at harness_shared.plugin_enables won't pick up renames
      // until something writes through the mirror path. Most commonly the
      // "Add plugin" popover surfaces stale legacy slugs as still-enabled
      // because of this. Run the backfill to reconcile.
      console.log('');
      console.log(yellow('  PG mirror may now be stale. Reconcile with:'));
      console.log(dim('    node ' + 'papercup/scripts/backfill-plugin-enables.mjs'));
    }
  }
}

// ─── plugin watch (P8 — dev-mode "restart needed" notifier) ────────────────

export async function cmdPluginWatch(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const slug = parsed.rest[0];
  if (!slug) die('plugin watch: usage: papercusp plugin watch <slug>');

  // Use the source dir if --src is provided (plugin author iterating in tree),
  // else watch the installed copy under ~/.papercusp/global-plugins/.
  const srcIdx = parsed.rest.indexOf('--src');
  const targetDir = srcIdx >= 0 && parsed.rest[srcIdx + 1]
    ? parsed.rest[srcIdx + 1]
    : join(globalPluginsDir(), slug);

  if (!existsSync(targetDir)) {
    die(`plugin watch: ${targetDir} does not exist`);
  }

  const { HotReloader } = await import(
    '../../../../../packages/plugin-loader/src/hot-reload.ts'
  );
  const hr = new HotReloader(targetDir, { debounceMs: 300 });

  hr.on('changed', (e: { changedAt: Date }) => {
    const ts = e.changedAt.toLocaleTimeString();
    console.log(`${dim('[' + ts + ']')} ${yellow('•')} change detected — restart \`papercusp run\` to pick it up`);
  });
  hr.on('reloaded', (e: { plugin: { name: string; version: string } }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(`${dim('[' + ts + ']')} ${green('✓')} re-imported ${cyan(e.plugin.name + '@' + e.plugin.version)} ${dim('(content may be cached under tsx; see hot-reload.ts caveat)')}`);
  });
  hr.on('error', (e: { error: Error }) => {
    const ts = new Date().toLocaleTimeString();
    console.error(`${dim('[' + ts + ']')} ${red('✗')} reload failed: ${e.error.message}`);
  });

  await hr.start();
  console.log(`watching ${cyan(targetDir)} ${dim('(Ctrl-C to stop)')}`);

  // Keep alive until Ctrl-C.
  await new Promise<void>((_resolve) => {
    process.on('SIGINT', () => {
      hr.stop();
      console.log('\n' + dim('stopped'));
      process.exit(0);
    });
  });
}

// ─── upgrade-pin (closes the paper-tiger reference in lockfile errors) ─────

export async function cmdUpgradePin(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const slug = parsed.rest[0];
  if (!slug) die('upgrade-pin: usage: papercusp upgrade-pin <slug> [--harness <slug>]');

  const { harness } = parsed.harness ? { harness: parsed.harness } : await resolveHarness(args);
  const lockPath = join(harnessesDir(), harness, 'papercusp.lock');
  if (!existsSync(lockPath)) {
    die(`upgrade-pin: no papercusp.lock at ${lockPath}`);
  }
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
    entries: Record<string, { version: string; requiredBy: string }>;
  };
  if (!lock.entries[slug]) {
    die(`upgrade-pin: ${slug} not in lockfile for ${harness}`);
  }

  // Ask the registry for the latest active version.
  const marketplaceUrl = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  let latest: string;
  try {
    const r = await fetch(`${marketplaceUrl}/catalog/${encodeURIComponent(slug)}`);
    if (!r.ok) die(`upgrade-pin: catalog HTTP ${r.status} for ${slug}`);
    const d = (await r.json()) as { versions: string[] };
    if (!Array.isArray(d.versions) || d.versions.length === 0) {
      die(`upgrade-pin: no active versions for ${slug} (the package may itself be quarantined)`);
    }
    latest = d.versions[0];
  } catch (e: any) {
    die(`upgrade-pin: registry probe failed: ${e?.message ?? e}`);
  }

  const oldVersion = lock.entries[slug].version;
  if (oldVersion === latest) {
    console.log(`${dim(`already pinned to ${latest}`)} — nothing to do`);
    return;
  }

  console.log(`re-pinning ${cyan(slug)} from ${oldVersion} → ${green(latest)} in ${cyan(harness)}`);
  // Trigger a real reinstall via the substrate's installOne flow. We do this
  // by exec'ing back through the CLI rather than reaching into another module
  // — keeps the consent + integrity + lockfile-write paths uniform.
  const cliBin = process.argv[1];
  const reinstall = spawn(process.execPath, [cliBin, 'install', `${slug}@${latest}`, '--harness', harness], {
    stdio: 'inherit',
  });
  const code = await new Promise<number>((r) => reinstall.on('exit', (c) => r(c ?? 0)));
  if (code !== 0) die(`upgrade-pin: reinstall failed (exit ${code})`, code);
  console.log(green(`✓ ${slug} re-pinned to ${latest}`));
}

// ─── migrate-tabs (P7 cutover one-shot) ───────────────────────────────────

const DEFAULT_TAB_PLUGINS = [
  '@papercupai/vscode-server',
  '@papercupai/pi-coding',
  '@papercupai/starlight',
];

export async function cmdMigrateTabs(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const { harness } = parsed.harness ? { harness: parsed.harness } : await resolveHarness(args);
  const cliBin = process.argv[1];

  console.log(bold(`migrate-tabs → ${cyan(harness)}`));
  console.log(dim('  installs the 3 default dashboard-tab plugins + enables them.'));
  console.log('');

  let installed = 0;
  let failed = 0;
  for (const slug of DEFAULT_TAB_PLUGINS) {
    console.log(`${dim('─')} ${cyan(slug)}`);
    const installCode = await new Promise<number>((resolve) => {
      const c = spawn(process.execPath, [
        cliBin, 'install', slug, '--harness', harness, '--accept-capabilities',
      ], { stdio: 'inherit' });
      c.on('exit', (code) => resolve(code ?? 0));
    });
    if (installCode !== 0) {
      console.log(`  ${red('✗')} install failed (exit ${installCode})`);
      failed++;
      continue;
    }
    const enableCode = await new Promise<number>((resolve) => {
      const c = spawn(process.execPath, [
        cliBin, 'plugin', 'enable', slug, '--harness', harness, '--accept-defaults',
      ], { stdio: 'inherit' });
      c.on('exit', (code) => resolve(code ?? 0));
    });
    if (enableCode !== 0) {
      console.log(`  ${red('✗')} enable failed (exit ${enableCode})`);
      failed++;
      continue;
    }
    installed++;
    console.log('');
  }

  console.log('');
  if (failed === 0) {
    console.log(green(`✓ migrated ${installed}/${DEFAULT_TAB_PLUGINS.length} default tab plugins`));
  } else {
    console.log(red(`✗ ${failed} failed (${installed} succeeded)`));
  }
  console.log('');
  if (installed > 0) {
    console.log(bold('Final step: enable the cutover flag'));
    console.log(`  Set ${cyan('PAPERCUSP_TABS_FROM_PLUGINS=1')} on the substrate process,`);
    console.log(`  then restart it. The harness UI will hide the legacy hard-coded`);
    console.log(`  ${cyan('docs')} / ${cyan('vscode')} / ${cyan('pi')} tabs in favor of the plugin-mounted ones.`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

// ─── lock subcommand (hygiene + batch upgrade) ────────────────────────────

export async function cmdLock(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'check':
      return cmdLockCheck(rest);
    case 'upgrade-all':
      return cmdLockUpgradeAll(rest);
    case 'prune':
      return cmdLockPrune(rest);
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(`${bold('papercusp lock')} — papercusp.lock hygiene

${bold('Subcommands:')}
  ${cyan('check')} [--harness <slug>]                Walk every entry; flag retracted/missing/outdated.
  ${cyan('upgrade-all')} [--harness <slug>]          Run upgrade-pin on every withdrawn/quarantined entry.
  ${cyan('prune')} [--harness <slug>] [--dry-run]    Remove orphaned transitive entries (requiredBy=<slug> whose parent is gone).
`);
      return;
    default:
      die(`lock: unknown subcommand "${sub}" — try \`papercusp lock help\``);
  }
}

async function cmdLockCheck(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const { harness } = parsed.harness ? { harness: parsed.harness } : await resolveHarness(args);
  const { readLock, validateLockAgainstInstalled, checkRetractionStates } = await import('./lockfile.ts');
  const lock = await readLock(harness);
  const slugs = Object.keys(lock.entries);
  console.log(bold(`papercusp.lock — ${cyan(harness)}`));
  if (slugs.length === 0) {
    console.log(dim('  (empty)'));
    return;
  }
  console.log(`  ${slugs.length} pinned plugin${slugs.length === 1 ? '' : 's'}`);

  // Local-installed validation.
  const inst = await validateLockAgainstInstalled(harness);
  if (inst.missing.length > 0) {
    console.log('');
    console.log(yellow(`local: ${inst.missing.length} entry/entries not present locally:`));
    for (const m of inst.missing) console.log(`  ${dim('•')} ${m}`);
    console.log(dim('  fix: papercusp install --from-lock'));
  } else {
    console.log(dim('  local: all entries installed at pinned versions'));
  }

  // Retraction probe.
  const marketplaceUrl = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  const retract = await checkRetractionStates(harness, marketplaceUrl);
  console.log('');
  if (retract.notes.length === 0) {
    console.log(green('registry: no retractions affecting this lockfile'));
  } else {
    console.log(bold('registry:'));
    for (const note of retract.notes) {
      const colored = note.startsWith('[QUARANTINED]')
        ? red(note)
        : note.startsWith('[withdrawn]')
        ? red(note)
        : yellow(note);
      console.log(`  ${colored}`);
    }
  }
  if (retract.blocked.length > 0) {
    console.log('');
    console.log(red(`${retract.blocked.length} blocking entry/entries`));
    console.log(dim(`  fix: papercusp lock upgrade-all --harness ${harness}`));
  }
}

async function cmdLockUpgradeAll(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const { harness } = parsed.harness ? { harness: parsed.harness } : await resolveHarness(args);
  const { checkRetractionStates } = await import('./lockfile.ts');
  const marketplaceUrl = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  const retract = await checkRetractionStates(harness, marketplaceUrl);
  // Anything blocked OR marked withdrawn (allowWithdrawn=false default) → upgrade.
  const targets = [...retract.blocked];
  if (targets.length === 0) {
    console.log(green('lock upgrade-all: nothing to do — no withdrawn/quarantined entries'));
    return;
  }
  console.log(`upgrading ${cyan(String(targets.length))} pinned entry/entries in ${cyan(harness)}`);
  let okCount = 0;
  let failCount = 0;
  const cliBin = process.argv[1];
  for (const slug of targets) {
    console.log('');
    console.log(`${dim('─')} ${cyan(slug)}`);
    const child = await new Promise<number>((resolve) => {
      const c = spawn(process.execPath, [cliBin, 'upgrade-pin', slug, '--harness', harness], {
        stdio: 'inherit',
      });
      c.on('exit', (code) => resolve(code ?? 0));
    });
    if (child === 0) okCount++;
    else failCount++;
  }
  console.log('');
  console.log(failCount === 0
    ? green(`✓ upgraded ${okCount} entry/entries`)
    : red(`✗ ${failCount} failed (${okCount} succeeded)`));
  process.exit(failCount === 0 ? 0 : 1);
}

async function cmdLockPrune(args: string[]): Promise<void> {
  const parsed = parseHarnessFlag(args);
  const dryRun = parsed.rest.includes('--dry-run');
  const { harness } = parsed.harness ? { harness: parsed.harness } : await resolveHarness(args);
  const { readLock, writeLock, removeFromLock } = await import('./lockfile.ts');
  const lock = await readLock(harness);
  const slugs = Object.keys(lock.entries);
  if (slugs.length === 0) {
    console.log(dim('lock prune: lockfile is empty'));
    return;
  }

  // Find orphans by chasing requiredBy back to a 'user' root. If the chain
  // breaks (parent is missing), the entry is orphaned. Cycles are broken by
  // tracking visited slugs.
  const orphans: string[] = [];
  for (const slug of slugs) {
    const visited = new Set<string>();
    let cursor: string | null = slug;
    let traceableToUser = false;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const entry: any = lock.entries[cursor];
      if (!entry) break;
      if (entry.requiredBy === 'user') {
        traceableToUser = true;
        break;
      }
      cursor = entry.requiredBy as string;
    }
    if (!traceableToUser) orphans.push(slug);
  }

  if (orphans.length === 0) {
    console.log(green(`lock prune: nothing to do — every entry traces to a user-installed root`));
    return;
  }
  console.log(bold(`${orphans.length} orphan${orphans.length === 1 ? '' : 's'} ${dryRun ? '(dry run)' : ''}:`));
  for (const o of orphans) {
    const entry = lock.entries[o];
    console.log(`  ${dim('•')} ${cyan(o)}  ${dim('→ requiredBy=' + entry.requiredBy)}`);
  }
  if (dryRun) {
    console.log(dim(`\n(no changes; rerun without --dry-run to remove)`));
    return;
  }
  for (const o of orphans) {
    await removeFromLock(harness, o);
  }
  console.log('');
  console.log(green(`✓ pruned ${orphans.length} orphan entr${orphans.length === 1 ? 'y' : 'ies'}`));
}

// ─── Top-level dispatcher ──────────────────────────────────────────────────

export async function cmdPlugin(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      return cmdPluginList(rest);
    case 'enable':
      return cmdPluginEnable(rest);
    case 'disable':
      return cmdPluginDisable(rest);
    case 'uninstall':
      return cmdPluginUninstall(rest);
    case 'rename':
      return cmdPluginRename(rest);
    case 'config':
      return cmdPluginConfig(rest);
    case 'invoke':
      return cmdPluginInvoke(rest);
    case 'watch':
      return cmdPluginWatch(rest);
    case 'verify':
      return cmdPluginVerify(rest);
    case 'init': {
      const { cmdPluginInit } = await import('./plugin-init-cli.ts');
      return cmdPluginInit(rest);
    }
    case 'lint': {
      const { cmdPluginLint } = await import('./plugin-lint.ts');
      return cmdPluginLint(rest);
    }
    case 'doctor': {
      const { cmdPluginDoctor } = await import('./plugin-doctor.ts');
      return cmdPluginDoctor(rest);
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(`${bold('papercusp plugin')} — per-harness plugin lifecycle

${bold('Subcommands:')}
  ${cyan('init <new-name>')} [--template <slug>] [--from-path <dir>] [--into <dir>] [--publisher <@scope>]
                                              Scaffold a new plugin from a reference template (default: cloudflare-stack).
  ${cyan('list')} [--harness <slug>]                          Show installed + enabled-for-harness map.
  ${cyan('enable <slug>')} [--harness <slug>] [--accept-defaults]   Enable a plugin in a harness; prompts configSchema.
  ${cyan('disable <slug>')} [--harness <slug>]                 Disable a plugin in a harness (preserves config).
  ${cyan('uninstall <slug>')} [--purge-grants]                Remove the plugin globally + disable in every harness.
  ${cyan('rename <old-slug> <new-slug>')}                     Rename an installed plugin's on-disk slug; migrates per-harness enable/config + grants.
  ${cyan('config <slug>')} [--harness <slug>] [--set k=v]…     Edit plugin config ($EDITOR if TTY; or --set repeated).
  ${cyan('invoke <slug> <action>')} [--harness <slug>] [--params '<json>'] [--dry-run]
                                              Manually fire a plugin action (operator-facing). Exits 5 on ok=false.
  ${cyan('watch <slug>')} [--src <dir>]                       Dev-mode: tail plugin source for changes; emits "restart needed" hints.
  ${cyan('verify')} [--harness <slug>] [--all] [--fix]        Recompute configHash from disk + flag drift in enabled-plugins.json.
  ${cyan('lint')} [<dir>]                                     Validate papercusp.json against the schema + check entry point. Pre-publish sanity.

${dim('Plugins are installed via `papercusp install <slug>` and live in ~/.papercusp/global-plugins/.')}
${dim('Per-harness state at ~/.papercusp/harnesses/<harness-slug>/{enabled-plugins.json, plugin-configs/}.')}`);
      return;
    default:
      die(`plugin: unknown subcommand "${sub}" — try \`papercusp plugin help\``);
  }
}
