-- 1334 — session_turn_windows: bounded-latency EXACT substring tier for common literals
-- (session-transcript-exact-fuzzy-search-2026-09-14 P-011 / WI-10005256; R-1 Route B per D-013/D-014).
--
-- WHY. The exact tier ran `lower(text) LIKE '%lit%'` against ONE trigram GIN over whole turns
-- (session_turns_text_trgm_idx). For a literal whose trigrams are individually common ('finder' =
-- fin+ind+nde+der) the GIN intersection returns ~126k candidate turns (9% of the corpus) of which ~105
-- truly contain the literal: the other 124k are rechecked away, and each recheck detoasts + lower()s a
-- turn of up to 8000 chars (~80 us) => ~10 s of pure CPU, so the 2 s exact deadline fires with 0 hits.
-- Measured on a 2% sample (p011-window-fp.mts): per-WINDOW candidates for 'finder' are 0.5% at 512 chars
-- (466 of 94k windows) vs 9.1% per whole turn, and each recheck is ~10x cheaper.
--
-- WHAT. A table of OVERLAPPING 512-char windows of lower(text), stride 448, overlap 64:
--   window g starts at char 0, 448, 896, ... while g < max(length-64, 1); wtext = substr(lower(text), g+1, 512).
-- Every substring of <= 65 chars (overlap + 1) lies wholly inside at least one window, so a window
-- trigram LIKE is RECALL-COMPLETE for such literals; a longer literal is filtered by its first 65 chars
-- and verified against the full parent turn by the read path. An empty turn still gets ONE window so
-- 'turn has no window rows' is a terminating backfill predicate.
--
-- MAINTENANCE: an AFTER INSERT OR UPDATE OF text trigger on session_turns keeps windows current;
-- the FK cascades deletes. Existing rows are backfilled by the deferred sessionSearchIndexBuild job
-- (keyset batches), then the GIN is built CONCURRENTLY — neither can run inside this migration's
-- transaction at corpus scale. A SMALL table (<= 10000 rows: fresh install, test DB) is backfilled and
-- indexed inline so the tier is ready immediately. Until the state row reads 'ready' the read path
-- keeps using the legacy turn-level trigram route (plan D-005 degrade-when-absent).
--
-- Replay-safe: every statement is IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF EXISTS + CREATE.
-- No destructive DDL (nothing is dropped except a trigger this file itself recreates).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS harness_shared.session_turn_windows (
  workspace_id text    NOT NULL,
  source_kind  text    NOT NULL,
  session_id   text    NOT NULL,
  turn_idx     integer NOT NULL,
  win_idx      integer NOT NULL,
  wtext        text    NOT NULL,
  PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx, win_idx),
  FOREIGN KEY (workspace_id, source_kind, session_id, turn_idx)
    REFERENCES harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx)
    ON DELETE CASCADE
);

COMMENT ON TABLE harness_shared.session_turn_windows IS
  'Overlapping 512-char windows (stride 448, overlap 64) of lower(session_turns.text) behind the bounded-latency exact substring tier (plan session-transcript-exact-fuzzy-search-2026-09-14 P-011). Maintained by trigger session_turn_windows_sync_trg; backfilled by the deferred sessionSearchIndexBuild job. Rebuildable: truncate it, reset session_turn_windows_state, and the job refills it.';

-- The window cut. Constants (512 / 448 / 64) are mirrored by SESSION_TURN_WINDOW_* in
-- packages/operator-core/lib/session-search-index-build.ts and pinned equal by its integration test.
CREATE OR REPLACE FUNCTION harness_shared.session_turn_windows_of(p_text text)
RETURNS TABLE (win_idx integer, wtext text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT (g / 448)::integer, substr(l.t, g + 1, 512)
    FROM (SELECT lower(p_text) AS t) l,
         LATERAL generate_series(0, GREATEST(length(l.t) - 64 - 1, 0), 448) AS g
$fn$;

CREATE OR REPLACE FUNCTION harness_shared.session_turn_windows_sync()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.text IS NOT DISTINCT FROM OLD.text THEN
      RETURN NULL;
    END IF;
    DELETE FROM harness_shared.session_turn_windows w
     WHERE w.workspace_id = NEW.workspace_id AND w.source_kind = NEW.source_kind
       AND w.session_id = NEW.session_id AND w.turn_idx = NEW.turn_idx;
  END IF;
  INSERT INTO harness_shared.session_turn_windows (workspace_id, source_kind, session_id, turn_idx, win_idx, wtext)
  SELECT NEW.workspace_id, NEW.source_kind, NEW.session_id, NEW.turn_idx, f.win_idx, f.wtext
    FROM harness_shared.session_turn_windows_of(NEW.text) f
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS session_turn_windows_sync_trg ON harness_shared.session_turns;
CREATE TRIGGER session_turn_windows_sync_trg
  AFTER INSERT OR UPDATE OF text ON harness_shared.session_turns
  FOR EACH ROW EXECUTE FUNCTION harness_shared.session_turn_windows_sync();

-- Build state for the deferred backfill. One row ('all'); the read path treats anything but 'ready'
-- as "windows tier not available yet" and falls back to the legacy turn-level route.
CREATE TABLE IF NOT EXISTS harness_shared.session_turn_windows_state (
  scope             text        PRIMARY KEY DEFAULT 'all',
  status            text        NOT NULL DEFAULT 'absent'
                      CHECK (status IN ('absent', 'building', 'ready', 'failed')),
  -- Keyset cursor over session_turns' primary key: the last turn whose windows the backfill wrote.
  cursor_workspace_id text,
  cursor_source_kind  text,
  cursor_session_id   text,
  cursor_turn_idx     integer,
  turns_done          bigint      NOT NULL DEFAULT 0,
  build_started_at    timestamptz,
  build_finished_at   timestamptz,
  heartbeat_at        timestamptz,
  last_error          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.session_turn_windows_state IS
  'Backfill state for harness_shared.session_turn_windows (P-011). status ready = every pre-existing turn has window rows AND the wtext trigram GIN is valid.';

INSERT INTO harness_shared.session_turn_windows_state (scope) VALUES ('all') ON CONFLICT (scope) DO NOTHING;

DO $$
DECLARE
  is_small boolean;
BEGIN
  SELECT count(*) <= 10000
    INTO is_small
    FROM (SELECT 1 FROM harness_shared.session_turns LIMIT 10001) AS probe;

  IF is_small THEN
    INSERT INTO harness_shared.session_turn_windows (workspace_id, source_kind, session_id, turn_idx, win_idx, wtext)
    SELECT t.workspace_id, t.source_kind, t.session_id, t.turn_idx, f.win_idx, f.wtext
      FROM harness_shared.session_turns t,
           LATERAL harness_shared.session_turn_windows_of(t.text) f
    ON CONFLICT DO NOTHING;
    EXECUTE 'CREATE INDEX IF NOT EXISTS session_turn_windows_wtext_trgm_idx '
         || 'ON harness_shared.session_turn_windows USING gin (wtext gin_trgm_ops)';
    UPDATE harness_shared.session_turn_windows_state
       SET status = 'ready', build_finished_at = now(), updated_at = now()
     WHERE scope = 'all';
  END IF;
END $$;
