/**
 * epoch-key-provider-chain — compose several {@link EpochKeyProvider}s into ONE that
 * tries each in order and returns the first key that resolves. WI-3232 (offline pot):
 * the running hive resolves an epoch key from the FEDERATED member provider (the
 * PG-wrapped `hive_epoch_keys` rows, hive-epoch-boot-deps) FIRST — it holds ALL granted
 * epochs [0..cur] and stays correct after a re-key — and falls back to the BUNDLED seed
 * provider (epoch-keys.json, bundled-epoch-key-provider) when the member can't yet. So a
 * fresh packaged install with NO admission still decrypts the seed's `cutAtEpoch`
 * content, while an online member keeps using its own per-epoch keys unchanged.
 *
 * Order-preserving + fail-closed:
 *   - A one-provider chain is byte-for-byte TRANSPARENT (the provider itself is returned),
 *     so the drain's `EpochKeyUnavailableError`-means-defer semantics are preserved exactly.
 *   - With several, the FIRST success wins; if EVERY provider throws, the LAST provider's
 *     error propagates. Put the member provider first and the bundled provider last, so an
 *     all-miss surfaces the bundled/member `EpochKeyUnavailableError` and the caller defers,
 *     exactly as today.
 *   - An empty chain (no usable provider) resolves nothing: every lookup throws
 *     `EpochKeyUnavailableError` (fail closed — never silently returns a wrong/absent key).
 */
import type { EpochKey } from './hive-epoch-crypto';
import type { EpochKeyProvider } from './hive-epoch-serving';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';

/**
 * Chain the given providers (null/undefined entries are dropped, so callers can pass an
 * optional member provider inline without pre-filtering). Returns a single
 * {@link EpochKeyProvider}; see the module header for the ordering + fail-closed contract.
 */
export function chainEpochKeyProviders(
  providers: readonly (EpochKeyProvider | null | undefined)[],
): EpochKeyProvider {
  const chain = providers.filter((p): p is EpochKeyProvider => Boolean(p));
  if (chain.length === 1) return chain[0];
  if (chain.length === 0) {
    return {
      async keyForEpoch(potId: string, epoch: number): Promise<EpochKey> {
        throw new EpochKeyUnavailableError(potId, epoch);
      },
    };
  }
  return {
    async keyForEpoch(potId: string, epoch: number): Promise<EpochKey> {
      let lastErr: unknown;
      for (const provider of chain) {
        try {
          return await provider.keyForEpoch(potId, epoch);
        } catch (e) {
          lastErr = e;
        }
      }
      // Every provider missed — propagate the last error (an EpochKeyUnavailableError
      // when the last provider is the bundled/member one) so the caller defers.
      throw lastErr;
    },
  };
}
