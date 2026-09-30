/**
 * Encryption-at-rest key sourcing for the credentials-class operator-state
 * tables.
 *
 * Resolution order:
 *   1. `process.env.PAPERCUSP_DB_ENCRYPTION_KEY` — deploy-time override.
 *      Strings are passed verbatim to pgcrypto's pgp_sym_encrypt, at any
 *      length: the operator chose that value deliberately.
 *   2. The key file — `~/.papercusp/db-encryption-key`, relocatable with
 *      `PAPERCUSP_DB_ENCRYPTION_KEY_FILE`. Auto-provisioned on first access
 *      as 32 random bytes, base64-encoded (44 chars), mode 0600.
 *
 * Custody rules for that file (WI-2144851, from the credential-hardening
 * recommendation in docs/audits/security-usability-2026-09-04.md):
 *
 *   - Creation is ONE `O_CREAT|O_EXCL` open at 0600, never write-then-chmod.
 *     The old sequence left the key world-readable in the gap — permanently,
 *     if the process died there — and let two concurrent operators each
 *     generate a different key and race to write it, silently orphaning
 *     whatever the loser had already encrypted. See ensureDbEncryptionKeyFile.
 *   - A file that exists but is too short to be a generated key is treated as
 *     damage, not as a passphrase: the read FAILS CLOSED and leaves the bytes
 *     untouched, because they may be the only route back to the real key.
 *   - A file readable beyond its owner is tightened on load, so a key already
 *     written loosely by an older build is repaired at the next boot.
 *
 * Loss of the key file (with no env override) still means the encrypted
 * credentials are unrecoverable. That is not catastrophic — the affected
 * secrets are re-entered through the UI — and the refusal message above spells
 * out that route, so the recovery instructions reach whoever hits the wall
 * rather than living only in a runbook.
 *
 * The set of tables encrypted is narrow on purpose:
 *   - operator_credentials, operator_voice_credentials  — API keys
 *   - operator_marketplace_token, operator_publish_credentials — tokens
 *   - operator_trust_store — publisher fingerprints + rotation log
 *
 * Each is single-row-per-workspace with a JSONB payload; the encrypted
 * column is `payload_ct BYTEA` alongside the legacy `payload JSONB`. The
 * read helper prefers `payload_ct` when present and falls back to
 * `payload` while the staged backfill is rolling. Write helpers always
 * write `payload_ct`.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const ENV_VAR = 'PAPERCUSP_DB_ENCRYPTION_KEY';
const KEY_FILE_ENV_VAR = 'PAPERCUSP_DB_ENCRYPTION_KEY_FILE';

/** Bytes of entropy in a key this module generates. base64 → 44 characters. */
const GENERATED_KEY_BYTES = 32;

/**
 * Shortest key-file body treated as a key rather than as damage. Deliberately
 * below the 44 characters we generate: the point is to catch a short read or a
 * partial write, not to police an operator who pasted their own material here.
 * Scoped to the FILE only — the env override is passed through verbatim at any
 * length, because that value is supplied deliberately by whoever set it.
 */
const MIN_KEY_FILE_CHARS = 32;

/** Thrown when the key file exists but cannot be trusted as a key. */
export class DbEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbEncryptionKeyError';
  }
}

/**
 * Resolve the key-file path lazily. This MUST NOT run at module-eval time:
 * this module is transitively pulled into the operator-vite renderer bundle
 * (via `operator-state-pg.ts` → `ENCRYPTED_TABLES`), where `node:os` is an
 * empty browser stub and `homedir()` is `undefined` — a top-level call threw
 * "homedir is not a function" on chunk load. Deferring it means importing the
 * module is side-effect-free; the fs/os work only runs server-side when
 * `getDbEncryptionKey()` is actually called.
 *
 * `PAPERCUSP_DB_ENCRYPTION_KEY_FILE` relocates the file — for a mounted secret,
 * a separate volume, or a throwaway path under test.
 */
export function dbEncryptionKeyFilePath(): string {
  const override = process.env[KEY_FILE_ENV_VAR];
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.papercusp', 'db-encryption-key');
}

/**
 * Refuse a key file we cannot trust, rather than encrypting new rows under it.
 *
 * A damaged key is worse than a missing one: rows written under it are
 * undecryptable by the real key, and the damage is silent — everything keeps
 * "working" until someone tries to read a credential back. So this fails closed
 * and leaves the file untouched, because the bytes on disk may still be the only
 * route back to the original key.
 */
function assertUsableKeyFileBody(raw: string, path: string): void {
  if (raw.length >= MIN_KEY_FILE_CHARS) return;
  throw new DbEncryptionKeyError(
    `db encryption key file ${path} holds ${raw.length} characters, under the ${MIN_KEY_FILE_CHARS}-character floor. ` +
      `This module only ever writes generated keys here (${GENERATED_KEY_BYTES} random bytes, base64 = 44 characters), ` +
      'so a shorter body is a TRUNCATED or CORRUPT file rather than a short passphrase. Refusing to use it: encrypting ' +
      'new rows under a damaged key makes them unreadable by the real key and would destroy the last chance to recover ' +
      'the rows already stored. The file has been left exactly as found. Recover by restoring it from backup, or by ' +
      `setting ${ENV_VAR} to the known key (that override is honoured verbatim at any length). If the key is genuinely ` +
      `lost, delete ${path} — a fresh key is generated on the next call and the affected credentials must be re-enter` +
      'ed through the UI, which is the documented cost of losing this file.',
  );
}

/**
 * Tighten a key file that is readable beyond its owner. The pre-2026-09 writer
 * created the file at the umask default and only chmod'd it afterwards, so any
 * key written by a process that died between those two calls is still 0644 on
 * disk. Repair on load rather than only on creation, so existing installs are
 * fixed by the next boot instead of staying exposed forever.
 */
function tightenKeyFilePermissions(path: string): void {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(path).mode & 0o077) === 0) return;
    chmodSync(path, 0o600);
  } catch {
    // Best-effort: an unreadable mode or a filesystem without POSIX permissions
    // must not stop a working key from being used.
  }
}

/**
 * Create the key file if it does not exist, and return the key it holds either
 * way. Exported because it is the provisioning primitive — an installer can call
 * it to place a key ahead of first boot — and because the lost-race branch is by
 * construction unreachable from a single call to `getDbEncryptionKey()`.
 *
 * Creation is a single `O_CREAT|O_EXCL` open at mode 0600. That closes two holes
 * in the previous write-then-chmod sequence:
 *
 *   - the key was world-readable between `writeFileSync` and `chmodSync`, and
 *     stayed that way permanently if the process died in the gap; and
 *   - two processes (this box runs the :3070 and :3170 operators side by side)
 *     could both observe "no key file", generate DIFFERENT keys, and both write.
 *     Last writer won, and every row the loser had already encrypted became
 *     permanently unreadable with nothing reporting it.
 *
 * On EEXIST we adopt the key already on disk. Adopting the winner's key is the
 * only safe resolution: keeping our own would encrypt rows under a key no other
 * process holds.
 */
export function ensureDbEncryptionKeyFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const generated = randomBytes(GENERATED_KEY_BYTES).toString('base64');

  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    // Lost the race, or the caller is re-entering. Read the winner's key.
    const raw = readFileSync(path, 'utf8').trim();
    assertUsableKeyFileBody(raw, path);
    tightenKeyFilePermissions(path);
    return raw;
  }

  try {
    writeSync(fd, `${generated}\n`, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return generated;
}

let _cachedKey: string | null = null;

/**
 * Set of tables whose JSONB payload is encrypted-at-rest. Adding a table
 * here means the helpers in `operator-state-pg.ts` will route reads
 * through `pgp_sym_decrypt` and writes through `pgp_sym_encrypt`. Tables
 * NOT in this set continue to use plaintext JSONB.
 */
export const ENCRYPTED_TABLES = new Set<string>([
  'operator_credentials',
  'operator_voice_credentials',
  'operator_marketplace_token',
  'operator_publish_credentials',
  'operator_trust_store',
  // Migration 047 — search-provider API keys for OMP web_search.
  'operator_search_provider_credentials',
  // Migration 526 — generic third-party integration API keys (owner-ask-batch-2026-07-06 P-002).
  'operator_integration_credentials',
]);

/**
 * Returns the symmetric key as a string. Bootstraps a key file on first
 * call if neither the env var nor the file exists. Cached in-process.
 */
export function getDbEncryptionKey(): string {
  if (_cachedKey !== null) return _cachedKey;

  const fromEnv = process.env[ENV_VAR];
  if (fromEnv && fromEnv.trim()) {
    _cachedKey = fromEnv.trim();
    return _cachedKey;
  }

  const KEY_FILE = dbEncryptionKeyFilePath();
  if (existsSync(KEY_FILE)) {
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    if (raw) {
      assertUsableKeyFileBody(raw, KEY_FILE);
      tightenKeyFilePermissions(KEY_FILE);
      _cachedKey = raw;
      return _cachedKey;
    }
    // Empty or whitespace-only. Unlike a short body, this carries no key material
    // at all, so there is nothing a refusal could preserve — replace it. Unlink
    // first so the exclusive create below remains the only writer.
    rmSync(KEY_FILE, { force: true });
  }

  _cachedKey = ensureDbEncryptionKeyFile(KEY_FILE);
  return _cachedKey;
}

/** Test-only — drop the in-process cache so `getDbEncryptionKey()` re-resolves. */
export function __resetDbEncryptionKeyForTests(): void {
  _cachedKey = null;
}
