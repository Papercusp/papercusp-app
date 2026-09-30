-- Cupboard migration 007 — repo→Hive binding fields (hive_pubkey + hive_title).
--
-- Plan: hive-from-github-url-2026-06-11 (P-004; D-004 HYBRID, ratified D-008).
--
-- The Cupboard is the UNIQUENESS + OFF-NETWORK INDEX for PUBLIC hives: one
-- listing row per member repo, all carrying the same hive_pubkey, so pasting
-- ANY member repo's GitHub URL finds the owning Hive. The signed directory
-- announce remains the CONTENT authority (title/members/links) — these
-- columns are a lookup key + a denormalized display title, not truth.
--
--   hive_pubkey — the owning Hive's raw 32-byte Ed25519 public key, base64
--                 (the SAME encoding as the hive directory announce's
--                 hive_pubkey). NULL = pre-hive listing or a plain
--                 shared-harness binding.
--   hive_title  — denormalized Hive display title for off-network browse;
--                 the directory announce wins on conflict. NULL when unknown.
--
-- Both columns are nullable ADD COLUMNs (002/003 pattern — no CHECK change,
-- so no 12-step table rebuild). Existing rows keep NULL. The partial index
-- serves the reverse lookup "all member-repo rows of hive X" (the P-007
-- publish/unlist set + visibility flips in P-015).
--
-- Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/007_hive_binding_fields.sql

ALTER TABLE harnesses ADD COLUMN hive_pubkey TEXT;
ALTER TABLE harnesses ADD COLUMN hive_title TEXT;

CREATE INDEX IF NOT EXISTS harnesses_hive_pubkey_idx
  ON harnesses (hive_pubkey) WHERE hive_pubkey IS NOT NULL;
