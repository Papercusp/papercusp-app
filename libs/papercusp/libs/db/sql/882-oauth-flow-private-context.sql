-- 880-oauth-flow-private-context.sql — external-triggers P-009
--
-- OAuth state is browser-visible, so per-flow secrets such as a PKCE verifier
-- must stay server-side. Extend the existing durable, single-use nonce row
-- instead of adding a second flow/session store.

ALTER TABLE harness_shared.oauth_nonces
  ADD COLUMN IF NOT EXISTS private_context jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN harness_shared.oauth_nonces.private_context IS
  'Server-only OAuth flow context (for example a PKCE verifier). Never serialize this value into the browser-visible state token.';
