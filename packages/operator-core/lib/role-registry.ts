/**
 * Role registry — scans for cross-cutting role manifests from
 * two sources:
 *
 *   1. **Built-in roles**: `<harness-package>/blueprints/base/prompts/<role>.role.json`
 *      sidecar files (the base role library). Ship with the substrate.
 *
 *   2. **Plugin-contributed roles**: each enabled plugin's
 *      `papercusp.json` may declare a `roles` array. The plugin
 *      bundles its own prompt at `<plugin-dir>/<promptPath>` (typically
 *      `roles/<role>.md`). Lets ecosystems ship their own specialists.
 *
 * Adding a new built-in role becomes:
 *   1. Write `blueprints/base/prompts/<role>.md` (the agent's system prompt).
 *   2. Write `blueprints/base/prompts/<role>.role.json` (this manifest).
 *
 * Adding a plugin-contributed role becomes:
 *   1. Write `<plugin>/<promptPath>` (the prompt).
 *   2. Add to `<plugin>/papercusp.json`:
 *      "roles": [{
 *        "id": "<role>",
 *        "promptPath": "roles/<role>.md",
 *        "whenUseful": "...",
 *        "output": { "kind": "features", "featureKind": "<kind>" },
 *        "alwaysFireOn": [...]
 *      }]
 *
 * Either way, the scoper consumes the merged registry and decides per
 * replan which roles to consult.
 *
 * Manifest shape:
 *   {
 *     id:           "infra-reviewer",
 *     whenUseful:   "Consult when SPEC additions might affect deploy pipeline...",
 *     output:       { kind: "features", featureKind: "infra" },
 *     alwaysFireOn: ["onProvisioned"],     // plugin lifecycle / event names
 *     budgetCents:  50,
 *     featureSize:  "small",
 *     source:       { kind: 'builtin' } | { kind: 'plugin', plugin: '@scope/x', promptPath: 'roles/x.md', dir: '...' }
 *   }
 *
 * Plugin-contributed roles namespace their id as `<plugin>:<role-id>`
 * to avoid collisions when two plugins both ship a "reviewer" role.
 * The dispatcher recognises this naming and resolves the prompt
 * accordingly.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { harnessPackageDir } from './harness-paths';
import { papercuspPath } from './papercusp-root';

export type RoleSource =
  | { kind: 'builtin' }
  | { kind: 'plugin'; plugin: string; promptPath: string; dir: string };

export interface RoleManifest {
  /** For builtins: matches the prompt filename `prompts/<id>.md`.
   *  For plugin-contributed: `<plugin-slug>:<plugin-local-id>`. */
  id: string;
  /** Free-form description scoper uses to decide whether to consult. */
  whenUseful: string;
  /**
   * What the role produces:
   *   - `features`: writes feature rows to harness_features tagged with
   *     `featureKind`. The most common shape; scoper coordinates via
   *     the kind-mismatch guard so it doesn't trample cross-cutting features.
   *   - `spec`: DEPRECATED. Historically appended bullets to SPEC.md so
   *     scoper-replan would fold them in. SPEC.md is deprecated (D-004),
   *     so the dispatcher no longer writes anything for this kind — no
   *     built-in role uses it.
   */
  output:
    | { kind: 'features'; featureKind: string }
    | { kind: 'spec'; specSection?: string };
  /**
   * Plugin lifecycle / event names that trigger this role outside of
   * scoper-decides flow. The substrate's role-triggers module reads
   * this field to wire post-hoc triggers (e.g. infra-reviewer fires on
   * `onProvisioned` to verify newly-provisioned infrastructure).
   */
  alwaysFireOn?: string[];
  /** Soft budget cap in USD cents per dispatch. Best-effort. */
  budgetCents?: number;
  /** Size hint for the dispatcher / UI. */
  featureSize?: 'small' | 'standard' | 'large';
  /**
   * What launch-time CONTEXT this role needs — the single source for
   * "does picking this role require a feature / plan?" Read by the `psu`
   * role picker, the /adv launch UIs, and `roles:get`/`roles:list`.
   * (`output` above says what a role PRODUCES; `consumes` says what it
   * needs to start.) Omitted on a cross-cutting manifest → falls back to
   * the kernel default in `KERNEL_ROLE_CONSUMES` / `roleConsumes()`. */
  consumes?: RoleConsumes;
  /** Where this role came from. Built-in unless surfaced from a plugin manifest. */
  source: RoleSource;
}

/** Launch-time context a role needs. `required` → the picker must
 *  collect it; `optional` → offer it; `none` → don't ask. */
export interface RoleConsumes {
  feature: 'required' | 'optional' | 'none';
  plan: 'optional' | 'none';
}

const DEFAULT_CONSUMES: RoleConsumes = { feature: 'none', plan: 'none' };

/** Validate + normalize a manifest's `consumes`. Returns undefined for
 *  absent/malformed input (the resolver then falls back to the kernel
 *  map / default), so a bad value never yields an invalid manifest. */
function parseConsumes(raw: unknown): RoleConsumes | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const feature = r.feature;
  const plan = r.plan;
  if (feature !== 'required' && feature !== 'optional' && feature !== 'none') return undefined;
  if (plan !== 'optional' && plan !== 'none') return undefined;
  return { feature, plan };
}

/**
 * Kernel (built-in pipeline) roles' context needs. Derived from which
 * `invoke(ctx, role, [...])` call-sites pass `FEATURE_ID` in
 * `orchestrator/main-loop.ts` (verified 2026-05-30): worker / validator /
 * debugger / architect get a feature; documenter / reviewer optionally;
 * scoper works at plan/spec scope; curator / operator / oracle need
 * neither. Plugin / cross-cutting roles declare their own `consumes` on
 * the manifest (falls back here, then to DEFAULT_CONSUMES).
 */
export const KERNEL_ROLE_CONSUMES: Record<string, RoleConsumes> = {
  worker: { feature: 'required', plan: 'none' },
  validator: { feature: 'required', plan: 'none' },
  debugger: { feature: 'required', plan: 'none' },
  architect: { feature: 'required', plan: 'none' },
  documenter: { feature: 'optional', plan: 'none' },
  reviewer: { feature: 'optional', plan: 'optional' },
  scoper: { feature: 'none', plan: 'optional' },
  curator: { feature: 'none', plan: 'none' },
  operator: { feature: 'none', plan: 'none' },
  oracle: { feature: 'none', plan: 'none' },
};

/**
 * Resolve a role's launch-time context needs: a plugin/cross-cutting
 * manifest's own `consumes` wins, else the kernel map, else the
 * none/none default. The single source `psu` + UIs read.
 */
export function roleConsumes(id: string, harnessSlug = ''): RoleConsumes {
  const manifest = getRole(id, harnessSlug);
  if (manifest?.consumes) return manifest.consumes;
  return KERNEL_ROLE_CONSUMES[id] ?? DEFAULT_CONSUMES;
}

const ROLE_ID_RE = /^[a-z][a-z0-9-]*$/;
// Plugin-contributed role ids look like `<plugin>:<local>`. The plugin
// part allows '@', '/', and '-' (matching scoped npm names); the local
// part follows ROLE_ID_RE.
const PLUGIN_ROLE_ID_RE = /^@?[a-z0-9][a-z0-9_/.-]*:[a-z][a-z0-9-]*$/;

interface CachedRegistry {
  roles: RoleManifest[];
  builtinMtime: number;
  /** harness-slug → cache (plugin scan depends on enabled plugins) */
  forSlug?: string;
  pluginsHash?: string;
}
let cached: CachedRegistry | null = null;

function readBuiltinRoles(promptsDir: string): RoleManifest[] {
  if (!existsSync(promptsDir)) return [];
  const out: RoleManifest[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(promptsDir).filter((e) => e.endsWith('.role.json'));
  } catch { return []; }

  for (const entry of entries) {
    const id = entry.replace(/\.role\.json$/, '');
    if (!ROLE_ID_RE.test(id)) continue;
    try {
      const raw = readFileSync(join(promptsDir, entry), 'utf8');
      const parsed = JSON.parse(raw) as Omit<RoleManifest, 'source'>;
      if (parsed.id !== id) continue;
      if (!parsed.whenUseful || typeof parsed.whenUseful !== 'string') continue;
      if (!parsed.output) continue;
      if (parsed.output.kind === 'features') {
        if (!parsed.output.featureKind || !ROLE_ID_RE.test(parsed.output.featureKind)) continue;
      } else if (parsed.output.kind === 'spec') {
        // spec output is structurally simpler — optional `specSection`
        // names the heading the agent's bullets will get appended under.
        // No required fields beyond `kind`.
      } else {
        continue; // unrecognised output shape
      }
      if (!existsSync(join(promptsDir, `${id}.md`))) continue;
      out.push({ ...parsed, consumes: parseConsumes(parsed.consumes), source: { kind: 'builtin' } });
    } catch { /* skip silently */ }
  }
  return out;
}

function readPluginRolesFromDir(pluginDir: string, pluginName: string): RoleManifest[] {
  const out: RoleManifest[] = [];
  let manifest: { roles?: Array<Omit<RoleManifest, 'id' | 'source'> & { id: string; promptPath: string }> };
  try {
    manifest = JSON.parse(readFileSync(join(pluginDir, 'papercusp.json'), 'utf8'));
  } catch { return []; }

  const roles = manifest.roles;
  if (!Array.isArray(roles)) return [];

  for (const decl of roles) {
    if (!decl?.id || !ROLE_ID_RE.test(decl.id)) continue;
    if (!decl.promptPath || typeof decl.promptPath !== 'string') continue;
    if (decl.promptPath.includes('..')) continue; // basic traversal guard
    if (!decl.whenUseful || typeof decl.whenUseful !== 'string') continue;
    if (!decl.output) continue;
    if (decl.output.kind === 'features') {
      if (!decl.output.featureKind || !ROLE_ID_RE.test(decl.output.featureKind)) continue;
    } else if (decl.output.kind === 'spec') {
      // ok — no required fields beyond `kind`.
    } else {
      continue;
    }
    const promptAbs = join(pluginDir, decl.promptPath);
    if (!existsSync(promptAbs)) continue;
    out.push({
      id: `${pluginName}:${decl.id}`,
      whenUseful: decl.whenUseful,
      output: decl.output,
      alwaysFireOn: decl.alwaysFireOn,
      budgetCents: decl.budgetCents,
      featureSize: decl.featureSize,
      consumes: parseConsumes((decl as { consumes?: unknown }).consumes),
      source: { kind: 'plugin', plugin: pluginName, promptPath: decl.promptPath, dir: pluginDir },
    });
  }
  return out;
}

/** Returns true if the path resolves to a directory (follows symlinks). */
function isDirOrSymlinkedDir(path: string): boolean {
  try {
    const fs = require('node:fs');
    return fs.statSync(path).isDirectory();
  } catch { return false; }
}

function readPluginRoles(harnessSlug: string): RoleManifest[] {
  if (!harnessSlug) return [];
  const harnessConfigsDir = papercuspPath('harnesses', harnessSlug);
  let enabled: Set<string>;
  try {
    const enabledRaw = JSON.parse(readFileSync(join(harnessConfigsDir, 'enabled-plugins.json'), 'utf8'));
    enabled = new Set(Object.keys(enabledRaw?.enabled ?? {}));
  } catch { return []; }
  if (enabled.size === 0) return [];

  const globalDir = papercuspPath('global-plugins');
  if (!existsSync(globalDir)) return [];

  // Walk @scope/plugin and bare plugin-name dirs. Plugins may be installed
  // as either real dirs or symlinks (the marketplace install path uses
  // symlinks for "live" dev plugins). We must stat-follow to detect
  // symlinked-directories; readdir's Dirent.isDirectory() returns false
  // for symlinks.
  const pluginDirs: Array<{ dir: string; name: string }> = [];
  try {
    for (const e of readdirSync(globalDir)) {
      const p = join(globalDir, e);
      if (!isDirOrSymlinkedDir(p)) continue;
      if (e.startsWith('@')) {
        try {
          for (const inner of readdirSync(p)) {
            const innerPath = join(p, inner);
            if (isDirOrSymlinkedDir(innerPath)) {
              pluginDirs.push({ dir: innerPath, name: `${e}/${inner}` });
            }
          }
        } catch { /* unreadable scope dir */ }
      } else {
        pluginDirs.push({ dir: p, name: e });
      }
    }
  } catch { return []; }

  const out: RoleManifest[] = [];
  for (const { dir, name } of pluginDirs) {
    if (!enabled.has(name) && !enabled.has(basename(dir))) continue;
    out.push(...readPluginRolesFromDir(dir, name));
  }
  return out;
}

function pluginsHashForSlug(harnessSlug: string): string {
  // Cheap signature: enabled-plugins.json mtime + content checksum proxy.
  if (!harnessSlug) return '0';
  try {
    const p = papercuspPath('harnesses', harnessSlug, 'enabled-plugins.json');
    const stat = require('node:fs').statSync(p);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch { return '0'; }
}

/**
 * Returns the merged role registry (builtin + plugin-contributed for this
 * harness) sorted by id. Caches on builtin mtime + plugin manifest mtime.
 *
 * Pass `harnessSlug` to include plugin-contributed roles for that
 * harness's enabled plugin set. Without it, only builtin roles are
 * returned.
 */
export function listRoles(harnessSlug = ''): RoleManifest[] {
  // blueprint-role-bundling Phase 5: the global harness `prompts/` dir was deleted;
  // built-in role manifests (`<role>.role.json` + `<role>.md`) live in the base role
  // library (`blueprints/base/prompts/`).
  const promptsDir = join(harnessPackageDir(), 'blueprints', 'base', 'prompts');
  let builtinMtime = 0;
  try {
    const stats = require('node:fs').statSync(promptsDir);
    builtinMtime = stats.mtimeMs;
  } catch { /* prompts dir absent — empty builtin */ }
  const pluginsHash = pluginsHashForSlug(harnessSlug);

  if (cached
      && cached.builtinMtime === builtinMtime
      && cached.forSlug === harnessSlug
      && cached.pluginsHash === pluginsHash) {
    return cached.roles;
  }

  const builtins = readBuiltinRoles(promptsDir);
  const pluginRoles = harnessSlug ? readPluginRoles(harnessSlug) : [];
  const merged = [...builtins, ...pluginRoles].sort((a, b) => a.id.localeCompare(b.id));

  cached = { roles: merged, builtinMtime, forSlug: harnessSlug, pluginsHash };
  return merged;
}

/**
 * Returns a single role's manifest by id, or null if not registered.
 * For plugin-contributed roles, pass the harness slug as the second
 * argument so the per-plugin registry resolves correctly.
 */
export function getRole(id: string, harnessSlug = ''): RoleManifest | null {
  return listRoles(harnessSlug).find((r) => r.id === id) ?? null;
}

/**
 * Returns roles whose `alwaysFireOn` includes the given event/lifecycle
 * name. Optionally scoped to a harness slug to include plugin-contributed
 * roles.
 */
export function rolesFiringOn(event: string, harnessSlug = ''): RoleManifest[] {
  return listRoles(harnessSlug).filter((r) => (r.alwaysFireOn ?? []).includes(event));
}

/**
 * Validate that a role id is well-formed. Used by the dispatcher and
 * tests to reject obviously-bad input before doing filesystem work.
 */
export function isValidRoleId(id: string): boolean {
  return ROLE_ID_RE.test(id) || PLUGIN_ROLE_ID_RE.test(id);
}

/** For the test suite: clear the mtime cache. */
export function __clearRoleRegistryCache(): void {
  cached = null;
}
