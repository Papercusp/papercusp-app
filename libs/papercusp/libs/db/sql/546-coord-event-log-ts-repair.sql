-- 546-coord-event-log-ts-repair.sql
-- WI-3826 (fleet-reliability-verification-2026-07-10): harness_shared.coord_event_log's `ts`
-- column diverged from the envelope's own `body->>'ts'` by >1s on ~4.3% of `messages`-surface
-- rows (2,317 / 53,560 sampled). Root cause: `appendLine` relied on the column's DEFAULT now()
-- at INSERT time, but `sendMessage` builds the envelope (stamping `ts`) and THEN awaits
-- audience-selector expansion + hive-scope resolution BEFORE the INSERT actually executes — a
-- slow resolve step let the column drift past the envelope's own timestamp. Any `WHERE ts >=
-- $since` SQL pushdown (the optimization this bug was found while designing) would SILENTLY
-- DROP those rows, since application code (filterInbox) has always compared against body.ts.
--
-- The write path (packages/coordination/src/event-log/pg-log.ts appendLine) now stamps `ts`
-- explicitly from the envelope's own `ts` field, so column and body agree BY CONSTRUCTION for
-- every future row. This migration is the one-time BACKFILL for rows written before that fix:
-- repair `ts` from `body->>'ts'` wherever they disagree by more than 1 second, using body as the
-- source of truth (it is what application code has always trusted).
--
-- Idempotent; safe to re-run — a repaired row has zero drift and is excluded by the WHERE on
-- every subsequent run.

UPDATE harness_shared.coord_event_log
   SET ts = (body ->> 'ts')::timestamptz
 WHERE (body ->> 'ts') IS NOT NULL
   AND abs(extract(epoch FROM (ts - (body ->> 'ts')::timestamptz))) > 1;
