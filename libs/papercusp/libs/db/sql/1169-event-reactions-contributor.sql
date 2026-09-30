-- Migration 1169 — event-reaction CONTRIBUTOR attribution (identities-v1 P-030 / D-012).
--
-- `harness_shared.event_reactions` (migration 153) records WHICH RULE fired
-- (`rule_id`) but not WHO CONTRIBUTED that rule. Once third-party rules can
-- install (a plugin, a blueprint, a standalone Cupboard `rule` listing — D-055),
-- rule_id alone cannot answer the two questions uninstall and budgeting need:
--
--   * "what has contributor X fired?"  — uninstall completeness (P-030 clause a).
--     A rule id is an opaque string chosen by its contributor; grouping fires by
--     contributor means parsing an id prefix, which is a convention, not a key.
--   * "has contributor X exceeded its fire budget?" (P-030 clause c). The global
--     cascade bound (`depth` + `cause_root_run_id`, enforced by
--     @papercusp/event-reaction's loop-guard MAX_REACTION_DEPTH=8) was designed
--     when every rule was first-party: it caps ONE cascade's depth and has no
--     per-contributor dimension, so N shallow rules from one contributor are
--     unbounded. That consumer is structurally blocked without this column.
--
-- `contributor` is the in-memory `ReactionRule.source` value made durable —
-- `plugin:<name>`, `standalone:<id>`, or NULL for a first-party built-in rule.
-- NULL is meaningful and is NOT backfilled: a pre-1169 row genuinely has no
-- recorded contributor, and inventing 'builtin' for it would assert provenance
-- this migration cannot observe.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, nullable, no default rewrite).
-- No destructive DDL, so no FORWARD-COMPAT acknowledgment is required: the
-- currently-deployed release simply never reads or writes the new column.
-- Composes onto 000-baseline.sql for fresh/embedded-pg boots; safe additive on
-- the native :5432 box. Runs as harness_admin.
--
-- No top-level BEGIN;/COMMIT;: the migration runner wraps each file in its own
-- transaction, and the pre-apply gate lint refuses a file that opens its own
-- (migration 153, whose style this otherwise follows, predates that rule).

\set ON_ERROR_STOP on

ALTER TABLE harness_shared.event_reactions
    ADD COLUMN IF NOT EXISTS contributor text;

COMMENT ON COLUMN harness_shared.event_reactions.contributor IS
    'Who contributed the rule that fired: the durable form of ReactionRule.source — ''plugin:<name>'', ''standalone:<id>'', or NULL for a first-party built-in rule (and for any row written before migration 1169, which is deliberately not backfilled). The attribution key for per-contributor uninstall completeness and fire budgeting (identities-v1 P-030, D-012).';

-- "What has contributor X fired lately, in this workspace" — the per-contributor
-- fire budget's read (P-030 clause c) and the uninstall audit's read (clause a).
-- Partial: a first-party (NULL contributor) row is never the subject of either
-- question, and excluding it keeps the index proportional to third-party traffic
-- rather than to total reaction volume.
CREATE INDEX IF NOT EXISTS event_reactions_contributor_idx
    ON harness_shared.event_reactions (workspace_id, contributor, fired_at DESC)
    WHERE contributor IS NOT NULL;
