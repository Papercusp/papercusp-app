/**
 * Idempotency hashes for provision lifecycle.
 *
 * Three hashes drive re-provision decisions:
 *   - configHash: sha256 of the structural projection of plugin config
 *                 (only fields that affect provisioning, NOT operational
 *                 toggles like polling interval).
 *   - scriptHash: sha256 of the setup-script file contents.
 *   - pluginVersion: semver from the plugin's manifest.
 *
 * Spec: /docs/snapshots/build-scripts#idempotency.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

/**
 * Stable JSON canonicalization: sorted keys, no whitespace.
 * NaN/undefined are dropped (stringify drops them anyway).
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * Compute the configHash.
 *
 * Pass `provisioningFields` to project only the fields that affect
 * provisioning. If undefined, all fields are included (conservative
 * default — every config change re-provisions).
 */
export function computeConfigHash(
  config: Record<string, unknown>,
  provisioningFields?: string[],
): string {
  let projected: Record<string, unknown>;
  if (provisioningFields) {
    projected = {};
    for (const k of provisioningFields) {
      if (k in config) projected[k] = config[k];
    }
  } else {
    projected = config;
  }
  return 'sha256:' + createHash('sha256').update(canonicalize(projected)).digest('hex');
}

/**
 * Compute scriptHash for one setup-script file.
 */
export async function computeScriptHash(scriptPath: string): Promise<string> {
  const content = await fs.readFile(scriptPath);
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

/**
 * Decide whether re-provisioning is needed given the previous + current
 * triple of hashes. Returns one of:
 *   - 'fresh'              first run, no previous state
 *   - 'unchanged'          all three match, skip
 *   - 'config-only'        configHash differs, scriptHash + version match
 *   - 'script-changed'     scriptHash differs (always re-provision, regardless of skipReprovisionOnPatch)
 *   - 'version-major'      pluginVersion changed across major
 *   - 'version-patch'      pluginVersion changed within minor (eligible for skipReprovisionOnPatch)
 *
 * Per spec: skipReprovisionOnPatch governs the version-patch case ONLY
 * when scriptHash matches. script-changed always trumps it.
 */
export interface PreviousHashes {
  configHash: string;
  scriptHash: string;
  pluginVersion: string;
}

export interface CurrentHashes extends PreviousHashes {}

export type ReprovisionDecision =
  | 'fresh'
  | 'unchanged'
  | 'config-only'
  | 'script-changed'
  | 'version-major'
  | 'version-patch';

export function decideReprovision(
  previous: PreviousHashes | null,
  current: CurrentHashes,
): ReprovisionDecision {
  if (!previous) return 'fresh';

  if (previous.scriptHash !== current.scriptHash) return 'script-changed';

  if (previous.pluginVersion !== current.pluginVersion) {
    const prevMajor = parseSemverMajor(previous.pluginVersion);
    const curMajor = parseSemverMajor(current.pluginVersion);
    if (prevMajor !== curMajor) return 'version-major';
    const prevMinor = parseSemverMinor(previous.pluginVersion);
    const curMinor = parseSemverMinor(current.pluginVersion);
    if (prevMinor !== curMinor) return 'version-major'; // treat minor like major to be safe
    return 'version-patch';
  }

  if (previous.configHash !== current.configHash) return 'config-only';

  return 'unchanged';
}

function parseSemverMajor(v: string): number {
  const m = /^(\d+)/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

function parseSemverMinor(v: string): number {
  const m = /^\d+\.(\d+)/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}
