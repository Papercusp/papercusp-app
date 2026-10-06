-- 1314-gateway-payload-chunks.sql
--
-- Plan papercusp-log-performance-remediation-2026-09-23, P-015(b), D-017, WI-10005005.
-- Store inference-gateway request bodies as content-defined chunks.
--
-- Measured 2026-10-01: the spool INSERT into gateway_payload_blobs was the largest
-- single WAL producer on the cluster (27% of statement WAL since the 2026-09-29
-- stats reset, ~426 kB per call). Each agent turn re-sends its whole conversation,
-- so a turn's body is mostly the previous turn's body plus a short tail. Over all
-- 120 live spool rows (730 s), pglz TOAST stored 42.8 MB; content-defined chunks
-- (avg 8 kB) with zstd on only the NEW chunks stored 6.6 MB.
--
-- gateway_payload_blobs stays the receipt-facing identity: its key is still the
-- sha256 of the whole body, and ref_count, expiry and the sweep rules are
-- unchanged. A chunked row carries the ordered chunk hashes in chunk_hashes and
-- an empty bytes value. Rows written before this migration keep their inline
-- bytes and chunk_hashes NULL; they age out under the existing two-minute TTL.
--
-- gateway_payload_chunks holds each distinct chunk once per workspace, zstd
-- compressed. It is a LOGGED table written in the same transaction as the manifest
-- row, so the D-004 durability contract (capless-inference-gateway-2026-08-28) is
-- unchanged. A chunk is kept while any manifest row references it, plus a grace
-- period since last_ref_at. last_ref_at is deliberately NOT indexed: writers
-- refresh it, and an index on it would make every refresh a non-HOT update.
-- fillfactor 80 leaves room on each page for those HOT updates.
--
-- STORAGE EXTERNAL: chunk bytes are already zstd-compressed, so TOAST should move
-- them out of line without trying pglz on them first.
--
-- Writer and sweeper: packages/operator-core/lib/inference-gateway/payload-spool.ts.
-- Guard: packages/operator-core/lib/inference-gateway/payload-spool.integration.test.ts.
--
-- FORWARD-COMPAT: the only DROP below removes gateway_payload_blobs_chunked_has_no_inline_bytes, a constraint this same migration creates (the drop makes a re-run idempotent). Everything else is additive: a new table and a nullable column that the release on :3070 never selects or writes, and its existing explicit-column INSERT leaves chunk_hashes NULL, which the new CHECK accepts.

CREATE TABLE IF NOT EXISTS harness_shared.gateway_payload_chunks (
  workspace_id text NOT NULL,
  chunk_hash bytea NOT NULL,
  bytes bytea NOT NULL,
  raw_length integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ref_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gateway_payload_chunks_pkey PRIMARY KEY (workspace_id, chunk_hash),
  CONSTRAINT gateway_payload_chunks_hash_is_sha256 CHECK (octet_length(chunk_hash) = 32),
  CONSTRAINT gateway_payload_chunks_raw_length_positive CHECK (raw_length > 0)
) WITH (fillfactor = 80);

ALTER TABLE harness_shared.gateway_payload_chunks ALTER COLUMN bytes SET STORAGE EXTERNAL;

COMMENT ON TABLE harness_shared.gateway_payload_chunks IS
  'Content-defined, zstd-compressed chunks of inference-gateway request bodies (D-017). Referenced by gateway_payload_blobs.chunk_hashes; swept by payload-spool.ts once unreferenced and past the grace period.';
COMMENT ON COLUMN harness_shared.gateway_payload_chunks.last_ref_at IS
  'Last time a writer referenced this chunk. Not indexed on purpose: an index would make every refresh a non-HOT update.';

ALTER TABLE harness_shared.gateway_payload_blobs
  ADD COLUMN IF NOT EXISTS chunk_hashes bytea[];

COMMENT ON COLUMN harness_shared.gateway_payload_blobs.chunk_hashes IS
  'Ordered sha256 hashes of the body''s chunks in gateway_payload_chunks (D-017). NULL for a row whose bytes are stored inline.';

ALTER TABLE harness_shared.gateway_payload_blobs
  DROP CONSTRAINT IF EXISTS gateway_payload_blobs_chunked_has_no_inline_bytes;
ALTER TABLE harness_shared.gateway_payload_blobs
  ADD CONSTRAINT gateway_payload_blobs_chunked_has_no_inline_bytes
  CHECK (chunk_hashes IS NULL OR octet_length(bytes) = 0);
