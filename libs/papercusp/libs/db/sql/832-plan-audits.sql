-- 832-plan-audits.sql
--
-- plan-completion-audit-and-acceptance-verdict-2026-08-13 P-001 — the audit record.
--
-- WHY ------------------------------------------------------------------------
-- `plans:set-plan-status → shipped` currently verifies the CEREMONY around a plan's
-- completion and never the work. `evaluatePlanAcceptanceGate` asks three questions —
-- does an acceptance rubric exist, does some grading of it rate every criterion, and
-- was that grading emitted by someone other than the rubric's author — and none of
-- them reads what the ratings SAY, whether the plan's own items are done, or whether
-- any of it matches the code.
--
-- Measured on the live store before this change: 181 criterion ratings have ever been
-- emitted against acceptance rubrics (157 healthy / 23 degraded / 1 unknown / 0 fail);
-- 8 plans shipped carrying a degraded criterion, blocked by nothing because nothing
-- could block on it; and `claude-md-projection-from-pg-2026-08-10` passed the gate and
-- shipped with `P-009` still `todo`. An agent had already filed the diagnosis on
-- 2026-08-12 (EI-20219912008114544): "a gate that checks completeness is not checking
-- correctness."
--
-- This table is where the missing half lives: a record, per plan, of every item having
-- been traced to the code that implements it, produced by the implementer before the
-- acceptance rubric is authored (plan D-004).
--
-- WHAT -----------------------------------------------------------------------
-- One row per audit PASS, not one per plan. A plan re-audited after further work
-- appends a new row rather than overwriting, so the sequence of passes is legible and
-- an earlier verdict cannot be quietly rewritten. The gate reads the highest
-- `audit_seq` for the plan; the rest is history.
--
-- SHAPE ----------------------------------------------------------------------
-- The per-item detail is jsonb rather than a child table, deliberately. D-006 means
-- entries ARE folded across a single plan's handful of pass rows (newest itemId wins),
-- so the original "always read as a unit alongside its parent" premise no longer holds.
-- The load-bearing reason remains: entries are never queried across plans, and every
-- read is bounded to one plan's small append-only pass history. A child table would add
-- a join without enabling a required cross-plan query. `items` holds objects of the form:
--
--   { itemId, verdict,
--     citations: [{ kind, path?, line?, symbol?, ref?, reason?, blobSha? }],
--     note?, auditedSha, auditedAt, itemTextHash, carriedFrom? }
--
--   verdict  implemented | not-code | partial | missing | dropped
--
-- Per plan D-002, NONE of those verdicts refuses a ship on its own — they record. The
-- one with a hard requirement is `dropped`, which must carry a reason: departing from
-- the plan is legitimate, departing silently is not. `findings` holds out-of-scope
-- discoveries, each with a disposition (`fixed` or `filed`) and, when filed, the
-- work-item ref — so a bug found while auditing is never both un-fixed and un-recorded.
--
-- `audited_sha` is the local `staging` HEAD when the audit ran. It is evidence about a
-- point in time, not a promise about now, which is exactly why the gate re-resolves
-- every citation against the CURRENT tree at ship time instead of trusting this row
-- (P-004). Nullable: an audit taken where the sha cannot be resolved is still a real
-- audit, and refusing to record one would push agents toward not auditing at all.
--
-- Purely additive: a new table and its indexes, touching no existing relation, so the
-- currently-deployed release cannot be broken by it and no FORWARD-COMPAT line is owed.
-- Nothing writes this table until P-002 lands the `plans:audit` verb.

CREATE TABLE IF NOT EXISTS harness_shared.plan_audits (
  workspace_id  text        NOT NULL,
  harness_slug  text        NOT NULL,
  plan_slug     text        NOT NULL,
  audit_seq     integer     NOT NULL,
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  audited_sha   text,
  items         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  findings      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  summary       text,
  PRIMARY KEY (workspace_id, plan_slug, audit_seq)
);

COMMENT ON TABLE harness_shared.plan_audits IS
  'Code-truth audit records, one row per audit PASS of a plan '
  '(plan-completion-audit-and-acceptance-verdict-2026-08-13). The implementer traces '
  'every non-dropped plan item to the code that implements it and cites it; the '
  'citations must resolve against the real tree at write time, and are re-resolved '
  'against the CURRENT tree by the completion gate at ship time. The gate reads the '
  'highest audit_seq for a plan; earlier passes are retained as history and are never '
  'rewritten.';

COMMENT ON COLUMN harness_shared.plan_audits.items IS
  'Per-item audit detail: [{ itemId, verdict, citations:[{kind,path?,line?,symbol?,'
  'ref?,reason?,blobSha?}], note?, auditedSha, auditedAt, itemTextHash, carriedFrom? }]. '
  'Entries are folded newest-first by itemId across one plan''s passes (D-006); an '
  'unlisted prior entry is mechanically carried with its original provenance, never '
  're-stamped at the new pass sha/time. verdict is implemented|not-code|partial|missing|dropped. '
  'Per plan D-002 no verdict refuses a ship on its own — they RECORD. `dropped` must '
  'carry a reason (the intentional-departure path); `implemented` must carry at least '
  'one citation. kind:''none'' is the escape hatch for items with no code artifact and '
  'requires a reason — the none-ratio is reported back to the caller and put in front '
  'of the independent grader (D-004), because it is the one soft spot a self-audit '
  'cannot close on its own.';

COMMENT ON COLUMN harness_shared.plan_audits.findings IS
  'Out-of-scope discoveries made while auditing: [{ summary, severity?, disposition, '
  'ref? }] where disposition is fixed|filed. A finding NEVER blocks the ship — that is '
  'what keeps "fix any bugs" from making a plan un-closeable (D-002) — but a `filed` '
  'finding must carry its work-item ref, so nothing is silently swallowed.';

COMMENT ON COLUMN harness_shared.plan_audits.audited_sha IS
  'Local staging HEAD when the audit ran. Evidence about a point in time, not a claim '
  'about now: the gate re-resolves citations against the CURRENT tree rather than '
  'trusting this. Nullable on purpose — an audit whose sha cannot be resolved is still '
  'a real audit.';

-- The gate's read is "the latest audit for this plan", which the primary key already
-- serves (its leading columns are the lookup and audit_seq is the ordering). This index
-- serves the other read: listing a harness's audit activity, which the plan-level PK
-- cannot answer without a full scan.
CREATE INDEX IF NOT EXISTS plan_audits_harness_recent_idx
  ON harness_shared.plan_audits (workspace_id, harness_slug, created_at DESC);

-- "Which audits did this agent produce" — the accountability read behind a self-audit
-- regime (D-004). Small and append-only.
CREATE INDEX IF NOT EXISTS plan_audits_created_by_idx
  ON harness_shared.plan_audits (created_by, created_at DESC);
