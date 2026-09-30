/**
 * Per-install instance config in workspace PG (`cloud-deployment-layer-2026-06-06`
 * P-008). The instance fields (phase/phases/dept) + per-instance knob overrides
 * move OFF `.papercusp/config.json` into the registry ProjectEntry (workspace PG),
 * so they federate to a cloud frame (D-007) instead of being stuck in a local
 * file. The operator delivers the assembled config to a spawned process / a frame
 * via the `HARNESS_CONFIG_JSON` env-transport (consumed by `readInstanceConfig`).
 *
 * The split + assemble are PURE (unit-tested); the async fns wire them to the
 * registry with a `config.json` fallback for un-migrated harnesses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectEntry } from '../harness-registry';

/**
 * Read a legacy `<stateDir>/config.json` (the deprecated instance-config file).
 * Used ONLY by the one-time migrator below — the live read path never touches the
 * file (`deprecate-harness-config-json-2026-06-06`). Returns {} when absent/bad.
 */
function readLegacyConfigJson(stateDir: string): Record<string, unknown> {
  const path = join(stateDir, 'config.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The pure instance-field subset stored on a ProjectEntry. */
export interface InstanceConfigFields {
  phase?: string;
  phases?: Record<string, Record<string, unknown>>;
  dept?: string;
  configOverrides?: Record<string, unknown>;
}

/**
 * Keys that are NOT per-instance knob overrides: the typed instance fields
 * (phase/phases/dept), harness_kind (shape), and the scaffold-time CONTRACT
 * artifacts that stay in config.json by design (harness_token/parent_slug/slug —
 * `deprecate-harness-config-json-2026-06-06` D-005). None land in `configOverrides`.
 */
const NON_OVERRIDE_KEYS = new Set([
  'phase', 'phases', 'dept', 'harness_kind',
  'harness_token', 'parent_slug', 'slug',
]);

/**
 * Split a `config.json` object into the instance fields (phase/phases/dept) + the
 * per-instance knob overrides (everything else, e.g. maxCostUsd/parallelWorkers).
 * Pure.
 */
export function splitConfigJson(cfg: Record<string, unknown>): InstanceConfigFields {
  const out: InstanceConfigFields = {};
  if (cfg.phase !== undefined) out.phase = cfg.phase as string;
  if (cfg.phases !== undefined) out.phases = cfg.phases as Record<string, Record<string, unknown>>;
  if (cfg.dept !== undefined) out.dept = cfg.dept as string;
  const overrides: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!NON_OVERRIDE_KEYS.has(k)) overrides[k] = v;
  }
  if (Object.keys(overrides).length > 0) out.configOverrides = overrides;
  return out;
}

/** True if a ProjectEntry already carries migrated instance config. */
export function hasInstanceConfig(entry: InstanceConfigFields): boolean {
  return (
    entry.phase !== undefined ||
    entry.phases !== undefined ||
    entry.dept !== undefined ||
    entry.configOverrides !== undefined
  );
}

/** Re-assemble a flat HarnessConfig-shaped object from a ProjectEntry's instance fields. Pure. */
export function instanceEntryToConfig(entry: InstanceConfigFields): Record<string, unknown> {
  return {
    ...(entry.configOverrides ?? {}),
    ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
    ...(entry.phases !== undefined ? { phases: entry.phases } : {}),
    ...(entry.dept !== undefined ? { dept: entry.dept } : {}),
  };
}

/**
 * Assemble the per-install instance config for a harness from the workspace-PG
 * registry ProjectEntry. `.papercusp/config.json` is no longer consulted
 * (`deprecate-harness-config-json-2026-06-06`); an un-migrated harness with no
 * instance fields in PG resolves to `{}` (the blueprint supplies every default).
 * Run `migrateConfigJsonToInstance` once to lift any legacy file content into PG.
 */
export async function assembleInstanceConfig(slug: string, workspaceId: string): Promise<Record<string, unknown>> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  const p = reg.projects.find((x) => x.slug === slug);
  if (!p) return {};
  return instanceEntryToConfig(p);
}

/** The `HARNESS_CONFIG_JSON` env-transport pair for a harness (empty if no config). */
export async function instanceConfigEnv(slug: string, workspaceId: string): Promise<Record<string, string>> {
  const cfg = await assembleInstanceConfig(slug, workspaceId);
  if (Object.keys(cfg).length === 0) return {};
  return { HARNESS_CONFIG_JSON: JSON.stringify(cfg) };
}

/**
 * Migrate an un-migrated harness's `.papercusp/config.json` instance content into
 * the registry (workspace PG). Idempotent: a no-op if already migrated or the
 * file is empty. After this, config.json is no longer the source of truth.
 */
export async function migrateConfigJsonToInstance(
  slug: string,
  workspaceId: string,
): Promise<{ migrated: boolean; fields: string[] }> {
  const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  const p = reg.projects.find((x) => x.slug === slug);
  if (!p || hasInstanceConfig(p)) return { migrated: false, fields: [] };
  const cfg = readLegacyConfigJson(join(p.path, '.papercusp'));
  const split = splitConfigJson(cfg);
  // Nothing instance-shaped to lift (e.g. a config.json holding only contract
  // artifacts, or no file at all) — leave the entry untouched.
  if (!hasInstanceConfig(split)) return { migrated: false, fields: [] };
  Object.assign(p as ProjectEntry, split);
  await saveHarnessRegistry(reg, workspaceId);
  return { migrated: true, fields: Object.keys(split) };
}

/**
 * One-time sweep: migrate every harness's legacy `.papercusp/config.json` instance
 * content into the workspace-PG registry, across one workspace (or the active one).
 * Idempotent — already-migrated / file-less harnesses are skipped. Returns the
 * per-harness results so a maintenance tool can report what moved.
 */
export async function migrateAllConfigJson(
  workspaceId?: string,
): Promise<{ slug: string; migrated: boolean; fields: string[] }[]> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const { activeWorkspaceId } = await import('../workspace-registry');
  const ws = workspaceId ?? activeWorkspaceId();
  const reg = await loadHarnessRegistry(ws);
  const out: { slug: string; migrated: boolean; fields: string[] }[] = [];
  for (const p of reg.projects) {
    const r = await migrateConfigJsonToInstance(p.slug, ws);
    out.push({ slug: p.slug, ...r });
  }
  return out;
}
