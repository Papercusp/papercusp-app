-- 549-backfill-coord-event-log-body-ts-msgid.sql
-- WI-3912: coord:feed (readCoordFeed's compareByTsThenId, feed.ts) crashed on EVERY call with
-- "Cannot read properties of undefined (reading 'localeCompare')". Root cause: coord_event_log
-- id 458510 (surface='messages', origin='remote' — a federated row folded from a peer's
-- deliberate test probe, "v2t probe3 HIVE-STAMPED ... unstamped local coord writes never
-- capture") has a `body` jsonb with NO `ts`/`msg_id` keys at all. Every LOCAL write path
-- (appendLine/putEvent/putEvents) stamps the envelope's own ts/msg_id into both the row's
-- columns AND its body BY CONSTRUCTION, so this never happens for a local write — but the
-- federation fold-apply path for remote rows stores whatever `body` shape the peer sent
-- verbatim, without re-validating it satisfies the CoordEnvelope contract. Every reader
-- downstream assumed body.ts/body.msg_id always exist (e.g. the sort in feed.ts, and the raw
-- `body->>'ts' > $sinceTs` pushdown filters in pg-log.ts's readLinesBounded/BoundedCursor).
--
-- pg-log.ts's `parseBody` now backstops body.ts/body.msg_id from the row's own NOT-NULL
-- `ts`/`msg_id` columns at READ time (fixes every reader in one place, including any FUTURE
-- malformed row) — this migration is the matching one-time DATA repair so the raw
-- `body->>'ts'`/`body->>'msg_id'` JSON-path filters some queries push down to SQL (which read
-- body directly, bypassing parseBody) see consistent data too, not just the parseBody callers.
--
-- Idempotent; safe to re-run — a row already carrying both keys is excluded by the WHERE on
-- every subsequent run.

UPDATE harness_shared.coord_event_log
   SET body = body
     || jsonb_build_object('ts', to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     || jsonb_build_object('msg_id', msg_id)
 WHERE (body ->> 'ts') IS NULL
    OR (body ->> 'msg_id') IS NULL;
