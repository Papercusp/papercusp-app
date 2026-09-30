-- 823: retire the permanently idle legacy `kind = 'work'` intake path.
--
-- V1 delegation is seat discovery -> signed spawn_request -> projection honor.
-- No production publisher ever authored a `work` offer, so the 30-second
-- p2p-work-intake routine was scheduled work with a permanent zero yield. The
-- action and schema branch retire with this migration.
--
-- Keep signed offer bytes immutable. Historical rows are not rewritten or
-- deleted: local_disposition is the store's deliberately unsigned,
-- non-federated host-local refusal column (migration 490). Existing non-null
-- dispositions remain untouched.

\set ON_ERROR_STOP on

UPDATE harness_shared.routines
   SET active = false,
       next_fire_at = NULL,
       updated_at = now()
 WHERE name = 'p2p-work-intake'
    OR target_role = 'system:p2p-work-intake';

UPDATE harness_shared.p2p_work_offers
   SET local_disposition = 'retired:legacy_work_kind'
 WHERE offer_kind = 'work'
   AND local_disposition IS NULL;
