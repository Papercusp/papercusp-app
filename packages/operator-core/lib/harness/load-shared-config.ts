/**
 * load-shared-config — read `.papercusp/shared.json` from a harness's
 * on-disk project directory.
 *
 * Plan: papercusp-dogfood-phase11-multi-engineer-2026-05-25 (P-078).
 *
 * The Phase 5a P-029 wizard writes this file when a harness is
 * shared. On every operator boot the substrate boot loop needs to
 * detect the file's presence and synthesize a `SwarmBinding` so
 * the harness joins the Hyperswarm topic and federates with peers.
 *
 * Contract:
 *   - Returns `null` when the file is absent (private harness or
 *     pre-share state). Callers boot without a swarm.
 *   - Returns `null` when the file is present but malformed —
 *     `isHarnessSharedConfig` rejects shape mismatches; better to
 *     boot private than to crash the loop.
 *   - Returns the parsed `HarnessSharedConfig` when valid.
 *
 * Sync I/O on purpose: boot-all is also sync (readdirSync, statSync).
 * The boot loop is process-startup-once, not a hot path. The
 * injection point lets tests pass a fake reader.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  isHarnessSharedConfig,
  HARNESS_SHARED_CONFIG_REL_PATH,
  type HarnessSharedConfig,
} from './harness-shared-config-types';

export interface LoadSharedConfigOpts {
  /** Override the file-read function. Tests inject a fake. */
  readFile?: (absPath: string) => string;
  /** Override the existence predicate. Tests inject a fake. */
  pathExists?: (absPath: string) => boolean;
}

/**
 * Read `<projectDir>/.papercusp/shared.json` if present + valid.
 *
 * `projectDir` is the on-disk root of the harness's git checkout
 * (NOT the substrate's corestore dir). Resolve it via
 * `resolveHarnessPaths(slug, workspaceId).projectDir` in callers
 * that have a slug; pass the absolute path here directly.
 */
export function loadSharedConfigFromProjectDir(
  projectDir: string,
  opts: LoadSharedConfigOpts = {},
): HarnessSharedConfig | null {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return null;
  const absPath = join(projectDir, HARNESS_SHARED_CONFIG_REL_PATH);
  const exists = opts.pathExists ?? existsSync;
  if (!exists(absPath)) return null;
  let text: string;
  try {
    const reader = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    text = reader(absPath);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isHarnessSharedConfig(parsed)) return null;
  return parsed;
}
