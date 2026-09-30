-- 677-work-item-authority-state.sql
--
-- agent-protocol-authority-semantics-2026-07-26 P-003 — the AUTHORITY axis.
--
-- WHY ------------------------------------------------------------------------
-- A terminal state today conflates two orthogonal facts:
--
--   1. LIFECYCLE  — "this item left the queue"          (state: passed/resolved/closed…)
--   2. AUTHORITY  — "the claim that it is finished is trustworthy"
--
-- Because they share one column, an agent asserting completion with no evidence
-- produces a row indistinguishable from a verified one. The system's answer to
-- that has been a leader audit that RE-OPENS bare assertions after the fact — a
-- verify-after-the-fact layer over a value that can be wrong. D-003 rejects that
-- shape: the fix is to make an unverified assertion FAIL TO REACH the
-- authoritative state in the first place, not to reach it and be corrected later.
--
-- Measured on the live store before this change (P-002): of 14,663 terminal rows,
-- 65.6% carry NO structured verification evidence — and every one of them reads as
-- "done" to burn-down, to the scheduler, and to a leader brief.
--
-- WHAT -----------------------------------------------------------------------
-- Add `authority` ALONGSIDE the existing state rather than replacing it, so
-- burn-down and the scheduler keep working during rollout.
--
--   proposed      — a completion was ASSERTED but carries no sufficient structured
--                   evidence. Lifecycle-terminal, authority-unsettled. Does NOT
--                   count toward burn-down. Stays owned by its closer and is
--                   surfaced by nag, never re-queued into the claimable pool (D-007).
--   committed     — asserted WITH sufficient evidence (verifiedHow + at least one of
--                   testsRun / testResult). Counts toward burn-down. The normal path.
--   validated     — RESERVED. A `committed` row additionally corroborated by a signal
--                   INDEPENDENT of its closer (a green run in the test-run ledger, a
--                   cited commit that exists, an owner ratification). Counts toward
--                   burn-down. No writer ships in this phase — see the note below.
--   pending_human — the completion cannot be settled by agent or machine and awaits
--                   owner ratification. Does NOT count toward burn-down.
--   invalid       — a previously-recorded terminal claim was CONTRADICTED (the item was
--                   reopened, the fix did not hold, a superseding item replaced it).
--                   Retains the fact that a bad close happened, which today is lost
--                   entirely when a reopen clears terminal state.
--
-- NULL is not a sixth value — it is the ABSENCE of an authority judgement, and it
-- means one of exactly two things, disambiguated by the row's state:
--
--   state non-terminal + authority NULL → the item is open. It owes no claim yet.
--   state terminal     + authority NULL → a LEGACY close, made under the pre-authority
--                                         contract. Counts toward burn-down, is never
--                                         nagged, and is never reopened or reclassified.
--
-- That second reading IS the D-005 backfill treatment, expressed structurally: this
-- migration deliberately performs NO BACKFILL. Stamping the ~9,600 pre-existing
-- evidence-less terminal rows as `proposed` would erase two-thirds of historical
-- burn-down overnight and swamp every leader brief with nags for work closed in good
-- faith under the old rules. Leaving them NULL is both honest (the system genuinely
-- has no authority judgement about them) and free (a nullable ADD COLUMN rewrites no
-- rows). It also makes the contract boundary exactly queryable, which the P-013
-- standing measurement needs: `authority IS NOT NULL` selects precisely the rows
-- closed under the new contract, with no date arithmetic and no era column.
--
-- ON `validated` SHIPPING WITHOUT A WRITER: it is reserved here deliberately, not
-- forgotten. Every other value is written by the completion gate at close time;
-- `validated` requires a corroboration source that does not exist yet, and its first
-- writer is a P-013 deliverable. It is declared now so the CHECK constraint does not
-- have to be rewritten later. If P-013 does not land a writer, the honest move is to
-- DROP it from the enum rather than leave a value nothing can produce.
--
-- SHAPE ----------------------------------------------------------------------
-- `harness_shared.work_items` is the ONE real table; both `harness_features_consolidated`
-- and `engineer_issues` are VIEWS over it, split on item_kind. So a single column serves
-- both families and cannot drift between them — the exact failure mode EI-10867 records,
-- where a privately-duplicated evidence key let the write path and the audit path
-- disagree about where evidence lived.
--
-- The value set is enforced by a CHECK constraint, not only by the TypeScript union.
-- That is the point of D-004: a load-bearing rule kept in prose (or in a Zod
-- `.describe()` string, per D-006) drifts; one kept in the harness holds.
--
-- No behaviour change lands with this migration. Nothing writes the column yet —
-- P-004 wires the writer.

-- ── 0. lock ordering (this migration deadlocked without it) ────────────────────
-- `work_items` is the hottest table on the box and both family views sit on top of it,
-- so this file touches a relation and its dependents in one transaction — the classic
-- shape for a lock-order deadlock.
--
-- A reader (`SELECT … FROM engineer_issues`) acquires AccessShareLock on the VIEW first,
-- then on the base table. The statement order below is the opposite: ALTER the table,
-- then REPLACE the views. The first apply attempt duly deadlocked at the second view:
--
--   Process A waits for AccessExclusiveLock on engineer_issues; blocked by process B.
--   Process B waits for AccessShareLock on work_items;          blocked by process A.
--
-- Acquiring every relation up front in READER order (views, then base) removes the
-- cycle: a conflicting reader now just makes this transaction WAIT while it holds
-- nothing, instead of each side holding what the other needs. Multi-table LOCK acquires
-- left to right, so the order of this list is the fix — do not reorder it.
--
-- The db:migrate runner already wraps this file in BEGIN + `SET LOCAL lock_timeout`, so
-- a contended apply fails fast and retryably rather than hanging the table.
LOCK TABLE harness_shared.engineer_issues,
           harness_shared.harness_features_consolidated,
           harness_shared.work_items
  IN ACCESS EXCLUSIVE MODE;

-- ── 1. the column, on the single base table ────────────────────────────────────
ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS authority text;

COMMENT ON COLUMN harness_shared.work_items.authority IS
  'Authority axis (plan agent-protocol-authority-semantics-2026-07-26 P-003): how '
  'trustworthy the terminal claim on this row is, orthogonal to lifecycle `status`. '
  'proposed|validated|committed|pending_human|invalid. NULL on a non-terminal row means '
  '"owes no claim yet"; NULL on a TERMINAL row means a legacy pre-authority close, which '
  'counts toward burn-down and is never nagged or reclassified (D-005). Only committed '
  'and validated count toward burn-down.';

-- ── 2. the value set, enforced in the harness rather than in prose ─────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_items_authority_check'
      AND conrelid = 'harness_shared.work_items'::regclass
  ) THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_authority_check
      CHECK (authority IS NULL OR authority IN
        ('proposed', 'validated', 'committed', 'pending_human', 'invalid'));
  END IF;
END $$;

-- ── 3. burn-down / nag read paths ──────────────────────────────────────────────
-- Partial: only rows closed under the new contract carry a non-null authority, so the
-- index stays small (zero rows on the day this lands) and grows only with new closes.
-- Ordered (workspace, harness, authority) to match how burn-down and leader briefs
-- scope their counts.
CREATE INDEX IF NOT EXISTS work_items_authority_idx
  ON harness_shared.work_items (workspace_id, harness_slug, authority)
  WHERE authority IS NOT NULL;

-- The nag path asks a narrower question — "which of MY closes still owe evidence" —
-- and answers it per closing principal.
CREATE INDEX IF NOT EXISTS work_items_authority_proposed_idx
  ON harness_shared.work_items (terminal_owner, updated_ts)
  WHERE authority = 'proposed';

-- ── 4. expose on both family views ─────────────────────────────────────────────
-- Appended LAST in each select list: CREATE OR REPLACE VIEW permits adding columns at
-- the end, but every pre-existing column must keep its name, type and position — so
-- these lists are the live definitions verbatim plus one trailing column.

CREATE OR REPLACE VIEW harness_shared.harness_features_consolidated AS
  SELECT harness_slug,
    feature_id,
    title,
    summary,
    status,
    attempts,
    claims,
    notes,
    metadata,
    kind,
    project_id,
    expected_cost_cents,
    tags,
    needs_human_review,
    ts,
    created_ts,
    updated_ts,
    parent_id,
    goal_id,
    taken_by,
    taken_at,
    expires_at,
    workspace_id,
    _search,
    deprecation_reason,
    see_also,
    needs_design,
    design_status,
    design_spec_id,
    discarded_design_work,
    completion_ref,
    created_by_github_user_id,
    working_users,
    worked_by_history,
    verified_done_at_remote_ts,
    verifier_last_error,
    verifier_last_checked_at,
    source_plan_slug,
    source_plan_item_ids,
    wave,
    feature_order,
    author_pubkey,
    origin,
    audit_verdict,
    audit_reasons,
    audited_at,
    item_kind,
    payload,
    assignee_rank,
    rank_writer,
    rank_updated_at,
    fed_ts,
    swarm_affinity,
    redundancy,
    verified_author_github_user_id,
    schedule,
    schedule_active,
    scheduled_at,
    tzid,
    template_slug,
    run_seq,
    requeue_count,
    fed_hlc,
    last_progress_at,
    terminal_owner,
    terminal_completion_ref,
    last_released_by,
    last_released_at,
    embedding,
    embedding_mode,
    terminal_reason,
    authority
   FROM harness_shared.work_items
  WHERE item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text]);

CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
  SELECT workspace_id,
    feature_id AS issue_id,
        CASE
            WHEN harness_slug ~~ 'operator:%'::text OR harness_slug = ''::text THEN 'operator'::text
            ELSE 'harness:'::text || harness_slug
        END AS scope,
    title,
    COALESCE(summary, ''::text) AS body,
    COALESCE((payload -> '_ei'::text) ->> 'severity'::text, 'minor'::text) AS severity,
    COALESCE((payload -> '_ei'::text) ->> 'source'::text, 'engineer'::text) AS source,
    status AS state,
    taken_by AS assignee,
    (payload -> '_ei'::text) ->> 'found_during'::text AS found_during,
    (payload -> '_ei'::text) ->> 'linked_feature_id'::text AS linked_feature_id,
    (payload -> '_ei'::text) ->> 'created_by'::text AS created_by,
    to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at,
    to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at,
    author_pubkey,
    origin,
    _search,
    item_kind AS kind,
    payload - '_ei'::text AS payload,
    (payload -> '_ei'::text) ->> 'assigned_by'::text AS assigned_by,
    taken_at AS assigned_at,
    assignee_rank,
    rank_writer,
    rank_updated_at,
    fed_ts,
    COALESCE((payload -> '_ei'::text) ->> 'signal_origin'::text, 'organic'::text) AS signal_origin,
    fed_hlc,
    terminal_owner,
    terminal_completion_ref,
    last_progress_at,
    harness_slug AS base_harness_slug,
    origin AS base_origin,
    feature_order,
    terminal_reason,
    authority
   FROM harness_shared.work_items
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);
