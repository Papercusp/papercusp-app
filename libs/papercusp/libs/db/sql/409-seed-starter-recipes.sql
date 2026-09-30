-- 409-seed-starter-recipes.sql — a small STARTER LIBRARY of reusable code:run recipes
-- (code-run-adoption, owner directive 2026-06-29).
--
-- WHY: the measured code:run adoption bottleneck is AWARENESS, not authoring — agents
-- hand-loop work_items:get / work_items:list+tag / set_state one call at a time because
-- they don't know a script already does it. recipes:search now surfaces relevant recipes
-- at coord:orient (orient.ts), but the corpus is sparse on day one. This seeds a handful of
-- generic, correct, SELF-CONTAINED multi-tool recipes so the very first orient/search has
-- something to return, and the "reuse before you author" prose has teeth.
--
-- INVARIANTS each seeded recipe satisfies (so it survives the search surface + is runnable):
--  * ≥2 DISTINCT tools_used — single-tool recipes are filtered as low-value (isLowValueRecipe),
--    so they would never surface; every recipe here fans across ≥2 tools.
--  * explicit title+description — auto-derived "recipe: …" titles are filtered too.
--  * SELF-CONTAINED — each derives its own inputs from a list/search call (no external ids to
--    fill), so recipes:run executes it verbatim without hand-editing.
--  * VERIFIED arg shapes + camelCased facade verbs (work_items:set_state → tools.work_items.setState).
--
-- embedding is left NULL: search still ranks these via the BM25 lexical leg (title_tsv, a
-- generated column) — the cosine leg simply contributes 0 until an embedding backfill runs.
-- The structural (tool-overlap) leg is moot here since recipes:search passes an empty toolset.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING — never clobbers a real (organically-captured)
-- recipe that happens to own one of these ids, and re-running the migration is a no-op.
-- Post-378 GLOBAL schema: no workspace_id / hive_slug columns on definitions.

INSERT INTO harness_shared.code_recipes (id, title, description, script, author_role, tools_used, status, tags, created_by)
VALUES
  (
    'triage-todo-work-items-by-keyword',
    'Triage TODO work items by keyword',
    'List TODO work items, filter to those whose title contains a keyword, and tag them all with one batched call. Edit `needle` + `topic`. Folds list + a tag-per-item loop into one code:run.',
    $js$// Tag every TODO work item whose title contains `needle` with `topic`, in one pass.
const needle = 'flaky';
const topic = 'triage';
const listed = await tools.work_items.list({ state: 'todo', limit: 200 });
const items = Array.isArray(listed) ? listed : (listed?.data ?? listed?.items ?? []);
const hits = items.filter((w) => (w.title ?? '').toLowerCase().includes(needle.toLowerCase()));
if (hits.length) await tools.work_items.tag({ ids: hits.map((w) => w.id), topic });
return { matched: hits.length, ids: hits.map((w) => w.id) };$js$,
    'system',
    ARRAY['work_items:list', 'work_items:tag'],
    'active',
    ARRAY['starter'],
    'system:starter-seed'
  ),
  (
    'oldest-todo-detail-report',
    'Report the oldest TODO work items with detail',
    'List TODO work items, pick the N oldest by creation time, and fetch full detail for all of them in one batched work_items:get (ids:[…]). Returns a compact report. Edit `N`.',
    $js$// Report the N oldest TODO work items with detail — list, pick oldest, fetch detail in one pass.
const N = 10;
const listed = await tools.work_items.list({ state: 'todo', limit: 200 });
const items = Array.isArray(listed) ? listed : (listed?.data ?? listed?.items ?? []);
const oldest = items
  .slice()
  .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  .slice(0, N);
const detail = oldest.length ? await tools.work_items.get({ ids: oldest.map((w) => w.id), detail: true }) : [];
return { count: oldest.length, items: detail };$js$,
    'system',
    ARRAY['work_items:list', 'work_items:get'],
    'active',
    ARRAY['starter'],
    'system:starter-seed'
  ),
  (
    'search-then-advance-state',
    'Search work items then advance them all to a state',
    'Find work items matching a free-text query, then move them ALL to a new lifecycle state in one batched work_items:set_state (ids:[…]). Edit `query` + `newState`. Folds search + a set_state-per-item loop into one call.',
    $js$// Find work items matching `query`, then advance them ALL to `newState` in one batched call.
const query = 'rate limit';
const newState = 'wip';
const found = await tools.work_items.search({ query, limit: 50 });
const items = Array.isArray(found) ? found : (found?.results ?? found?.data ?? []);
const ids = items.map((w) => w.id).filter(Boolean);
if (ids.length) await tools.work_items.setState({ ids, state: newState });
return { advanced: ids.length, ids };$js$,
    'system',
    ARRAY['work_items:search', 'work_items:set_state'],
    'active',
    ARRAY['starter'],
    'system:starter-seed'
  ),
  (
    'flag-stale-todo-items-with-comment',
    'Comment a triage note on stale TODO items',
    'List TODO work items, find those older than N days, and post the same triage-note comment on each in one batched work_items:comment (items:[…]). Edit `days` + `note`.',
    $js$// Comment a triage note on every TODO item older than `days`, in one batched call.
const days = 30;
const note = 'Auto-flagged stale by the triage recipe — re-confirm or close.';
const listed = await tools.work_items.list({ state: 'todo', limit: 200 });
const items = Array.isArray(listed) ? listed : (listed?.data ?? listed?.items ?? []);
const cutoff = Date.now() - days * 86400000;
const stale = items.filter((w) => w.createdAt && Date.parse(w.createdAt) < cutoff);
if (stale.length) await tools.work_items.comment({ items: stale.map((w) => ({ id: w.id, body: note })) });
return { flagged: stale.length, ids: stale.map((w) => w.id) };$js$,
    'system',
    ARRAY['work_items:list', 'work_items:comment'],
    'active',
    ARRAY['starter'],
    'system:starter-seed'
  )
ON CONFLICT (id) DO NOTHING;
