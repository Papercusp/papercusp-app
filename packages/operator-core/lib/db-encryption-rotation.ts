/**
 * db-encryption-rotation — re-encrypt every at-rest row under a new symmetric
 * key.
 *
 * WI-2144851 / security-boundary-remediation-and-usability-2026-09-04 P-007.
 * The source audit asks for "safe atomic key creation, and tested key
 * recovery/rotation" on the `db-encryption.ts` store. Creation and recovery
 * landed with that module; ROTATION had nothing behind it — no path anywhere
 * re-encrypted the ENCRYPTED_TABLES rows under a new key, so the only way to
 * retire a key that had leaked was to lose every credential it protected.
 *
 * ## Why this is mostly a file-ordering problem, not a crypto problem
 *
 * The re-encryption itself is one `UPDATE ... pgp_sym_encrypt(pgp_sym_decrypt(
 * payload_ct, old), new)` per table, and pgcrypto makes it fail closed for
 * free: a wrong `old` key raises "Wrong key or corrupt data", which aborts the
 * transaction and leaves every row exactly as it was.
 *
 * The dangerous part is that the ciphertext lives in Postgres while the key
 * lives on disk, so a rotation has to move TWO things and any window between
 * them is a window where the operator cannot read its own credentials:
 *
 *   - DB rotated, key file still old  → every decrypt fails on next boot.
 *   - Key file rotated, DB still old  → every decrypt fails on next boot.
 *
 * Neither is recoverable by retrying; both need the missing key. So the
 * sequence below is chosen to make every crash window land somewhere the
 * operator can get back from, and to make the one unavoidable window as narrow
 * as a single `rename(2)`:
 *
 *   1. Stage the new key at `<keyfile>.next` (O_EXCL, 0600). Nothing reads
 *      this path, so the store is untouched and a crash here is a no-op.
 *   2. Run the whole DB rotation in ONE transaction, and VERIFY inside it by
 *      decrypting every row back with the NEW key before committing. A crash
 *      or a bad key here rolls back; `.next` is cleaned up on the way out.
 *   3. Back up the live key to `<keyfile>.prev-<timestamp>`, then `rename()`
 *      `.next` over the live path.
 *
 * The window between the commit in (2) and the rename in (3) is the only one
 * that can leave the store unreadable — and it is survivable precisely because
 * `.next` still holds the new key: moving that file into place completes the
 * rotation by hand. `INTERRUPTED_ROTATION_HELP` is that instruction, and it is
 * attached to the error rather than left in a doc nobody reads at 3am.
 *
 * Deliberately NOT done here:
 *   - `updated_at` is not bumped. Rotation re-encrypts the payload; it does not
 *     CHANGE it, and callers use that column to mean "when the credential last
 *     changed". Touching it would be a lie that invalidates caches for nothing.
 *   - Plaintext (`payload_ct IS NULL`) rows are counted and REPORTED, never
 *     silently swept into the new key. Those rows predate encryption-at-rest;
 *     bringing them in is a migration with its own semantics, and quietly
 *     doing it inside a "rotate" would hide the fact that they were sitting in
 *     the clear. Reporting is what lets the operator decide.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';

import { DbEncryptionKeyError, ENCRYPTED_TABLES } from './db-encryption';

/** Bytes of entropy in a key this module generates. base64 → 44 characters. */
const GENERATED_KEY_BYTES = 32;

/**
 * Shortest acceptable replacement key. Mirrors `db-encryption.ts`'s key-file
 * floor on purpose: a rotation that installed a key the LOADER would then
 * refuse as corrupt would brick the store on the next boot, having already
 * re-encrypted every row under it.
 */
const MIN_KEY_CHARS = 32;

export const INTERRUPTED_ROTATION_HELP =
  'If the database was already re-encrypted before this failed, the staged key file (<keyfile>.next) is the ONLY ' +
  'copy of the key those rows are now under — do NOT delete it. Recover by moving it over the live key file ' +
  '(mv <keyfile>.next <keyfile>) and restarting the operator. If decryption still fails afterwards, the rotation ' +
  'did not commit and the ORIGINAL key file is still correct; delete the staged file instead.';

export type RotationTableResult = {
  table: string;
  /** Rows re-encrypted under the new key. */
  rotated: number;
  /** Rows holding plaintext `payload` and no ciphertext — nothing to rotate. */
  plaintextRows: number;
};

export type RotationResult = {
  dryRun: boolean;
  tables: RotationTableResult[];
  rotatedTotal: number;
  /** Rows still at rest in the clear. Non-zero is a finding, not an error. */
  plaintextTotal: number;
  /** Where the superseded key was preserved. Absent on a dry run. */
  previousKeyPath?: string;
};

/** Minimal structural type for the postgres.js tag this module needs. */
type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  (fragment: string): unknown;
  begin<T>(cb: (tx: SqlTag) => Promise<T>): Promise<T>;
};

class DryRunRollback extends Error {
  constructor(readonly result: RotationTableResult[]) {
    super('dry run — rolling back');
  }
}

/** Generate a replacement key with the same shape the store bootstraps with. */
export function generateDbEncryptionKey(): string {
  return randomBytes(GENERATED_KEY_BYTES).toString('base64');
}

function assertUsableNewKey(key: string): void {
  if (key.trim().length >= MIN_KEY_CHARS) return;
  throw new DbEncryptionKeyError(
    `refusing to rotate to a ${key.trim().length}-character key, under the ${MIN_KEY_CHARS}-character floor that ` +
      'db-encryption.ts enforces when LOADING a key file. Rotating to it would re-encrypt every row under a key the ' +
      'loader then refuses as corrupt on the next boot — the store would be unreadable and the rotation would look ' +
      'like it had succeeded. Nothing has been changed.',
  );
}

/**
 * Re-encrypt every encrypted row from `currentKey` to `newKey`.
 *
 * The caller supplies `sql` rather than this module reaching for a pool: the
 * ordering above is the whole point of the function, and injecting the handle
 * is what lets it be tested without a live database.
 */
export async function rotateDbEncryptionKey(opts: {
  sql: SqlTag;
  currentKey: string;
  newKey: string;
  /** Path of the live key file — normally `keyFile()` from db-encryption. */
  keyFilePath: string;
  /** Verify and report, then roll back without changing anything. */
  dryRun?: boolean;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
}): Promise<RotationResult> {
  const { sql, currentKey, newKey, keyFilePath, dryRun = false } = opts;
  const now = opts.now ?? Date.now;

  assertUsableNewKey(newKey);
  if (currentKey === newKey) {
    throw new DbEncryptionKeyError(
      'refusing to rotate a key to itself: this would rewrite every row for no change in protection, while still ' +
        'spending the crash windows a real rotation carries. Nothing has been changed.',
    );
  }

  const stagedPath = `${keyFilePath}.next`;
  if (!dryRun) stageNewKey(stagedPath, newKey);

  let tables: RotationTableResult[];
  try {
    tables = await sql.begin(async (tx) => {
      const results: RotationTableResult[] = [];
      for (const table of [...ENCRYPTED_TABLES].sort()) {
        const rel = tx(`harness_shared.${table}`);

        // Re-encrypt in the DATABASE. Round-tripping the plaintext through this
        // process would put every credential in the operator's heap — and in
        // any crash dump taken while a rotation was running — for no gain.
        const rotated = (await tx`
          UPDATE ${rel}
             SET payload_ct = pgp_sym_encrypt(pgp_sym_decrypt(payload_ct, ${currentKey})::text, ${newKey})
           WHERE payload_ct IS NOT NULL
          RETURNING workspace_id
        `) as unknown[];

        // Prove the new ciphertext is readable BEFORE committing. Without this
        // the transaction would happily commit rows that only pgcrypto could
        // tell us were wrong, and we would find out at the next credential read.
        // The ::jsonb cast is load-bearing: it re-asserts the shape the read
        // path in operator-state-pg.ts casts to.
        await tx`
          SELECT pgp_sym_decrypt(payload_ct, ${newKey})::jsonb AS verified
            FROM ${rel}
           WHERE payload_ct IS NOT NULL
        `;

        const plaintext = (await tx`
          SELECT workspace_id FROM ${rel} WHERE payload_ct IS NULL
        `) as unknown[];

        results.push({
          table,
          rotated: rotated.length,
          plaintextRows: plaintext.length,
        });
      }

      // Roll back by throwing — the verification above has already run, so a
      // dry run reports exactly what a real one would do.
      if (dryRun) throw new DryRunRollback(results);
      return results;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) {
      return summarize(err.result, true);
    }
    // The rotation did not commit, so the staged key protects nothing and
    // leaving it behind would block the next attempt.
    if (!dryRun) rmSync(stagedPath, { force: true });
    throw err;
  }

  let previousKeyPath: string | undefined;
  try {
    previousKeyPath = installStagedKey(keyFilePath, stagedPath, now());
  } catch (err) {
    throw new DbEncryptionKeyError(
      `the database was re-encrypted successfully, but installing the new key file failed: ${
        (err as Error)?.message ?? String(err)
      }. ${INTERRUPTED_ROTATION_HELP.replace(/<keyfile>/g, keyFilePath)}`,
    );
  }

  return summarize(tables, false, previousKeyPath);
}

function summarize(
  tables: RotationTableResult[],
  dryRun: boolean,
  previousKeyPath?: string,
): RotationResult {
  return {
    dryRun,
    tables,
    rotatedTotal: tables.reduce((n, t) => n + t.rotated, 0),
    plaintextTotal: tables.reduce((n, t) => n + t.plaintextRows, 0),
    ...(previousKeyPath ? { previousKeyPath } : {}),
  };
}

/**
 * Write the replacement key somewhere durable but INERT before touching the
 * database. O_EXCL because an existing `.next` means a previous rotation died
 * partway: that file may be the only copy of the key the rows are under, so
 * clobbering it is the one unrecoverable mistake available here.
 */
function stageNewKey(stagedPath: string, newKey: string): void {
  let fd: number;
  try {
    fd = openSync(stagedPath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new DbEncryptionKeyError(
        `a staged key already exists at ${stagedPath}, which means an earlier rotation did not finish. That file may ` +
          'be the only copy of the key the database rows are now encrypted under, so this refuses rather than ' +
          `overwrite it. ${INTERRUPTED_ROTATION_HELP.replace(/<keyfile>/g, stagedPath.replace(/\.next$/, ''))}`,
      );
    }
    throw err;
  }
  try {
    writeSync(fd, `${newKey}\n`, null, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Preserve the superseded key, then move the staged one into place.
 *
 * The backup is taken FIRST and by copy-then-rename rather than by renaming the
 * live file away: between those two operations the live path must never be
 * absent, because `getDbEncryptionKey()` treats a missing key file as "first
 * boot" and GENERATES a fresh key — which a concurrent operator process would
 * then encrypt new rows under.
 */
function installStagedKey(keyFilePath: string, stagedPath: string, nowMs: number): string {
  const previousKeyPath = `${keyFilePath}.prev-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}`;

  if (existsSync(keyFilePath)) {
    const live = readFileSync(keyFilePath, 'utf8');
    const fd = openSync(previousKeyPath, 'wx', 0o600);
    try {
      writeSync(fd, live, null, 'utf8');
    } finally {
      closeSync(fd);
    }
  }

  // Atomic: readers see either the old key or the new one, never a partial file.
  renameSync(stagedPath, keyFilePath);
  return previousKeyPath;
}
