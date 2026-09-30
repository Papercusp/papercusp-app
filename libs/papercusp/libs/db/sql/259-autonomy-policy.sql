-- 259-autonomy-policy.sql
--
-- queen-autonomy-policy-2026-06-13 (B-03 / P-021, P-023): the per-category
-- autonomy-policy store — the owner's control surface for the Queen autonomy
-- gate. One row per (workspace, category): the owner-set risk `ceiling` (D-003,
-- the cap), a `locked` flag (D-005, never-auto / protected), and the graduation
-- engine's earned `graduated_level` (B-16, moves only WITHIN the ceiling).
--
-- The gate (D-004): a Queen action auto-decides iff
--   risk_tier(item) ≤ min(ceiling, graduated_level)
--   ∧ reversible ∧ ¬authority_owner ∧ ¬locked(category)
-- Reversibility / authority / risk_tier are orthogonal axes owned by their own
-- modules; THIS table holds the per-category ceiling half.
--
-- Behavior-neutral by construction (D-007): every category ships with the
-- ceiling at `none` (never-auto), so the day this lands behaviour is identical
-- to today — autonomy only widens when the owner deliberately lowers a ceiling,
-- and only after the P-092 arming gate. The four PROTECTED categories
-- (release-deploy · spend-budget · credentials-auth · system-control, D-005)
-- additionally ship `locked = true` and can never graduate above never-auto.
--
-- Category ids are the canonical 13-category partition; the SINGLE source of
-- truth is packages/operator-core/lib/autonomy/categories.ts
-- (AUTONOMY_CATEGORY_IDS / PROTECTED_CATEGORIES). The seed VALUES below MUST
-- match it — the drift guard autonomy-policy-seed.test.ts asserts equality, so
-- the SQL literals can't silently diverge from the TS taxonomy.
--
-- MUTABLE settings table (not append-only): the owner edits ceilings and the
-- graduation engine bumps graduated_level, so harness_app keeps UPDATE. DELETE /
-- TRUNCATE are revoked — the category set is fixed; rows are upserted, never
-- removed (applying 246's lesson: the baseline's ALTER DEFAULT PRIVILEGES hands
-- harness_app ALL on every new table at CREATE time, so the REVOKE rides this
-- migration). harness_zero (the read-only sync role) gets SELECT only.
--
-- Idempotent; additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.autonomy_policy (
    workspace_id        text NOT NULL DEFAULT 'default',
    -- One of the 13 canonical category ids (categories.ts AUTONOMY_CATEGORY_IDS).
    category            text NOT NULL,
    -- Owner-set risk ceiling (D-003). `never-auto` = nothing auto-runs (shipped
    -- default). Vocabulary = @papercusp/plan-parser AUTONOMY_CEILINGS (B-01 seam).
    ceiling             text NOT NULL DEFAULT 'never-auto'
        CHECK (ceiling IN ('never-auto', 'trivial', 'low', 'moderate', 'high', 'critical')),
    -- Never-auto regardless of ceiling/graduation (D-005). Protected → true.
    locked              boolean NOT NULL DEFAULT false,
    -- Graduation engine's earned level (B-16); clamped ≤ ceiling at write time.
    graduated_level     text NOT NULL DEFAULT 'never-auto'
        CHECK (graduated_level IN ('never-auto', 'trivial', 'low', 'moderate', 'high', 'critical')),
    -- Per-class threshold overrides (forward slot for B-16's graduation thresholds).
    threshold_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Owner's explicit override directive (e.g. { pinned: true } pins graduation);
    -- null = governed by ceiling + graduation.
    owner_override      jsonb,
    updated_by          text NOT NULL DEFAULT 'system',
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, category)
);

GRANT SELECT, INSERT, UPDATE ON harness_shared.autonomy_policy TO harness_app;
REVOKE DELETE, TRUNCATE ON harness_shared.autonomy_policy FROM harness_app;
GRANT SELECT ON harness_shared.autonomy_policy TO harness_zero;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON harness_shared.autonomy_policy FROM harness_zero;

-- Seed the 13-category partition for the canonical 'default' workspace at the
-- behavior-neutral default (D-007): every ceiling never-auto; the four protected
-- categories locked. ON CONFLICT DO NOTHING = idempotent on re-apply and never
-- clobbers an owner-set ceiling. Other workspaces need no seed row — the store's
-- read merges these same defaults for any missing (workspace, category) pair
-- (fail-safe never-auto), so the table-less / unseeded state is already correct.
INSERT INTO harness_shared.autonomy_policy
    (workspace_id, category, ceiling, locked, graduated_level, updated_by)
VALUES
    ('default', 'inbox-triage',        'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'escalations',         'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'plan-governance',     'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'work-prioritization', 'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'ideation-intake',     'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'implementation',      'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'review-merge',        'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'release-deploy',      'never-auto', true,  'never-auto', 'migration:259'),
    ('default', 'spend-budget',        'never-auto', true,  'never-auto', 'migration:259'),
    ('default', 'agent-lifecycle',     'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'credentials-auth',    'never-auto', true,  'never-auto', 'migration:259'),
    ('default', 'knowledge-curation',  'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'schedule-arm',        'never-auto', false, 'never-auto', 'migration:259'),
    ('default', 'system-control',      'never-auto', true,  'never-auto', 'migration:259')
ON CONFLICT (workspace_id, category) DO NOTHING;
