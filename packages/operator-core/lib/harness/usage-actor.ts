/**
 * resolveUsageActor — resolve the local machine's { githubUserId, devicePubkey }
 * for P-070 usage-event emission.
 *
 * Composes the SAME pieces the Model-B announce identity uses
 * (resolveLocalGithubIdentity → gh user, resolveDeviceKeychainId → keychain id,
 * loadOrGenerateDeviceKeypair → device pubkey) but does NOT require a booted
 * substrate log (no logCoreKeyHex) — usage events are emitted whether or not the
 * harness is shared. `device_pubkey` is NOT NULL in the ledger, so an emit needs
 * a real key; this is where it comes from.
 *
 * Returns `null` when gh is unauthenticated — the caller (emitUsageEventBestEffort)
 * then skips the emit silently. The gh `GET /user` is a network call, so a
 * successful resolution is cached for the process lifetime (the gh user + device
 * key are stable per machine). A null result is NOT cached, so an emit retried
 * after `gh auth login` resolves correctly.
 */
import {
  resolveLocalGithubIdentity,
  type LocalGithubIdentity,
} from '../identity/resolve-local-github-identity';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';

export interface UsageActor {
  githubUserId: number;
  /** Raw 32-byte Ed25519 device pubkey, base64 (== binding device_pubkey). */
  devicePubkey: string;
}

export interface ResolveUsageActorDeps {
  resolveGithubIdentity?: () => Promise<LocalGithubIdentity>;
  resolveKeychainId?: (githubUserId: number) => string;
  loadKeypair?: (
    keychainId: string,
  ) => Promise<{ keychainId: string; pubkeyBase64: string }>;
}

let cached: UsageActor | null = null;

export async function resolveUsageActor(
  deps: ResolveUsageActorDeps = {},
): Promise<UsageActor | null> {
  if (cached) return cached;
  const resolveGh = deps.resolveGithubIdentity ?? resolveLocalGithubIdentity;
  const identity = await resolveGh();
  if (identity.kind !== 'ok') return null; // do NOT cache — retry once gh authed
  const buildKeychainId = deps.resolveKeychainId ?? resolveDeviceKeychainId;
  const loadKeypair = deps.loadKeypair ?? loadOrGenerateDeviceKeypair;
  const keychainId = buildKeychainId(identity.githubUserId);
  const keypair = await loadKeypair(keychainId);
  cached = {
    githubUserId: identity.githubUserId,
    devicePubkey: keypair.pubkeyBase64,
  };
  return cached;
}

/** Test-only: clear the process-lifetime cache between cases. */
export function _resetUsageActorCacheForTests(): void {
  cached = null;
}
