/**
 * sentinel-model-file — just-in-time file projection of the Sentinel's SESSION
 * model override (model-override-sidebar-2026-06-23).
 *
 * The dock 🛡 Sentinel launches via the `psu-sentinel` BASH wrapper, which cannot
 * read the canonical session override (owner-steering → hive_settings in PG). So
 * `pot:set-steering` projects `modelOverrides.papercup` to a tiny file the wrapper
 * reads at launch: `~/.papercusp/sentinel-model` holds the `model[:effort]` spec, or
 * is ABSENT when there's no override (⇒ the wrapper passes no `--model` → the
 * workspace / CLI default). This is the storage-policy "PG-canonical, file projected
 * just-in-time" pattern (NOT a file-primary mirror — PG/owner-steering stays the
 * source of truth; this file is a transient launch-time projection). LOCAL dock only.
 */
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Absolute path the `psu-sentinel` wrapper reads its `--model` spec from. */
export function sentinelModelFilePath(): string {
  return join(homedir(), '.papercusp', 'sentinel-model');
}

/**
 * Project the Sentinel's session model spec to the wrapper-read file, or REMOVE it
 * when cleared (null/empty ⇒ no override). Best-effort; never throws — a write
 * failure just means the wrapper falls back to the default model on next launch.
 */
export function materializeSentinelModelFile(spec: string | null | undefined): void {
  const path = sentinelModelFilePath();
  try {
    const s = (spec ?? '').trim();
    if (s) {
      mkdirSync(join(homedir(), '.papercusp'), { recursive: true });
      writeFileSync(path, s, 'utf8');
    } else if (existsSync(path)) {
      rmSync(path);
    }
  } catch {
    /* best-effort projection — the wrapper degrades to the default model */
  }
}
