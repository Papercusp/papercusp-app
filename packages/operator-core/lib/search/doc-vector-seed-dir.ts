/**
 * Where the installed Server keeps its shipped doc-vector seed
 * (plan ship-precomputed-doc-vectors-2026-10-01, P-003).
 *
 * The release cut writes the seed to `papercusp-desktop/src-tauri/doc-vector-seed/`
 * and `tauri.server.conf.json` bundles it as a SIBLING resource of `sidecar/` and
 * `seed/` (not inside `seed/`, which the hive-seed decisions govern). So on an
 * installed Server it sits at `<resourceRoot>/doc-vector-seed` — Linux .deb
 * `usr/lib/<Product>/doc-vector-seed`, macOS `Contents/Resources/doc-vector-seed`.
 *
 * Resolution reuses the hive seed's channel (restore-hive-seed.ts resolveSeedDir):
 * an explicit `PAPERCUSP_DOC_VECTOR_SEED_DIR` wins; otherwise the dir is found
 * next to a resource dir the desktop already exports to the sidecar. That needs
 * no new env var crossing the Rust spawn or the WSL `WSLENV` list.
 *
 * Autodetect requires `manifest.json`: build.rs leaves a manifest-less
 * placeholder on dev/cleaned checkouts, and that must read as "no seed".
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SEED_SIBLING_RESOURCE_ENVS } from '../sync/hyperbee/restore-hive-seed';
import { DOC_VECTOR_SEED_DIR_ENV, DOC_VECTOR_SEED_MANIFEST } from './doc-vector-seed';

/** Bundle resource directory name (tauri.server.conf.json `doc-vector-seed/**\/*`). */
export const DOC_VECTOR_SEED_RESOURCE = 'doc-vector-seed';

export interface ResolveDocVectorSeedDirOpts {
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

/**
 * The seed dir to load, or null when none is installed. An explicit env value
 * is returned as-is even without a manifest: the loader then refuses it as
 * `invalid-seed` and logs why, which is the signal an operator who set it needs.
 */
export function resolveDocVectorSeedDir(opts: ResolveDocVectorSeedDirOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const explicit = env[DOC_VECTOR_SEED_DIR_ENV]?.trim();
  if (explicit) return explicit;
  for (const key of SEED_SIBLING_RESOURCE_ENVS) {
    const sib = env[key]?.trim();
    if (!sib) continue;
    // `<sidecar>/doc-vector-seed` first, then `<resourceRoot>/doc-vector-seed`
    // (the packaged layout, where it is a sibling of sidecar/).
    for (const candidate of [join(dirname(sib), DOC_VECTOR_SEED_RESOURCE), join(dirname(dirname(sib)), DOC_VECTOR_SEED_RESOURCE)]) {
      if (exists(join(candidate, DOC_VECTOR_SEED_MANIFEST))) return candidate;
    }
  }
  return null;
}
