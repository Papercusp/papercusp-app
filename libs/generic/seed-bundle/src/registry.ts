/**
 * @papercusp/seed-bundle — the SeedProvider seam + registry.
 *
 * A {@link SeedProvider} is the host-supplied substrate adapter that knows how to
 * CUT a checkpoint of one store kind, VERIFY a checkpoint's integrity, and
 * RESTORE it into place (so the store's native catch-up resumes from it). The
 * generic layer never touches git or hypercore itself — it orchestrates over
 * these injected providers. The provider IS the configure()/injection seam.
 */

import type { SeedStoreEntry } from './manifest';

/**
 * The bytes/handle a provider works with. Opaque to the generic layer — a
 * provider narrows it (e.g. a git provider takes a bundle path, a corestore
 * provider takes a directory handle).
 */
export type SeedPayload = Uint8Array | { readonly path: string } | unknown;

/** Provider-specific context for a cut (build/release time). */
export interface SeedCutContext {
  readonly [k: string]: unknown;
}

/** Provider-specific context for a restore (first-boot time). */
export interface SeedRestoreContext {
  readonly [k: string]: unknown;
}

/** The verdict of {@link SeedProvider.verify}. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** What a cut produces: the manifest entry describing the store + its payload. */
export interface SeedCutOutput {
  readonly entry: SeedStoreEntry;
  readonly payload: SeedPayload;
}

/** The substrate adapter for one store kind. */
export interface SeedProvider {
  readonly kind: string;
  /** Produce a self-verifying checkpoint of the live store (build/release time). */
  cut(ctx: SeedCutContext): Promise<SeedCutOutput>;
  /** Cheap integrity check BEFORE restore — hash + native shape. Never trusts blindly. */
  verify(entry: SeedStoreEntry, payload: SeedPayload): Promise<VerifyResult>;
  /** Drop the checkpoint into place so the store's NATIVE catch-up resumes from it. */
  restore(entry: SeedStoreEntry, payload: SeedPayload, ctx: SeedRestoreContext): Promise<void>;
}

/** A kind → provider registry. One provider per kind. */
export class SeedProviderRegistry {
  private readonly byKind = new Map<string, SeedProvider>();

  /** Register a provider. Throws on an empty kind or a duplicate registration. */
  register(provider: SeedProvider): this {
    if (!provider.kind) throw new Error('SeedProvider.kind is required');
    if (this.byKind.has(provider.kind)) {
      throw new Error(`duplicate seed provider kind: ${provider.kind}`);
    }
    this.byKind.set(provider.kind, provider);
    return this;
  }

  get(kind: string): SeedProvider | undefined {
    return this.byKind.get(kind);
  }

  /** Like {@link get} but throws a diagnostic error (listing known kinds) on a miss. */
  require(kind: string): SeedProvider {
    const p = this.byKind.get(kind);
    if (!p) {
      throw new Error(
        `no seed provider registered for kind: ${kind} (have: ${this.kinds().join(', ') || 'none'})`,
      );
    }
    return p;
  }

  kinds(): string[] {
    return [...this.byKind.keys()];
  }
}
