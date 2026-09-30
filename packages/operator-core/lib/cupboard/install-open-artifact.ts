/**
 * install-open-artifact — the production caller of `openRetrievedArtifact`
 * (shared-pot-dao-cupboard-v1-2026-09-04 D-045 §3b).
 *
 * WHY THIS EXISTS
 * ---------------
 * `install-door-gate` already refuses an encrypted release when no `openArtifact`
 * seam is configured, and its refusal names this function by name — but nothing
 * production ever SUPPLIED that seam, so `openRetrievedArtifact` had zero
 * non-test callers and every encrypted install died on the fail-closed throw
 * (WI-2146273's caller-disposition table; P-027 measured `dead`).
 *
 * This module is that supplier. It is deliberately the ONLY place the decrypt
 * step lives: the door decides WHETHER an encrypted release may be applied, and
 * this decides HOW the ciphertext becomes the bytes that land on disk.
 *
 * WHAT MAKES THE CALL LOAD-BEARING
 * --------------------------------
 * Every refusal here THROWS, which `runInstallPlan` turns into an `apply-failed`
 * step and a rollback — so a wrong recipient, a revoked key version, a missing
 * out-of-band key or a failed AEAD check aborts the install instead of writing
 * something. And the bytes handed to `applyPlaintext` are the DECRYPTED ones, so
 * removing the call does not merely lose a grep hit: it writes ciphertext to
 * disk as if it were the unit.
 *
 * WHAT IS NOT RE-CHECKED, AND WHY
 * -------------------------------
 * The ciphertext is not re-hashed against `distribution.rootHash`. AES-GCM binds
 * the ciphertext to `{ releaseContentHash, keyVersion }` as additional
 * authenticated data, so bytes from the wrong release — or tampered bytes —
 * fail the auth tag inside `decryptArtifact`. A second content-address pass
 * would be a weaker copy of a check the cipher already makes.
 */
import {
  openRetrievedArtifact,
  type KeyWrapAdapter,
  type WrappedKeyDeliveryAdapter,
} from '../p2p/artifact-encryption';
import type { InstalledRelease } from './entitled-delivery';
import type { ApplyInput } from './install-runner';

/**
 * The collaborators the decrypt step needs. Each is nullable-or-refusing rather
 * than optional-and-skipped: an unconfigured provider must refuse the install,
 * never fall through to applying the encrypted bytes.
 */
export interface PrivateArtifactAccess {
  /** Unwraps the content key for this recipient. null ⇒ no provider configured. */
  readonly wrapAdapter: KeyWrapAdapter | null;
  /** Fetches the out-of-band wrapped key. null ⇒ no provider configured. */
  readonly deliveryAdapter: WrappedKeyDeliveryAdapter | null;
  /**
   * The assembled, chunk-verified CIPHERTEXT for this distribution.
   *
   * `RetrievalProgress` records WHICH chunks were verified, never the bytes —
   * the provider adapter that fetched them owns those — so the assembled
   * ciphertext is read back here. Returning null refuses the install.
   */
  readonly readCiphertext: (input: ApplyInput) => Promise<Buffer | null> | Buffer | null;
  /** Write the DECRYPTED bytes into place. Throwing is the failure path, as with `runner.apply`. */
  readonly applyPlaintext: (
    input: ApplyInput,
    plaintext: Buffer,
  ) => InstalledRelease | Promise<InstalledRelease>;
  /** Key versions withdrawn for this release; a match refuses before any unwrap. */
  readonly revokedKeyVersions?: (
    input: ApplyInput,
  ) => readonly number[] | Promise<readonly number[]>;
}

/**
 * Build the `openArtifact` seam `install-door-gate` asks for.
 *
 * `subject` is the recipient identity the entitlement was looked up under, and
 * it is the SAME identity the wrapped key was addressed to at publish time —
 * which is why the seam is built per request rather than once per process: a
 * key wrapped for one buyer must not open under another's install.
 */
export function createOpenArtifactSeam(
  access: PrivateArtifactAccess,
  context: { readonly subject: string },
): (input: ApplyInput) => Promise<InstalledRelease> {
  return async (input: ApplyInput): Promise<InstalledRelease> => {
    const envelope = input.distribution.encryption;
    if (!envelope) {
      throw new Error(
        `${input.releaseRef}: the encrypted-apply seam was called for a distribution carrying no ` +
          'encryption envelope — the plain runner.apply owns that release',
      );
    }

    // The envelope names the bytes it can open. A manifest whose declared
    // ciphertext hash is not the root actually distributed is describing a
    // different artifact, and decrypting it would authenticate the wrong bytes.
    if (envelope.ciphertextHash !== input.distribution.rootHash) {
      throw new Error(
        `${input.releaseRef}: encryption envelope names ciphertext ${envelope.ciphertextHash} but the ` +
          `distribution manifest ships ${input.distribution.rootHash}`,
      );
    }

    if (!access.wrapAdapter) {
      throw new Error(
        `${input.releaseRef} is encrypted and no key-wrap provider is configured at the install door — ` +
          'the content key cannot be unwrapped, so the bytes are not applied',
      );
    }
    if (!access.deliveryAdapter) {
      throw new Error(
        `${input.releaseRef} is encrypted and no wrapped-key delivery provider is configured at the ` +
          'install door — the out-of-band key cannot be fetched, so the bytes are not applied',
      );
    }

    const ciphertext = await access.readCiphertext(input);
    if (!ciphertext) {
      throw new Error(
        `${input.releaseRef}: retrieval verified every chunk but no assembled ciphertext could be read ` +
          'back for decryption',
      );
    }

    const revokedKeyVersions = (await access.revokedKeyVersions?.(input)) ?? [];

    const opened = await openRetrievedArtifact({
      ciphertext,
      recipientId: context.subject,
      keyVersion: envelope.keyVersion,
      release: input.release,
      envelope,
      wrapAdapter: access.wrapAdapter,
      deliveryAdapter: access.deliveryAdapter,
      ...(revokedKeyVersions.length > 0 ? { revokedKeyVersions } : {}),
    });

    if (!opened.ok) {
      // The code is surfaced verbatim: `not-entitled`, `key-revoked` and
      // `no-wrapped-key` are different next actions for whoever is installing,
      // and collapsing them into "install failed" is what makes the refusal
      // unactionable.
      throw new Error(`${input.releaseRef}: ${opened.code} — ${opened.detail}`);
    }

    return access.applyPlaintext(input, opened.plaintext);
  };
}
