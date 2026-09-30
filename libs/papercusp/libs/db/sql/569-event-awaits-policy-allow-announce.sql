-- 569-event-awaits-policy-allow-announce.sql
-- Announced gate events (fleet-member-native-guidance-2026-07-10 P-010, EI-9270) —
-- the MISSING half of migration 550.
--
-- 550 added scope_kind/scope_ref and taught the code an `announce` await policy
-- (types.ts AwaitPolicy = 'wake' | 'notify' | 'announce'; registerAnnouncement
-- INSERTs policy='announce'), but LEFT the DB CHECK constraint from migration 163
-- untouched:  CHECK (policy IN ('wake', 'notify')).  So every events:emit
-- { announce:true } threw `event_awaits_policy_check` violation in production —
-- the feature was dead on arrival. The unit tests mock the store, so they never
-- exercised the real INSERT and could not catch the drift; a post-deploy LIVE
-- smoke (WI-3960) did.
--
-- Lesson (recorded as an EI): a migration that widens a code-level enum backing a
-- CHECK-constrained column MUST widen the CHECK in the same migration.
--
-- The new value set is a SUPERSET of the old, so validating existing rows (all
-- 'wake'/'notify') always passes. Idempotent: DROP IF EXISTS + ADD. A brief
-- ACCESS EXCLUSIVE lock + one validating scan; no table rewrite.

ALTER TABLE harness_shared.event_awaits
  DROP CONSTRAINT IF EXISTS event_awaits_policy_check;

ALTER TABLE harness_shared.event_awaits
  ADD CONSTRAINT event_awaits_policy_check
  CHECK (policy IN ('wake', 'notify', 'announce'));
