-- 726 — WI-7057: a federated op carrying NULL attribution must not CLEAR a
-- populated completion record on a work-item that stays terminal.
--
-- WHAT WENT WRONG ------------------------------------------------------------
-- `applyEngineerIssueOp`
-- (packages/operator-core/lib/sync/hyperbee/projections/engineer-issues.ts)
-- upserts a federated issue op with:
--
--     ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
--       ...
--       terminal_owner          = EXCLUDED.terminal_owner,
--       terminal_completion_ref = EXCLUDED.terminal_completion_ref,
--       terminal_reason         = EXCLUDED.terminal_reason,
--       authority               = EXCLUDED.authority
--
-- Every one of those is UNCONDITIONAL. A peer whose copy of an item never
-- learned the completion attribution sends those four columns as NULL, and the
-- op — once it wins the `fed_apply_wins` LWW guard, which it legitimately can,
-- because it is genuinely NEWER — overwrites a populated LOCAL completion
-- record with NULLs.
--
-- The damage is invisible from the row afterwards. `origin` stays 'local' (the
-- preserve-origin trigger, mig 513/514), `status` stays terminal, and the item
-- reads as a perfectly ordinary close that simply has no completer. It was
-- found only because the sweep does NOT clear `payload._completionEvidence`:
-- the surviving evidence blob proves the columns HAD been populated. That
-- untouched witness is the only reason this was provable at all.
--
-- MEASURED BLAST RADIUS (2026-08-02, live operator DB). Terminal issue-family
-- rows, evidence-bearing / of those with terminal_owner IS NULL:
--
--   remote + peer-authored : 1856 / 1856 = 100.0%   <- NOT this bug. Replicas of
--       items completed on another node; terminal attribution simply never
--       federates for them. A separate, lower-severity federation GAP.
--   local  + peer-authored :  306 /  849 =  36.0%   <- THIS BUG. Locally-created
--       items whose row a peer op overwrote. 282 of them in a single 37-second
--       burst at 01:54:40-01:55:17Z from one peer (pubkey 3229ad4b3b994b12).
--   local  + local-authored:    0 / 1941 =   0.0%   <- the control. The LOCAL
--       write path never loses attribution (its WI-6218 / mig-683 guard works).
--
-- That 0.0% local baseline is what makes 36% mean something. Read alone, a raw
-- count of NULL terminal_owner rows is not evidence of anything: 77.3% of
-- terminal rows outside the burst window have a NULL closed_ts too, and that is
-- entirely normal. Only the origin-split comparison isolates the real signal.
--
-- WHY A TRIGGER AND NOT A COALESCE IN THE PROJECTION -------------------------
-- Same argument mig 698 makes for `closed_ts`, and it is the whole point of
-- fixing it here: the projection is not the only writer, merely the one caught.
-- `harness_shared.work_items` is written by the issue-family compat view's
-- INSTEAD OF trigger, the features projection, the DBOS finalizer, ad-hoc
-- repair migrations, and any future sync path. Patching the one call site that
-- was observed doing this leaves the invariant resting on every future writer
-- remembering it — which is exactly the state that produced this bug. A BEFORE
-- trigger makes it structurally impossible instead.
--
-- THE RULE — deliberately narrow, three properties worth stating explicitly:
--
--   1. It only ever converts a NULL back into the value already on the row. It
--      never invents, and never overrides a value the incoming op actually
--      carries, so a genuine completion always wins.
--   2. It applies ONLY while the row stays terminal on both sides. A real
--      REOPEN (terminal -> non-terminal) still clears the triple, because for a
--      reopened item a stale completer is worse than an absent one.
--   3. It does NOT touch the LWW guard. A populated-vs-populated conflict is
--      still decided entirely by `fed_apply_wins`, which already hashes all
--      four of these columns into its content digest (EI-16756, mig 708/D-035).
--      This trigger only removes NULL from the set of things that can win.
--
-- KNOWN, ACCEPTED CONSEQUENCE — replica divergence, stated plainly rather than
-- discovered later: after this lands, a local row keeps an attribution that the
-- sending peer does not have, so the two replicas disagree on those columns
-- until the peers federate the triple properly (that is the remote+peer 100%
-- row above, and is tracked separately). This is the correct trade: the columns
-- are a completion-integrity ATTRIBUTION record, and converging them to NULL
-- destroys audit evidence to achieve agreement. Preserving real evidence beats
-- agreeing on its absence.
--
-- Idempotent: CREATE OR REPLACE + DROP/CREATE TRIGGER. Re-running is a no-op.
-- This migration is pure protection — it repairs no existing row. The 306
-- damaged rows need a separate backfill sourced from
-- harness_shared.tool_invocations.args_json (only 5 of them carry a
-- payload._completionAttestations record to recover from), the same source and
-- the same five aliasing paths migration 683 documents.

-- ---------------------------------------------------------------------------
-- 1. Precondition: the canonical terminal-status predicate (mig 698) must exist.
--    Reused rather than re-spelled so this trigger cannot drift from the
--    canonical set the rest of the schema agrees on.
-- ---------------------------------------------------------------------------
DO $pre726$
BEGIN
  IF to_regprocedure('harness_shared.work_item_status_is_terminal(text)') IS NULL THEN
    RAISE EXCEPTION
      '726: harness_shared.work_item_status_is_terminal(text) not found — migration 698 must apply first';
  END IF;
END
$pre726$;

-- ---------------------------------------------------------------------------
-- 2. The guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION harness_shared.preserve_work_item_terminal_attribution()
RETURNS trigger
LANGUAGE plpgsql
AS $fn726$
BEGIN
  -- Only defend a row that was terminal and STAYS terminal. A reopen is allowed
  -- to clear the completion record (property 2 in the header).
  IF harness_shared.work_item_status_is_terminal(OLD.status)
     AND harness_shared.work_item_status_is_terminal(NEW.status)
  THEN
    -- COALESCE, never an overwrite: an incoming non-NULL always wins, so a
    -- genuine re-completion and the LWW guard both behave exactly as before.
    NEW.terminal_owner          := COALESCE(NEW.terminal_owner,          OLD.terminal_owner);
    NEW.terminal_completion_ref := COALESCE(NEW.terminal_completion_ref, OLD.terminal_completion_ref);
    NEW.authority               := COALESCE(NEW.authority,               OLD.authority);
    NEW.terminal_reason         := COALESCE(NEW.terminal_reason,         OLD.terminal_reason);
  END IF;

  RETURN NEW;
END
$fn726$;

COMMENT ON FUNCTION harness_shared.preserve_work_item_terminal_attribution() IS
  'WI-7057: prevents a write carrying NULL completion attribution from clearing a populated '
  'terminal_owner/terminal_completion_ref/authority/terminal_reason while the work-item stays '
  'terminal. Federated ops from a peer that never learned the attribution were silently '
  'destroying local completion records (306 rows). COALESCE only — an incoming non-NULL always '
  'wins, so fed_apply_wins LWW resolution is unchanged. A genuine reopen still clears the triple.';

DROP TRIGGER IF EXISTS preserve_work_item_terminal_attribution_trg ON harness_shared.work_items;
CREATE TRIGGER preserve_work_item_terminal_attribution_trg
  BEFORE UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.preserve_work_item_terminal_attribution();

-- ---------------------------------------------------------------------------
-- 3. Post-condition: fail loudly rather than half-apply.
-- ---------------------------------------------------------------------------
DO $post726$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c     ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'work_items'
       AND t.tgname  = 'preserve_work_item_terminal_attribution_trg'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '726: post-condition failed — preserve_work_item_terminal_attribution_trg is not installed on harness_shared.work_items';
  END IF;
END
$post726$;
