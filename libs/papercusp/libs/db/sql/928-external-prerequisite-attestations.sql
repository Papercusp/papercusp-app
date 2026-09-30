-- 928-external-prerequisite-attestations.sql — WI-41115
-- Plan: typed-external-prerequisite-attestations-for-release-gates-2026-08-15, P-002.
--
-- The zero-secret attestation store for a release gate's EXTERNAL prerequisites
-- (a Stripe endpoint binding, an Apple signing certificate). A row records that a
-- capability was observed PRESENT and how it is BOUND — never the credential.
--
-- ZERO-SECRET BY CONSTRUCTION: there is deliberately no column a credential value
-- belongs in. `binding` holds fingerprint / binding metadata only (a cert SHA-256,
-- a webhook endpoint id, a bundle id). The application-side chokepoint
-- (buildAttestation in packages/operator-core/lib/release/external-prerequisites.ts)
-- refuses credential-shaped values before they can reach this table.
--
-- EXPIRY IS THE POINT: `expires_at` is what stops a release scorecard sitting green
-- across a window in which the external wall silently changed. A receipt at or past
-- its expiry reads as ABSENT to the gate — the readiness resolver treats the
-- boundary as spent, and treats an uninterpretable row as absent rather than ready.
--
-- Purely additive (new table + new indexes); no destructive DDL, so no
-- FORWARD-COMPAT acknowledgment is required. The currently-deployed release does
-- not read this table at all — the probe runner (P-003) and the gate wiring (P-005)
-- land later.

CREATE TABLE IF NOT EXISTS harness_shared.external_prerequisite_attestations (
  workspace_id      text        NOT NULL,
  harness_slug      text        NOT NULL,

  -- Stable per-scope identifier of the prerequisite this receipt attests.
  prerequisite_key  text        NOT NULL,

  -- Capability kind; mirrors EXTERNAL_CAPABILITY_KINDS in external-prerequisites.ts.
  capability_kind   text        NOT NULL,

  -- Whether the probe found the capability present. FALSE means the probe RAN and
  -- found the wall down, which is deliberately distinguishable from no row at all.
  present           boolean     NOT NULL,

  -- Fingerprint / binding METADATA only — never a credential value.
  binding           jsonb       NOT NULL DEFAULT '{}'::jsonb,

  observed_at       timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,

  -- How this receipt was obtained: 'probe' | 'operator' | 'imported'.
  provenance        text        NOT NULL,

  -- Non-secret reference to the probe that produced it.
  probe_ref         text        NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, harness_slug, prerequisite_key),

  CONSTRAINT external_prerequisite_attestations_provenance_chk
    CHECK (provenance IN ('probe', 'operator', 'imported')),

  -- A receipt that expires at or before it was observed is already spent on
  -- arrival; reject it at the boundary rather than storing a row that can only
  -- ever read as expired.
  CONSTRAINT external_prerequisite_attestations_expiry_chk
    CHECK (expires_at > observed_at),

  -- Defense in depth for the zero-secret invariant: `binding` must be a JSON
  -- OBJECT, so a bare string (the shape a leaked credential would most likely
  -- arrive as) cannot be stored at all.
  CONSTRAINT external_prerequisite_attestations_binding_is_object_chk
    CHECK (jsonb_typeof(binding) = 'object')
);

-- The gate's read: "which prerequisites in this scope are still standing?"
CREATE INDEX IF NOT EXISTS external_prerequisite_attestations_scope_expiry_key
  ON harness_shared.external_prerequisite_attestations (workspace_id, harness_slug, expires_at);

-- The lifecycle sweep's read (P-003): "what has lapsed and needs re-probing?"
CREATE INDEX IF NOT EXISTS external_prerequisite_attestations_expiring_key
  ON harness_shared.external_prerequisite_attestations (expires_at)
  WHERE present = true;

COMMENT ON TABLE harness_shared.external_prerequisite_attestations IS
  'Zero-secret receipts that a release gate''s external prerequisite was observed present and how it is bound. Holds presence, binding/fingerprint metadata, timestamps and provenance — never a credential value. Plan typed-external-prerequisite-attestations-for-release-gates-2026-08-15 P-002.';

COMMENT ON COLUMN harness_shared.external_prerequisite_attestations.binding IS
  'Fingerprint/binding metadata only (cert SHA-256, webhook endpoint id, bundle id). NEVER a credential value — enforced application-side by buildAttestation().';

COMMENT ON COLUMN harness_shared.external_prerequisite_attestations.expires_at IS
  'At or past this instant the receipt reads as ABSENT to the gate, so a scorecard cannot stay green while the external wall silently changed.';
