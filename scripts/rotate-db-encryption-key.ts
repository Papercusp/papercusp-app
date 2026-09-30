/**
 * rotate-db-encryption-key — retire the at-rest encryption key and re-encrypt
 * every credential under a fresh one.
 *
 * WI-2144851 / security-boundary-remediation-and-usability-2026-09-04 P-007.
 * `db-encryption-rotation.ts` holds the logic and its safety ordering; this is
 * the entrypoint that makes it reachable. Without it the capability is dead
 * code: the operator could not rotate a leaked key without losing every
 * credential it protected.
 *
 *   npx tsx scripts/rotate-db-encryption-key.ts              # DRY RUN (default)
 *   npx tsx scripts/rotate-db-encryption-key.ts --execute    # for real
 *
 * Dry run is the default deliberately, matching deploy-cli: a rotation is a
 * two-place move (Postgres + a file on disk) whose failure modes are only
 * recoverable while you still hold the old key, so "what would this do" should
 * never require committing to it.
 */
import { getOrgPg } from '@papercusp/db-org';

import { dbEncryptionKeyFilePath, getDbEncryptionKey } from '../packages/operator-core/lib/db-encryption';
import {
  generateDbEncryptionKey,
  rotateDbEncryptionKey,
} from '../packages/operator-core/lib/db-encryption-rotation';

const ENV_VAR = 'PAPERCUSP_DB_ENCRYPTION_KEY';

async function main(): Promise<number> {
  const execute = process.argv.includes('--execute');

  // REFUSE when the key is pinned by the environment. `getDbEncryptionKey()`
  // prefers $PAPERCUSP_DB_ENCRYPTION_KEY over the key file, so rotating would
  // re-encrypt every row under the new key, write that key to a file nothing
  // reads, and leave the operator still using the OLD env value — an
  // unreadable store produced by a run that reported success. The operator has
  // to move the env var itself, so this cannot be safely automated here.
  if (process.env[ENV_VAR]?.trim()) {
    console.error(
      `refusing to rotate: ${ENV_VAR} is set, so it — not the key file — is the key this operator uses.\n` +
        'Rotation installs a new KEY FILE, which that override would continue to shadow: the database would be ' +
        're-encrypted under a key the running operator never reads, and every credential would fail to decrypt on ' +
        `the next read.\n\nTo rotate a deployment pinned this way: unset ${ENV_VAR} so the key file is authoritative, ` +
        `run this again, then set ${ENV_VAR} to the new key from the key file if you still want it pinned.`,
    );
    return 2;
  }

  const keyFilePath = dbEncryptionKeyFilePath();
  const currentKey = getDbEncryptionKey();
  const newKey = generateDbEncryptionKey();
  const { sql } = getOrgPg();

  console.log(`key file : ${keyFilePath}`);
  console.log(`mode     : ${execute ? 'EXECUTE — this will re-encrypt and install a new key' : 'DRY RUN'}`);

  const res = await rotateDbEncryptionKey({
    sql: sql as never,
    currentKey,
    newKey,
    keyFilePath,
    dryRun: !execute,
  });

  console.log('');
  for (const t of res.tables) {
    const plaintext = t.plaintextRows > 0 ? `  ⚠ ${t.plaintextRows} plaintext row(s)` : '';
    console.log(`  ${t.table.padEnd(42)} ${String(t.rotated).padStart(3)} rotated${plaintext}`);
  }
  console.log(`\n  total: ${res.rotatedTotal} row(s) re-encrypted across ${res.tables.length} table(s)`);

  if (res.plaintextTotal > 0) {
    // A finding, not a failure: these rows predate encryption-at-rest and are
    // sitting in the clear. Rotation deliberately does not sweep them in, so
    // say so rather than let a clean-looking report imply they were handled.
    console.log(
      `\n  ⚠ ${res.plaintextTotal} row(s) hold PLAINTEXT payloads (payload_ct IS NULL) and were NOT rotated —\n` +
        '    there is no ciphertext on them to re-key. They are at rest in the clear; re-saving each through the\n' +
        '    UI writes it back encrypted under the current key.',
    );
  }

  if (res.dryRun) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --execute to rotate.');
  } else {
    console.log(`\nRotated. Superseded key preserved at: ${res.previousKeyPath}`);
    console.log('Restart the operator so it picks up the new key.');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`\nrotation FAILED: ${(err as Error)?.message ?? String(err)}`);
    process.exit(1);
  });
