/**
 * device-keychain-id — the ONE canonical builder for the device-keypair
 * keychain id.
 *
 * The convention (documented in `keychain.ts` §"Account name" and
 * `attestation-types.ts` `DeviceKeypairId.keychainId`) is a PER-GitHub-user
 * id of the form:
 *
 *   `<github_user_id>:<machine-fingerprint>`
 *
 * so a multi-account machine can hold ONE device keypair per GitHub identity.
 * The keypair under this id is what:
 *   - signs the attestation gist + the `.papercusp/contributors/<login>.json`
 *     contributor file (the channel-2 binding artifact), and
 *   - is advertised as `device_pubkey` in the Model B swarm announce.
 *
 * Read-admission's channel-2 verifies a REMOTE peer's published contributor
 * file against the `device_pubkey` the announce advertises, so the announce
 * MUST advertise the key stored under the SAME keychain id the contributor
 * file was signed with. Both paths therefore go through THIS builder — a
 * single source of truth removes the class of bug where the announce and the
 * binding/publish path key off different keychain ids and every channel-2
 * check fails.
 *
 * Pure + dependency-light: the machine fingerprint is derived from
 * `hostname + username` (the same machine-derived inputs `keychain.ts`'s
 * encrypted-file fallback uses for its PBKDF2 key), so a given user on a given
 * machine always resolves to a stable id across restarts.
 */

import { hostname as getHostname, userInfo } from 'node:os';

/**
 * Derive the stable per-machine fingerprint component of the keychain id.
 * `hostname + username` — the same machine-identifying inputs used elsewhere
 * in the identity layer. Sanitized so the id is a safe keychain account name
 * (alphanumeric, `-`, `_`); other characters collapse to `_`.
 */
export function machineFingerprint(input?: { hostname?: string; username?: string }): string {
  const host = (input?.hostname ?? safeHostname()).trim();
  const user = (input?.username ?? safeUsername()).trim();
  const raw = `${host}-${user}` || 'unknown-machine';
  return sanitize(raw);
}

/**
 * Build the canonical device-keypair keychain id for a GitHub user on this
 * machine: `<github_user_id>:<machine-fingerprint>`.
 *
 * @param githubUserId stable numeric GitHub user id (NOT login — login renames).
 * @param input optional machine-fingerprint overrides (tests).
 */
export function resolveDeviceKeychainId(
  githubUserId: number,
  input?: { hostname?: string; username?: string },
): string {
  if (!Number.isInteger(githubUserId) || githubUserId <= 0) {
    throw new Error(
      `resolveDeviceKeychainId: githubUserId must be a positive integer, got ${githubUserId}`,
    );
  }
  return `${githubUserId}:${machineFingerprint(input)}`;
}

function safeHostname(): string {
  try {
    return getHostname() ?? '';
  } catch {
    return '';
  }
}

function safeUsername(): string {
  try {
    return userInfo().username ?? '';
  } catch {
    return '';
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
