-- WI-41089 / lsp-fleet-scale-all-languages-2026-08-21 P-006.
-- The daemon adapter is reused; generic settings cannot arbitrate versioned,
-- per-intent observations atomically, so these cells need their own relation.
CREATE TABLE IF NOT EXISTS harness_shared.lsp_capabilities (
  language text NOT NULL CHECK (length(language) > 0),
  intent text NOT NULL CHECK (intent IN
    ('definition', 'references', 'implementations', 'rename-preview', 'diagnostics', 'symbol-search')),
  server_identity text NOT NULL CHECK (server_identity ~ '^[0-9a-f]{64}$'),
  supported boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('initialize', 'request-success', 'publish', 'method-not-found')),
  evidence text NOT NULL,
  evidence_priority smallint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (language, intent, server_identity),
  CHECK ((source = 'initialize' AND evidence_priority = 1)
    OR (source IN ('request-success', 'publish') AND evidence_priority = 2)
    OR (source = 'method-not-found' AND evidence_priority = 3 AND supported = false))
);
COMMENT ON TABLE harness_shared.lsp_capabilities IS
  'Fleet-wide daemon capability observations by language, intent and installed server identity. Protocol refusals outrank declarations.';
