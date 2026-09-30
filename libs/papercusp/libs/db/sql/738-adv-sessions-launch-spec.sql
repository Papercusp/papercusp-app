-- 738-adv-sessions-launch-spec.sql
--
-- P-002 of stale-prompt-render-in-live-sessions-2026-08-02.
--
-- A carry-respawn (psu-pty-host recycleChild) rebuilds the child's argv from the
-- ORIGINAL argv and copies --system-prompt-file through verbatim, so a session's
-- base persona render is pinned to the FIRST launch of its chain forever: only
-- the carry document is refreshed. Measured 2026-08-02: 27 of 53 live claude
-- sessions were running a render up to 14 days old, i.e. every prompt fix landed
-- for roughly half the fleet.
--
-- Fixing that means RE-RENDERING at respawn, which means the operator has to be
-- able to replay the launch's resolved buildLaunchSpec inputs. They are not
-- stored anywhere today (only the literal psu invocation, in launch_argv, which
-- would have to be re-parsed — a fork of the bootstrap resolution logic). This
-- column is the resolved struct itself, written beside launch_argv by
-- bootstrap-su and read back by the persona-refresh endpoint keyed on
-- coord_owner_id (stable across every respawn by design; see mintRecycleArgs).
--
-- Nullable + additive: rows launched before this migration simply have no spec,
-- and the refresh endpoint fail-softs to the inherited render for them.
ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS launch_spec jsonb;

COMMENT ON COLUMN harness_shared.adv_sessions.launch_spec IS
  'Resolved su persona render inputs (SuLaunchSpecRecord) so a carry-respawn can re-render the launch context from current prompt sources instead of reusing the predecessor file.';
