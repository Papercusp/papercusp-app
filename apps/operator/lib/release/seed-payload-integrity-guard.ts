/**
 * WI-39447 — the recurrence guard for a manifest that describes bytes WHICH ARE NOT THERE.
 *
 * WHY THIS EXISTS, and why the existing guards could not catch it. `seed-degradation-guard`
 * judges the final manifest's CLAIMS ABOUT ITSELF (is a `coreSparseFrom` label honest, is the
 * declared size sane). `assertStagedRangeIsLocal` judges the REPLICA, and lives inside the
 * corestore provider's `cut()`. Between them sits the case neither can see: a manifest whose
 * `hash`/`sizeBytes` are internally plausible and honestly labelled, but describe a payload
 * that is not the one on disk. Nothing measured the manifest AGAINST THE BYTES.
 *
 * THE PATH THAT PRODUCES IT IS THE DEFAULT ONE. `ensure-release-seed.sh` defaults
 * `PAPERCUSP_SEED_REUSE_CORESTORE=auto`, so the normal release passes `--reuse-corestore`
 * whenever a committed corestore exists. On that path the corestore is never cut:
 * `readReusableCorestore` (cut-seed-cli.ts) reads the store entry out of the PRIOR manifest —
 * it hashes nothing and sizes nothing — and `graftCorestoreEntry` copies that entry onto the
 * new manifest verbatim. The bytes are moved/copied separately. So the declared hash and size
 * are inherited metadata that no longer has to correspond to anything, and because the graft
 * never calls the provider's `cut()`, the fresh-cut guards are structurally out of reach.
 *
 * WHAT IT COSTS WHEN IT SHIPS. `restoreSeed` (libs/generic/seed-bundle/src/restore.ts) calls
 * `provider.verify(entry, payload)` BEFORE `restore`, and `verify` is exactly a `hashDir` of
 * the payload against `entry.hash`. A mismatch is not a warning and not a crash: the store is
 * pushed as a failed outcome and `continue`d past. Restore is failure-isolating, so the git
 * store still lands and the install looks like it worked — while the corestore, i.e. the whole
 * hive, silently never restores. Measured on the shipped 2026-08-15 seed: declared
 * 13b280d7…/318,544,683 B against an actual fa4fddc2…/268,378,998 B (50,165,685 short, 64 of
 * 76 blocks present). That artifact restores an EMPTY hive on every fresh install.
 *
 * SO THE GUARD RUNS THE RESTORE SIDE'S OWN CHECK, AT CUT TIME. It does not reimplement
 * hashing — a second implementation is a second thing to drift. It resolves each store's
 * payload dir and calls the SAME `provider.verify()` from the SAME `defaultSeedRegistry()`
 * that boot uses, so "the cut passed" and "the install will verify" cannot disagree.
 *
 * ⛔ IT REFUSES; IT DOES NOT RECOMPUTE. Rewriting the entry from the bytes on disk would make
 * every one of these manifests self-consistent and ship the defect anyway — the 2026-08-15
 * corestore is missing twelve blocks of hive history, and a recomputed hash would launder that
 * into a valid-looking seed. A refused cut costs minutes; a published installer that restores
 * an empty hive does not announce itself at all (the same reasoning as its two siblings).
 */

import { isAbsolute, join } from 'node:path';
import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';

/** One store whose declared payload does not match the bytes staged for it. */
export interface SeedPayloadFinding {
  readonly kind: string;
  readonly reason: string;
}

export interface SeedPayloadIntegrityResult {
  readonly ok: boolean;
  /** Which cut branch produced the manifest — reported so a red names the likely cause. */
  readonly origin: 'fresh' | 'reuse';
  /** Store kinds actually measured (a kind absent here was NOT checked). */
  readonly checked: readonly string[];
  readonly findings: readonly SeedPayloadFinding[];
  readonly message: string;
}

/** The restore side's verdict shape, narrowed to what this guard reads. */
export interface StoreVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Verify one store's staged payload against its declared entry. Injected for tests; the
 * default resolves the real providers lazily so importing this guard does not pull in
 * Corestore/hypercore.
 */
export type SeedStoreVerifier = (entry: SeedStoreEntry, payloadPath: string) => Promise<StoreVerdict>;

/**
 * The production verifier: the SAME registry `restore-hive-seed` builds for boot. Imported
 * lazily — see {@link SeedStoreVerifier}.
 */
export const defaultSeedStoreVerifier: SeedStoreVerifier = async (entry, payloadPath) => {
  const { defaultSeedRegistry } = await import(
    '@papercusp/operator-core/lib/sync/hyperbee/restore-hive-seed'
  );
  const provider = defaultSeedRegistry().get(entry.kind);
  if (!provider) return { ok: false, reason: `no provider registered for kind ${entry.kind}` };
  return provider.verify(entry, { path: payloadPath });
};

/**
 * Resolve a store entry's staged payload directory. The cutter deliberately records a RELATIVE
 * subdir so the manifest is portable (seed-cutter.ts), so the seed dir is what makes it absolute.
 */
function resolvePayloadPath(entry: SeedStoreEntry, dir: string): string | null {
  const source = entry.source as { type?: string; path?: string } | undefined;
  const path = source?.path;
  if (!path) return null;
  return isAbsolute(path) ? path : join(dir, path);
}

/**
 * Judge a FINAL seed manifest against the bytes staged in `dir`. Pure verdict — see
 * {@link assertSeedPayloadMatchesManifest} for the throwing form the cut path uses.
 */
export async function judgeSeedPayloadIntegrity(inp: {
  readonly manifest: SeedManifest;
  readonly dir: string;
  readonly origin: 'fresh' | 'reuse';
  readonly verify?: SeedStoreVerifier;
}): Promise<SeedPayloadIntegrityResult> {
  const { manifest, dir, origin } = inp;
  const verify = inp.verify ?? defaultSeedStoreVerifier;

  const findings: SeedPayloadFinding[] = [];
  const checked: string[] = [];

  for (const entry of manifest.stores) {
    const payloadPath = resolvePayloadPath(entry, dir);
    if (!payloadPath) {
      // Never skip silently: an unresolvable payload is an UNMEASURED store, and this guard's
      // whole point is that an unmeasured store is how the defect shipped in the first place.
      findings.push({
        kind: entry.kind,
        reason: `store declares no resolvable payload path (source=${JSON.stringify(entry.source)}) — cannot be measured`,
      });
      continue;
    }
    checked.push(entry.kind);
    const verdict = await verify(entry, payloadPath);
    if (!verdict.ok) {
      findings.push({ kind: entry.kind, reason: verdict.reason ?? 'unknown' });
    }
  }

  const ok = findings.length === 0;
  const message = ok
    ? `[seed-guard] payload integrity OK (${origin} cut, verified ${checked.join(', ') || 'no stores'}).`
    : [
        `[seed-guard] REFUSING a seed whose manifest does not describe its payload (${origin} cut):`,
        ...findings.map((f) => `  • ${f.kind}: ${f.reason}`),
        '',
        'This is the check the INSTALLER runs (seed-bundle restoreSeed → provider.verify). Shipping',
        'past it does not degrade gracefully: the failing store is skipped and its data never',
        'restores, while the rest of the install succeeds and looks healthy.',
        '',
        origin === 'reuse'
          ? 'The corestore was GRAFTED (--reuse-corestore), so its hash/sizeBytes were inherited from the\nprior manifest and never re-measured. Re-cut the corestore FRESH (drop --reuse-corestore, or set\nPAPERCUSP_SEED_REUSE_CORESTORE=0) — do NOT "fix" this by recomputing the entry from the bytes,\nwhich would only make a short payload self-consistent.'
          : 'A fresh cut should have hashed exactly these bytes — treat a mismatch here as the staged dir\nbeing mutated after the entry was built (a live store re-opening it is the usual cause).',
      ].join('\n');

  return { ok, origin, checked, findings, message };
}

/** Throwing form for the cut path — refuses a seed whose manifest does not describe its bytes. */
export async function assertSeedPayloadMatchesManifest(inp: {
  readonly manifest: SeedManifest;
  readonly dir: string;
  readonly origin: 'fresh' | 'reuse';
  readonly verify?: SeedStoreVerifier;
  readonly log?: (msg: string) => void;
}): Promise<SeedPayloadIntegrityResult> {
  const result = await judgeSeedPayloadIntegrity(inp);
  if (!result.ok) throw new Error(result.message);
  (inp.log ?? console.warn)(result.message);
  return result;
}
