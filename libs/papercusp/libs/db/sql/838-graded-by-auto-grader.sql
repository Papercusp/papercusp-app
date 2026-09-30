-- 838-graded-by-auto-grader.sql — retire the legacy 'Queen' auto-grader
-- attribution (WI-39481 / P-009, Learning-tab vocab retirement).
--
-- graded_by (mig 234) now carries the neutral machine id 'auto-grader' for
-- Mug-context auto-grades (deriveGradedBy in agent-tools/scout/grade-idea.ts);
-- identified agents keep writing their resolved ownerId and 'owner' stays the
-- human-surface fallback. Data-only migration: no schema change, so the
-- currently-deployed release keeps working (it never branches on the 'Queen'
-- literal — sovereignty checks compare 'owner' only; the UI maps the value
-- through graderLabel, which tolerates unknown values by rendering them raw).

UPDATE harness_shared.scout_routed_ideas
   SET graded_by = 'auto-grader'
 WHERE graded_by = 'Queen';
