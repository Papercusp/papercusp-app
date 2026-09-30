-- 758-memory-recall-stats-leg-provenance.sql
--
-- context-injection-retrieval-reach-and-visibility-2026-08-03 P-002 (WI-10888).
-- Per-LEG retrieval provenance + the ADMISSION FUNNEL.
--
-- Migration 703 made the three POOLS visible; this makes the two LEGS and the
-- filter chain visible. The gap it closes is the one that has repeatedly made
-- this plan's own work unfalsifiable:
--
--   `memory_recall_stats` is written in injection.ts BEFORE every filter runs.
--   So the row answers "what did the index return", and NOTHING answers "what
--   actually reached the agent". Between the two sit knowledge-pack filtering,
--   feedback suppression, workspace scoping, session-epoch dedup, near-duplicate
--   collapse and the char budget -- six stages that can each drop a row, none of
--   them measured. A recall recorded as 12 hits and delivering 2 lines is
--   indistinguishable from one delivering 12.
--
-- That blindness is not hypothetical. Three separate corpus-leg changes on this
-- plan (D-066, D-070) were accepted or rejected on volume metrics that moved in
-- the OPPOSITE direction from relevance -- admitted lines per query rose +0.46
-- while known-item retrieval fell 2/7 -> 0/7. A funnel column is what makes
-- "more context arrived, none of it the answer" a query instead of a bench run.
--
-- === legs ===
--
--   {"cosine":  {"ran":true, "candidates":29,"qualifying":29,"depth":12},
--    "lexical": {"ran":true, "candidates":36,"qualifying":0, "depth":36},
--    "mode":"cosine-gated","fused":29}
--
--   ran        -- did the leg EXECUTE. `false` is a distinct observation from
--                zero candidates: `cosine-gated` mode deliberately never starts
--                the lexical leg when the cosine leg comes back empty. Reading a
--                contracted short-circuit as a retrieval failure sends the reader
--                to fix the wrong leg.
--   candidates -- rows the leg returned, pre-fusion.
--   qualifying -- rows that cleared the leg's OWN bar and were given a fusion
--                rank (the lexical leg's minLexScore). candidates - qualifying is
--                the count the bar removed. The live case this exists to catch:
--                ALL 108 lexical hits conferring an RRF bonus scored below even
--                the loosest calibrated bar, i.e. not one was a real match.
--   depth      -- the per-scope budget IN EFFECT for THAT leg on THAT call. The
--                two legs have DIFFERENT budgets (cosine gets `limit`, lexical
--                pulls lexicalDepth ?? limit*3), so each records its own; sharing
--                one would misjudge the other leg's saturation by 3x. Recorded,
--                never inferred later from a constant -- same contract as
--                `pools.limit` (703) and for the same reason: the constants get
--                retuned and a saturation test against today's value silently
--                misreads every older row.
--
-- Per-ENTRY leg attribution is NOT stored here. A fused score is a SUM over legs
-- and is not invertible, so `MemoryEntry.retrieval` carries {cosineRank,
-- lexicalRank} on the entry itself; `admission.byLeg` below aggregates it for the
-- rows that were actually delivered.
--
-- === admission ===
--
--   {"returned":12,"admitted":2,"truncated":true,
--    "dropped":{"pack":0,"feedback":0,"workspace":1,"dedup":7,"nearDuplicate":1,"budget":1},
--    "byLeg":{"cosineOnly":2,"lexicalOnly":0,"both":0}}
--
--   returned  -- what the index gave back (equals hit_count; carried alongside so
--                the funnel reads as one object without a join to its own row).
--   admitted  -- lines that actually reached the agent.
--   dropped   -- per STAGE, in pipeline order. A stage is recorded even at 0:
--                "this filter ran and removed nothing" and "this filter never
--                ran" are different facts, and only the first is a healthy zero.
--   byLeg     -- which leg(s) produced the ADMITTED lines. cosineOnly vs
--                lexicalOnly vs both. A leg that keeps producing candidates while
--                never producing an admitted line is contributing nothing, which
--                no pre-filter count can show.
--   truncated -- the char budget cut the block.
--
-- Both columns are NULL for pull-path rows (memory:search), which has no fan-out
-- and no filter chain -- same nullability posture as `pools`, so "single-pool
-- read" stays distinguishable from "multi-pool read that lost its breakdown".
--
-- NO INDEX, DELIBERATELY. Migration 752 dropped 703's GIN on `pools`
-- (jsonb_path_ops, partial on NOT NULL) after 0 index scans across the entire
-- lifetime of the database against 4304 kB maintained over 106,941 writes. Its
-- consumer stated the partial predicate verbatim and the planner still preferred
-- `memory_recall_stats_created_idx`, because every real question here is a
-- created_at WINDOW and the jsonb predicate removes only ~2.7% of rows in it.
-- These columns have the identical access shape, so an index on them would be
-- redundant for the identical reason. Add one only with a measured plan showing
-- the created_at index losing.

ALTER TABLE harness_shared.memory_recall_stats
  ADD COLUMN IF NOT EXISTS legs jsonb,
  ADD COLUMN IF NOT EXISTS admission jsonb;

COMMENT ON COLUMN harness_shared.memory_recall_stats.legs IS
  'Per-leg retrieval provenance at recall time: {cosine|lexical: {ran, candidates, qualifying, depth}, mode, fused}. ran=false means the leg never executed (cosine-gated short-circuit), which is NOT zero candidates. NULL on pull-path reads. context-injection-retrieval-reach-and-visibility-2026-08-03 P-002.';

COMMENT ON COLUMN harness_shared.memory_recall_stats.admission IS
  'Admission funnel: {returned, admitted, truncated, dropped:{stage:n}, byLeg:{cosineOnly,lexicalOnly,both}}. The row itself records what the INDEX returned; this records what reached the agent after the six filter stages between. NULL on pull-path reads. P-002.';
