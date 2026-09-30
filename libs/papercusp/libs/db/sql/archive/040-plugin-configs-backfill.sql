\set ON_ERROR_STOP on
BEGIN;

-- Migration 040 — encrypt existing plugin_configs rows.
--
-- For every row where config_ct IS NULL but config IS NOT NULL, copy the
-- plaintext into the encrypted column and wipe the plaintext one. Uses a
-- session-set GUC for the key so the migration is replayable in CI/dev
-- without baking the literal key into SQL history.
--
-- Run with:
--   PAPERCUSP_DB_ENCRYPTION_KEY=<key> \
--     psql -v key="'$PAPERCUSP_DB_ENCRYPTION_KEY'" -f 040-plugin-configs-backfill.sql
--
-- (The :key substitution lets us pass the key via a command-line variable.)

\if :{?key}
\else
  \echo 'ERROR: must invoke with -v key=''<encryption_key>'''
  \quit 1
\endif

-- updated_at is BIGINT epoch-ms (not TIMESTAMPTZ), matching how
-- mirrorPluginConfig writes it. Use extract+cast to keep the schema
-- consistent.
UPDATE harness_shared.plugin_configs
   SET config_ct = pgp_sym_encrypt(config::text, :key),
       config = NULL,
       updated_at = (extract(epoch from now()) * 1000)::bigint
 WHERE config IS NOT NULL
   AND config_ct IS NULL;

COMMIT;
