-- 688: issue-family CDC wire row — carry created_ts + the completion-integrity pair.
--
-- WI-6327 (RELEASE BLOCKER, p2p). `capture_work_items_outbox` hand-builds the ISSUE
-- family's wire row with `jsonb_build_object(...)` (unlike the FEATURE family, which
-- ships `to_jsonb(v_rec)` and therefore carries every column for free). Three columns
-- the receiving mapper (`toEngineerIssueValue`, feature-issue-op-keys.ts) READS were
-- never in that builder:
--
--   created_at / created_ts       terminal_owner       terminal_completion_ref
--
-- Verified against the live artifact, not the migration history:
--   SELECT (row ? 'created_at') FROM harness_shared.substrate_outbox
--    WHERE table_name='engineer_issues' ORDER BY id DESC LIMIT 5;   -- => all false
--   pg_get_functiondef(capture_work_items_outbox) contains neither 'created_at',
--   'terminal_owner' nor 'terminal_completion_ref'.
--
-- CONSEQUENCE 1 (the blocker). The mapper's `created_at` fallback —
--   created_at: typeof row.created_at === 'string' && row.created_at
--     ? row.created_at : new Date().toISOString()
-- documents itself as "defensive against a malformed op (a real row always carries
-- it)". That premise was false for the WHOLE issue family, so the fallback was not an
-- edge case, it was the ONLY branch ever taken: every issue op went on the wire
-- claiming it was created at drain time. The receiver's EI-13285 id-collision guard
-- then compared that fabricated "now" against the local row's real created_ts, found
-- them days apart, concluded "two distinct issues share this id", and DROPPED the op.
-- Net effect: an issue/task op could never be applied to a peer that already held the
-- row — new issues federated, every subsequent update was silently discarded. Observed
-- live on the P-302 rig 2026-07-27: 10,070 distinct issue_ids refused, ~1GB/hr of
-- collision warnings (98.4% of the sidecar log).
--
-- CONSEQUENCE 2 (silent, separate). `terminal_owner` / `terminal_completion_ref` — the
-- "who resolved it + what proves it" pair that work-item-completion-integrity-2026-07-01
-- (WI-1403 / EI-5269) added precisely SO a peer could see completion evidence — reached
-- every peer as NULL, because the mapper's `strOrNull(row.terminal_owner)` read a key
-- the capture never wrote. (`terminal_reason` WAS added, by mig 640, which is what makes
-- the omission of its two siblings a clear oversight rather than a design choice.)
--
-- FIX. Carry all three. `created_ts` (epoch ms bigint) is carried INSTEAD OF a
-- to_timestamp()'d `created_at` on purpose:
--   (a) it is the exact same unit and value as the `work_items.created_ts` column the
--       guard compares against, so the comparison is integer-vs-integer with no ISO
--       parse and no float round-trip through to_timestamp(bigint/1000.0);
--   (b) it is a key NO historical op can carry, which gives the receiver a reliable
--       "is this created-at authoritative?" discriminator. Ops already written to the
--       hypercore carry the FABRICATED created_at and are indistinguishable from a
--       genuine collision on timestamp alone; keying the guard on `created_ts` lets it
--       stay strict for post-fix ops while failing OPEN for legacy ones (which is the
--       behaviour those ops effectively had anyway, the guard having been a 100%
--       false-positive since the day it shipped). See engineer-issues.ts.
--   (c) it matches the FEATURE family, whose wire row already carries created_ts.
--
-- Idempotent: CREATE OR REPLACE of the trigger FUNCTION only. No DDL, no data change.
-- Body is mig 640's verbatim, with the three keys added to the issue-family builder.

CREATE OR REPLACE FUNCTION harness_shared.capture_work_items_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    DECLARE
      v_op     TEXT;
      v_rec    RECORD;
      v_ws     TEXT;
      v_slug   TEXT;
      v_scope  TEXT;
      v_tbl    TEXT;
      v_key    TEXT;
      v_row    JSONB;
      v_cnt    INT;
      v_op_hlc TEXT;
      v_ts     BIGINT;
    BEGIN
      IF TG_OP = 'DELETE' THEN v_op := 'del'; v_rec := OLD; ELSE v_op := 'put'; v_rec := NEW; END IF;

      -- Echo-loop guard: skip remote-origin writes (the projections' own applies).
      IF COALESCE(v_rec.origin, 'local') <> 'local' THEN RETURN v_rec; END IF;

      v_ws  := COALESCE(v_rec.workspace_id, '');
      v_key := v_rec.feature_id;

      IF v_rec.item_kind IN ('bug', 'change', 'task') THEN
        -- ── ISSUE family (mig 382). ─────────────────────────────────────────────────
        -- SU cross-workspace meta + unscoped rows have no single Pot to ride → local.
        IF v_ws = '' OR v_ws = '*' THEN RETURN v_rec; END IF;
        -- scope derived PURELY from harness_slug (D-003): operator:<ws> => operator;
        -- harness slug otherwise.
        v_scope := CASE WHEN v_rec.harness_slug LIKE 'operator:%' THEN 'operator'
                        ELSE 'harness:' || v_rec.harness_slug END;
        IF v_scope LIKE 'harness:%' THEN
          -- mig 452 (WI-900 M1): canonicalize the routing slug so a retired-slug
          -- write self-heals into its current pot instead of orphaning (mirrors
          -- capture_substrate_outbox, mig 359).
          v_slug := harness_shared.canonical_harness_slug(substr(v_scope, 9));
        ELSIF v_scope = 'operator' THEN
          -- Operator/Queen shared backlog rides the workspace's single Pot home.
          -- 0 or >1 Pot homes → ambiguous → stay local (multi-Pot pointer is a follow).
          -- mig 559: harness_shared.hives/home_slug renamed to pots/pot_home_slug (mig 557).
          SELECT count(*)::int, min(pot_home_slug) INTO v_cnt, v_slug
            FROM harness_shared.pots WHERE workspace_id = v_ws;
          IF v_cnt <> 1 THEN
            -- mig 454 (WI-1633 / WI-900 M2): make the drop OBSERVABLE — no outbox
            -- row is inserted for this op, so plan-drain-reconcile's stall detector
            -- (which only sees rows that DID reach substrate_outbox) can never
            -- flag it. A future listener/alert can act on this without polling
            -- for an absence.
            PERFORM pg_notify('substrate_outbox_gap', v_ws || '::operator::' || v_cnt::text);
            RETURN v_rec;
          END IF;
        ELSE
          RETURN v_rec;  -- unknown scope shape → local
        END IF;
        IF v_slug IS NULL OR v_slug = '' THEN RETURN v_rec; END IF;

        v_tbl := 'engineer_issues';
        v_row := jsonb_strip_nulls(jsonb_build_object(
          'workspace_id',      v_ws,
          'issue_id',          v_rec.feature_id,
          'scope',             v_scope,
          'title',             v_rec.title,
          'body',              COALESCE(v_rec.summary, ''),
          'severity',          COALESCE(v_rec.payload->'_ei'->>'severity', 'minor'),
          'source',            COALESCE(v_rec.payload->'_ei'->>'source', 'engineer'),
          'state',             v_rec.status,
          'terminal_reason',   v_rec.terminal_reason,
          -- WI-6327: the completion-integrity pair (WI-1403 / EI-5269). Federated so a
          -- peer sees WHO reached the terminal state and the evidence — until now the
          -- mapper read these keys and the capture never wrote them, so they landed
          -- NULL on every peer.
          'terminal_owner',           v_rec.terminal_owner,
          'terminal_completion_ref',  v_rec.terminal_completion_ref,
          -- WI-6327: the row's REAL creation instant, in the same unit as the
          -- work_items.created_ts column the receiver's EI-13285 guard compares
          -- against. Absent here, the drain fabricated new Date().toISOString() and
          -- the guard read every op as an id collision. Its presence is also the
          -- receiver's "authoritative created-at" discriminator vs pre-688 ops.
          'created_ts',        v_rec.created_ts,
          'assignee',          v_rec.taken_by,
          'assigned_by',       v_rec.payload->'_ei'->>'assigned_by',
          'assigned_at',       v_rec.taken_at,
          'found_during',      v_rec.payload->'_ei'->>'found_during',
          'linked_feature_id', v_rec.payload->'_ei'->>'linked_feature_id',
          'created_by',        v_rec.payload->'_ei'->>'created_by',
          'kind',              v_rec.item_kind,
          'payload',           (v_rec.payload - '_ei'),
          'origin',            v_rec.origin,
          'author_pubkey',     v_rec.author_pubkey,
          'fed_ts',            v_rec.fed_ts,
          'fed_hlc',           v_rec.fed_hlc,
          'signal_origin',     COALESCE(v_rec.payload->'_ei'->>'signal_origin', 'local'),
          'harness_slug',      v_slug));
      ELSE
        -- ── FEATURE family: original table_name + the (unchanged) hfc row shape. ──────
        v_tbl  := 'harness_features_consolidated';
        -- mig 452 (WI-900 M1): canonicalize — same rationale as the issue family above.
        v_slug := harness_shared.canonical_harness_slug(v_rec.harness_slug);
        v_row  := to_jsonb(v_rec);
      END IF;

      -- D-001 (EI-79): the op's HLC ordering key, threaded onto the wire op by the drain
      -- so the remote peer's projection materialises the SAME fed_hlc the author's local
      -- row carries (identical ordering key on BOTH peers → convergence). put → the row's
      -- fed_hlc (the mig-314 BEFORE-stamp value); del → a fresh hlc_now() (a del is a new
      -- event causally-after the row's last state; the OLD row's fed_hlc would
      -- under-stamp it).
      --
      -- mig 446: the wire ts gets the SAME one-clock treatment — a stamp-regime put
      -- (row carries fed_hlc ⇒ the BEFORE trigger stamped fed_ts atomically with it)
      -- threads the ROW's fed_ts so author + receivers persist the SAME fed_ts; now()
      -- here is the txn-START clock and permanently diverges from the row's
      -- clock_timestamp() stamp. Dels and unstamped rows keep now() (unchanged).
      IF v_op = 'del' THEN
        v_op_hlc := harness_shared.hlc_now();
        v_ts     := (extract(epoch from now()) * 1000)::bigint;
      ELSE
        v_op_hlc := v_rec.fed_hlc;
        v_ts     := CASE WHEN v_rec.fed_hlc IS NOT NULL
                         THEN COALESCE(v_rec.fed_ts, (extract(epoch from now()) * 1000)::bigint)
                         ELSE (extract(epoch from now()) * 1000)::bigint
                    END;
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
      VALUES
        (v_ws, v_slug, v_tbl, v_op, v_key, v_row, v_ts, v_op_hlc);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || COALESCE(v_slug, ''));
      RETURN v_rec;
    END;
    $function$;
