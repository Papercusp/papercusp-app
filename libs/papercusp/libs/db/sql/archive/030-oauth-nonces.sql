-- 030-oauth-nonces.sql
--
-- Round-7 file→PG (well, mem→PG): OAuth state-token nonce table.
--
-- Was previously a process-local `Map<string, NonceRecord>` in
-- apps/operator/lib/oauth/state.ts — non-durable across operator
-- restarts and incompatible with multi-instance deploys (each
-- instance had its own nonce set; a callback could land on a
-- different instance from the one that issued the nonce).
--
-- Per-message: a row is INSERTed at signState() time and SELECT-then-
-- UPDATE at verifyAndConsumeState() time. The (nonce) PK gives us
-- replay protection (consumed=true rows survive their TTL window so
-- repeated callbacks reliably return 'already-consumed').
--
-- TTL cleanup: rows expire 5 min after issue (configurable per signState
-- call; default 5 min). A periodic sweep deletes consumed-and-expired
-- rows to keep the table small. The sweep runs opportunistically (on
-- each verify) when the table is large; no scheduled job needed.
--
-- Not in zero_harness publication — server-internal nonce ledger.

CREATE TABLE IF NOT EXISTS harness_shared.oauth_nonces (
  nonce       TEXT PRIMARY KEY,
  exp_ms      BIGINT NOT NULL,
  consumed    BOOLEAN NOT NULL DEFAULT false,
  created_at  BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS oauth_nonces_exp_idx
  ON harness_shared.oauth_nonces (exp_ms);
