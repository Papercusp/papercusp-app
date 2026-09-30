-- operator_secrets — small KV for operator-process secrets that must
-- outlive a single restart and survive without a flat-file footprint.
--
-- Designed for tiny, infrequent reads (spawn-signing key, future:
-- voice-credential encryption salt, dashboard signing key). Don't use
-- this for per-call state.
--
-- Why PG vs ~/.papercusp/<file>: a same-UID agent can `cat` any flat
-- file in the user's home; PG access requires the same agent to also
-- know the DSN, the schema, and either share the operator's libpq
-- session or hold valid credentials. It's still same-UID (the operator
-- writes those into env, etc.), so this is friction not enforcement —
-- see docs/endpoint-system/superuser-mode.mdx's threat-model caveats.
--
-- The first user is the per-spawn URL HMAC key
-- (apps/operator/lib/spawn-signing.ts). Rotating the row revokes every
-- live spawn URL — coarse but adequate for "we shipped a bad prompt,
-- kill everything."
CREATE TABLE IF NOT EXISTS harness_shared.operator_secrets (
  name        TEXT PRIMARY KEY,                      -- 'spawn-signing-key', etc.
  value_b64   TEXT NOT NULL,                         -- base64-encoded bytes
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at  TIMESTAMPTZ
);
