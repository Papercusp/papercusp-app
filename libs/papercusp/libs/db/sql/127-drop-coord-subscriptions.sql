-- Migration 127 — drop the retired path-glob coord_subscriptions table.
--
-- Plan: coordination-substrate-2026-06-03 (Phase 3 — retire coord:watch).
--
-- The legacy `coord:watch` path-glob subscription model + its fireNotifications
-- firehose are retired (the entity/topic substrate — coord_topics /
-- coord_entity_subscriptions, mig 123 — replaces them). With the operator
-- watch model (subscriptions.ts), the watch tools, and the @papercusp/coordination
-- subscription-store seam all deleted, this table has no remaining reader/writer,
-- so it is dropped here.
--
-- Safe plain DROP (no CASCADE): a repo-wide grep confirms no function / trigger /
-- view body references coord_subscriptions — it was only ever read/written by the
-- now-deleted application code. The PK + coord_subscriptions_owner_active index
-- drop with the table.
--
-- Idempotent: DROP TABLE IF EXISTS. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS harness_shared.coord_subscriptions;

COMMIT;
