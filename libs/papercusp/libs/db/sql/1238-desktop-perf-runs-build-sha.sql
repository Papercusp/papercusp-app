-- A desktop-perf run must say WHICH BUILD it measured, not only when that build's
-- file was written. `git_sha` is the checkout HEAD at run time, which is a
-- different fact: the packaged binary under test can be days older than the
-- checkout (WI-10003815 measured a 12-day-old binary). The release gate needs the
-- build's own source identity to tell a measurement of the candidate from a
-- measurement of something else (plan desktop-perf-measure-candidate-build-2026-09-29,
-- D-001 / P-001). NULL means the identity is unknown (a build that recorded none),
-- and the gate then falls back to the file-mtime rule.
ALTER TABLE harness_shared.desktop_perf_runs
  ADD COLUMN IF NOT EXISTS build_sha text;
