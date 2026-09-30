-- 729 — WI-7057 BACKFILL: restore the completion attribution the hyperbee
-- federation projection destroyed, and mark — rather than guess — the part of it
-- that is not recoverable.
--
-- Migration 726 is the PROTECTION for this bug (a BEFORE UPDATE trigger that
-- stops a NULL-carrying federated op from clearing a populated completion
-- record). It repairs nothing. This is the repair.
--
-- ===========================================================================
-- WHAT WAS ACTUALLY DESTROYED — a per-column measurement, because three of the
-- four columns 726 protects turned out NOT to be damage at all.
-- ===========================================================================
-- 726's own header (and WI-7057's checkpoint before it) describes the loss as
-- "the completion quad": terminal_owner + terminal_completion_ref +
-- terminal_reason + authority. That is right about what the projection WRITES
-- and wrong about what it DESTROYED, and the difference decides what a repair
-- may legitimately touch. Measured on the live operator DB 2026-08-02, terminal
-- issue-family rows carrying payload._completionEvidence, split by origin and
-- authorship — cohort A is the control (no peer op ever touched these rows):
--
--   cohort                      n      owner   ref     reason  authority   (% NULL)
--   A local-origin, local-auth  1989    0.0%   28.1%   52.5%     71.3%   <- control
--   B local-origin, peer-auth    854   35.8%   93.4%   83.3%     42.3%   <- damaged
--   C remote-origin              1856  100.0%  100.0%  70.3%     99.9%   <- fed gap
--
--   · terminal_owner — 0.0% NULL on the control, 35.8% in the damaged cohort.
--     A column that is ALWAYS populated on the clean path and NULL on 306 rows
--     a peer touched is destruction, per row, with no inference required. This
--     is the one column this migration restores.
--   · terminal_completion_ref — 93.4% vs a 28.1% baseline. Real excess loss
--     (~558 rows), but the baseline is high enough that no INDIVIDUAL row can be
--     called damaged. Restored only where a ledger record supplies it, never
--     derived.
--   · terminal_reason — 83.3% vs 52.5%. Same shape, weaker. Not touched.
--   · authority — 42.3% NULL in the damaged cohort vs 71.3% on the control.
--     LOWER than baseline, i.e. NOT DESTROYED AT ALL. Never touched here.
--
-- That last one is the trap this migration exists to avoid walking into. The
-- obvious repair — "recompute authority from the surviving _completionEvidence
-- using migration 683's sufficiency rule" — looks free, because the evidence
-- blob survived on all 306 rows. It is wrong: on the control population that
-- rule predicts 'committed' for 2,020 rows of which 1,426 (70.6%) actually
-- store NULL. Applying it would have written a plausible, uniform, fabricated
-- value onto 306 rows and made them look BETTER-evidenced than the untouched
-- ones. NULL authority is the normal resting state here, not a wound.
--
-- This is the same red herring as `closed_ts` in WI-7057's own investigation
-- (77.3% of untouched terminal rows have a NULL closed_ts, which was nearly
-- reported as the smoking gun). Both were caught the same way: measure the
-- column on a population the bug never touched BEFORE calling its absence
-- damage.
--
-- ===========================================================================
-- HOW MUCH IS RECOVERABLE — 18 of 306, and the honest answer for the other 288
-- ===========================================================================
-- The only surviving record of WHO completed one of these items is
-- harness_shared.tool_invocations.args_json. Measured against the damaged set:
--
--   306  rows with terminal_owner destroyed
--    18  have a terminal-close invocation in the ledger  <- Part A repairs these
--   288  do not                                          <- Part B marks these
--
-- The ledger's own floor is 2026-07-19T08:02:55Z and these items were closed
-- before it. Two other candidate sources were checked and rejected, recorded
-- here so the next agent does not re-walk them:
--   · payload._completionAttestations — 0 of 306 carry one. (726's header says
--     5; that figure came from a wider population and does not hold for this
--     set. Corrected here.)
--   · harness_shared.audit_log — records work_items:claim_hold set/clear only.
--     It has never recorded a state transition, so it cannot attribute a close.
--   · harness_shared.claim_audit / work_item_claims — a claim is not a close,
--     and work_item_claims keeps only the LIVE claim (PK per item, deleted on
--     release), so neither carries the historical holder of a closed item.
--
-- We do not guess the 288. An attribution invented from "who probably closed
-- this" is exactly the failure mode of the original bug — a completion record
-- that reads as authoritative and is not — and 683 refused the same guess for
-- the same reason. Instead Part B STAMPS them, which converts a silent absence
-- into a recorded, queryable fact: an auditor reading one of these rows now
-- sees "attribution destroyed by WI-7057, closer unrecoverable" rather than
-- "closed by nobody", and the no-completion-record-suspicious bucket gains a
-- one-predicate honest exclusion instead of 288 permanent false positives.
--
-- ===========================================================================
-- WHAT THIS MIGRATION DOES NOT DO
-- ===========================================================================
--   · Lifecycle state is never touched. Every one of these items is
--     legitimately terminal; only the record of who completed it was lost.
--   · payload._completionEvidence is never touched. It is the surviving witness
--     that proved the damage; overwriting it would destroy the evidence.
--   · authority / terminal_reason are never written — see the measurement above.
--   · terminal_completion_ref is only ever filled when it is NULL and the ledger
--     supplies one. A surviving ref always wins.
--   · The remote-origin cohort (1,856 rows, 100% NULL) is OUT OF SCOPE. Those
--     replicas never HAD local attribution — completion attribution simply does
--     not federate. That is a separate gap, filed as EI-19364248626802623.
--
-- KNOWN, ACCEPTED CONSEQUENCE — stated rather than discovered later: both parts
-- write payload, and capture_work_items_issue_upd_trg enqueues a federation
-- outbox op on any payload change, so this migration emits ~306 outbox ops. That
-- is harmless (the ops carry no attribution today, and 726 now prevents a
-- returning op from re-clobbering us) but it is a visible burst on the
-- federation queue at apply time. Part A bumps updated_ts because the repaired
-- row is genuinely newer truth; Part B deliberately does NOT, because an
-- annotation must not win an LWW race against a peer's real update.
--
-- IDEMPOTENT: rows already carrying payload._terminalAttributionRepair (Part A)
-- or payload._attributionLoss (Part B) are skipped, so a re-run is a no-op. On a
-- database with no such damage this migration does nothing.

DO $wi7057$
DECLARE
  v_repaired INT := 0;
  v_marked   INT := 0;
  v_skipped  INT := 0;
  v_floor    TIMESTAMPTZ;
BEGIN
  -- Reuse the canonical terminal predicate (mig 698) rather than re-spelling the
  -- status set, so this cannot drift from what 726 and the rest of the schema
  -- agree "terminal" means.
  IF to_regprocedure('harness_shared.work_item_status_is_terminal(text)') IS NULL THEN
    RAISE EXCEPTION
      '729: harness_shared.work_item_status_is_terminal(text) not found — migration 698 must apply first';
  END IF;

  SELECT MIN(invoked_at) INTO v_floor
    FROM harness_shared.tool_invocations
   WHERE tool_name IN ('work_items:complete', 'work_items:set_state');

  -- -------------------------------------------------------------------------
  -- The damaged set. Every predicate here is load-bearing:
  --   origin='local'            — the item was CREATED here, so it HAD local
  --                               attribution. A remote replica never did.
  --   author_pubkey IS NOT NULL — a peer op wrote this row (local writes leave
  --                               it NULL by design, mig 214). This is what
  --                               separates cohort B from the clean control.
  --   terminal_owner IS NULL    — the column that is 0.0% NULL on the control.
  --   _completionEvidence       — the surviving witness proving a real
  --                               completion path ran and stamped the columns.
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE _729_damaged ON COMMIT DROP AS
  SELECT wi.workspace_id, wi.harness_slug, wi.feature_id
    FROM harness_shared.work_items wi
   WHERE wi.origin = 'local'
     AND wi.author_pubkey IS NOT NULL
     AND wi.terminal_owner IS NULL
     AND wi.item_kind IN ('bug', 'change', 'task')
     AND harness_shared.work_item_status_is_terminal(wi.status)
     AND COALESCE(wi.payload, '{}'::JSONB) ? '_completionEvidence'
     AND NOT (COALESCE(wi.payload, '{}'::JSONB) ? '_terminalAttributionRepair')
     AND NOT (COALESCE(wi.payload, '{}'::JSONB) ? '_attributionLoss');

  SELECT COUNT(*) INTO v_skipped
    FROM harness_shared.work_items wi
   WHERE COALESCE(wi.payload, '{}'::JSONB) ?| ARRAY['_terminalAttributionRepair', '_attributionLoss'];

  IF NOT EXISTS (SELECT 1 FROM _729_damaged) THEN
    RAISE NOTICE '729: no damaged rows found (% already marked by a previous run) — nothing to do.', v_skipped;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- Recoverable closers, extracted from the invocation ledger with the SAME five
  -- aliasing paths migration 683 documents. Missing any one of them silently
  -- undercounts evidence and can seat the wrong closer:
  --   1. completion as an object              -> completion.verifiedHow
  --   2. nested alias                         -> completion.verification.*
  --   3. `tests` as an alias for testsRun
  --   4. batch form                           -> items[].completion
  --   5. FLAT form — completion fields passed as TOP-LEVEL args with no
  --      `completion` wrapper (gatherFlatCompletion). When both are present the
  --      OBJECT wins; for the items[] batch form flat gathering is SKIPPED.
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE _729_closes ON COMMIT DROP AS
  WITH raw AS (
    SELECT ti.id AS inv_id,
           ti.invoked_at,
           ti.workspace_id,
           ti.coord_owner_id,
           -- tools:invoke dispatches server-side under the real tool name,
           -- nesting the real args one level down. Unwrap both shapes to one.
           CASE WHEN ti.tool_name = 'tools:invoke' THEN ti.args_json -> 'args' ELSE ti.args_json END AS a,
           CASE WHEN ti.tool_name = 'tools:invoke' THEN ti.args_json ->> 'name' ELSE ti.tool_name END AS tname
      FROM harness_shared.tool_invocations ti
     WHERE ti.status = 'ok'
       AND ti.coord_owner_id IS NOT NULL
       AND (
             ti.tool_name IN ('work_items:complete', 'work_items:set_state')
          OR (ti.tool_name = 'tools:invoke'
              AND ti.args_json ->> 'name' IN ('work_items:complete', 'work_items:set_state'))
           )
  ), expanded AS (
    SELECT r.inv_id,
           r.invoked_at,
           r.workspace_id,
           r.coord_owner_id,
           COALESCE(it ->> 'id', idv, r.a ->> 'id') AS item_id,
           COALESCE(it ->> 'state', r.a ->> 'state',
                    CASE WHEN r.tname = 'work_items:complete' THEN 'done' END) AS state,
           COALESCE(it ->> 'completionRef', r.a ->> 'completionRef') AS completion_ref,
           CASE
             WHEN it IS NOT NULL THEN
               CASE WHEN jsonb_typeof(it -> 'completion') = 'object' THEN it -> 'completion' ELSE '{}'::JSONB END
             ELSE
               COALESCE(CASE WHEN jsonb_typeof(r.a -> 'completion') = 'object' THEN r.a -> 'completion' END, '{}'::JSONB)
           END AS cobj,
           CASE WHEN it IS NULL THEN r.a ELSE '{}'::JSONB END AS flat
      FROM raw r
      LEFT JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(r.a -> 'items') = 'array' THEN r.a -> 'items' ELSE '[]'::JSONB END) it ON TRUE
      LEFT JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(r.a -> 'ids') = 'array' THEN r.a -> 'ids' ELSE '[]'::JSONB END) idv ON TRUE
  )
  SELECT e.inv_id,
         e.invoked_at,
         e.workspace_id,
         e.coord_owner_id,
         e.item_id,
         COALESCE(e.completion_ref,
                  e.cobj ->> 'summary',
                  e.flat ->> 'summary') AS completion_ref,
         -- 683's sufficiency bar, used ONLY to order competing closers. It is
         -- deliberately NOT written to `authority` — see the header.
         ( COALESCE(e.cobj ->> 'verifiedHow', e.flat ->> 'verifiedHow',
                    e.cobj -> 'verification' ->> 'verifiedHow',
                    e.flat -> 'verification' ->> 'verifiedHow') IS NOT NULL
           AND ( btrim(COALESCE(e.cobj ->> 'testsRun', e.flat ->> 'testsRun',
                                e.cobj -> 'verification' ->> 'testsRun',
                                e.cobj ->> 'tests', e.flat ->> 'tests', '')) <> ''
              OR btrim(COALESCE(e.cobj ->> 'testResult', e.flat ->> 'testResult',
                                e.cobj -> 'verification' ->> 'testResult', '')) <> '' ) ) AS sufficient
    FROM expanded e
   WHERE e.item_id IS NOT NULL
     AND harness_shared.work_item_status_is_terminal(e.state);

  -- One closer per damaged item: the guard's rule — the first SUFFICIENT close
  -- wins; absent any, the first close. A tie leaves the earlier record standing.
  CREATE TEMP TABLE _729_repairs ON COMMIT DROP AS
  SELECT DISTINCT ON (d.workspace_id, d.feature_id)
         d.workspace_id,
         d.harness_slug,
         d.feature_id,
         c.coord_owner_id AS win_owner,
         c.completion_ref AS win_ref,
         c.inv_id         AS win_inv,
         c.invoked_at     AS win_at
    FROM _729_damaged d
    JOIN _729_closes c
      ON c.workspace_id = d.workspace_id
     AND c.item_id      = d.feature_id
   ORDER BY d.workspace_id, d.feature_id, c.sufficient DESC, c.invoked_at, c.inv_id;

  -- -------------------------------------------------------------------------
  -- PART A — restore the evidenced closers.
  -- -------------------------------------------------------------------------
  UPDATE harness_shared.work_items wi
     SET terminal_owner = r.win_owner,
         -- A surviving ref always wins; we only ever fill a hole.
         terminal_completion_ref = COALESCE(wi.terminal_completion_ref, r.win_ref),
         payload = COALESCE(wi.payload, '{}'::JSONB)
           || jsonb_build_object('_terminalAttributionRepair', jsonb_build_object(
                'migration', '729',
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'restoredOwner', r.win_owner,
                'restoredFrom', 'harness_shared.tool_invocations',
                'restoredFromInvocation', r.win_inv,
                'closedAt', to_char(r.win_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'reason', 'WI-7057: terminal_owner was cleared by a federated op carrying NULL attribution (applyEngineerIssueOp ON CONFLICT DO UPDATE, before migration 726)'
              )),
         updated_ts = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
    FROM _729_repairs r
   WHERE wi.workspace_id = r.workspace_id
     AND wi.harness_slug = r.harness_slug
     AND wi.feature_id   = r.feature_id;

  GET DIAGNOSTICS v_repaired = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- PART B — mark the unrecoverable remainder. Columns are NOT touched, and
  -- updated_ts is deliberately left alone: this is an annotation, and an
  -- annotation must not win an LWW race against a peer's real update.
  -- -------------------------------------------------------------------------
  UPDATE harness_shared.work_items wi
     SET payload = COALESCE(wi.payload, '{}'::JSONB)
           || jsonb_build_object('_attributionLoss', jsonb_build_object(
                'migration', '729',
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'lostColumns', jsonb_build_array('terminal_owner'),
                'cause', 'WI-7057: a federated op carrying NULL attribution cleared this row''s completion record (applyEngineerIssueOp ON CONFLICT DO UPDATE, before migration 726)',
                'recoverable', FALSE,
                'why', 'no terminal-close invocation for this item survives in harness_shared.tool_invocations (ledger floor '
                       || COALESCE(to_char(v_floor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'unknown')
                       || '); payload._completionEvidence survived and remains authoritative for WHAT was verified',
                'note', 'this row was NOT closed without a completer — the completer record was destroyed. Exclude it from no-completion-record audits by this key rather than counting it as a suspicious close.'
              ))
    FROM _729_damaged d
   WHERE wi.workspace_id = d.workspace_id
     AND wi.harness_slug = d.harness_slug
     AND wi.feature_id   = d.feature_id
     AND NOT EXISTS (SELECT 1 FROM _729_repairs r
                      WHERE r.workspace_id = d.workspace_id
                        AND r.harness_slug = d.harness_slug
                        AND r.feature_id   = d.feature_id);

  GET DIAGNOSTICS v_marked = ROW_COUNT;

  RAISE NOTICE '729: restored terminal_owner on % work-item(s) from the invocation ledger; marked % as unrecoverable attribution loss; % row(s) already carried a marker (skipped).',
    v_repaired, v_marked, v_skipped;
END
$wi7057$;
