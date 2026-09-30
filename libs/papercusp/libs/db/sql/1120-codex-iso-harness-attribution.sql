-- 1120: resolve harness_slug for CODEX isolation-root usage samples (WI-2144763).
--
-- This is the second half of the interactive writer fix that 1119 began, and it
-- exists because 1119's own coverage claim was OPTIMISTIC in a way only the live
-- data revealed. Read the measurement before the code.
--
-- WHAT 1119 ACTUALLY ACHIEVED (measured 2026-09-05T02:46Z, papercusp-workspace).
-- 1119 went live at 01:52:36Z and is genuinely working -- the writer moved from
-- 0.00% attribution to a real, still-climbing number. But on the population it
-- has actually seen since going live:
--
--   rows since 01:52:36Z   306
--   stamped                226   (73.86%)
--   unstamped               80   (26.14%)
--
-- 73.86% is the honest figure. It is not 100%, and nothing downstream should be
-- written as though the interactive writer is now fully attributed.
--
-- WHERE THE REMAINING 26% COMES FROM. Decomposing the 63 distinct unstamped
-- sessions by the transcript root that produced them:
--
--   codex-iso     58   (~92% of the gap)
--   claude-iso     5
--
-- That is not a resolver failure -- it is a WIRING gap, and 1119's own header
-- predicted it without noticing the size: `ingestInteractiveUsage` builds the
-- `claude-iso-*` adapters WITH an `ownerId` lifted from the root path, and the
-- `codex-iso-*` adapters WITHOUT one. So every psu-launched codex session fell
-- straight through the owner route onto the adv_sessions session fallback, which
-- 1119 measured at 7.8% for exactly this reason.
--
-- WHY THE SESSION FALLBACK CANNOT RESCUE THEM. Of the 63 unstamped sessions only
-- 10 appear in adv_sessions under their sample's `session_id` at all; the other
-- 53 are absent, so the fallback has no row to join to. Codex names its rollouts
-- `rollout-<ts>-<uuid>.jsonl` and the adapter stores that trailing uuid, which is
-- not the key adv_sessions is indexed by for these sessions.
--
-- THE KEY THAT WORKS, AND WHY IT NEEDS NO JOIN TO DISCOVER. A psu-launched codex
-- session runs under a per-session CODEX_HOME shaped
-- `~/.papercusp/su-codex-homes/session-<advId>/`, and `<advId>` is literally
-- `adv_sessions.id` -- the bigint PRIMARY KEY. The ingester already walks that
-- directory to find the transcripts, so the primary key is in hand at INSERT
-- time, for free, exactly as the coord owner id is for the claude isolation
-- roots. This is the same insight as 1119 (prefer what the PATH already carries
-- over a join that cannot answer), applied to the adapter 1119 left unwired.
--
-- MEASURED COVERAGE OF THIS ROUTE, before it was written (the check that decided
-- the design rather than justifying it afterwards):
--
--   codex-iso unstamped sessions        58
--   ... with an adv_sessions row on id  58   (100.0%)
--   ... with a coord_owner_id           58   (100.0%)
--   ... resolving to a harness_slug     44   ( 75.9%)
--
-- So this recovers 44 of the 58, not all of them. The residual 14 have a real
-- adv_sessions row and a real coord owner whose session_briefs simply carry no
-- harness_slug -- no join can invent one, and this migration does not pretend to.
-- Projected effect on the live window above: 226/306 -> ~270/306 (~88%), still
-- short of 100% and deliberately stated that way.
--
-- ADDITIVE ONLY. This creates a NEW 4-argument overload and leaves the existing
-- 3-argument function untouched, because the currently-deployed release checkout
-- still calls the 3-arg form -- dropping or re-signing it would break interactive
-- ingest on :3070 the moment this applied, hours before the new code ships. The
-- two coexist unambiguously (different arity, no DEFAULT on the new parameter, so
-- no overload-resolution ambiguity). No destructive DDL, hence no FORWARD-COMPAT
-- acknowledgment is required.
--
-- NO INDEX, for the reason 1119 recorded at length: the adv_sessions PK and
-- `session_briefs.owner_id` are already indexed, so this route is a PK lookup
-- plus an indexed lookup and needs nothing new. A plain CREATE INDEX on
-- agent_usage_samples remains a real hazard on a continuously-written table.

CREATE OR REPLACE FUNCTION harness_shared.harness_slug_for_usage_attribution(
  p_workspace_id text,
  p_owner_id text,
  p_session_id text,
  p_adv_session_id bigint
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    -- 1. PRIMARY (83.4% owner coverage): the coord owner id lifted straight from
    --    a claude isolation transcript path. No join. Unchanged from 1119.
    (
      SELECT b.harness_slug
        FROM harness_shared.session_briefs b
       WHERE b.owner_id = p_owner_id
         AND b.workspace_id = p_workspace_id
         AND b.harness_slug IS NOT NULL
       ORDER BY b.updated_at DESC
       LIMIT 1
    ),
    -- 2. NEW (75.9% measured on the codex gap): the adv_sessions PRIMARY KEY
    --    carried by the per-session CODEX_HOME directory name. Ranked above the
    --    session route because it is a primary-key lookup on a value taken from
    --    the path, whereas route 3 depends on the rollout uuid matching
    --    adv_sessions.session_id -- which, for these sessions, it does not.
    (
      SELECT b.harness_slug
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.session_briefs b
          ON b.owner_id = a.coord_owner_id
         AND b.workspace_id = p_workspace_id
       WHERE a.id = p_adv_session_id
         AND b.harness_slug IS NOT NULL
       ORDER BY b.updated_at DESC
       LIMIT 1
    ),
    -- 3. LAST RESORT (7.8%): the native session route, for adapters whose root
    --    carries neither an owner nor an adv id (the global, non-isolation roots).
    (
      SELECT b.harness_slug
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.session_briefs b
          ON b.owner_id = a.coord_owner_id
         AND b.workspace_id = p_workspace_id
       WHERE a.session_id = p_session_id
         AND b.harness_slug IS NOT NULL
       ORDER BY b.updated_at DESC
       LIMIT 1
    )
  )
$$;

COMMENT ON FUNCTION harness_shared.harness_slug_for_usage_attribution(text, text, text, bigint) IS
  'Resolve write-time harness provenance for a usage sample. Precedence: coord owner id from a claude isolation path (83.4%), then the adv_sessions PK from a per-session CODEX_HOME dir name (75.9% measured on the codex gap), then the adv_sessions session route (7.8%). NULL when none resolve -- ~14 of 58 measured codex sessions have no harness_slug on any brief and are genuinely unattributable by join (WI-2144763).';
