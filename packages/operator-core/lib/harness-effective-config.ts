/**
 * Operator-side EFFECTIVE per-harness config: the `coding`-blueprint knobs (shape
 * defaults) overlaid UNDER the workspace-PG instance config (per-install overrides
 * win). The PG-sourced sibling of the orchestrator's `readEffectiveConfig` — which
 * reads the env-transport / config.json INSIDE the spawned process — for operator
 * endpoint routes that need a knob value without spawning anything.
 *
 * `deprecate-harness-config-json-2026-06-06`: routes that used to read a harness's
 * `.papercusp/config.json` directly read here instead, so config.json stops being a
 * live source. Instance config comes from the registry ProjectEntry via
 * `assembleInstanceConfig`, which keeps a config.json file-fallback for un-migrated
 * harnesses until the one-time migrator runs (P-008) and the fallback is cut (P-009).
 */
import { join } from 'node:path';
import { loadHarnessKnobs, deepMergeConfig, type HarnessConfig } from '@papercusp/orchestrator';
import { assembleInstanceConfig } from './deployment/instance-config';

/**
 * Blueprint knobs (base) ⊕ workspace-PG instance config (override). Mirrors the
 * orchestrator's instance-over-blueprint precedence. `projectPath` is the harness
 * install dir (its `.papercusp/blueprint.yaml` supplies the knob defaults).
 */
export async function readEffectiveHarnessConfig(
  slug: string,
  workspaceId: string,
  projectPath: string,
): Promise<HarnessConfig> {
  const instance = await assembleInstanceConfig(slug, workspaceId);
  const knobs = (loadHarnessKnobs(join(projectPath, '.papercusp')) ?? {}) as Record<string, unknown>;
  const merged = Object.keys(knobs).length === 0 ? instance : deepMergeConfig(knobs, instance);
  return merged as HarnessConfig;
}
