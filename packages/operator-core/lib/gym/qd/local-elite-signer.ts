/**
 * Local elite-outcome signer resolver (federated-scout-gym-learning-2026-07-02
 * F1-6 / P-014, D-005 hole 3 — the SEND-side signing layer).
 *
 * The receive side already verifies device-signed EliteOutcomeRecords
 * (gym-qd-elites projection → verifyEliteOutcomeForElite). This is the missing
 * SEND-side half: give the gym cycle a signer so an accepted champion's elite
 * federates WITH its own device-signed outcome proof, not just the bare
 * `federatable` boolean — upgrading it from outcome-UNVERIFIED to
 * outcome-VERIFIED on every receiver that can resolve our device.
 *
 * The signer MUST use the SAME device key boot.ts signs announces with, because
 * the receiver re-derives the expected signer as
 * `resolveAuthorDevice(ourSourceLog) = admittedIdentities.get(ourLog).devicePubkey`
 * — our announce device. We resolve that identity from the persisted announce cache
 * (`loadCachedLocalAnnounceIdentity`), so the pubkey we stamp provably matches what
 * the receiver expects (anti-lift parity), WITHOUT coupling the control-plane gym
 * cycle to the live substrate object graph.
 *
 * BEST-EFFORT: a cold box (substrate never announced), a rotated key, or any read
 * failure yields `undefined` — the cycle then federates tier-1 (unsigned but still
 * admitted). Signing can never DROP an elite: a receiver that fails verification
 * just leaves `outcome_verified=false`, identical to the unsigned case.
 */
import type { EliteOutcomeSigner } from './federate-elite';
import {
  loadCachedLocalAnnounceIdentity,
  type LocalAnnounceIdentity,
} from '../../sync/hyperbee/local-announce-identity';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';

/**
 * Resolve an {@link EliteOutcomeSigner} bound to THIS peer's announce device key,
 * or `undefined` when no local device identity is available (federate tier-1).
 *
 * @param load  injectable identity loader (tests); defaults to the cache-first
 *              {@link loadCachedLocalAnnounceIdentity}.
 */
export async function resolveLocalEliteOutcomeSigner(
  load: () => Promise<LocalAnnounceIdentity | null> = loadCachedLocalAnnounceIdentity,
): Promise<EliteOutcomeSigner | undefined> {
  const identity = await load().catch(() => null);
  if (!identity) return undefined;
  const { keychainId, devicePubkeyBase64 } = identity;
  return {
    devicePubkeyBase64,
    // The private key never leaves the keychain — sign through the thin helper,
    // exactly as the announce signer does (signWithDeviceKey(keychainId, …)).
    sign: (bytes: Buffer) => signWithDeviceKey(keychainId, bytes),
  };
}
