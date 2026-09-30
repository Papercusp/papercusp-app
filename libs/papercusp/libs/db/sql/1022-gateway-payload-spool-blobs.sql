-- 1022-gateway-payload-spool-blobs.sql
--
-- P-006 / WI-472439 (capless-inference-gateway-2026-08-28, D-004 + D-011):
-- durable backing store for the inference gateway's PRE-ACCEPTANCE request-body spool.
--
-- Why this table exists. D-004 requires request bodies to be spooled BEFORE the gateway
-- accepts work, so that (a) queue depth never scales resident memory and (b) a durable
-- receipt can own execution after the originating socket — or the whole process — is gone.
-- The admission contract already carries and persists a bounded `payloadRef` string
-- (resource-governor/admission.ts); nothing stored the bytes it referred to. This is that
-- storage.
--
-- What this is NOT: a new payload system. Per D-011 the policy layer (hash-verify on write,
-- idempotent dedupe, refcounted GC) is the existing generic BlobStore port in
-- libs/generic/artifact-registry. This table is only the Postgres BACKEND behind that
-- 4-method port — the smallest extension that fits the repo's Postgres-by-default storage
-- policy. harness_text_artifacts was evaluated first and rejected: text-typed, path-keyed,
-- with no bytes, refcount, or TTL.
--
-- Additive only: one new table, no DDL against any existing relation, so no FORWARD-COMPAT
-- acknowledgment is required — the currently-deployed release simply does not see it.

CREATE TABLE IF NOT EXISTS harness_shared.gateway_payload_blobs (
  -- The content address IS the key: lowercase hex sha256 of `bytes`. Callers pass this as
  -- the admission `payloadRef`, which is what makes a retried request with an identical body
  -- dedupe to one row instead of spawning a second stored payload (D-004 idempotency).
  blob_key         text        NOT NULL,
  workspace_id     text        NOT NULL DEFAULT '',

  bytes            bytea       NOT NULL,
  -- Denormalized so queue-depth/GC accounting never has to detoast `bytes`.
  byte_length      bigint      NOT NULL,
  content_type     text        NULL,

  -- Refcount for gcIfUnreferenced: incremented per receipt that names this blob, decremented
  -- when that receipt settles. A blob at zero is collectable; it is NOT deleted inline, so a
  -- retry arriving between settle and sweep can still resurrect it.
  ref_count        integer     NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  -- Backstop against an accepted-but-never-executed receipt pinning bytes forever. The
  -- sweeper treats expires_at as a floor, never as permission to delete a referenced blob.
  expires_at       timestamptz NULL,

  CONSTRAINT gateway_payload_blobs_pkey PRIMARY KEY (workspace_id, blob_key),
  -- The key must actually be a sha256 hex digest. This is the invariant the content-addressed
  -- put verifies in code; asserting it here means a hand-written INSERT cannot quietly store a
  -- blob under a key that no reader will ever compute.
  CONSTRAINT gateway_payload_blobs_key_is_sha256 CHECK (blob_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT gateway_payload_blobs_len_nonneg CHECK (byte_length >= 0),
  CONSTRAINT gateway_payload_blobs_refcount_nonneg CHECK (ref_count >= 0)
);

-- GC sweep: find collectable blobs (unreferenced, oldest first) without scanning referenced ones.
CREATE INDEX IF NOT EXISTS gateway_payload_blobs_gc_idx
  ON harness_shared.gateway_payload_blobs (workspace_id, last_accessed_at)
  WHERE ref_count = 0;

-- TTL sweep for the accepted-but-abandoned case above.
CREATE INDEX IF NOT EXISTS gateway_payload_blobs_expiry_idx
  ON harness_shared.gateway_payload_blobs (expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON TABLE harness_shared.gateway_payload_blobs IS
  'Content-addressed request-body spool for the inference gateway''s pre-acceptance durable admission path (capless-inference-gateway-2026-08-28 D-004/D-011). Postgres backend behind the generic BlobStore port in libs/generic/artifact-registry; blob_key is the sha256 of bytes and is used directly as the admission payloadRef.';

COMMENT ON COLUMN harness_shared.gateway_payload_blobs.blob_key IS
  'Lowercase hex sha256 of bytes. Used verbatim as the admission payloadRef, so an identical retried body dedupes here instead of storing twice.';

COMMENT ON COLUMN harness_shared.gateway_payload_blobs.ref_count IS
  'Number of live receipts naming this blob. Zero means collectable, not deleted: the sweeper reclaims lazily so a retry between settle and sweep can still resurrect the payload.';
