-- WI-37571 — document the 'revived' loop-transition event in the column's own comment.
--
-- The `event` column is plain text with NO check constraint, so a new vocabulary member
-- needs no DDL to START WORKING. That is exactly why this comment matters: the comment IS
-- the schema's statement of what the vocabulary is, and it is what a reader consults before
-- writing a census query over this table.
--
-- This item exists because the reverse drift is expensive. `disarmed` was named in this very
-- comment (and in the TypeScript union) while NO code emitted it, so the table answered
-- "was this loop ever disarmed?" with silence for 26+ real disarms/day. Adding an event the
-- comment does not mention would be the same defect mirrored: a reader would query
-- event IN ('parked','rearmed','disarmed'), silently drop every revival, and conclude that
-- disarms are never reversed.
--
-- Comment-only. No data, no structure, no destructive DDL — nothing here can break the
-- currently-deployed release, which reads this table only through the code paths above.
COMMENT ON COLUMN harness_shared.routine_loop_transitions.event IS
  'parked = claimed and parked at the ''infinity'' in-flight sentinel (turn dispatched); '
  'rearmed = moved off ''infinity'' back to a concrete fire time; '
  'disarmed = deactivated (guard disarm / cost-cap / loop:end); '
  'revived = un-disarmed by the stalled-loops-guard revival pass — the only transition that '
  'crosses back over active = FALSE. A disarmed/revived PAIR is what makes the revival rate '
  'observable: without it, "the veto is working so nobody needed reviving" and "the revival '
  'pass never ran" are the same observation (zero).';
