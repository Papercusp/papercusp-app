-- 574-agent-facts-audience-provenance.sql — coord-authority-hardening-2026-07-11
-- P-007 (H3+C, owner-ratified D-001): two delivery-trust columns on the
-- standing-facts ledger.
--
--   • audience_scope  — WHO may receive the fact in folds (orthogonal to `scope`,
--     which says what the fact is ABOUT). NULL = unrestricted (today's behavior).
--     v1 grammar: 'fleet:<slug>' — the orient facts-fold delivers such a fact
--     ONLY to members of that fleet. Validated at the tool layer
--     (validateAudienceScope); free-form values are rejected at assert so a typo
--     can't silently hide a fact from everyone.
--
--   • source_provenance — the platform-VERIFIED stamp for a TYPED sourceRef
--     (msg:<id> / wi:<id>/WI-/EI- / owner-turn), captured server-side at assert
--     time (H2-tier reuse): { kind, verified, quote?, label?, error?, verifiedAt }.
--     NULL for free-text sourceRefs (unchanged) and legacy rows. Folds render it
--     verbatim with zero extra reads — assert-time stamping keeps the fold
--     deterministic and IO-free (the D-002 zero-extra-calls principle).
--
-- Both columns are LOCAL-only in v1: the federation wire row (projections/
-- agent-facts.ts) does not carry them — fleets are pot-local and a peer cannot
-- verify our provenance anyway. isAgentFactWireRow ignores unknown keys, so the
-- capture's to_jsonb(row) still validates.
--
-- Idempotent. Applied via the runner (db:migrate / A1 boot-apply).

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS audience_scope    text,
  ADD COLUMN IF NOT EXISTS source_provenance jsonb;

COMMENT ON COLUMN harness_shared.agent_facts.audience_scope IS
  'P-007: fold-delivery audience restriction (v1: fleet:<slug>); NULL = unrestricted. Orthogonal to scope (what the fact is about).';
COMMENT ON COLUMN harness_shared.agent_facts.source_provenance IS
  'P-007: platform-verified stamp for a typed sourceRef (msg:/wi:/owner-turn), captured at assert time; NULL for free-text/legacy.';
