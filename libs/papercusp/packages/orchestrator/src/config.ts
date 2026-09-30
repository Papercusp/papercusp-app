/**
 * In-memory harness-config helpers (dotted lookup + phase resolution). Replaces
 * bash's `config_get 'product.enabled' 'false'` with `configGet(cfg, 'product.enabled', false)`.
 *
 * NOTE: `.papercusp/config.json` is DEPRECATED as a runtime config source
 * (`deprecate-harness-config-json-2026-06-06`). The effective config is assembled
 * from the `coding` blueprint + the workspace-PG instance store and delivered to
 * the orchestrator via the `HARNESS_CONFIG_JSON` env-transport (see
 * `effective-config.ts`). These helpers operate on that in-memory config object —
 * nothing here reads a file.
 */
import type { HarnessConfig } from './types';

/**
 * Look up a dotted-path value in a config object, returning `defaultValue`
 * if any segment is missing. Mirrors bash run.sh's `config_get`.
 *
 *   configGet(cfg, 'phases.staging.port', 3055)
 *   configGet(cfg, 'reviewer.replanOnAccept', false)
 */
export function configGet<T = unknown>(
  cfg: HarnessConfig,
  path: string,
  defaultValue: T,
): T {
  const segments = path.split('.');
  let cur: unknown = cfg;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null) return defaultValue;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return defaultValue;
  }
  return (cur as T) ?? defaultValue;
}

/**
 * Resolve the harness phase + port + dbPath from config.
 * Defaults to `phase: "staging"`, port/dbPath empty when absent.
 */
export function resolvePhase(cfg: HarnessConfig): {
  phase: string;
  port: string;
  dbPath: string;
} {
  const phase = (cfg.phase as string) ?? 'staging';
  const phases = cfg.phases ?? {};
  const p = phases[phase] ?? {};
  return {
    phase,
    port: p.port != null ? String(p.port) : '',
    dbPath: p.dbPath != null ? String(p.dbPath) : '',
  };
}
