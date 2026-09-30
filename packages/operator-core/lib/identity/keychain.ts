/**
 * keychain — OS-level (or encrypted-file fallback) persistence for an
 * Ed25519 private key. Originally the device key (Phase 1b attestation,
 * P-011); now also the per-HIVE identity key (shared-hive-federation P-002),
 * which passes a distinct `serviceName`.
 *
 * Load tiers, tried in order:
 *   1. `secret-tool` (Linux, libsecret / GNOME Keyring)
 *   2. `security` CLI (macOS Keychain)
 *   3. Encrypted-file fallback in PAPERCUSP_IDENTITY_DIR or
 *      ~/.papercusp/identity/ (AES-256-GCM, machine-derived PBKDF2 key from
 *      hostname + username)
 *
 * Stores deliberately converge an available OS backend AND every tier-3 root
 * this runtime can read. macOS can boot headlessly with the login Keychain
 * locked (`security` exits 36), so an OS-only device key would disappear
 * precisely when the sidecar must restart without an Aqua login. A configured
 * shared identity root is also mirrored into the legacy HOME root: a stale or
 * partially-upgraded launcher that omitted PAPERCUSP_IDENTITY_DIR must still
 * load the SAME DER rather than minting a second device identity.
 *
 * Tier 3 is not as strong as an OS keychain but avoids storing the
 * private key in plain text. Acceptable for Phase 1b; a full Tauri
 * stronghold plugin can replace tier 3 if the threat model demands it.
 *
 * Runtime caching (WI-5218): keychainLoad was measured at ~34% of bg-host CPU
 * (2026-07-17 profile) — every epoch-key unwrap on the substrate hot path
 * re-spawned `secret-tool` AND the macOS-only `security` CLI (both ENOENT on a
 * Linux box; fork/exec of a multi-GB process runs on the event-loop thread) and
 * re-ran a 210k-iteration PBKDF2, starving the event loop (loop-governor
 * lag-recoveries 30-50/h). So this module now keeps three in-memory memos:
 * successful/not_found load results (TTL'd; invalidated by store/delete),
 * a single-flight map so concurrent loads of one id share a read, and a
 * backend-availability flag so a missing CLI binary is never re-spawned.
 * io_error/decryption_failed results are NEVER cached (retry must see the disk).
 *
 * Service name for OS keychain entries defaults to `papercusp-device-keypair`;
 * callers (e.g. the hive keypair) pass their own to namespace a different key
 * class. Account name (label attribute) is the keychainId — e.g.
 * `<github_user_id>:<machine-fingerprint>` for a device, `hive:<ws>:<slug>`
 * for a hive. The encrypted-file fallback keys ONLY by keychainId (those id
 * shapes never collide), so existing on-disk device keys keep resolving
 * unchanged regardless of serviceName.
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { execFile as _execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, hostname as getHostname, userInfo } from 'node:os';
import { promisify } from 'node:util';

// Lazy promisify — import-safe in the operator-vite SPA bundle (node:util is
// browser-stubbed; a top-level promisify() call crashes at import → blank page).
// Deferred to first call; never invoked in the browser.
const execFile: (...a: unknown[]) => Promise<{ stdout: string; stderr: string }> = (...a) =>
  (promisify(_execFile) as (...x: unknown[]) => Promise<{ stdout: string; stderr: string }>)(...a);
const pbkdf2Async: (...a: unknown[]) => Promise<Buffer> = (...a) =>
  (promisify(pbkdf2) as (...x: unknown[]) => Promise<Buffer>)(...a);

const SERVICE_NAME = 'papercusp-device-keypair';

/**
 * Request-only env sidecars share the primary operator's identity directory,
 * but they are not identity owners.  A stale child must therefore be able to
 * READ an existing device key while being unable to mint, replace, or delete
 * the device keypair.  Keep this check here as a second line of defence below
 * local-announce-identity's load-only resolver: older bundles can still reach
 * this module through a different call path, and a default-service write must
 * never split the primary/legacy mirrors.
 */
export function isRequestOnlyIdentityProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.PAPERCUSP_ENV_OPERATOR_ID ||
      env.PAPERCUSP_IDENTITY_MODE === 'load-only' ||
      env.PAPERCUSP_REQUEST_ONLY === '1',
  );
}

export function identityWritesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isRequestOnlyIdentityProcess(env);
}

function identityDir(): string {
  return process.env.PAPERCUSP_IDENTITY_DIR || join(homedir(), '.papercusp', 'identity');
}

// AES-256-GCM constants
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 recommendation for PBKDF2-SHA512

// File format: [16-byte salt][12-byte iv][16-byte auth tag][...ciphertext]
const SALT_LEN = 16;
const FILE_HEADER_LEN = SALT_LEN + IV_LEN + TAG_LEN;

export type KeychainError =
  | { kind: 'not_found' }
  | { kind: 'decryption_failed'; reason: string }
  | { kind: 'io_error'; reason: string };

export type KeychainResult<T> = { kind: 'ok'; value: T } | { kind: 'error'; error: KeychainError };

interface KeychainLoadContext {
  platform: NodeJS.Platform;
  identityDirs: string[];
  home: string;
  hostname: string;
  username: string;
  hostnameSource: 'os' | 'seed-override';
}

/**
 * Non-secret derivation context for diagnosing a key that exists but cannot be
 * read in a particular launcher/process context. Never includes key bytes,
 * salts, ciphertext, or the derived AES key.
 */
function keychainLoadContext(): KeychainLoadContext {
  const hostnameOverride = process.env.PAPERCUSP_SEED_REAL_HOSTNAME;
  return {
    platform: process.platform,
    identityDirs: identityReadDirs(),
    home: homedir(),
    hostname: hostnameOverride || getHostname(),
    username: userInfo().username,
    hostnameSource: hostnameOverride ? 'seed-override' : 'os',
  };
}

// ─── load cache / single-flight / backend availability (WI-5218) ─────────────

const LOAD_OK_TTL_MS = 5 * 60_000;
const LOAD_NOT_FOUND_TTL_MS = 30_000; // a key stored by ANOTHER process becomes visible within this bound
const loadCache = new Map<string, { result: KeychainResult<Buffer>; expiresAt: number }>();
const inflightLoads = new Map<string, Promise<KeychainResult<Buffer>>>();
// Bumped by store/delete: an in-flight load that started before the bump must
// not populate the cache with its (possibly pre-mutation) result.
let cacheEpoch = 0;
// Flips false on the first ENOENT for that CLI — a binary that isn't installed
// will not appear mid-process; never spawn it again.
const backendAvailable = { secretTool: true, securityCli: true };

function loadCacheKey(serviceName: string, keychainId: string): string {
  return serviceName + '\0' + keychainId;
}

// Callers receive a fresh Buffer per hit so a mutated result can't poison the cache.
function cloneLoadResult(r: KeychainResult<Buffer>): KeychainResult<Buffer> {
  return r.kind === 'ok' ? { kind: 'ok', value: Buffer.from(r.value) } : r;
}

function invalidateLoadCache(serviceName: string, keychainId: string): void {
  cacheEpoch += 1;
  loadCache.delete(loadCacheKey(serviceName, keychainId));
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Store a private key DER buffer under keychainId. Overwrites any existing
 * entry. An available OS backend receives the key first, then the encrypted
 * file mirror is written unconditionally so a later locked/headless session
 * resolves the exact same device identity.
 */
export async function keychainStore(
  keychainId: string,
  privateKeyDer: Buffer,
  serviceName: string = SERVICE_NAME,
): Promise<void> {
  if (!identityWritesAllowed()) {
    throw new Error(
      'request-only sidecar identity guard: device key writes are load-only; ' +
        'run the primary operator to create or repair the device identity',
    );
  }
  const b64 = privateKeyDer.toString('base64');

  invalidateLoadCache(serviceName, keychainId);
  try {
    const secretToolResult = await trySecretTool('store', keychainId, b64, serviceName);
    if (secretToolResult === null) {
      await trySecurityCli('store', keychainId, b64, serviceName);
    }
    // Do not turn this into a first-success return. Both OS store helpers return
    // the empty string on success, and the historical truthiness checks happened
    // to fall through here. That accidental behavior kept most keys converged but
    // had no recurrence guard; a future "cleanup" could strand the OS-only key in
    // a locked login Keychain and split the device identity again (D-005).
    await fileStore(keychainId, privateKeyDer);
  } finally {
    // A load can begin after the pre-store invalidation and finish while the
    // replacement is still in progress. Invalidate again so that pre-mutation
    // result cannot survive this completed (or failed) write in the cache.
    invalidateLoadCache(serviceName, keychainId);
  }
}

/**
 * Load a private key DER buffer by keychainId. Returns `not_found`
 * when no entry exists (first run → caller should generate a new key).
 */
export async function keychainLoad(
  keychainId: string,
  serviceName: string = SERVICE_NAME,
): Promise<KeychainResult<Buffer>> {
  const key = loadCacheKey(serviceName, keychainId);
  const hit = loadCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return cloneLoadResult(hit.result);
  const pending = inflightLoads.get(key);
  if (pending) return pending.then(cloneLoadResult);

  const epochAtStart = cacheEpoch;
  const p = keychainLoadUncached(keychainId, serviceName)
    .then((r) => {
      if (cacheEpoch === epochAtStart) {
        if (r.kind === 'ok') {
          loadCache.set(key, { result: cloneLoadResult(r), expiresAt: Date.now() + LOAD_OK_TTL_MS });
        } else if (r.error.kind === 'not_found') {
          loadCache.set(key, { result: r, expiresAt: Date.now() + LOAD_NOT_FOUND_TTL_MS });
        }
        // io_error / decryption_failed: uncached — the next call retries the disk.
      }
      return r;
    })
    .finally(() => inflightLoads.delete(key));
  inflightLoads.set(key, p);
  return p.then(cloneLoadResult);
}

async function keychainLoadUncached(
  keychainId: string,
  serviceName: string,
): Promise<KeychainResult<Buffer>> {
  const secTool = await trySecretTool('load', keychainId, '', serviceName);
  if (secTool !== null) {
    if (secTool !== '') return { kind: 'ok', value: Buffer.from(secTool, 'base64') };
    // An available OS backend can legitimately miss this item while the
    // encrypted mirror still has it (most visibly a headless macOS
    // LaunchDaemon whose login Keychain lookup exits 44).  A tier miss means
    // "try the next tier", not "the device key does not exist".
  }

  const security = await trySecurityCli('load', keychainId, '', serviceName);
  if (security !== null) {
    if (security !== '') return { kind: 'ok', value: Buffer.from(security, 'base64') };
    // Same rule as secret-tool: only the final encrypted-file tier can prove
    // that every persisted copy is absent.
  }

  return fileLoad(keychainId);
}

/**
 * Delete a keychain entry. No-op if not found.
 */
export async function keychainDelete(
  keychainId: string,
  serviceName: string = SERVICE_NAME,
): Promise<void> {
  if (!identityWritesAllowed()) {
    throw new Error(
      'request-only sidecar identity guard: device key deletion is load-only; ' +
        'run the primary operator to change the device identity',
    );
  }
  invalidateLoadCache(serviceName, keychainId);
  await trySecretTool('delete', keychainId, '', serviceName);
  await trySecurityCli('delete', keychainId, '', serviceName);
  await fileDelete(keychainId);
}

// ─── secret-tool (Linux / libsecret) ─────────────────────────────────────────

async function trySecretTool(
  op: 'store' | 'load' | 'delete',
  id: string,
  value: string,
  serviceName: string = SERVICE_NAME,
): Promise<string | null> {
  if (!backendAvailable.secretTool) return null;
  try {
    if (op === 'store') {
      await execFile('secret-tool', [
        'store',
        '--label', serviceName + ':' + id,
        'service', serviceName,
        'account', id,
      ], { input: value, timeout: 5000 });
      return '';
    }
    if (op === 'load') {
      const { stdout } = await execFile('secret-tool', [
        'lookup',
        'service', serviceName,
        'account', id,
      ], { timeout: 5000 });
      return stdout.trim();
    }
    if (op === 'delete') {
      await execFile('secret-tool', [
        'clear',
        'service', serviceName,
        'account', id,
      ], { timeout: 5000 });
      return '';
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // ENOENT = binary not installed — remember, so it is never spawned again.
    if ((err as { code?: string }).code === 'ENOENT' || /ENOENT/.test(msg)) {
      backendAvailable.secretTool = false;
      return null;
    }
    if (/not found|command not found/i.test(msg)) return null;
    if (op === 'load' && /No matching secret/i.test(msg)) return '';
    return null;
  }
}

// ─── security CLI (macOS) ─────────────────────────────────────────────────────

async function trySecurityCli(
  op: 'store' | 'load' | 'delete',
  id: string,
  value: string,
  serviceName: string = SERVICE_NAME,
): Promise<string | null> {
  // The `security` CLI exists only on macOS — spawning it anywhere else is a
  // guaranteed ENOENT (and fork/exec cost) per call.
  if (process.platform !== 'darwin' || !backendAvailable.securityCli) return null;
  try {
    if (op === 'store') {
      await execFile('security', [
        'add-generic-password',
        '-s', serviceName,
        '-a', id,
        '-w', value,
        '-U',
      ], { timeout: 5000 });
      return '';
    }
    if (op === 'load') {
      const { stdout } = await execFile('security', [
        'find-generic-password',
        '-s', serviceName,
        '-a', id,
        '-w',
      ], { timeout: 5000 });
      return stdout.trim();
    }
    if (op === 'delete') {
      await execFile('security', [
        'delete-generic-password',
        '-s', serviceName,
        '-a', id,
      ], { timeout: 5000 });
      return '';
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as { code?: string }).code === 'ENOENT' || /ENOENT/.test(msg)) {
      backendAvailable.securityCli = false;
      return null;
    }
    if (/not found|command not found/i.test(msg)) return null;
    // macOS exits 44 when the item doesn't exist
    if (op === 'load' && /The specified item could not be found|exit code 44/i.test(msg)) return '';
    return null;
  }
}

// ─── encrypted-file fallback ──────────────────────────────────────────────────

function encFileName(keychainId: string): string {
  // Sanitize the id to a safe filename component
  const safe = keychainId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return 'keypair-' + safe + '.enc';
}

/**
 * Dirs to READ a key from, in priority order: the configured `identityDir()`
 * first, then the legacy `~/.papercusp/identity` default. A shared-operator
 * switch (PAPERCUSP_IDENTITY_DIR=…/.shared/.papercusp/identity) leaves
 * PRE-switch keys in the legacy default, so reading both makes the owner find
 * its hive keys regardless of which dir they landed in — otherwise
 * `loadHivePubkey` returns null and the hive silently "stays dark" (never
 * announces/serves its content core; content federation breaks with no loud
 * signal). Keys are machine-encrypted (hostname+username PBKDF2), so a key
 * written in either dir decrypts identically on this machine.
 * (shared-hive-member-content-federation D-024; D-023 BUG A — orphaned owner keys.)
 */
function identityReadDirs(): string[] {
  const primary = identityDir();
  const legacy = join(homedir(), '.papercusp', 'identity');
  return primary === legacy ? [primary] : [primary, legacy];
}

async function deriveMachineKey(salt: Buffer): Promise<Buffer> {
  // The release seed cutter re-execs under bwrap with a neutral UTS hostname so
  // RocksDB cannot publish this box's name.  Its child still needs to decrypt
  // the owner's fallback keychain entry, which was encrypted with the REAL
  // hostname before the namespace switch.  The cutter hands that value down in
  // this narrowly named env var; ordinary callers keep the OS hostname path.
  const context = keychainLoadContext();
  const machineSecret = [context.hostname, context.username, 'papercusp-v1'].join(':');
  return pbkdf2Async(machineSecret, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha512');
}

async function atomicWritePrivateFile(path: string, blob: Buffer): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporaryPath, blob, { mode: 0o600, flag: 'wx' });
    // POSIX rename is atomic within one directory: concurrent LaunchDaemon,
    // desktop, and source-preflight readers see the complete previous blob or
    // the complete replacement, never an O_TRUNC/partial ciphertext that is
    // misclassified as decryption_failed.
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

/**
 * Encrypt for ONE mirror and stage it beside its final path without publishing.
 * A staged temp is also a proof that this dir is reachable and writable, which
 * is what lets `fileStore` commit to publishing every mirror or none.
 */
async function fileStageInDir(
  dir: string,
  keychainId: string,
  privateKeyDer: Buffer,
): Promise<{ temporaryPath: string; finalPath: string }> {
  await mkdir(dir, { recursive: true });
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveMachineKey(salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyDer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, iv, authTag, ciphertext]);
  const finalPath = join(dir, encFileName(keychainId));
  const temporaryPath = `${finalPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await writeFile(temporaryPath, blob, { mode: 0o600, flag: 'wx' });
  return { temporaryPath, finalPath };
}

async function fileStore(keychainId: string, privateKeyDer: Buffer): Promise<void> {
  // The read path accepts both a configured shared root and the historical
  // HOME root. The write path must therefore converge BOTH. Writing only the
  // configured root leaves an older launcher (or installed binary) that omits
  // PAPERCUSP_IDENTITY_DIR unable to see the canonical key; it then observes a
  // true not_found and legitimately mints a different device identity into the
  // legacy root. The next configured reader used to prefer that new legacy key
  // and overwrite the good shared mirror — the live EI-203928 recurrence.
  //
  // Converging them in a bare sequential loop is NOT sufficient, and no rogue
  // writer is needed to split them (EI-21987155936742109): each file write is
  // atomic on its own, but the PAIR was not. A crash, kill, ENOSPC, EACCES, or
  // an unmounted share between the two writes published a fresh key into the
  // configured root while the legacy root kept the ATTESTED one — the split
  // `fileLoad` then refuses forever, leaving every P2P substrate unbooted (live
  // on Avis-iMac.local 2026-08-31, a recurrence of resolved WI-2018). So STAGE
  // every mirror first: a staged temp proves that dir writable, and only then
  // do the renames run. A store that cannot reach every mirror now publishes
  // none and leaves the last converged identity intact.
  const dirs = identityReadDirs();
  const staged: Array<{ temporaryPath: string; finalPath: string }> = [];
  try {
    for (const dir of dirs) {
      staged.push(await fileStageInDir(dir, keychainId, privateKeyDer));
    }
  } catch (err) {
    await Promise.all(staged.map((s) => unlink(s.temporaryPath).catch(() => {})));
    throw err;
  }

  // Every mirror is proven writable. Publish; if a rename still fails part way,
  // restore the mirrors already replaced so the pair cannot be left divergent.
  const priorBlobs = await Promise.all(staged.map((s) => readFile(s.finalPath).catch(() => null)));
  const published = new Set<number>();
  try {
    for (let i = 0; i < staged.length; i++) {
      await rename(staged[i].temporaryPath, staged[i].finalPath);
      published.add(i);
    }
  } catch (err) {
    for (let i = 0; i < staged.length; i++) {
      if (!published.has(i)) {
        await unlink(staged[i].temporaryPath).catch(() => {});
        continue;
      }
      const before = priorBlobs[i];
      if (before) await atomicWritePrivateFile(staged[i].finalPath, before).catch(() => {});
      else await unlink(staged[i].finalPath).catch(() => {});
    }
    throw err;
  }
}

async function fileLoadFromDir(dir: string, name: string): Promise<KeychainResult<Buffer>> {
  let blob: Buffer;
  try {
    blob = await readFile(join(dir, name));
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    return code === 'ENOENT'
      ? { kind: 'error', error: { kind: 'not_found' } }
      : {
          kind: 'error',
          error: {
            kind: 'io_error',
            reason: `${String(err)}; context=${JSON.stringify(keychainLoadContext())}`,
          },
        };
  }
  if (blob.length < FILE_HEADER_LEN) {
    return {
      kind: 'error',
      error: {
        kind: 'decryption_failed',
        reason: `file too short; context=${JSON.stringify(keychainLoadContext())}`,
      },
    };
  }

  const salt = blob.subarray(0, SALT_LEN);
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = blob.subarray(SALT_LEN + IV_LEN, FILE_HEADER_LEN);
  const ciphertext = blob.subarray(FILE_HEADER_LEN);
  const key = await deriveMachineKey(salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(authTag);
  try {
    return { kind: 'ok', value: Buffer.concat([decipher.update(ciphertext), decipher.final()]) };
  } catch {
    return {
      kind: 'error',
      error: {
        kind: 'decryption_failed',
        reason:
          'auth tag mismatch — key rotated or file corrupted; ' +
          `context=${JSON.stringify(keychainLoadContext())}`,
      },
    };
  }
}

async function fileLoad(keychainId: string): Promise<KeychainResult<Buffer>> {
  const name = encFileName(keychainId);
  const dirs = identityReadDirs();
  const primary = await fileLoadFromDir(dirs[0], name);
  if (dirs.length === 1) return primary;

  const legacy = await fileLoadFromDir(dirs[1], name);
  if (primary.kind === 'ok' && legacy.kind === 'ok') {
    if (!primary.value.equals(legacy.value)) {
      // Both files decrypt, so first-success ordering CANNOT establish which
      // identity is canonical. Legacy is not inherently older: a stale launcher
      // that omitted PAPERCUSP_IDENTITY_DIR can mint a brand-new legacy key.
      // Never choose one or mutate either from a read path. `io_error` is the
      // fail-closed class loadOrGenerateDeviceKeypair refuses to regenerate on.
      return {
        kind: 'error',
        error: {
          kind: 'io_error',
          reason:
            'configured and legacy encrypted identity mirrors disagree — refusing to select or mutate either; ' +
            `context=${JSON.stringify(keychainLoadContext())}`,
        },
      };
    }
    return primary;
  }
  if (primary.kind === 'ok') return primary;
  if (legacy.kind === 'ok') return legacy;

  // Prefer the most-informative error: a found-but-broken file over an I/O
  // failure, and either over a plain miss.
  for (const result of [primary, legacy]) {
    if (result.error.kind === 'decryption_failed') return result;
  }
  for (const result of [primary, legacy]) {
    if (result.error.kind === 'io_error') return result;
  }
  return { kind: 'error', error: { kind: 'not_found' } };
}

async function fileDelete(keychainId: string): Promise<void> {
  // WI-2018: delete from EVERY dir `fileLoad` reads (primary + legacy), not just the
  // configured primary. Deleting only one copy left a legacy-dir copy that `fileLoad`
  // silently RESURRECTED on the next load — so a poisoned/divergent key survived its
  // own cleanup (the split-device-identity class; proven live on the mac VM
  // 2026-07-03, where a poison-era epoch key persisted in the second identity root).
  const name = encFileName(keychainId);
  for (const dir of identityReadDirs()) {
    try {
      await unlink(join(dir, name));
    } catch {
      // ignore — not_found is fine for delete
    }
  }
}

/**
 * WI-2009 / wake-#5742 diagnostics: probe WHICH tier(s) currently hold
 * `keychainId` — READ-ONLY, never mutates, never throws. `file` reports the
 * first dir (primary | legacy) holding a blob for the id (existence, not
 * decryptability). Used by the epoch-boot instrumentation to make the
 * split-device-identity class visible (presence tier vs epoch tier resolving
 * different keys because a tier is unreadable in one process context).
 */
export async function keychainProbeTiers(
  keychainId: string,
  serviceName: string = SERVICE_NAME,
): Promise<{
  secretTool: boolean;
  securityCli: boolean;
  file: 'primary' | 'legacy' | null;
  mirrorsDiverged: boolean;
}> {
  let secretTool = false;
  let securityCli = false;
  try {
    const st = await trySecretTool('load', keychainId, '', serviceName);
    secretTool = st !== null && st !== '';
  } catch {
    /* probe only */
  }
  try {
    const sec = await trySecurityCli('load', keychainId, '', serviceName);
    securityCli = sec !== null && sec !== '';
  } catch {
    /* probe only */
  }
  // This probe used to stop at the first mirror that read, so a box whose
  // mirrors had SPLIT still reported a healthy `file:'primary'` — structurally
  // blind to the one recurrence it was added to diagnose. Read EVERY mirror and
  // report the divergence itself, so the condition is visible while the box is
  // live instead of only as a fail-closed load much later
  // (EI-21987155936742109, recurrence of WI-2018).
  let file: 'primary' | 'legacy' | null = null;
  const decrypted: Buffer[] = [];
  const name = encFileName(keychainId);
  const dirs = identityReadDirs();
  for (let i = 0; i < dirs.length; i++) {
    const result = await fileLoadFromDir(dirs[i], name);
    // Present == the bytes were readable, whether or not they decrypt; that is
    // the same condition the previous existence check reported.
    const present = result.kind === 'ok' || result.error.kind === 'decryption_failed';
    if (!present) continue;
    if (file === null) file = i === 0 ? 'primary' : 'legacy';
    if (result.kind === 'ok') decrypted.push(result.value);
  }
  const mirrorsDiverged = decrypted.length > 1 && decrypted.some((d) => !d.equals(decrypted[0]));
  return { secretTool, securityCli, file, mirrorsDiverged };
}
