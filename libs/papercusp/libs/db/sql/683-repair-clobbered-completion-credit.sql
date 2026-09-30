-- 683 — WI-6222: repair work-items whose COMPLETION CREDIT was reassigned by a
-- cross-owner second terminal close, before the EI-18736669939338784 guard landed.
--
-- WHAT WENT WRONG (the guard's own filing has the long form). Before the guard,
-- `setWorkItemState` stamped `terminal_owner` / `terminal_completion_ref` /
-- `authority` UNCONDITIONALLY on every terminal write. A second agent re-closing an
-- already-terminal item therefore took credit for the first agent's completion — and,
-- when their close carried a non-empty but thinner evidence object, overwrote the
-- first agent's `payload._completionEvidence` with it.
--
-- The worst rows are NOT the ones that lost evidence. They are the ones that kept
-- closer A's verification while crediting closer B: those read as a clean,
-- well-evidenced close and pass every audit we have, while presenting a verification
-- as having been performed by an agent who did not perform it. Nothing on the row
-- marks the seam. That is why this repairs ATTRIBUTION, not just evidence.
--
-- WHAT THIS MIGRATION DOES — it replays the landed guard retroactively and writes
-- exactly the outcome the guard would have produced, so a repaired row is
-- indistinguishable from a row the guard protected:
--
--   · the authoritative record becomes the FIRST close whose evidence meets the
--     `committed` bar (verifiedHow PLUS one of testsRun/testResult); if no close
--     meets it, the FIRST close stands. This is the guard's rule, NOT "first wins":
--     `upgrade = incomingSufficient && !existingSufficient`, and a TIE deliberately
--     leaves the earlier record standing (work-items.ts, isSecondTerminalClose).
--   · every other close is preserved under `payload._completionAttestations` in the
--     guard's own shape ({ at, by, state, completionRef, completionAuthority,
--     evidence, outcome }), newest-last, bounded to 5 — so NOTHING is destroyed by
--     this repair, including the record it displaces.
--   · lifecycle STATE is never touched. Every one of these items is legitimately
--     terminal; only who is credited, and with what evidence, was wrong.
--
-- EVIDENCE RECOVERY — the first closer's full structured record is still in
-- `harness_shared.tool_invocations.args_json`. Reading it back correctly requires
-- handling FIVE aliasing paths, and missing any one of them silently UNDERCOUNTS
-- evidence and mis-seats the winner:
--   1. `completion` as an object                    → completion.verifiedHow
--   2. nested alias                                 → completion.verification.verifiedHow
--   3. `tests` as an alias for testsRun             → completionEvidenceFromRecord
--   4. batch form                                   → items[].completion
--   5. FLAT form — completion fields passed as TOP-LEVEL args with no `completion`
--      wrapper, lifted by gatherFlatCompletion (completion-coerce.ts). When BOTH a
--      completion object and flat siblings are present the OBJECT wins
--      ({ ...flat, ...base }); for the items[] batch form flat gathering is SKIPPED
--      entirely. Path 5 is why an earlier pass concluded WI-6112's live
--      `verifiedHow:'unit'` was attributable to no logged actor — it was passed flat.
--
-- DELIBERATELY OUT OF SCOPE (each excluded below, none silently):
--   · rows whose live `terminal_owner` matches NO logged closer — those are
--     skipCompletionGate system-sweep writes, which the guard also exempts. Tracked
--     separately as WI-6218. We do not guess at attribution we cannot evidence.
--   · items with an intervening REOPEN between the closes — closer B genuinely
--     completed reopened work; that is not a clobber.
--   · items where any later close passed `force: true` — the guard exempts forced
--     closes, so overriding the earlier record was the caller's explicit intent.
--   · items whose close history may predate the tool_invocations retention window
--     (bounded by created_ts below) — a "first closer" we cannot see is a first
--     closer we must not overwrite.
--   · the FEATURE family (3 rows at time of writing). `harness_shared.work_items` is
--     the canonical store the guard itself writes attestations through for the ISSUE
--     family (bug/change/task), but `setWorkItemState`'s terminal write for features
--     targets `harness_features_consolidated`. Repairing a feature row here risks
--     writing the authoritative columns to a surface the feature path does not read
--     back, i.e. a silent divergence — the exact class of damage this migration
--     exists to undo. Left for a follow-up that establishes the feature-side write
--     surface first, rather than guessed at now.
--
-- IDEMPOTENT: rows already carrying `payload._completionCreditRepair` are skipped, so
-- a re-run is a no-op. On a database with no such damage this migration does nothing.

DO $repair$
DECLARE
  v_floor_ms  BIGINT;
  v_repaired  INT := 0;
  v_skipped   INT := 0;
BEGIN
  -- Retention floor of the invocation ledger, as epoch ms. An item created before
  -- this cannot have its full close history evidenced here, so it is left alone.
  SELECT (EXTRACT(EPOCH FROM MIN(invoked_at)) * 1000)::BIGINT
    INTO v_floor_ms
    FROM harness_shared.tool_invocations
   WHERE tool_name IN ('work_items:complete', 'work_items:set_state');

  IF v_floor_ms IS NULL THEN
    RAISE NOTICE '683: no tool_invocations ledger — nothing to repair.';
    RETURN;
  END IF;

  CREATE TEMP TABLE _683_closes ON COMMIT DROP AS
  WITH raw AS (
    SELECT ti.id AS inv_id,
           ti.invoked_at,
           ti.workspace_id,
           ti.coord_owner_id,
           -- tools:invoke dispatches server-side under the real tool name, nesting the
           -- real args one level down. Unwrap both shapes to one.
           CASE WHEN ti.tool_name = 'tools:invoke' THEN ti.args_json -> 'args' ELSE ti.args_json END AS a,
           CASE WHEN ti.tool_name = 'tools:invoke' THEN ti.args_json ->> 'name' ELSE ti.tool_name END AS tname
      FROM harness_shared.tool_invocations ti
     WHERE ti.status = 'ok'
       AND ti.coord_owner_id IS NOT NULL
       AND (
             ti.tool_name IN ('work_items:complete', 'work_items:set_state', 'work_items:claim', 'work_items:claim_next')
          OR (ti.tool_name = 'tools:invoke'
              AND ti.args_json ->> 'name' IN ('work_items:complete', 'work_items:set_state', 'work_items:claim', 'work_items:claim_next'))
           )
  ), expanded AS (
    SELECT r.inv_id,
           r.invoked_at,
           r.workspace_id,
           r.coord_owner_id,
           r.tname,
           COALESCE(it ->> 'id', idv, r.a ->> 'id') AS item_id,
           COALESCE(it ->> 'state', r.a ->> 'state',
                    CASE WHEN r.tname = 'work_items:complete' THEN 'done' END) AS state,
           COALESCE((it ->> 'force')::BOOLEAN, (r.a ->> 'force')::BOOLEAN, FALSE) AS forced,
           -- Path 4/5: the batch form takes ONLY its per-item completion (gatherFlatCompletion
           -- bails when args.items is present); the single form merges flat siblings under the
           -- completion object, with the object winning.
           CASE
             WHEN it IS NOT NULL THEN
               CASE WHEN jsonb_typeof(it -> 'completion') = 'object' THEN it -> 'completion' ELSE '{}'::JSONB END
             ELSE
               COALESCE(CASE WHEN jsonb_typeof(r.a -> 'completion') = 'object' THEN r.a -> 'completion' END, '{}'::JSONB)
           END AS cobj,
           CASE WHEN it IS NULL THEN r.a ELSE '{}'::JSONB END AS flat,
           COALESCE(it ->> 'completionRef', r.a ->> 'completionRef') AS completion_ref
      FROM raw r
      LEFT JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(r.a -> 'items') = 'array' THEN r.a -> 'items' ELSE '[]'::JSONB END) it ON TRUE
      LEFT JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(r.a -> 'ids') = 'array' THEN r.a -> 'ids' ELSE '[]'::JSONB END) idv ON TRUE
  ), typed AS (
    SELECT e.*,
           CASE WHEN e.state IN ('done', 'passed', 'resolved', 'closed', 'dropped', 'deprecated')
                THEN 'terminal' ELSE 'reopen' END AS kind,
           COALESCE(e.cobj -> 'verification', e.flat -> 'verification') AS vobj
      FROM expanded e
     WHERE e.item_id IS NOT NULL
  )
  SELECT t.inv_id,
         t.invoked_at,
         t.workspace_id,
         t.coord_owner_id,
         t.item_id,
         t.state,
         t.forced,
         t.kind,
         t.completion_ref,
         -- Paths 1/2/3/5 folded into one extraction, mirroring completionEvidenceFromRecord.
         COALESCE(t.cobj ->> 'verifiedHow', t.flat ->> 'verifiedHow', t.vobj ->> 'verifiedHow') AS v_how,
         COALESCE(t.cobj ->> 'testsRun', t.flat ->> 'testsRun', t.vobj ->> 'testsRun',
                  t.cobj ->> 'tests', t.flat ->> 'tests') AS v_run,
         COALESCE(t.cobj ->> 'testResult', t.flat ->> 'testResult', t.vobj ->> 'testResult') AS v_res,
         COALESCE(t.cobj -> 'filesChanged', t.flat -> 'filesChanged', t.vobj -> 'filesChanged') AS v_files,
         COALESCE(t.cobj -> 'addedTests', t.flat -> 'addedTests', t.vobj -> 'addedTests') AS v_added,
         COALESCE(t.cobj ->> 'summary', t.flat ->> 'summary') AS v_summary
    FROM typed t;

  CREATE TEMP TABLE _683_ranked ON COMMIT DROP AS
  SELECT c.*,
         (c.v_how IS NOT NULL
          AND (btrim(COALESCE(c.v_run, '')) <> '' OR btrim(COALESCE(c.v_res, '')) <> '')) AS sufficient,
         row_number() OVER (PARTITION BY c.workspace_id, c.item_id ORDER BY c.invoked_at, c.inv_id) AS rn
    FROM _683_closes c
   WHERE c.kind = 'terminal';

  CREATE TEMP TABLE _683_repairs ON COMMIT DROP AS
  WITH first_close AS (
    SELECT * FROM _683_ranked WHERE rn = 1
  ), cross_owner AS (
    -- The earliest cross-owner SECOND close: the moment credit could have moved.
    SELECT r.workspace_id, r.item_id, MIN(r.invoked_at) AS second_at
      FROM _683_ranked r
      JOIN first_close f ON f.workspace_id = r.workspace_id AND f.item_id = r.item_id
     WHERE r.rn > 1 AND r.coord_owner_id <> f.coord_owner_id
     GROUP BY r.workspace_id, r.item_id
  ), reopened AS (
    -- An intervening reopen makes the later close legitimate, not a clobber.
    SELECT DISTINCT co.workspace_id, co.item_id
      FROM cross_owner co
      JOIN first_close f ON f.workspace_id = co.workspace_id AND f.item_id = co.item_id
      JOIN _683_closes e ON e.workspace_id = co.workspace_id
                        AND e.item_id = co.item_id
                        AND e.kind = 'reopen'
                        AND e.invoked_at > f.invoked_at
                        AND e.invoked_at < co.second_at
  ), forced AS (
    SELECT DISTINCT workspace_id, item_id FROM _683_ranked WHERE rn > 1 AND forced
  ), candidates AS (
    SELECT co.workspace_id, co.item_id
      FROM cross_owner co
     WHERE NOT EXISTS (SELECT 1 FROM reopened rp WHERE rp.workspace_id = co.workspace_id AND rp.item_id = co.item_id)
       AND NOT EXISTS (SELECT 1 FROM forced fo WHERE fo.workspace_id = co.workspace_id AND fo.item_id = co.item_id)
  ), winner AS (
    -- The guard's rule: first SUFFICIENT close wins; absent any, the first close.
    SELECT DISTINCT ON (r.workspace_id, r.item_id)
           r.workspace_id, r.item_id, r.inv_id AS win_inv, r.coord_owner_id AS win_owner,
           r.completion_ref AS win_ref, r.sufficient AS win_sufficient,
           r.v_how, r.v_run, r.v_res, r.v_files, r.v_added, r.v_summary
      FROM _683_ranked r
      JOIN candidates c ON c.workspace_id = r.workspace_id AND c.item_id = r.item_id
     ORDER BY r.workspace_id, r.item_id, r.sufficient DESC, r.rn
  )
  SELECT w.*,
         wi.terminal_owner        AS live_owner,
         wi.terminal_completion_ref AS live_ref,
         wi.authority             AS live_authority,
         wi.payload               AS live_payload,
         wi.harness_slug
    FROM winner w
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = w.workspace_id AND wi.feature_id = w.item_id
   WHERE wi.terminal_owner IS NOT NULL
     -- ISSUE family only — see the feature-family exclusion in the header.
     AND wi.item_kind IN ('bug', 'change', 'task')
     -- Credit currently sits with a DIFFERENT principal than the guard would seat.
     AND wi.terminal_owner <> w.win_owner
     -- ...and that principal is one we can see closing it. If it is not, this is a
     -- skipCompletionGate system write (WI-6218), not an agent-vs-agent clobber.
     AND EXISTS (SELECT 1 FROM _683_ranked r2
                  WHERE r2.workspace_id = w.workspace_id AND r2.item_id = w.item_id
                    AND r2.coord_owner_id = wi.terminal_owner)
     -- The whole close history must be inside the ledger we can read.
     AND wi.created_ts >= v_floor_ms
     -- Idempotency.
     AND NOT (COALESCE(wi.payload, '{}'::JSONB) ? '_completionCreditRepair');

  SELECT COUNT(*) INTO v_repaired FROM _683_repairs;

  SELECT COUNT(*) INTO v_skipped
    FROM harness_shared.work_items wi
   WHERE COALESCE(wi.payload, '{}'::JSONB) ? '_completionCreditRepair';

  UPDATE harness_shared.work_items wi
     SET terminal_owner = r.win_owner,
         terminal_completion_ref = COALESCE(r.win_ref, r.v_summary, wi.terminal_completion_ref),
         -- P-004's judgement, recomputed for the record that now stands.
         authority = CASE WHEN r.win_sufficient THEN 'committed' ELSE 'proposed' END,
         payload = jsonb_strip_nulls(
           COALESCE(wi.payload, '{}'::JSONB)
           -- Restore the winner's structured evidence as authoritative.
           || jsonb_build_object('_completionEvidence', jsonb_strip_nulls(jsonb_build_object(
                'verifiedHow',  r.v_how,
                'testsRun',     r.v_run,
                'testResult',   r.v_res,
                'filesChanged', r.v_files,
                'addedTests',   r.v_added
              )))
           -- Preserve the record this repair DISPLACES, in the guard's own shape, so the
           -- repair is additive: the displaced closer's claim remains readable and the
           -- change is reversible from the row itself.
           || jsonb_build_object('_completionAttestations',
                COALESCE(
                  (SELECT jsonb_agg(x) FROM (
                     SELECT x FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(wi.payload -> '_completionAttestations') = 'array'
                            THEN wi.payload -> '_completionAttestations' ELSE '[]'::JSONB END) x
                      OFFSET GREATEST(0, jsonb_array_length(
                       CASE WHEN jsonb_typeof(wi.payload -> '_completionAttestations') = 'array'
                            THEN wi.payload -> '_completionAttestations' ELSE '[]'::JSONB END) - 4)
                   ) t),
                  '[]'::JSONB)
                || jsonb_build_array(jsonb_build_object(
                     'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     'by', r.live_owner,
                     'state', wi.status,
                     'completionRef', r.live_ref,
                     'completionAuthority', r.live_authority,
                     'evidence', wi.payload -> '_completionEvidence',
                     -- `superseded`: this record WAS authoritative and is being replaced by
                     -- one that outranks it under the guard's rule. Archived, not deleted.
                     'outcome', 'superseded'
                   )))
           || jsonb_build_object('_completionCreditRepair', jsonb_build_object(
                'migration', '683',
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'previousOwner', r.live_owner,
                'previousAuthority', r.live_authority,
                'restoredFromInvocation', r.win_inv,
                'reason', 'WI-6222: credit reassigned by a cross-owner second terminal close before the EI-18736669939338784 guard landed'
              ))
         ),
         updated_ts = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
    FROM _683_repairs r
   WHERE wi.workspace_id = r.workspace_id
     AND wi.feature_id = r.item_id;

  RAISE NOTICE '683: repaired % work-item(s) whose completion credit was reassigned; % already repaired (skipped).',
    v_repaired, v_skipped;
END
$repair$;
