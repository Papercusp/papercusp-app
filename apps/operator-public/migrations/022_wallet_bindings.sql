-- Signed-nonce EVM wallet binding (shared-pot DAO plan P-029).
--
-- A wallet address is never an identity lookup. Challenges are issued only
-- after GitHub-bearer authentication and bind the authenticated principal,
-- wallet, chain, expiry, and exact SIWE-style message. `consumed_token` is the
-- compare-and-set witness used by the Worker store: a verifier may persist a
-- binding only when its own one-time token consumed the challenge.

CREATE TABLE IF NOT EXISTS wallet_binding_challenges (
  challenge_id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  domain TEXT NOT NULL,
  uri TEXT NOT NULL,
  message TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  consumed_token TEXT,
  CHECK (chain_id > 0),
  CHECK (expires_at_ms > issued_at_ms),
  CHECK (
    (consumed_at_ms IS NULL AND consumed_token IS NULL) OR
    (consumed_at_ms IS NOT NULL AND consumed_token IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS wallet_binding_challenges_principal_idx
  ON wallet_binding_challenges (principal_id, issued_at_ms DESC);

CREATE INDEX IF NOT EXISTS wallet_binding_challenges_expiry_idx
  ON wallet_binding_challenges (expires_at_ms);

CREATE TABLE IF NOT EXISTS wallet_bindings (
  principal_id TEXT PRIMARY KEY NOT NULL,
  wallet_address TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  challenge_id TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (chain_id > 0)
);

CREATE INDEX IF NOT EXISTS wallet_bindings_wallet_idx
  ON wallet_bindings (wallet_address);
