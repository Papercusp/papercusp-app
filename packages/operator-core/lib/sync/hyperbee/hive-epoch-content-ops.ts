/**
 * hive-epoch-content-ops — the op-SELECTION for the read-plane re-key (C-001,
 * shared-hive-rekey-2026-06-19, the capture-wire half / su-7dcd8). Decides WHICH
 * federated CDC ops get their payload encrypted under the current hive epoch on
 * capture (encrypt-on-write, `encryptForCurrentEpoch`).
 *
 * THE RULE — exclude-set, encrypt-the-rest (fail-CLOSED toward the security goal):
 * a content op is encrypted UNLESS its projection tableTag is one of the hive
 * ADMISSION / KEY / POLICY tags a peer must be able to read IN THE CLEAR to join,
 * be admitted, fetch its wrapped epoch key, and verify owner policy. Everything
 * else (the actual hive CONTENT — features, issues, plans, coordination, work
 * items) is encrypted, so a removed/excluded peer cannot read post-boundary
 * content even though it still replicates the ciphertext bytes.
 *
 * Why exclude-set and not an allow-list: a NEW content tag added later must
 * default to ENCRYPTED (no silent read-cutoff leak). The cost of the opposite
 * failure — accidentally encrypting an infra tag — is a LOUD break (a joiner
 * can't admit / can't get its key), caught immediately by the federation
 * integration tests, prompting a conscious add to PLAINTEXT_TAGS here.
 *
 * SELF-CONSISTENT WITH THE DECRYPT-GATE: the apply-side decrypt-gate keys off the
 * envelope `epoch?` field (op.epoch != null ⇒ decrypt). The capture-wire stamps
 * `epoch` ONLY on ops this predicate selects, so the two selections cannot drift
 * — this module is the single source of truth for the encrypt set.
 *
 * The tags are the projection `tableTag`s (LocalWriteOp.table), i.e. the values
 * of `TABLE_NAME_TO_TABLE_TAG` in feature-issue-op-keys.ts — NOT the PG
 * table_names.
 */

/**
 * Hive ADMISSION / KEY / POLICY tableTags that MUST stay plaintext so a joining
 * or remaining peer can read them without a key:
 *  - hive-members        — contributor/device admission (who is in the hive).
 *  - hive-settings-by-key — per-hive settings INCLUDING the monotonic `epoch`
 *                           row; a joiner reads it to know the current epoch.
 *  - hive-policy          — the owner-SIGNED policy record (verified before apply).
 *  - hive-epoch-keys      — the per-member WRAPPED epoch keys themselves (already
 *                           individually sealed; the member unwraps with its device
 *                           key — encrypting the distribution would be circular).
 *  - hive-reports         — the member→owner moderation report queue (EN-3).
 *  - hive-pending-joins   — approval-mode pending join requests (EN-3).
 */
export const REKEY_PLAINTEXT_TAGS: ReadonlySet<string> = new Set<string>([
  'hive-members',
  'hive-settings-by-key',
  'hive-policy',
  'hive-epoch-keys',
  'hive-reports',
  'hive-pending-joins',
]);

/**
 * Should a federated op for this projection tableTag have its payload encrypted
 * under the current hive epoch on capture? True for hive CONTENT; false for the
 * admission/key/policy infra a peer must read in the clear (REKEY_PLAINTEXT_TAGS).
 *
 * Tag-only: the capture-wire additionally restricts to `put` ops with a defined
 * value (a `del` carries no payload to encrypt) and to the re-key flag being on.
 */
export function shouldEncryptOpForRekey(tableTag: string): boolean {
  return !REKEY_PLAINTEXT_TAGS.has(tableTag);
}
