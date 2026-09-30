# Credentials encryption (pgcrypto)
URL: /internal/docs/system/credentials-encryption

How credentials-class operator-state tables are encrypted at rest, and the runbook for rotation and recovery.

# Credentials encryption at rest

Migrations `027-pgcrypto-credentials.sql` and `028-pgcrypto-drop-plaintext.sql`
(now squashed into `000-baseline.sql`; the numbered files live under
`libs/papercusp/libs/db/sql/archive/`) add column-level encryption-at-rest for
the credentials-class operator-state tables. A pgcrypto-encrypted
`payload_ct BYTEA` column holds the data; the legacy `payload JSONB` column is
kept as a `'{}'::jsonb` papercup so the helpers in
`packages/operator-core/lib/operator-state-pg.ts` can keep INSERTing it without
a schema-shape change for now. A future migration will drop the column.

## Tables encrypted

The set lives in `packages/operator-core/lib/db-encryption.ts` as `ENCRYPTED_TABLES`:

* `operator_credentials` — generic API credentials
* `operator_voice_credentials` — OpenAI / ElevenLabs / Cartesia / Deepgram / Picovoice / Google keys
* `operator_marketplace_token` — marketplace publish service tokens
* `operator_publish_credentials` — R2 access keys (when populated)
* `operator_trust_store` — publisher signing-key fingerprints + rotation log
* `operator_search_provider_credentials` — OMP `web_search` provider API keys (Migration 047)

All six are also omitted from the Zero schema/query surface
(`libs/zero-harness/src/schema.ts`) and served PG-only via REST, so they never
hit the WS/Zero sync path — `operator_credentials` is explicitly commented
"intentionally NOT here (PG-only via REST)" in `libs/zero-harness/src/queries.ts`.
(They *are* in the `zero_harness` PG publication, which is created schema-wide
as `FOR TABLES IN SCHEMA harness_shared, papercup_shared`; what keeps them off
the broadcast surface is their absence from the hand-written Zero schema, not
the publication.) The encrypted-at-rest layer is defense-in-depth on top of that.

:::note\[Also encrypted, but outside `ENCRYPTED_TABLES`]
`harness_shared.plugin_configs.config_ct` is encrypted at rest with the **same**
`getDbEncryptionKey()` key and the same `pgp_sym_encrypt` / `pgp_sym_decrypt`
mechanism (Migration 039). It is **not** in `ENCRYPTED_TABLES` because it routes
through its own helper, `packages/operator-core/lib/plugin-configs-pg.ts`, keyed
by `(harness_slug, plugin_slug)` — not the `operator-state-pg.ts` branch. Anything
that depends on the key (rotation, recovery) must account for `plugin_configs`
too — see the runbook and recovery sections below.
:::

## Key sourcing

`getDbEncryptionKey()` in `packages/operator-core/lib/db-encryption.ts` resolves in order:

1. **`process.env.PAPERCUSP_DB_ENCRYPTION_KEY`** — deploy-time override.
   Anything in this env var is passed verbatim to `pgp_sym_encrypt`. Use a
   long random string (32+ bytes worth of entropy).
2. **`~/.papercusp/db-encryption-key`** — file fallback. Auto-bootstrapped on
   first call: 32 random bytes, base64-encoded (44 chars), written with
   mode `0600`.

The key is cached in-process; restart the operator to pick up a changed key.

## Threat model

| Threat                                               | Covered                                         |
| ---------------------------------------------------- | ----------------------------------------------- |
| Leaked DB dump (`pg_dump`, backup snapshot, replica) | ✓ ciphertext only                               |
| WAL filesystem read                                  | ✓ ciphertext only                               |
| `harness_admin` SELECT without key file              | ✓ cannot decrypt                                |
| Casual paste of `\d+` output                         | ✓ shows bytea, not values                       |
| **Live RCE on the operator process**                 | ✗ attacker reads the key file like we do        |
| Loss of the key file                                 | Credentials are unrecoverable (re-enter via UI) |
| Side-channel on `pgp_sym_decrypt` timing             | Not analysed; not in scope for V1               |

This is **encryption-at-rest, not encryption-in-use.** It defends against
offline attacks on the data, not online compromise of the running service.

## Recovery — lost the key

If `~/.papercusp/db-encryption-key` is lost AND no env-var override is set:

1. The operator will **auto-generate a new key** on first read of an
   encrypted table. With the new key, every existing `payload_ct` row
   becomes undecryptable (`pgp_sym_decrypt` errors).
2. Affected rows are not catastrophic to lose. Recovery flow:
   * Settings → Voice / Credentials / Marketplace pages re-prompt the user
     to enter their API keys. The next write encrypts with the new key.
   * For `operator_trust_store`, prior plugin trusts must be re-confirmed
     on next install (the user sees a "rebuild trust" prompt — degraded
     but not destructive).
   * `harness_shared.plugin_configs.config_ct` rows (encrypted under the
     same key) also become undecryptable. The on-disk
     `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json` files are
     authoritative, so re-encrypt the `config_ct` mirror from them — either let
     the runtime helper `mirrorPluginConfig()` (`plugin-configs-pg.ts`, which
     writes `config_ct` via `pgp_sym_encrypt` with `workspace_id`) re-mirror on
     the next config write, or run migration `040-plugin-configs-backfill.sql`
     (`UPDATE … SET config_ct = pgp_sym_encrypt(config::text, :key)`). Do **not**
     use `scripts/backfill-plugin-configs.mjs` for this — it writes the plaintext
     `config` column only, never `config_ct`, and is stale against the current
     schema.
3. **Do not panic-DELETE undecryptable rows.** The pgcrypto failure surfaces
   as an exception in the helper; rows with stale ciphertext don't corrupt
   anything else, and the user-driven re-entry path naturally overwrites
   them.

If you have a backup of the prior key file, restore it. Then the existing
ciphertext decrypts again as before.

## Rotation runbook

Rotation re-encrypts every row with a new key, then promotes the new key
to primary. Since it requires read-then-write of all credentials rows it
should be coordinated with no concurrent operator writes (single-user
deploys: just briefly restart after).

```bash
# 1. Generate new key
NEW_KEY=$(python3 -c "import secrets, base64; print(base64.b64encode(secrets.token_bytes(32)).decode())")
OLD_KEY=$(cat ~/.papercusp/db-encryption-key)

# 2. Re-encrypt every row in every encrypted table.
PGURL='postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp'
for tbl in operator_credentials operator_voice_credentials operator_marketplace_token operator_publish_credentials operator_trust_store operator_search_provider_credentials; do
  psql "$PGURL" -v ON_ERROR_STOP=1 -c "
    UPDATE harness_shared.$tbl
    SET payload_ct = pgp_sym_encrypt(pgp_sym_decrypt(payload_ct, '$OLD_KEY'), '$NEW_KEY')
    WHERE payload_ct IS NOT NULL
  "
done

# 2b. plugin_configs is also encrypted under the same key (Migration 039) but
#     lives outside ENCRYPTED_TABLES, so the loop above skips it. Re-encrypt
#     its config_ct too (keyed by harness_slug/plugin_slug, not workspace_id).
psql "$PGURL" -v ON_ERROR_STOP=1 -c "
  UPDATE harness_shared.plugin_configs
  SET config_ct = pgp_sym_encrypt(pgp_sym_decrypt(config_ct, '$OLD_KEY'), '$NEW_KEY')
  WHERE config_ct IS NOT NULL
"

# 3. Promote the new key.
echo "$NEW_KEY" > ~/.papercusp/db-encryption-key.tmp
chmod 0600 ~/.papercusp/db-encryption-key.tmp
mv ~/.papercusp/db-encryption-key.tmp ~/.papercusp/db-encryption-key

# 4. Restart the operator to drop the cached old key.
#    (The in-process cache only re-resolves on cold start.)
```

Verify by hitting `GET /api/agent-mcp/operator-credentials` — the masked
keys should match what was there before rotation. If decryption fails,
the key file change didn't take; restart didn't run; or the UPDATE in
step 2 errored mid-loop and rolled back.

## Adding a table to the encrypted set

1. Add the table name to `ENCRYPTED_TABLES` in `packages/operator-core/lib/db-encryption.ts`.
2. Write a new migration that adds `payload_ct BYTEA` to the table and
   encrypts existing rows (cf. 027 + the runtime backfill loop pattern).
3. Add a follow-up migration that wipes the plaintext payload (cf. 028).

The `packages/operator-core/lib/operator-state-pg.ts` helpers branch on
`ENCRYPTED_TABLES.has(table)` automatically — no per-table code change required.

## What's NOT done (deliberate)

* **Asymmetric (`pgp_pub_*`)** so a write-only key can't read. Adds key
  management overhead; not justified for single-user dev.
* **OS keyring (Tauri keychain / libsecret)** for the key. The flat file at
  mode 0600 is roughly equivalent to keyring on a single-user host.
* **Real KMS** (cloud or on-prem). Out of scope for V1.
* **Drop plaintext column entirely.** Migration 028 wipes it to `'{}'::jsonb`
  rather than DROPping; future migration after we confirm nothing else
  queries the column will run `ALTER TABLE ... DROP COLUMN payload`.
