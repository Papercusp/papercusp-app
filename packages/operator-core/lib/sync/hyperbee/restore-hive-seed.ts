/**
 * restore-hive-seed — the "restore-before-join" orchestration (plan
 * hive-seed-bundle-2026-07-04 P-007; design memo agent-insights/hive-seed-bundle-design).
 *
 * Runs at first boot BEFORE the (UNMODIFIED) canonical-hive join. It pre-positions
 * the seeded bytes so the join's clone + swarm delta-replication transfer only the
 * delta on top — never re-transferring the whole ~5 GB repo + full author-log
 * history. The join, admission, epoch-key delivery, and merge all run afterward,
 * exactly as today; a seed is UNTRUSTED CACHE (every block is re-verified natively).
 *
 * THE ADMISSION-TIMING SPLIT (the load-bearing subtlety):
 *
 *  • The CORESTORE seed is a plaintext CONTAINER (its blocks are epoch-CIPHERTEXT,
 *    decrypted later when admission delivers the epoch key — same as any replicated
 *    block). It needs NO key to RESTORE, so it restores PRE-JOIN unconditionally.
 *
 *  • The GIT seed of the PRIVATE repo is ENCRYPTED AT REST, and its key
 *    (`seed-key-op`) is delivered only POST-ADMISSION. So `git clone` from the
 *    bundle CANNOT run before the join hands over the key. When no key is present
 *    we DEFER that store (the host cold-paths it / re-invokes restore with the key
 *    after admission); when the key IS present (a later invocation, or an
 *    unencrypted seed) it restores too.
 *
 * Failure-isolating + cold-safe: a missing seed ⇒ `ran:false` (pure cold path); any
 * one store's failure never aborts the others (that store just cold-catches). This
 * is what keeps the dogfood's real join exercised end-to-end (D-007).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  decodeManifest,
  restoreSeed,
  SeedProviderRegistry,
  type SeedManifest,
  type SeedStoreEntry,
  type SeedPayload,
  type StoreRestoreOutcome,
} from '@papercusp/seed-bundle';
import { createGitSeedProvider } from './seed-provider-git';
import { createCorestoreSeedProvider } from './seed-provider-corestore';

export const SEED_MANIFEST_FILE = 'manifest.json';

/**
 * Resource-dir env vars the Tauri sidecar hands the operator (see
 * papercusp-desktop/src-tauri/src/main.rs — each is `sidecar_dir.join("<name>")`).
 * The bundled seed dir sits either NEXT TO these (`<sidecar>/seed`) or — in every
 * REAL bundle layout (Linux .deb `usr/lib/<Product>/`, macOS
 * `Contents/Resources/`) — next to the sidecar dir itself at the RESOURCE ROOT
 * (`<resourceRoot>/seed`, i.e. `dirname(dirname(any of these))/seed`), because
 * tauri.conf bundles `seed/**` and `sidecar/**` as sibling resources. Autodetect
 * probes BOTH (manifest-checked), parent first. Found live on the first seeded
 * Linux .deb E2E (2026-07-05, WI-2902): only `<sidecar>/seed` was probed, the
 * installed seed sat at `<resourceRoot>/seed`, and every packaged install
 * silently cold-joined (network re-clone) with the 3.6 GB seed unused.
 * Ordered by how reliably each is set on boot.
 */
export const SEED_SIBLING_RESOURCE_ENVS = ['PAPERCUSP_PROMPTS_DIR', 'PAPERCUSP_HARNESS_DIR', 'PAPERCUSP_PG_SQL_DIR'] as const;

export interface ResolveSeedDirResult {
  /** The seed dir to restore from, or null ⇒ take the cold path. */
  readonly seedDir: string | null;
  /** True iff `--no-seed` forced the cold path — DISTINCT from "no seed found"
   *  (both yield seedDir:null, but only this one is an explicit operator opt-out). */
  readonly disabled: boolean;
  /** How the dir was resolved (telemetry/debug):
   *  'no-seed' | 'env' | 'env-missing' | `autodetect:${string}` | 'none'. */
  readonly source: string;
}

/**
 * Resolve WHERE the installer-bundled seed lives — headless-testably (pure over an
 * injected env + existence check; the P-010 live-wire that replaces the bare
 * PAPERCUSP_SEED_DIR default with real Tauri bundled-resource autodetect + an env
 * override). Precedence:
 *
 *   1. `PAPERCUSP_NO_SEED`  → disabled (cold path), regardless of anything else —
 *      the operator's kill-switch + how the cold-join canary forces a real join.
 *   2. `PAPERCUSP_SEED_DIR` → explicit override (release/test hook); honored when
 *      it actually holds a manifest. A set-but-manifest-less value FALLS THROUGH
 *      to autodetect (it is a HINT, not a veto) — dead-ending on `env-missing`
 *      is exactly how the first seeded .deb shipped with its seed unreachable
 *      (the Rust side passed `<sidecar>/seed` while the bundle held
 *      `<resourceRoot>/seed`; WI-2902 2026-07-05).
 *   3. AUTODETECT from a sibling resource dir the sidecar is already handed:
 *      probe `dirname(<sibling>)/seed` (`<sidecar>/seed`) THEN
 *      `dirname(dirname(<sibling>))/seed` (`<resourceRoot>/seed` — the real
 *      .deb/.app layout), accepted only when its manifest is present.
 *   4. Otherwise none — dev boxes + current seed-less packaged builds keep the
 *      unchanged cold join.
 *
 * Accepting a candidate ONLY when its manifest.json exists means a wrong guess (or
 * an empty placeholder seed dir) degrades to the cold path, never a broken restore.
 */
export function resolveSeedDir(
  opts: { env?: Record<string, string | undefined>; exists?: (path: string) => boolean } = {},
): ResolveSeedDirResult {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const hasManifest = (dir: string): boolean => exists(join(dir, SEED_MANIFEST_FILE));

  if (env.PAPERCUSP_NO_SEED) return { seedDir: null, disabled: true, source: 'no-seed' };

  const explicit = env.PAPERCUSP_SEED_DIR;
  if (explicit && hasManifest(explicit)) {
    return { seedDir: explicit, disabled: false, source: 'env' };
  }

  for (const key of SEED_SIBLING_RESOURCE_ENVS) {
    const sib = env[key];
    if (!sib) continue;
    // `<sidecar>/seed` first (dev/src-tauri layout), then `<resourceRoot>/seed`
    // (the real .deb/.app bundle layout — seed and sidecar are sibling resources).
    for (const candidate of [join(dirname(sib), 'seed'), join(dirname(dirname(sib)), 'seed')]) {
      if (hasManifest(candidate)) return { seedDir: candidate, disabled: false, source: `autodetect:${key}` };
    }
  }

  // A set-but-manifest-less explicit dir is reported distinctly (telemetry) once
  // the autodetect ALSO found nothing — the fallthrough above is the fix for the
  // wrong-env-path dead end (WI-2902).
  if (explicit) return { seedDir: null, disabled: false, source: 'env-missing' };
  return { seedDir: null, disabled: false, source: 'none' };
}

export interface RestoreHiveSeedCtx {
  /** The installed seed resource dir (holds manifest.json + per-store subdirs).
   *  Absent/empty ⇒ no seed shipped ⇒ pure cold path. */
  readonly seedDir: string;
  /** Where the git seed's checkout is restored (the repo working dir). */
  readonly targetRepoDir: string;
  /** The fresh install's corestore dir (`.papercusp/<hive>/hyperbee`). */
  readonly targetStoreDir: string;
  /** The git-seed decryption key — present ONLY post-admission. When absent, an
   *  encrypted git store is DEFERRED (not restored) rather than failing. */
  readonly decryptionKey?: Uint8Array;
  /** Override the origin the restored clone re-points at (else the seed's own). */
  readonly originUrl?: string;
  /** The `--no-seed` escape hatch: force-skip restore entirely and take the pure
   *  cold path (ran:false), even when a valid seed is present. The bootstrap default
   *  wires this from the PAPERCUSP_NO_SEED env — the operator's kill-switch if a
   *  shipped seed ever misbehaves, and how the cold-join canary forces a real join. */
  readonly disabled?: boolean;
  /** Restrict restore to these store kinds (e.g. `['git']`). Absent ⇒ all stores.
   *  The post-admission deferred-git-restore trigger (P-010 live-wire 2) uses this to
   *  re-restore ONLY the now-decryptable git store, without re-copying the corestore
   *  that already restored pre-join. */
  readonly onlyKinds?: readonly string[];
  /** Seams (tests inject; defaults are the real filesystem + providers). */
  readonly readManifest?: (seedDir: string) => Promise<SeedManifest | null>;
  readonly registry?: SeedProviderRegistry;
  readonly log?: SeedLog;
}

/** Severity for {@link SeedLog}. WI-9413: every seed degradation used to be reported
 *  through one untyped string sink, so "restored everything" and "this install will
 *  boot EMPTY" were the same kind of line. On a build that ships a seed, a cold path
 *  is ALWAYS a defect — but it was indistinguishable from progress, and the log was
 *  the only place it surfaced at all. */
export type SeedLogLevel = 'info' | 'warn' | 'error';

/** The seed logging seam. `level` is optional and defaults to 'info', so every
 *  pre-existing `(msg: string) => void` caller stays assignable and unchanged —
 *  a narrower function is assignable to a wider signature in TS. */
export type SeedLog = (msg: string, level?: SeedLogLevel) => void;

export interface RestoreHiveSeedResult {
  /** False ⇒ no seed present (cold path); true ⇒ a manifest was found + processed. */
  readonly ran: boolean;
  /** Per-store restore verdicts (empty when `ran:false`). */
  readonly outcomes: readonly StoreRestoreOutcome[];
  /** Store kinds intentionally NOT restored this pass (e.g. an encrypted git store
   *  awaiting its post-admission key) — the host restores them later / cold-paths them. */
  readonly deferred: readonly string[];
}

/** Default manifest reader — returns null (⇒ cold path) when no seed is shipped. */
async function defaultReadManifest(seedDir: string): Promise<SeedManifest | null> {
  const p = join(seedDir, SEED_MANIFEST_FILE);
  if (!seedDir || !existsSync(p)) return null;
  try {
    return decodeManifest(await readFile(p, 'utf8'));
  } catch {
    return null; // a corrupt/invalid manifest ⇒ cold path, never a boot failure
  }
}

/** The default provider registry: the git + corestore substrate adapters. */
export function defaultSeedRegistry(): SeedProviderRegistry {
  return new SeedProviderRegistry().register(createGitSeedProvider()).register(createCorestoreSeedProvider());
}

/** A store must be DEFERRED when it is encrypted at rest and we have no key yet. */
function isDeferred(entry: SeedStoreEntry, hasKey: boolean): boolean {
  return Boolean(entry.encryption) && !hasKey;
}

/**
 * Restore whatever the seed can pre-position right now, honoring the
 * admission-timing split. Returns per-store outcomes + the deferred set. NEVER
 * throws — a missing/corrupt seed or a per-store failure degrades to the cold path.
 */
export async function restoreHiveSeed(ctx: RestoreHiveSeedCtx): Promise<RestoreHiveSeedResult> {
  const log = ctx.log ?? (() => {});
  const readManifest = ctx.readManifest ?? defaultReadManifest;

  if (ctx.disabled) {
    log('[seed] restore disabled (--no-seed) — forcing the cold join path');
    return { ran: false, outcomes: [], deferred: [] };
  }

  const manifest = await readManifest(ctx.seedDir).catch(() => null);
  if (!manifest) {
    // WI-9413. A null manifest has TWO causes with opposite severities, and
    // defaultReadManifest collapses both to null (no file ⇒ null; corrupt/undecodable
    // ⇒ null, deliberately, so a bad seed never hard-fails boot). Distinguish them
    // here by asking whether the manifest FILE is actually on disk:
    //
    //   - absent  ⇒ genuinely no seed shipped (dev checkout, CI, --no-seed builds).
    //               The cold path is correct and expected. Stay at info, or the
    //               signal becomes noise on every developer machine.
    //   - present ⇒ a seed WAS shipped and we could not read it. This install will
    //               cold-join, and on an offline box that means the empty pot the
    //               entire seed effort exists to prevent. Always a defect.
    const shipped = Boolean(ctx.seedDir) && existsSync(join(ctx.seedDir, SEED_MANIFEST_FILE));
    if (shipped) {
      log(
        `[seed] manifest present at ${ctx.seedDir} but UNREADABLE — cold path (full join). ` +
          `A shipped seed that cannot be decoded means this install boots empty offline.`,
        'error',
      );
    } else {
      log('[seed] no seed present — cold path (full join)');
    }
    return { ran: false, outcomes: [], deferred: [] };
  }

  const hasKey = Boolean(ctx.decryptionKey);
  const onlyKinds = ctx.onlyKinds;
  const restoreNow: SeedStoreEntry[] = [];
  const deferred: string[] = [];
  for (const entry of manifest.stores) {
    if (onlyKinds && !onlyKinds.includes(entry.kind)) continue; // scoped restore (e.g. git-only)
    if (isDeferred(entry, hasKey)) {
      deferred.push(entry.kind);
      log(`[seed] deferring ${entry.kind} store — encrypted, key not yet available (post-admission)`);
    } else {
      restoreNow.push(entry);
    }
  }

  if (restoreNow.length === 0) {
    log('[seed] nothing to restore pre-key; all stores deferred to post-admission / cold path');
    return { ran: true, outcomes: [], deferred };
  }

  const registry = ctx.registry ?? defaultSeedRegistry();
  // Resolve each entry's RELATIVE source.path (git|corestore) against the seed dir.
  const resolvePayload = async (entry: SeedStoreEntry): Promise<SeedPayload> => {
    const src = entry.source;
    const rel = src.type === 'resource' ? src.path : entry.kind;
    return { path: join(ctx.seedDir, rel) };
  };

  const subManifest: SeedManifest = { ...manifest, stores: restoreNow };
  const restoreCtx = {
    targetRepoDir: ctx.targetRepoDir,
    targetStoreDir: ctx.targetStoreDir,
    ...(ctx.decryptionKey ? { decryptionKey: ctx.decryptionKey } : {}),
    ...(ctx.originUrl ? { originUrl: ctx.originUrl } : {}),
  };
  const result = await restoreSeed(subManifest, registry, resolvePayload, restoreCtx);
  for (const o of result.outcomes) {
    // WI-9413: a per-store failure here is unambiguous — we HAD a valid manifest and
    // tried to restore, so this is never the expected seedless case. That store's
    // content will be cold-fetched (or, offline, simply absent).
    if (o.ok) log(`[seed] restored ${o.kind}`);
    else log(`[seed] ${o.kind} restore failed (cold-pathing): ${o.reason ?? 'unknown'}`, 'error');
  }
  return { ran: true, outcomes: result.outcomes, deferred };
}
