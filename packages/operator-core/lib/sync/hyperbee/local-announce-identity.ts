/**
 * local-announce-identity — resolve THIS peer's identity for the Model B
 * signed announce (Stage 4b).
 *
 * The announce binds our writable log core to our device identity:
 *   { device_pubkey, github_user_id, github_login, log_core_key, sig }
 *
 * The log core key comes from the boot's own log; the rest of the identity is
 * resolved here:
 *   - github_user_id / github_login — the locally-authenticated GitHub user
 *     (gh CLI token → `GET /user`), the channel-1/channel-2 inputs the remote
 *     peer needs to verify our binding. Resolved FIRST, because the device
 *     keychain id is keyed by this user id (see below).
 *   - keychainId / device_pubkey — the device Ed25519 keypair, loaded (or
 *     generated, idempotent) from the OS keychain under the CANONICAL per-user
 *     keychain id `<github_user_id>:<machine-fingerprint>` (built by the shared
 *     `resolveDeviceKeychainId`). This is the SAME id the join path's
 *     binding/contributor-file publish signs under — so the announced
 *     `device_pubkey` matches the key the published contributor file was
 *     signed with, and the remote peer's read-admission channel-2 verify
 *     (`verifyContributorFileSignature`) passes. Using a DIFFERENT id here
 *     (e.g. a fixed `'papercusp-device'`) would advertise a key the remote's
 *     contributor file was NOT signed with, failing every channel-2 check so
 *     no log is ever admitted. The pubkey is the SAME raw-32-byte base64 the
 *     two-channel binding uses.
 *
 * Throws when the CHANNEL-1 identity can't be resolved AND no usable cache exists (no
 * gh auth / keychain failure on a device that has never successfully announced before
 * — see `identityFromCache` below, which transparently falls back to the persisted
 * `~/.papercusp/local-announce-identity.json` on a re-auth failure once one exists).
 * boot.ts's swarm-join catch treats an actual throw as "stay local-only" — a peer that
 * truly can't announce simply doesn't federate. A SUSTAINED stall in that state is
 * escalated by federation-join-stall-watchdog.ts (WI-757 part b), which reads the
 * `swarm_join_failed` boot-history event that catch records.
 *
 * A CHANNEL-2 failure does NOT throw (WI-38355): when the attestation gist can't be
 * resolved the identity degrades to `attestationGistId: ''` and each consumer decides
 * what an unattested identity means. See `resolveLocalAnnounceIdentity` below for the
 * full argument and for what deliberately did NOT change (`ingestAnnounce`'s
 * verified-only admission).
 */

import { loadOrGenerateDeviceKeypair, ensureAttestationGist } from '../../identity/attest';
import { resolveLocalGithubIdentity } from '../../identity/resolve-local-github-identity';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { getGhAuthToken } from '../../identity/gh-token';
import { isRequestOnlyIdentityProcess, keychainLoad } from '../../identity/keychain';
import { pubkeyBase64FromDer } from '../../identity/ed25519';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface LocalAnnounceIdentity {
  keychainId: string;
  /** Raw 32-byte Ed25519 device pubkey, base64 (== binding device_pubkey). */
  devicePubkeyBase64: string;
  githubUserId: number;
  githubLogin: string;
  /** This device's attestation gist id — carried on the signed announce so a
   *  remote peer admits via `verifyAttestation` with NO shared-repo read
   *  (write-free join, `non-collaborator-join-fork-pr-2026-06-02`). */
  attestationGistId: string;
}

/** Inputs the gist resolver receives — this peer's resolved device identity. */
export interface ResolveAttestationGistArgs {
  keychainId: string;
  pubkeyBase64: string;
  githubUserId: number;
  githubLogin: string;
}

export interface ResolveLocalAnnounceIdentityOpts {
  /** 64-hex Hypercore key of our writable log (from boot's own log). */
  logCoreKeyHex: string;
  /**
   * Override the keychain id (tests / multi-identity dev). When omitted the
   * canonical `<github_user_id>:<machine-fingerprint>` id is derived from the
   * resolved gh user via `resolveDeviceKeychainId`.
   */
  keychainId?: string;
  /**
   * Resolve the locally-authenticated GitHub user. Defaults to the gh-token
   * Octokit `users.getAuthenticated()`. Injectable for tests.
   */
  resolveGithubUser?: () => Promise<{ id: number; login: string }>;
  /** Override the keypair loader (tests). */
  loadKeypair?: (keychainId: string) => Promise<{ keychainId: string; pubkeyBase64: string }>;
  /**
   * Override the keychain-id builder (tests). Defaults to the canonical
   * `resolveDeviceKeychainId`.
   */
  buildKeychainId?: (githubUserId: number) => string;
  /**
   * Resolve this device's attestation gist id. Defaults to the idempotent
   * find-or-create over the gh-token (`ensureAttestationGist`). Injectable for
   * tests (and for any path that already holds the gist id).
   */
  resolveAttestationGistId?: (args: ResolveAttestationGistArgs) => Promise<string>;
  /**
   * Persisted last-good identity cache. Production defaults to
   * `~/.papercusp/local-announce-identity.json`; tests with injected deps
   * default to disabled unless they pass a path explicitly.
   */
  cachePath?: string | false;
  /**
   * WI-38355 — notified when the CHANNEL-2 attestation gist could not be
   * resolved and the identity degraded to `attestationGistId: ''` instead of
   * throwing. Defaults to a warn-once-per-keychain `console.warn`; pass a
   * no-op to silence it (a per-tick caller), or your own reporter.
   */
  onAttestationUnavailable?: (args: { keychainId: string; cause: unknown }) => void;
  /**
   * Identity lifecycle for this caller. `load-only` is the request-only
   * sidecar contract: return an already-cached, keychain-verified identity or
   * fail closed WITHOUT GitHub I/O, gist creation, key generation, cache
   * writes, or encrypted-mirror writes. Defaults from
   * PAPERCUSP_IDENTITY_MODE; ordinary substrate owners remain `authoring`.
   */
  identityMode?: 'authoring' | 'load-only';
}

/**
 * Bundled-sidecar capability marker checked by env-operator-launcher before it
 * starts (or keeps) a request-only bundle. An old bundle that lacks this exact
 * marker predates the load-only behavior and is not admitted to the shared
 * identity directory.
 */
export const REQUEST_ONLY_IDENTITY_GUARD_V1 =
  'papercusp-request-only-identity-load-only-v1';

export interface LocalHiveMemberAnnounceIdentityMember {
  githubUserId: number;
  githubUsername: string;
  deviceAttestations: Array<{
    device_pubkey?: string | null;
    gist_id?: string | null;
  }>;
  revokedPubkeys?: string[];
}

export interface ResolveLocalAnnounceIdentityFromHiveMembersOpts {
  members: LocalHiveMemberAnnounceIdentityMember[];
  /**
   * Load an EXISTING keypair by keychain id. The default deliberately does not
   * generate a key: a local membership fallback is valid only when the durable
   * Hive membership row already names this device's existing pubkey.
   */
  loadExistingKeypair?: (
    keychainId: string,
  ) => Promise<{ keychainId: string; pubkeyBase64: string } | null>;
  buildKeychainId?: (githubUserId: number) => string;
  /**
   * WI-10003109: source for a real gist when the membership row's attestation for
   * this device carries an empty one. Defaults to the persisted, keychain-verified
   * identity cache (no GitHub I/O). Injected-dependency calls default to none, so
   * tests stay hermetic.
   */
  loadCachedIdentity?: () => Promise<LocalAnnounceIdentity | null>;
}

interface CachedLocalAnnounceIdentity extends LocalAnnounceIdentity {
  version: 1;
  savedAt: number;
}

/**
 * A successful announce identity is machine-local and stable, but this resolver is
 * reached by several idempotent boot/directory reconciliation paths. Treat a recent,
 * keychain-verified persisted value as the happy path so those retries do not turn
 * into an unbounded GitHub `GET /user` + gist-list loop. A short TTL preserves prompt
 * pickup of a changed gh login; older entries remain available only through the
 * existing outage fallback below.
 */
const FRESH_IDENTITY_CACHE_TTL_MS = 60_000;

function defaultCachePath(): string {
  return process.env.PAPERCUSP_ANNOUNCE_IDENTITY_CACHE ||
    join(homedir(), '.papercusp', 'local-announce-identity.json');
}

function cachePathFor(opts: ResolveLocalAnnounceIdentityOpts): string | false {
  if (opts.cachePath !== undefined) return opts.cachePath;
  // Injected dependency tests should stay hermetic by default.
  if (
    opts.resolveGithubUser ||
    opts.loadKeypair ||
    opts.buildKeychainId ||
    opts.resolveAttestationGistId
  ) {
    return false;
  }
  return defaultCachePath();
}

function isCachedIdentity(value: unknown): value is CachedLocalAnnounceIdentity {
  const v = value as Partial<CachedLocalAnnounceIdentity> | null;
  return Boolean(
    v &&
      v.version === 1 &&
      typeof v.savedAt === 'number' &&
      Number.isFinite(v.savedAt) &&
      typeof v.keychainId === 'string' &&
      v.keychainId &&
      typeof v.devicePubkeyBase64 === 'string' &&
      v.devicePubkeyBase64 &&
      typeof v.githubUserId === 'number' &&
      Number.isFinite(v.githubUserId) &&
      typeof v.githubLogin === 'string' &&
      v.githubLogin &&
      typeof v.attestationGistId === 'string' &&
      v.attestationGistId,
  );
}

async function readCachedIdentity(path: string | false): Promise<CachedLocalAnnounceIdentity | null> {
  if (!path) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isCachedIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCachedIdentity(
  path: string | false,
  identity: LocalAnnounceIdentity,
): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    const body: CachedLocalAnnounceIdentity = { version: 1, savedAt: Date.now(), ...identity };
    await writeFile(path, JSON.stringify(body, null, 2), 'utf8');
  } catch {
    // Cache is a resilience aid; never fail identity resolution because it could
    // not be written.
  }
}

async function identityFromCache(
  path: string | false,
  // Load-only or load-or-generate — either shape is accepted; a null/throw result
  // is treated as "no verifiable keypair" (returns null), never an error.
  loadKeypair: (keychainId: string) => Promise<{ keychainId: string; pubkeyBase64: string } | null>,
  maxAgeMs?: number,
): Promise<LocalAnnounceIdentity | null> {
  const cached = await readCachedIdentity(path);
  if (!cached) return null;
  if (maxAgeMs !== undefined) {
    const ageMs = Date.now() - cached.savedAt;
    if (ageMs < 0 || ageMs >= maxAgeMs) return null;
  }
  const keypair = await loadKeypair(cached.keychainId).catch(() => null);
  if (!keypair || keypair.pubkeyBase64 !== cached.devicePubkeyBase64) return null;
  return {
    keychainId: cached.keychainId,
    devicePubkeyBase64: cached.devicePubkeyBase64,
    githubUserId: cached.githubUserId,
    githubLogin: cached.githubLogin,
    attestationGistId: cached.attestationGistId,
  };
}

/**
 * Load THIS peer's announce identity from the persisted cache ONLY — never
 * resolving gh / generating a key. Reads `~/.papercusp/local-announce-identity.json`
 * (the artifact `resolveLocalAnnounceIdentity` writes once the substrate has booted +
 * announced) and re-verifies it against the OS keychain: the cached
 * `devicePubkeyBase64` must still match a key present under the cached `keychainId`.
 *
 * Returns null on a cold box (never announced), a cache/keychain mismatch (rotated
 * key), or any read failure — the caller treats null as "no local device signer
 * available" and degrades gracefully.
 *
 * This is the DECOUPLED reuse seam for the SAME device identity boot.ts signs
 * announces with (F1-6/P-014 elite outcome-signing): any control-plane caller that
 * needs to sign AS this peer (e.g. the gym cycle's elite-outcome signer) resolves it
 * here without coupling to the live substrate object graph, and gets a pubkey a
 * receiver's `resolveAuthorDevice(ourLog)` provably matches (anti-lift parity).
 */
export async function loadCachedLocalAnnounceIdentity(
  cachePath: string | false = defaultCachePath(),
  // LOAD-ONLY keypair verifier (tests inject); defaults to the real keychain read.
  loadKeypair: (
    keychainId: string,
  ) => Promise<{ keychainId: string; pubkeyBase64: string } | null> = loadExistingDeviceKeypair,
): Promise<LocalAnnounceIdentity | null> {
  return identityFromCache(cachePath, loadKeypair);
}

async function defaultResolveGithubUser(): Promise<{ id: number; login: string }> {
  // Reuse the token-keyed /user cache shared by the rest of the app. Calling the
  // lower-level getAuthenticatedGithubUser() here bypassed that cache and let
  // repeated directory wiring consume the entire 5,000-request core window.
  const identity = await resolveLocalGithubIdentity();
  if (identity.kind !== 'ok') {
    throw new Error('local-announce-identity: gh not authenticated (run `gh auth login`)');
  }
  return { id: identity.githubUserId, login: identity.githubLogin };
}

async function defaultResolveAttestationGistId(
  args: ResolveAttestationGistArgs,
): Promise<string> {
  const tok = await getGhAuthToken();
  if (tok.kind !== 'ok') {
    throw new Error('local-announce-identity: gh token required to resolve attestation gist');
  }
  return ensureAttestationGist({
    keychainId: args.keychainId,
    pubkeyBase64: args.pubkeyBase64,
    deviceLabel: `papercusp-${args.githubLogin}`,
    githubUserId: args.githubUserId,
    githubLogin: args.githubLogin,
    token: tok.token,
  });
}

async function loadExistingDeviceKeypair(
  keychainId: string,
): Promise<{ keychainId: string; pubkeyBase64: string } | null> {
  const loaded = await keychainLoad(keychainId);
  if (loaded.kind !== 'ok') return null;
  return { keychainId, pubkeyBase64: pubkeyBase64FromDer(loaded.value) };
}

/**
 * Offline/durable fallback for Hive federation startup. If this device is
 * already present in the local `hive_members` projection, its membership row
 * carries the GitHub id/login, device pubkey, and optional gist id needed to
 * build a signed announce. This lets known Hive members rejoin the swarm during
 * a GitHub outage without weakening admission: peers still verify the announce
 * signature and admit only if their own `hive_members` row names the same device
 * pubkey (or, for unknown peers, the normal gist path still applies).
 *
 * WI-10003109: a row can carry an EMPTY gist for this device (the owner's own row
 * written at pot creation, before its gist existed). Announcing that empty gist
 * makes every gist-gated joiner reject the owner as binding_invalid, although the
 * device has a valid gist in its identity cache. So an empty gist is filled from
 * the cache when the cache names the same device and GitHub user.
 */
export async function resolveLocalAnnounceIdentityFromHiveMembers(
  opts: ResolveLocalAnnounceIdentityFromHiveMembersOpts,
): Promise<LocalAnnounceIdentity | null> {
  const buildKeychainId = opts.buildKeychainId ?? resolveDeviceKeychainId;
  const loadExistingKeypair = opts.loadExistingKeypair ?? loadExistingDeviceKeypair;
  const loadCachedIdentity =
    opts.loadCachedIdentity ??
    (opts.loadExistingKeypair || opts.buildKeychainId
      ? async () => null
      : () => loadCachedLocalAnnounceIdentity());

  for (const member of opts.members) {
    const keychainId = buildKeychainId(member.githubUserId);
    const keypair = await loadExistingKeypair(keychainId).catch(() => null);
    if (!keypair) continue;
    const revoked = new Set(member.revokedPubkeys ?? []);
    for (const attestation of member.deviceAttestations ?? []) {
      const devicePubkey = attestation?.device_pubkey;
      if (!devicePubkey || revoked.has(devicePubkey)) continue;
      if (devicePubkey !== keypair.pubkeyBase64) continue;
      let attestationGistId = attestation.gist_id ?? '';
      if (!attestationGistId) {
        const cached = await loadCachedIdentity().catch(() => null);
        if (
          cached?.attestationGistId &&
          cached.devicePubkeyBase64 === keypair.pubkeyBase64 &&
          cached.githubUserId === member.githubUserId
        ) {
          attestationGistId = cached.attestationGistId;
        }
      }
      return {
        keychainId,
        devicePubkeyBase64: keypair.pubkeyBase64,
        githubUserId: member.githubUserId,
        githubLogin: member.githubUsername,
        attestationGistId,
      };
    }
  }

  return null;
}

/** Warn-once-per-keychain guard for the WI-38355 channel-2 degrade. A gist
 *  outage is an ACCOUNT-level condition (see below), so every retry degrades
 *  identically and an unguarded warn would spam a per-tick announce loop. */
const warnedAttestationUnavailable = new Set<string>();

function defaultOnAttestationUnavailable({ keychainId, cause }: { keychainId: string; cause: unknown }) {
  if (warnedAttestationUnavailable.has(keychainId)) return;
  warnedAttestationUnavailable.add(keychainId);
  console.warn(
    `[local-announce-identity] attestation gist unavailable for ${keychainId} — announcing UNATTESTED ` +
      `(attestation_gist_id: ''). Channel-1 (Ed25519 signature) is unaffected; peers that require ` +
      `channel-2 will not admit this descriptor until the gist resolves. Cause: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

/**
 * Resolve the local peer's announce identity. Throws when the CHANNEL-1 inputs
 * (gh user, device keypair) can't be resolved, so the caller's swarm-join catch
 * keeps the harness local-only.
 *
 * WI-38355 — a CHANNEL-2 failure (the attestation gist) is NOT fatal. It
 * degrades to `attestationGistId: ''` and lets each consumer decide what an
 * unattested identity means, because:
 *   - the wire format has always tolerated it: `verifyHiveAnnounce`
 *     (hive-announce.ts:254) requires only `typeof attestation_gist_id ===
 *     'string'`, and its own doc states the channel-1/channel-2 split;
 *   - `resolveLocalAnnounceIdentityFromHiveMembers` (above) ALREADY returns
 *     `attestation.gist_id ?? ''`, and boot.ts:4355 already PREFERS that
 *     resolver — so an empty-gist announce is an existing live code path here,
 *     not a new state this introduces;
 *   - the throw bought no security. Every downstream verifier still applies its
 *     own channel-2 policy (`HiveDirectory.ingestAnnounce`, hive-directory.ts,
 *     rejects `unattested` — a DELIBERATE trust boundary, D-001 verified-only,
 *     deliberately left untouched here). Refusing to resolve locally only moved
 *     the failure earlier and took unrelated capability down with it.
 *
 * What it took down: `wireHiveDirectoryForWorkspace` (hive-directory-boot.ts:462)
 * calls this as the FIRST statement in its try, so the rethrow landed in the
 * catch at :518 and abandoned the ENTIRE directory boot-join — no topic join, no
 * transport, no descriptor for ANY owned hive. A GitHub account with no verified
 * email cannot create gists at all (422), which is account-level and therefore
 * permanent under retry.
 */
export async function resolveLocalAnnounceIdentity(
  opts: ResolveLocalAnnounceIdentityOpts,
): Promise<LocalAnnounceIdentity> {
  if (!opts.logCoreKeyHex) {
    throw new Error('resolveLocalAnnounceIdentity: logCoreKeyHex required');
  }
  const identityMode =
    opts.identityMode ??
    (isRequestOnlyIdentityProcess(process.env) ? 'load-only' : 'authoring');
  const loadKeypair = opts.loadKeypair ?? loadOrGenerateDeviceKeypair;
  const resolveUser = opts.resolveGithubUser ?? defaultResolveGithubUser;
  const buildKeychainId = opts.buildKeychainId ?? resolveDeviceKeychainId;
  const cachePath = cachePathFor(opts);

  if (identityMode === 'load-only') {
    // This branch is intentionally the whole request-only identity surface.
    // `identityFromCache` reads the cache and keychain only. It never calls the
    // user/gist resolvers and the verifier is load-only unless a test supplied
    // an explicit loader. In particular, never fall through to
    // loadOrGenerateDeviceKeypair: a miss must disable federation in this
    // request-serving process, not mint a second machine identity.
    const cached = await identityFromCache(
      cachePath,
      opts.loadKeypair ?? loadExistingDeviceKeypair,
    );
    if (cached) return cached;
    throw new Error(
      `${REQUEST_ONLY_IDENTITY_GUARD_V1}: no cached, keychain-verified identity; ` +
        'request-only sidecars may load identity but never create or repair it',
    );
  }

  // This is deliberately before every GitHub operation. The cache is accepted on
  // the success path only while fresh and only after the current keychain still
  // proves the same device pubkey; a stale value continues to be fallback-only.
  const freshCached = await identityFromCache(
    cachePath,
    loadKeypair,
    FRESH_IDENTITY_CACHE_TTL_MS,
  );
  if (freshCached) return freshCached;

  // Resolve the gh user FIRST — the canonical device keychain id is keyed by
  // the user's id (`<github_user_id>:<machine-fingerprint>`), the SAME id the
  // join path signs the contributor file under. An explicit `keychainId`
  // override wins (tests / multi-identity dev).
  let user: { id: number; login: string };
  try {
    user = await resolveUser();
  } catch (e) {
    const cached = await identityFromCache(cachePath, loadKeypair);
    if (cached) return cached;
    throw e;
  }
  const keychainId = opts.keychainId ?? buildKeychainId(user.id);
  const keypair = await loadKeypair(keychainId);
  const resolveGist = opts.resolveAttestationGistId ?? defaultResolveAttestationGistId;
  let attestationGistId: string;
  try {
    attestationGistId = await resolveGist({
      keychainId,
      pubkeyBase64: keypair.pubkeyBase64,
      githubUserId: user.id,
      githubLogin: user.login,
    });
  } catch (e) {
    // A cached identity for THIS device carries a real, previously-resolved
    // gist — strictly better than degrading, so it still wins.
    const cached = await identityFromCache(cachePath, loadKeypair);
    if (
      cached &&
      cached.keychainId === keychainId &&
      cached.devicePubkeyBase64 === keypair.pubkeyBase64 &&
      cached.githubUserId === user.id
    ) {
      return cached;
    }
    // WI-38355: channel-2 degrade, NOT a throw. Deliberately NOT persisted to
    // the cache — the cache means "an identity we fully resolved once", and
    // writing an empty gist into it would make the offline path (the
    // resolveUser catch above, which does no match check) hand back an
    // unattested identity for a device that may well have a real one.
    (opts.onAttestationUnavailable ?? defaultOnAttestationUnavailable)({ keychainId, cause: e });
    return {
      keychainId,
      devicePubkeyBase64: keypair.pubkeyBase64,
      githubUserId: user.id,
      githubLogin: user.login,
      attestationGistId: '',
    };
  }

  const identity = {
    keychainId,
    devicePubkeyBase64: keypair.pubkeyBase64,
    githubUserId: user.id,
    githubLogin: user.login,
    attestationGistId,
  };
  await writeCachedIdentity(cachePath, identity);
  return identity;
}
