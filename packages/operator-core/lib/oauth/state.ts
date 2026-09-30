/**
 * OAuth state token — HMAC-signed URL parameter, single-use server-side nonce.
 *
 * Spec: /docs/snapshots/oauth-integration#state-design.
 *
 * State lives in the URL `state` param end-to-end (no cookies). Each
 * concurrent OAuth flow has independent state. The state token claims:
 *   { plugin, harness, field, providerHost, exp, nonce }
 *
 * The nonce is server-side single-use: the first callback consumes it
 * and subsequent callbacks with the same nonce are rejected. Per-flow private
 * context (for example a PKCE verifier) is stored on that nonce row and never
 * serialized into the browser-visible state token.
 *
 * Storage: `harness_shared.oauth_nonces` (PG, migration 030). Was
 * previously a process-local Map, lost across restarts and incompatible
 * with multi-instance deploys. Per the prior module doc's V1.1 TODO.
 *
 * Both helpers are now async because the nonce read/write is a PG
 * round-trip; callers in the two oauth routes were updated.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org/connection';

const STATE_VERSION = 1 as const;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

/** Server-only values carried from authorize start to callback. */
export type OAuthFlowPrivateContext = Readonly<Record<string, string>>;

export interface SignStateOptions {
  ttlMs?: number;
  privateContext?: OAuthFlowPrivateContext;
}

export interface StateClaims {
  plugin: string;
  harness: string;
  field: string;
  providerHost: string;
  /** Provider id (e.g. `github`). */
  provider: string;
}

interface SignedState extends StateClaims {
  v: typeof STATE_VERSION;
  exp: number;
  nonce: string;
}

const SECRET_ENV_VAR = 'PAPERCUSP_OAUTH_STATE_SECRET';
const KEY_FILE_ENV_VAR = 'PAPERCUSP_OAUTH_STATE_KEY_FILE';
const MIN_SECRET_CHARS = 32;
const GENERATED_KEY_BYTES = 32;

/** Bounded publish/adopt passes. Each loses at most one link() race, so this is
 *  a cap on contention, not a timeout — 8 is far beyond the worker count. */
const KEY_PUBLISH_ATTEMPTS = 8;
/** Grace given to a possible in-flight writer before an EMPTY key file is
 *  judged stale. Only reachable for a file this module did not publish. */
const EMPTY_KEY_GRACE_MS = 50;

/**
 * Where the per-INSTALL signing key lives. `homedir()` is called lazily, never
 * at module scope: this module is reachable from bundles where `node:os` is an
 * empty browser stub and `homedir` is not a function, and a top-level call
 * would throw on chunk load. Mirrors `db-encryption.ts`.
 *
 * `PAPERCUSP_OAUTH_STATE_KEY_FILE` relocates the file — for a mounted secret,
 * a separate volume, or a throwaway path under test.
 */
export function oauthStateKeyFilePath(): string {
  const override = process.env[KEY_FILE_ENV_VAR];
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.papercusp', 'oauth-state-key');
}

/**
 * Repair a key file readable beyond its owner, on LOAD rather than only on
 * creation, so an install whose key was written by an older/interrupted writer
 * is fixed by the next boot instead of staying exposed forever.
 */
function tightenKeyFilePermissions(path: string): void {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(path).mode & 0o077) === 0) return;
    chmodSync(path, 0o600);
  } catch {
    // Best-effort: an unreadable mode, or a filesystem without POSIX
    // permissions, must not stop a working key from being used.
  }
}

/**
 * Create the key file if absent and return the key it holds either way.
 *
 * The key is PUBLISHED ATOMICALLY: written in full to a private temp file at
 * mode 0600, then `link()`ed into place. `link()` either succeeds or fails
 * EEXIST — it never clobbers — so `path` is only ever observable as ABSENT or
 * COMPLETE, and a losing racer can never destroy the winner's file. Mode 0600
 * comes from the original `open`, never a write-then-chmod, which would leave
 * the key world-readable in the gap and permanently so if the process died.
 *
 * WI-10001496. The previous implementation created `path` itself with
 * O_CREAT|O_EXCL and wrote into it AFTERWARDS, leaving a window where the file
 * existed but was EMPTY. A sibling arriving in that window read empty, unlinked
 * the file and created its own; the first worker's `write()` then landed on an
 * orphaned inode, so it returned a key present on no disk and signed under a key
 * no sibling held — reintroducing the exact split-key bug this function exists
 * to end, at the one moment it matters: a cold boot where all N SO_REUSEPORT
 * workers race this path from nothing.
 *
 * An empty `path` is therefore never something WE publish. It can only be a
 * leftover from that older writer, a crash mid-write, or external truncation, so
 * a possible in-flight writer is given a brief grace period before the file is
 * judged stale. We never unlink a file that has content.
 */
export function ensureOAuthStateKeyFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < KEY_PUBLISH_ATTEMPTS; attempt++) {
    const onDisk = readKeyFileContents(path);
    if (onDisk !== null) {
      if (onDisk !== '') {
        tightenKeyFilePermissions(path);
        return onDisk;
      }
      sleepSync(EMPTY_KEY_GRACE_MS);
      if (readKeyFileContents(path) === '') rmSync(path, { force: true });
      continue;
    }

    const generated = randomBytes(GENERATED_KEY_BYTES).toString('base64');
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeSync(fd, `${generated}\n`, null, 'utf8');
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(tmp, path);
        return generated;
      } catch (err) {
        // EEXIST: a sibling published first. Loop and adopt theirs — keeping our
        // own is the split-key bug. `tmp` and `path` share a directory, so EXDEV
        // is unreachable; anything else is a real fault and must surface.
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  // Every pass lost the race yet never found a readable key. Failing loud is the
  // point: falling back to a process-local key IS the split-key bug.
  throw new Error(
    `Could not establish an OAuth state key at ${path} after ${KEY_PUBLISH_ATTEMPTS} attempts.`,
  );
}

/** `null` = absent · `''` = present but carrying no key material · else the key. */
function readKeyFileContents(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Block this thread. `ensureOAuthStateKeyFile` is synchronous (it is called from
 * `getSecret()`, itself sync), so a timer-based wait is not available.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let secretKey: Buffer | null = null;

/**
 * The HMAC key for state tokens. Resolution order:
 *
 *   1. `PAPERCUSP_OAUTH_STATE_SECRET` — the server-deployment override.
 *   2. A per-install key file, generated on first use (see above).
 *
 * There is deliberately NO random in-memory fallback. The previous one
 * (`randomBytes(32)` cached module-scope) gave every PROCESS its own key, which
 * cannot work here at all: `hono-host.ts` sets `reusePort: true` and
 * `cluster-fork.ts` forks N request workers, so the kernel load-balances the
 * authorize-start and the OAuth callback onto DIFFERENT workers. The callback
 * then verified a signature made under a key it did not have and every Google
 * login failed `bad-signature` — nonce rows written by the start leg, never
 * consumed, because verification bails before the nonce claim.
 *
 * A file also makes the key per-INSTALL, which is what a DISTRIBUTED build
 * needs: a single secret baked into a shipped binary could be extracted by
 * anyone and used to forge state tokens for every user.
 */
function getSecret(): Buffer {
  if (secretKey) return secretKey;

  const env = process.env[SECRET_ENV_VAR];
  if (env && env.trim()) {
    const trimmed = env.trim();
    // Fail LOUD on a too-short override. The old code silently fell back to a
    // random key here, so a misconfigured secret broke every login while
    // looking configured — the failure reported itself as `bad-signature`,
    // which points at the token rather than at the setting that caused it.
    if (trimmed.length < MIN_SECRET_CHARS) {
      throw new Error(
        `${SECRET_ENV_VAR} is ${trimmed.length} characters, under the ${MIN_SECRET_CHARS}-character floor. ` +
          'Refusing to sign OAuth state under a weak key. Set a longer value, or unset it entirely to use the ' +
          `per-install key file at ${oauthStateKeyFilePath()} (generated automatically).`,
      );
    }
    secretKey = Buffer.from(trimmed, 'utf8');
    return secretKey;
  }

  secretKey = Buffer.from(ensureOAuthStateKeyFile(oauthStateKeyFilePath()), 'utf8');
  return secretKey;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

async function rememberNonce(nonce: string, exp: number, privateContext: OAuthFlowPrivateContext): Promise<void> {
  const { sql } = getOrgPg();
  const now = Date.now();
  const privateContextJson = JSON.stringify(privateContext);
  await sql`
    INSERT INTO harness_shared.oauth_nonces
      (nonce, exp_ms, consumed, created_at, private_context)
    VALUES (${nonce}, ${exp}, false, ${now}, ${privateContextJson}::jsonb)
    ON CONFLICT (nonce) DO NOTHING
  `;
  // Opportunistic GC: if the table is larger than 1000 rows, sweep expired
  // entries. Cheap because of the exp_ms index.
  const cnt = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.oauth_nonces`;
  if ((cnt[0]?.n ?? 0) > 1000) {
    await sql`DELETE FROM harness_shared.oauth_nonces WHERE exp_ms < ${now}`;
  }
}

/**
 * Sign a state token. The returned string is opaque from a security
 * perspective — caller treats it as a single token, not parseable.
 */
export async function signState(
  claims: StateClaims,
  ttlOrOptions: number | SignStateOptions = DEFAULT_TTL_MS,
): Promise<string> {
  const options = typeof ttlOrOptions === 'number' ? { ttlMs: ttlOrOptions } : ttlOrOptions;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const payload: SignedState = {
    ...claims,
    v: STATE_VERSION,
    exp: Date.now() + ttlMs,
    nonce: b64url(randomBytes(16)),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', getSecret()).update(body).digest());
  await rememberNonce(payload.nonce, payload.exp, options.privateContext ?? {});
  return `${body}.${sig}`;
}

export interface VerifyStateResult {
  ok: boolean;
  claims?: StateClaims;
  privateContext?: OAuthFlowPrivateContext;
  error?: 'malformed' | 'bad-signature' | 'expired' | 'unknown-nonce' | 'already-consumed';
}

function normalizePrivateContext(value: unknown): OAuthFlowPrivateContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

/**
 * Verify a state token AND consume its nonce. A successful verify is
 * destructive — calling it twice with the same token returns
 * `already-consumed`. The consumption is a single transactional
 * UPDATE … WHERE consumed = false RETURNING — atomic against concurrent
 * callbacks racing to claim the same nonce.
 */
export async function verifyAndConsumeState(token: string): Promise<VerifyStateResult> {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: 'malformed' };
  }
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) return { ok: false, error: 'malformed' };

  const expectedSig = b64url(createHmac('sha256', getSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad-signature' };
  }

  let payload: SignedState;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (payload.v !== STATE_VERSION) return { ok: false, error: 'malformed' };
  if (payload.exp < Date.now()) return { ok: false, error: 'expired' };

  const { sql } = getOrgPg();
  // Single round-trip atomic claim. CTE first checks existence; UPDATE
  // claims if not yet consumed. The two RETURNING paths let us
  // distinguish unknown-nonce from already-consumed.
  const claimed = await sql<
    {
      status: 'claimed' | 'already' | 'unknown';
      privateContext: unknown;
    }[]
  >`
    WITH lookup AS (
      SELECT consumed, private_context
        FROM harness_shared.oauth_nonces
       WHERE nonce = ${payload.nonce}
    ),
    upd AS (
      UPDATE harness_shared.oauth_nonces
         SET consumed = true
       WHERE nonce = ${payload.nonce} AND consumed = false
       RETURNING private_context
    )
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM lookup) THEN 'unknown'::text
      WHEN EXISTS (SELECT 1 FROM upd) THEN 'claimed'::text
      ELSE 'already'::text
    END AS status,
    (SELECT private_context FROM upd LIMIT 1) AS "privateContext"
  `;
  const status = claimed[0]?.status ?? 'unknown';
  if (status === 'unknown') return { ok: false, error: 'unknown-nonce' };
  if (status === 'already') return { ok: false, error: 'already-consumed' };

  return {
    ok: true,
    claims: {
      plugin: payload.plugin,
      harness: payload.harness,
      field: payload.field,
      providerHost: payload.providerHost,
      provider: payload.provider,
    },
    privateContext: normalizePrivateContext(claimed[0]?.privateContext),
  };
}

/**
 * Test-only: drop the in-process secret-key cache and DELETE all rows
 * in oauth_nonces. The DELETE is destructive across the whole table,
 * so don't use this in any non-test path.
 */
/**
 * Test-only: drop ONLY the in-process key cache, leaving the nonce rows intact.
 *
 * This is the cross-worker simulation: a sibling reusePort worker shares the
 * key FILE and the PG nonce table, but has none of this process's memory. The
 * full `__resetForTest` below also DELETEs the nonces, which would turn that
 * scenario into `unknown-nonce` and hide the signature property under test.
 */
export function __resetSecretCacheForTest(): void {
  secretKey = null;
}

export async function __resetForTest(): Promise<void> {
  secretKey = null;
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.oauth_nonces`;
}
