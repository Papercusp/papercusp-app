/**
 * The personal disclosure ledger, for integration fixtures that hand-roll a
 * minimal `harness_shared` schema instead of applying migrations.
 *
 * Every agent-facing transcript read (sessions:search, sessions:read, consult
 * routing) consults this table to withhold turns recorded inside another agent's
 * disclosure windows (plan personal-data-reader-set-labels-2026-10-01 D-006,
 * personal-vault/transcript-exclusion.ts). A fixture without it makes those
 * reads refuse with `disclosure_ledger_unavailable` — fail-closed by design.
 *
 * Same columns as the migrated table; the `user_id` foreign key to
 * `harness_shared.users` is dropped because these fixtures have no users table.
 * Suites that need the real constraints use `createOrgTestDb` (migrated).
 */
export const DISCLOSURE_LEDGER_FIXTURE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.personal_disclosures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id text NOT NULL,
    user_id uuid NOT NULL,
    agent_owner_id text NOT NULL,
    document_id uuid NOT NULL,
    source text NOT NULL,
    level text NOT NULL,
    reader_set text[] NOT NULL,
    delivered_via text NOT NULL,
    delivered_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    released_by text,
    release_ref text
  )
`;
