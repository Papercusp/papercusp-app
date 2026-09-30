-- Backend-local fences, not installer ownership (blueprint_package_resources).
-- The ordinary memory_write_journal is retryable and purgeable, so cannot fence
-- a late write after cancellation or hard privacy deletion. Retain only hashes
-- and routing IDs here; never retain deleted content. No FK/cascade to memories.
CREATE TABLE harness_shared.memory_managed_writes (
  write_key uuid PRIMARY KEY,
  scope text NOT NULL,
  request_hash text,
  fingerprint text,
  canceled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
  CHECK (fingerprint IS NULL OR fingerprint ~ '^[a-f0-9]{64}$')
);
-- Only the canonical backend's admin connection mutates these fences. No
-- application-role grant: they are not a workspace-scoped tool/read surface.
COMMENT ON TABLE harness_shared.memory_managed_writes IS
  'Permanent non-content idempotency/cancellation fences for managed canonical memory writes; not a replay queue.';
