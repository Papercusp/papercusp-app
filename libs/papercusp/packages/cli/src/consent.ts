/**
 * Plugin install consent UI (spec §14.3.4 + §14.9.2).
 *
 * Surfaces a capability prompt before tarball download. Scope is
 * per-(plugin, version, harness-slug) with a sticky "extend to other harnesses"
 * affordance: if the same (plugin, version) was previously granted in another
 * harness, the operator gets a second prompt offering "current harness only" or
 * "all current and future harnesses". The "all" choice writes to
 * ~/.papercusp/extended-grants.json and future installs of the same
 * (plugin, version) into other harnesses skip the prompt entirely.
 */
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as readline from 'node:readline';

import { papercuspRoot } from './papercusp-root.ts';
// Resolved LAZILY (a function call per use), not cached into a top-level
// const at import time — matching plugin-cli.ts's convention (see EI-214).
// papercuspRoot() itself is a per-process singleton cache, so a test can
// override it (set PAPERCUSP_HOME + call _resetPapercuspRootForTests())
// BEFORE the first real call into this module and every path here picks up
// the override. A top-level `const X = join(papercuspRoot(), ...)` would
// instead freeze the REAL root at this module's import time — which happens
// during the test file's own import-hoisting, before any test-file setup
// code (like an env-var override) has a chance to run — making the paths
// impossible to test-isolate and coupling every test run to the real shared
// ~/.papercusp-workspaces/*/granted-capabilities.json file (WI-3106).
function grantedPath(): string {
  return join(papercuspRoot(), 'granted-capabilities.json');
}
function extendedPath(): string {
  return join(papercuspRoot(), 'extended-grants.json');
}

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

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

export type GrantSource = 'first-grant' | 'extended' | 'ci';

export interface GrantedRecord {
  caps: string[];
  grantedAt: string;
  source: GrantSource;
}

export interface GrantedFile {
  /** "<slug>@<version>" → harness-slug → record. */
  grants: Record<string, Record<string, GrantedRecord>>;
}

export interface ExtendedFile {
  /** "<slug>@<version>" → record. Applied to every harness on install. */
  extended: Record<string, { caps: string[]; extendedAt: string }>;
}

async function readGranted(): Promise<GrantedFile> {
  return (await readJson<GrantedFile>(grantedPath())) ?? { grants: {} };
}

async function readExtended(): Promise<ExtendedFile> {
  return (await readJson<ExtendedFile>(extendedPath())) ?? { extended: {} };
}

function pluginVerKey(slug: string, version: string): string {
  return `${slug}@${version}`;
}

export function capsHash(caps: string[]): string {
  const sorted = [...caps].sort();
  return 'sha256-' + createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 32);
}

/** Group capability strings into the three §10 tiers for display. */
function tierOf(cap: string): 'low' | 'medium' | 'high' {
  if (cap.startsWith('secrets:write:')) return 'high';
  if (cap.startsWith('secrets:read:')) return 'high';
  if (cap.startsWith('http:fetch:')) return cap.includes('*') ? 'high' : 'medium';
  if (cap.startsWith('roles:register:')) return 'medium';
  if (cap.startsWith('events:emit:') || cap.startsWith('events:listen:')) return 'low';
  if (cap === 'storage:plugin-private' || cap === 'db:plugin-schema') return 'low';
  if (cap.startsWith('ui:')) return 'low';
  if (cap.endsWith(':write')) return 'medium';
  if (cap.endsWith(':read')) return 'low';
  return 'medium';
}

function printCapabilityList(caps: string[]): void {
  const groups: Record<'high' | 'medium' | 'low', string[]> = { high: [], medium: [], low: [] };
  for (const c of caps) groups[tierOf(c)].push(c);
  if (groups.high.length > 0) {
    console.log('  ' + red(bold('high tier (sensitive):')));
    for (const c of groups.high) console.log(`    ${red('!')} ${c}`);
  }
  if (groups.medium.length > 0) {
    console.log('  ' + yellow(bold('medium tier:')));
    for (const c of groups.medium) console.log(`    ${yellow('•')} ${c}`);
  }
  if (groups.low.length > 0) {
    console.log('  ' + dim('low tier:'));
    for (const c of groups.low) console.log(`    ${dim('•')} ${c}`);
  }
}

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (a) => resolve(a)));
}

export interface ConsentInput {
  manifest: { name: string; version: string; kind?: 'plugin' | 'template'; description?: string; capabilities?: string[] };
  harnessSlug: string;
  /** CI flag: skip prompt, accept current harness only. */
  acceptCurrentHarness?: boolean;
  /** CI flag: skip prompt, extend to all current/future harnesses. */
  acceptAllHarnesses?: boolean;
}

export interface ConsentOutput {
  granted: boolean;
  grantedCapsHash: string | null;
  caps: string[];
  source: GrantSource;
  /** True if the user (or CI flag) extended the grant to all harnesses. */
  extended: boolean;
}

/** Public: check if a (plugin, version) is already extended to all harnesses. */
export async function isAlreadyExtended(slug: string, version: string): Promise<boolean> {
  const ext = await readExtended();
  return Boolean(ext.extended[pluginVerKey(slug, version)]);
}

/** Public: list harnesses that previously granted this (plugin, version). */
export async function priorGrantsFor(slug: string, version: string): Promise<string[]> {
  const granted = await readGranted();
  const map = granted.grants[pluginVerKey(slug, version)];
  return map ? Object.keys(map) : [];
}

/**
 * Run the consent flow. Writes to granted-capabilities.json on accept;
 * to extended-grants.json if the user extends. Returns the recorded record.
 *
 * If the (plugin, version) is already extended-to-all, returns immediately
 * without prompting.
 */
export async function promptConsent(input: ConsentInput): Promise<ConsentOutput> {
  const { manifest, harnessSlug } = input;
  const caps: string[] = manifest.capabilities ?? [];
  const key = pluginVerKey(manifest.name, manifest.version);

  // Auto-skip if previously extended to all.
  if (await isAlreadyExtended(manifest.name, manifest.version)) {
    const granted = await readGranted();
    if (!granted.grants[key]) granted.grants[key] = {};
    granted.grants[key][harnessSlug] = {
      caps,
      grantedAt: new Date().toISOString(),
      source: 'extended',
    };
    await writeJson(grantedPath(), granted);
    console.log(green(`✓ capabilities auto-granted (previously extended to all harnesses)`));
    return {
      granted: true,
      grantedCapsHash: capsHash(caps),
      caps,
      source: 'extended',
      extended: true,
    };
  }

  // CI fast paths.
  if (input.acceptAllHarnesses) {
    return acceptInternal(manifest, harnessSlug, caps, true, 'ci');
  }
  if (input.acceptCurrentHarness) {
    return acceptInternal(manifest, harnessSlug, caps, false, 'ci');
  }

  // Interactive prompt.
  console.log('');
  console.log(bold('━━ Capability consent ━━'));
  console.log(`You are installing a ${cyan('plugin')} — ${bold(manifest.name + '@' + manifest.version)}`);
  console.log(dim('It will be enabled into your harness instances and run alongside the template’s logic.'));
  if (manifest.description) console.log('');
  if (manifest.description) console.log(`  ${manifest.description}`);
  console.log('');
  if (caps.length === 0) {
    console.log(`  ${dim('(plugin declares no capabilities)')}`);
  } else {
    console.log(`This plugin requests ${caps.length} capabilit${caps.length === 1 ? 'y' : 'ies'}:`);
    printCapabilityList(caps);
  }
  console.log('');
  console.log(`Scope: ${cyan(harnessSlug)} (current harness)`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await ask(rl, `Approve? [y/N] `)).trim().toLowerCase();
    if (!['y', 'yes'].includes(ans)) {
      console.log(red('  ✗ refused; install cancelled'));
      return { granted: false, grantedCapsHash: null, caps, source: 'first-grant', extended: false };
    }

    // Sticky-extend prompt: only show if there are prior grants for this
    // (plugin, version) in *other* harnesses, so the user is a repeat-installer.
    const priorHarnesses = await priorGrantsFor(manifest.name, manifest.version);
    const otherHarnesses = priorHarnesses.filter((h) => h !== harnessSlug);
    let extend = false;
    if (otherHarnesses.length > 0) {
      console.log('');
      console.log(dim(`Previously granted in: ${otherHarnesses.join(', ')}`));
      const a2 = (await ask(rl, `Extend grant to all current and future harnesses? [y/N] `)).trim().toLowerCase();
      extend = ['y', 'yes'].includes(a2);
    }

    return acceptInternal(manifest, harnessSlug, caps, extend, 'first-grant');
  } finally {
    rl.close();
  }
}

async function acceptInternal(
  manifest: ConsentInput['manifest'],
  harnessSlug: string,
  caps: string[],
  extend: boolean,
  source: GrantSource,
): Promise<ConsentOutput> {
  const granted = await readGranted();
  const key = pluginVerKey(manifest.name, manifest.version);
  if (!granted.grants[key]) granted.grants[key] = {};
  granted.grants[key][harnessSlug] = {
    caps,
    grantedAt: new Date().toISOString(),
    source: extend ? 'extended' : source,
  };
  await writeJson(grantedPath(), granted);

  if (extend) {
    const ext = await readExtended();
    ext.extended[key] = { caps, extendedAt: new Date().toISOString() };
    await writeJson(extendedPath(), ext);
  }

  console.log(green(`✓ capabilities granted${extend ? ' (extended to all harnesses)' : ''}`));
  return {
    granted: true,
    grantedCapsHash: capsHash(caps),
    caps,
    source: extend ? 'extended' : source,
    extended: extend,
  };
}

/**
 * Compute the diff of capabilities between an old grant and a new manifest.
 * `papercusp install <slug>` calls this on update so we re-prompt only when
 * the new version asks for caps the prior grant didn't approve.
 */
export async function netNewCapabilitiesSinceGrant(
  slug: string,
  newVersion: string,
  newCaps: string[],
  harnessSlug: string,
): Promise<string[]> {
  const granted = await readGranted();
  // Find the most recent grant for this slug in this harness, regardless of version.
  const candidateKeys = Object.keys(granted.grants)
    .filter((k) => k.startsWith(`${slug}@`))
    .filter((k) => granted.grants[k][harnessSlug]);
  if (candidateKeys.length === 0) return newCaps;  // never granted before
  const priorCaps = new Set<string>();
  for (const k of candidateKeys) {
    for (const c of granted.grants[k][harnessSlug].caps) priorCaps.add(c);
  }
  return newCaps.filter((c) => !priorCaps.has(c));
}

/**
 * Full diff between the most recent prior grant for (slug, harnessSlug) and
 * a new capability set. Returns null if there's no prior grant — first
 * install is not a "diff" worth showing.
 */
export async function diffCapabilitiesSinceGrant(
  slug: string,
  harnessSlug: string,
  newCaps: string[],
): Promise<{ priorVersion: string; added: string[]; removed: string[] } | null> {
  const granted = await readGranted();
  // Find the most recent grant for this slug in this harness — pick by grantedAt desc.
  const candidates = Object.entries(granted.grants)
    .filter(([k]) => {
      // Match key by stripping `@<version>` from the end. Handles scoped names.
      const at = k.lastIndexOf('@');
      if (at <= 0) return false;
      return k.slice(0, at) === slug;
    })
    .filter(([, byHarness]) => byHarness[harnessSlug])
    .map(([k, byHarness]) => ({
      version: k.slice(k.lastIndexOf('@') + 1),
      caps: byHarness[harnessSlug].caps,
      grantedAt: byHarness[harnessSlug].grantedAt,
    }))
    .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
  if (candidates.length === 0) return null;
  const prior = candidates[0];
  const priorSet = new Set(prior.caps);
  const newSet = new Set(newCaps);
  const added = newCaps.filter((c) => !priorSet.has(c));
  const removed = prior.caps.filter((c) => !newSet.has(c));
  return { priorVersion: prior.version, added, removed };
}
