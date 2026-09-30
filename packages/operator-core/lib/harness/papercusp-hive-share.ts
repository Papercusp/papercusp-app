/**
 * papercusp-hive-share — Solution C orchestration: announce the dogfood `papercusp`
 * hive as a SHARED P2P hive under a PER-OWNER identity, gated by
 * DOGFOOD_PAPERCUSP_POT_SHARE (default ON, still reversible by flag).
 *
 * Two hook points around the hive create in bootstrap-papercusp-hive:
 *
 *   adoptSharedHiveIdentity()  — BEFORE the hive is created. If the owner already
 *     has a hive-identity gist (a prior device of theirs created it), inject that
 *     keypair into the keychain so `ensurePapercuspHive` creates the hive under the
 *     OWNER's identity (same pubkey ⇒ same federation topic) instead of minting a
 *     fresh per-device one. Returns the state threaded to goSharedHive, or null to
 *     skip sharing this boot (flag off / no gh / not resolvable).
 *
 *   goSharedHive(state)        — AFTER the hive is created + homed. The FIRST device
 *     (no gist yet) publishes its just-minted keypair + a fresh invite secret to a
 *     per-owner PRIVATE gist; then BOTH paths announce the hive on the INVITE topic
 *     (go-live on the federation topic, no public/Cupboard leak) and set an
 *     owner-signed ALLOWLIST policy naming ONLY the owner's GitHub login — so the
 *     owner's own devices auto-merge and strangers on the topic are refused.
 *
 * Everything is BEST-EFFORT + never throws: a failure (no network, missing `gist`
 * scope, …) just skips/retries on the next boot. The shared identity's PRIVATE key
 * never leaves the owner's private gist — it is NOT baked into the binary (the
 * Solution-C security property).
 *
 * All collaborators are injectable seams for hermetic unit tests.
 */

import { randomBytes } from 'node:crypto';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { keychainStore, keychainLoad } from '../identity/keychain';
import { hiveKeychainId, HIVE_KEYPAIR_SERVICE, loadHiveKeyStatus, type HiveKeyStatus } from '../identity/hive-keypair';
import { pubkeyBase64FromDer } from '../identity/ed25519';
import { setHiveListing } from '../hive-set-listing';
import {
  mutateHivePolicyIfChanged,
  type AuthorHivePolicyInput,
  type AuthorHivePolicySeams,
  type MutateHivePolicyIfChangedResult,
} from '../hive-policy-author';
import type { HivePolicy } from '../hive-policy-schema';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import { PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import {
  fetchOwnerHiveIdentityRecord,
  publishOwnerHiveIdentity,
  isUsableIdentityPassphrase,
  type OwnerHiveIdentity,
} from './papercusp-shared-identity-gist';
import { bakedCanonicalHiveInvite } from './papercusp-hive-join';
import { CANONICAL_HIVE_TEAM_ALLOWLIST } from './canonical-hive-team-allowlist';

/** State threaded from the BEFORE hook (adopt) to the AFTER hook (goShared). */
export interface SharedHiveState {
  /** The owner's GitHub login — the sole allowlist entry (auto-admit my devices). */
  githubLogin: string;
  /** The owner's gh token — used to publish the identity gist on the first device. */
  token: string;
  /** The identity fetched from the gist; null ⇒ THIS device is the first/creator. */
  existing: OwnerHiveIdentity | null;
  /** The OWNER-HELD passphrase the identity gist is sealed under (WI-2147371 / D-056).
   *  Required and non-optional: without one there is no publish path at all, so
   *  {@link adoptSharedHiveIdentity} returns null rather than producing a state that
   *  could reach a plaintext write. */
  passphrase: string;
  /** True when `existing` came from a pre-fix v1 PLAINTEXT gist. goSharedHive re-seals
   *  it in place so the live exposure is retired, not merely adopted. */
  existingLegacyPlaintext: boolean;
}

export interface HiveShareDeps {
  isEnabled?: () => Promise<boolean>;
  resolveGithub?: typeof resolveLocalGithubIdentity;
  /** Resolve the canonical gist blob AND whether it was a legacy plaintext publish.
   *  Default: {@link fetchOwnerHiveIdentityRecord}. */
  fetchIdentityRecord?: typeof fetchOwnerHiveIdentityRecord;
  publishIdentity?: typeof publishOwnerHiveIdentity;
  /** The OWNER-HELD passphrase the identity gist is sealed under (WI-2147371 / D-056).
   *  Default: `PAPERCUSP_HIVE_IDENTITY_PASSPHRASE` from the environment — injected
   *  config the owner supplies on each of their devices, never a repo file and never
   *  the gh token (which rotates and would strand every published blob). When it
   *  resolves to null/too-short, sharing NO-OPS for this boot: the device keeps its own
   *  hive identity. That degradation is deliberate — there is no plaintext fallback. */
  identityPassphrase?: () => Promise<string | null>;
  storeKey?: (keychainId: string, value: Buffer, service: string) => Promise<unknown>;
  loadKey?: (keychainId: string, service: string) => Promise<{ kind: 'ok'; value: Buffer } | { kind: 'error' }>;
  setListing?: typeof setHiveListing;
  /** The policy writer. Default: {@link authorBootPolicy} — a DEFAULTS + allowlist-UNION
   *  pass over the current signed policy that skips the re-sign when nothing changed
   *  (WI-2039866). Tests inject a capture; it receives the DESIRED boot policy. */
  authorPolicy?: (input: AuthorHivePolicyInput) => Promise<MutateHivePolicyIfChangedResult>;
  /** Seams for the default {@link authorBootPolicy} (read-current / sign / write). */
  policySeams?: AuthorHivePolicySeams;
  randomSecret?: () => string;
  /** The canonical invite secret baked into the public build (so every one of the
   *  owner's devices announces on the SAME invite topic that fresh installs listen on
   *  — WI-867 cause (a)). Default: bakedCanonicalHiveInvite()?.inviteSecret ?? null. */
  canonicalSecret?: () => string | null;
  /** Derive the raw-32 pubkey (base64) from the private DER. Default: pubkeyBase64FromDer. */
  derivePubkey?: (der: Buffer) => string;
  /** This hive's actual local key status — 'not_found' on a non-owner box (no
   *  competing local identity, safe to proceed), 'ok' with the pubkey to compare
   *  against the gist on the owner box, or 'error' when a key IS present but
   *  couldn't be read/decrypted (must NOT be treated as 'not_found' — WI-762: a
   *  read/decrypt failure is not proof of "no competing identity", so the guard
   *  fails closed on 'error' instead of silently proceeding). Default: loadHiveKeyStatus. */
  loadPubkey?: (workspaceId: string, slug: string) => Promise<HiveKeyStatus>;
  /** Extra GitHub logins admitted beyond the owner — the team allowlist that makes the
   *  dogfood a real SHARED hive (P-007). Default: CANONICAL_HIVE_TEAM_ALLOWLIST. */
  teamAllowlist?: readonly string[];
  /** P-019 — the hive's membership admission mode. Default 'allowlist' (the canonical dogfood
   *  hive is a PRIVATE team hive — D-001). A PUBLIC project hive passes 'open' so anyone may join
   *  + contribute without being a collaborator; 'approval' queues join requests for the owner. */
  membershipMode?: 'open' | 'approval' | 'allowlist';
  /** P-018 / D-012 — federated content write authority. Default: author-scoped for an `open` hive
   *  (so a stranger-member can't delete others' plans), else 'member' (trusted-hive behavior). */
  contentWriteAuthority?: 'member' | 'author-scoped';
}

/**
 * The owner-held sealing passphrase (WI-2147371 / D-056). Injected config on each of
 * the owner's devices — deliberately NOT the gh token (it rotates, which would strand
 * every already-published blob) and never a repo file. Absent ⇒ sharing no-ops.
 */
export const IDENTITY_PASSPHRASE_ENV = 'PAPERCUSP_HIVE_IDENTITY_PASSPHRASE';

async function defaultIdentityPassphrase(): Promise<string | null> {
  const raw = process.env[IDENTITY_PASSPHRASE_ENV];
  return isUsableIdentityPassphrase(raw) ? raw : null;
}

async function defaultIsEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.DOGFOOD_PAPERCUSP_POT_SHARE, 'system');
  } catch {
    return false;
  }
}

/**
 * BEFORE the hive is created: adopt the owner's existing shared identity if present.
 * Returns the state for goSharedHive, or null when sharing is skipped this boot.
 */
export async function adoptSharedHiveIdentity(deps: HiveShareDeps = {}): Promise<SharedHiveState | null> {
  const isEnabled = deps.isEnabled ?? defaultIsEnabled;
  if (!(await isEnabled())) return null;

  const resolveGithub = deps.resolveGithub ?? resolveLocalGithubIdentity;
  const fetchIdentityRecord = deps.fetchIdentityRecord ?? fetchOwnerHiveIdentityRecord;
  const identityPassphrase = deps.identityPassphrase ?? defaultIdentityPassphrase;
  const storeKey =
    deps.storeKey ?? ((id, value, service) => keychainStore(id, value, service));

  try {
    const id = await resolveGithub();
    if (id.kind !== 'ok') return null; // no gh yet → can't share; retry next boot

    // No owner passphrase ⇒ no sealed publish is possible, and there is deliberately no
    // plaintext fallback (WI-2147371). Skip sharing entirely rather than reach a write
    // path that could leak the hive private key to anyone who learns the gist URL.
    const passphrase = await identityPassphrase();
    if (!isUsableIdentityPassphrase(passphrase)) return null;

    const record = await fetchIdentityRecord(id.token, passphrase);
    const existing = record?.identity ?? null;
    if (existing) {
      // Adopt the owner's hive identity BEFORE the hive is created, so
      // ensurePapercuspHive → loadOrGenerateHiveKeypair LOADS it (same pubkey ⇒ same
      // federation topic) instead of minting a conflicting per-device identity.
      await storeKey(
        hiveKeychainId(PAPERCUSP_WORKSPACE_ID, PAPERCUSP_HIVE_SLUG),
        Buffer.from(existing.privateKeyDer, 'base64'),
        HIVE_KEYPAIR_SERVICE,
      );
    }
    return {
      githubLogin: id.githubLogin,
      token: id.token,
      existing,
      passphrase,
      existingLegacyPlaintext: record?.legacyPlaintext ?? false,
    };
  } catch {
    return null; // best-effort
  }
}

/**
 * The boot-time DESIRED policy keys (what {@link goSharedHive} computes each boot).
 */
// A type alias (not an interface) so it is assignable to `HivePolicy`'s open record.
export type BootPolicyDesired = {
  membership: 'open' | 'approval' | 'allowlist';
  allowlist: string[];
  contentWriteAuthority?: 'author-scoped';
  comms: { defaultTier: 'steer' };
};

/**
 * Merge the boot-time desired keys over the CURRENT signed policy (pure). WI-2039866:
 * the old path REPLACED the whole signed policy on every boot with whatever this boot
 * could compute, which (a) stripped every allowlist entry the owner had added through
 * the API — on the tower the gh-CLI login (papercupai) differs from the identity the
 * owner's devices are attested under (ownerhandle), so each restart re-authored an allowlist
 * that excluded the owner's own devices and both legs of the tower↔VM rig went dark —
 * and (b) wiped every other owner-authored key (bans, rate caps, comms tweaks). Boot is
 * a DEFAULTS pass, not the owner's control surface:
 *   - `allowlist` is the UNION of what this boot computes and what is already signed;
 *     boot never removes a login (removal is an explicit API/UI act).
 *   - `membership` / `comms` / `contentWriteAuthority` are filled in only when the
 *     current policy does not already state them.
 *   - every other key rides through untouched.
 */
export function mergeBootPolicy(current: HivePolicy, desired: BootPolicyDesired): HivePolicy {
  const signed = Array.isArray(current.allowlist)
    ? current.allowlist.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const next: HivePolicy = {
    ...current,
    membership: current.membership ?? desired.membership,
    allowlist: Array.from(new Set([...desired.allowlist, ...signed])),
    comms: current.comms ?? desired.comms,
  };
  if (next.contentWriteAuthority === undefined) {
    if (desired.contentWriteAuthority) next.contentWriteAuthority = desired.contentWriteAuthority;
    else delete next.contentWriteAuthority;
  }
  return next;
}

/**
 * The default boot policy writer: {@link mergeBootPolicy} over the current signed row,
 * re-signed ONLY when the canonical bytes change (no more one-version-per-restart churn).
 */
export async function authorBootPolicy(
  input: AuthorHivePolicyInput,
  seams: AuthorHivePolicySeams = {},
): Promise<MutateHivePolicyIfChangedResult> {
  const desired = input.policy as unknown as BootPolicyDesired;
  return mutateHivePolicyIfChanged(
    {
      workspaceId: input.workspaceId,
      potHomeSlug: input.potHomeSlug,
      mutate: (current) => mergeBootPolicy(current, desired),
    },
    seams,
  );
}

/**
 * AFTER the hive is created + homed: publish the identity gist (first device only),
 * then announce (invite) + set the owner-only allowlist policy. No-op when `state`
 * is null. Best-effort; never throws.
 */
export async function goSharedHive(state: SharedHiveState | null, deps: HiveShareDeps = {}): Promise<void> {
  if (!state) return;

  const publishIdentity = deps.publishIdentity ?? publishOwnerHiveIdentity;
  const loadKey = deps.loadKey ?? ((id, service) => keychainLoad(id, service));
  const setListing = deps.setListing ?? setHiveListing;
  const authorPolicy =
    deps.authorPolicy ?? ((input: AuthorHivePolicyInput) => authorBootPolicy(input, deps.policySeams));
  const randomSecret = deps.randomSecret ?? (() => randomBytes(32).toString('hex'));
  const canonicalSecret = deps.canonicalSecret ?? (() => bakedCanonicalHiveInvite()?.inviteSecret ?? null);
  const derivePubkey = deps.derivePubkey ?? pubkeyBase64FromDer;

  try {
    // The baked canonical secret is AUTHORITATIVE for the public release: every owner
    // device must announce on the SAME invite topic that fresh installs listen on. It
    // wins over a (possibly drifted) gist secret; only dev builds with no baked invite
    // fall back to the gist secret / a fresh random one.
    const bakedSecret = canonicalSecret();
    let inviteSecret = bakedSecret ?? state.existing?.inviteSecret;

    if (!state.existing) {
      // First device: read the just-minted hive keypair and publish it (+ the canonical
      // invite secret, or a fresh random one for dev builds) to the per-owner private
      // gist, so the owner's NEXT device adopts the same identity.
      const loaded = await loadKey(hiveKeychainId(PAPERCUSP_WORKSPACE_ID, PAPERCUSP_HIVE_SLUG), HIVE_KEYPAIR_SERVICE);
      if (loaded.kind !== 'ok') return; // can't read our own key — skip, retry next boot
      inviteSecret = bakedSecret ?? randomSecret();
      await publishIdentity(
        state.token,
        {
          version: 1,
          privateKeyDer: Buffer.from(loaded.value).toString('base64'),
          pubkeyBase64: derivePubkey(loaded.value),
          inviteSecret,
        },
        state.passphrase,
      );
    } else if (state.existingLegacyPlaintext && state.existing) {
      // WI-2147371: the canonical gist is a pre-fix PLAINTEXT blob that is readable by
      // anyone who learns its URL. Adopting it is not enough — RE-SEAL it in place (the
      // publish path PATCHes the canonical gist), which is what actually retires the
      // live exposure instead of only preventing new ones.
      await publishIdentity(
        state.token,
        { ...state.existing, inviteSecret: state.existing.inviteSecret },
        state.passphrase,
      );
    }
    if (!inviteSecret) return;

    // Go-live on the INVITE topic (not `public` — no global directory / Cupboard
    // leak of the private dogfood repo). This also triggers the harness to JOIN the
    // federation topic (derived from the shared pubkey) so the owner's devices find
    // each other.
    await setListing(
      {
        potId: PAPERCUSP_HIVE_SLUG,
        title: 'Papercusp',
        description: 'Papercusp building itself — shared dogfood hive.',
        visibility: 'invite',
        inviteSecret,
      },
      PAPERCUSP_WORKSPACE_ID,
    );

    // Allowlist admission. Default policy is `open` (admit ANY peer on the topic),
    // which would let a stranger merge — so this allowlist is the ESSENTIAL gate:
    // admit the owner's own GitHub login PLUS each allowlisted teammate (P-007 — what
    // makes the dogfood a real SHARED hive while repos stay private), all authenticated
    // via the device-attestation binding (not spoofable); refuse everyone else.
    const teamAllowlist = deps.teamAllowlist ?? CANONICAL_HIVE_TEAM_ALLOWLIST;
    const membershipMode = deps.membershipMode ?? 'allowlist';
    // P-019: an `open` PUBLIC hive admits anyone (no allowlist gate) and DEFAULTS to author-scoped
    // content writes (P-018/D-012) so a stranger-member can't overwrite/delete others' plans. A
    // private allowlist/approval hive keeps the owner+team gate and 'member' writes (today).
    const contentWriteAuthority =
      deps.contentWriteAuthority ?? (membershipMode === 'open' ? 'author-scoped' : 'member');
    // What THIS boot can compute. The default writer (authorBootPolicy) merges it OVER
    // the current signed policy — union on the allowlist, fill-in-defaults elsewhere —
    // so a boot can only ever ADD admission, never strip what the owner signed (WI-2039866).
    const desired: BootPolicyDesired = {
      membership: membershipMode,
      // The allowlist is only consulted under 'allowlist' mode, but we always carry the owner+team
      // set so flipping modes later doesn't lose it; it is inert under 'open'/'approval'.
      allowlist: Array.from(new Set([state.githubLogin, ...teamAllowlist])),
      ...(contentWriteAuthority === 'author-scoped' ? { contentWriteAuthority } : {}),
      // P-013 (cross-machine-coord-parity-and-trust-2026-07-01): the per-owner
      // dogfood hive is the SAME human's devices — full comms parity by default
      // (steer). Without this, the conservative fallback ('message') would
      // suppress cross-machine wakes between the owner's own machines.
      comms: { defaultTier: 'steer' },
    };
    await authorPolicy({
      workspaceId: PAPERCUSP_WORKSPACE_ID,
      potHomeSlug: PAPERCUSP_HIVE_SLUG,
      policy: desired,
    });
  } catch {
    // best-effort — a failed announce / policy author retries on the next boot.
  }
}

/**
 * Enable sharing on an ALREADY-PRESENT hive — the "go shared on a hive that was
 * created before the flag was on" path (and every subsequent boot). Unlike the
 * create path it does NOT inject a key (the hive's identity is already fixed); it
 * resolves the owner, then publishes (first device) / announces / sets the policy.
 *
 * Guard: if a gist already holds an identity whose pubkey does NOT match THIS hive's
 * actual pubkey, the local hive was created independently and can't retroactively
 * adopt the shared identity — SKIP (announcing a mismatched identity would put this
 * device on a different topic). To converge, that device must be re-created with the
 * flag on so the create path adopts the gist first. This guard is meaningful ONLY on
 * the owner box (only it ever holds the hive's private key to compare); a non-owner
 * member device legitimately has no local key at all (`loadHiveKeyStatus` returns
 * `not_found`) and always proceeds — there is no competing identity for it to check.
 * A genuine key-read/decrypt ERROR is distinct from "no key" and fails closed (WI-762)
 * rather than being silently treated as the safe not_found case.
 *
 * Idempotent + best-effort + flag-gated; a no-op when the flag is off.
 */
export async function shareExistingHive(deps: HiveShareDeps = {}): Promise<void> {
  const isEnabled = deps.isEnabled ?? defaultIsEnabled;
  if (!(await isEnabled())) return;

  const resolveGithub = deps.resolveGithub ?? resolveLocalGithubIdentity;
  const fetchIdentityRecord = deps.fetchIdentityRecord ?? fetchOwnerHiveIdentityRecord;
  const identityPassphrase = deps.identityPassphrase ?? defaultIdentityPassphrase;
  const loadPubkey = deps.loadPubkey ?? loadHiveKeyStatus;

  try {
    const id = await resolveGithub();
    if (id.kind !== 'ok') return;

    // Same fail-closed rule as adoptSharedHiveIdentity: no owner passphrase ⇒ no sealed
    // publish path exists, and there is no plaintext fallback (WI-2147371).
    const passphrase = await identityPassphrase();
    if (!isUsableIdentityPassphrase(passphrase)) return;

    const record = await fetchIdentityRecord(id.token, passphrase);
    const existing = record?.identity ?? null;
    if (existing) {
      const status = await loadPubkey(PAPERCUSP_WORKSPACE_ID, PAPERCUSP_HIVE_SLUG);
      // WI-762: the original guard was `if (localPubkey && localPubkey !== existing.pubkeyBase64) return`
      // — a plain `string | null` collapses "no local key held" (a normal non-owner
      // device; nothing to compare, safe to proceed) and "a local key IS held but
      // failed to load/decrypt" (a real error) into the same falsy `null`, so a
      // read/decrypt failure fell through the `localPubkey &&` short-circuit and
      // silently proceeded to adopt an UNVERIFIED gist identity. Handle the three
      // cases explicitly:
      if (status.kind === 'error') return; // can't verify — fail closed, don't adopt an unverified identity
      if (status.kind === 'ok' && status.pubkeyBase64 !== existing.pubkeyBase64) return; // mismatched local identity — skip
      // status.kind === 'not_found': no local identity to compare (the expected,
      // legitimate state for every non-owner member device) — proceed.
    }
    await goSharedHive(
      {
        githubLogin: id.githubLogin,
        token: id.token,
        existing,
        passphrase,
        existingLegacyPlaintext: record?.legacyPlaintext ?? false,
      },
      deps,
    );
  } catch {
    // best-effort
  }
}
