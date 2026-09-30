-- 676: backfill harness_shared.plan_items / plan_decisions from the existing
-- harness_plans.items / .decisions jsonb
-- (plan `normalize-plan-items-decisions-to-rows-2026-07-26`, P-003).
--
-- Migration 675 created the tables and the write path populates them going
-- forward; this lands the plans that already have a populated derived jsonb, so
-- readers can be cut over without waiting for all ~967 plans to be rewritten.
--
-- BACKFILL FROM THE JSONB, NOT FROM `content`. Both are derived from the same
-- markdown by the same function, but the jsonb is the output that function
-- ALREADY produced for these rows — using it makes the backfill exact by
-- construction and removes any chance that a parser change between then and now
-- silently rewrites history. (Re-parsing `content` would be a re-derivation, not
-- a backfill.)
--
-- THE ~57 PLANS WITH items IS NULL are federated rows: the hyperbee projection
-- writes the DOCUMENT (content + hash + scalars) and never populated the derived
-- jsonb either, so they already sit in the "fall back to parsing content" state
-- that migration 331 established. They are NOT a regression introduced by this
-- work and are populated by their next local write. Verified before writing
-- this: 967 plans total, 910 with items populated, 57 NULL — and all 57 have
-- non-empty content, so the fallback has something to parse.
--
-- IDEMPOTENT: ON CONFLICT DO UPDATE converges rather than conflicting, and it
-- deliberately does NOT blanket-DELETE first — that would wipe rows the live
-- write path may have written between 675 and this migration. Safe to re-run:
-- these rows are a derived index of harness_plans.content, never a source of
-- truth (see 675's header).

INSERT INTO harness_shared.plan_items (
  workspace_id, harness_slug, plan_slug,
  item_id, seq, item_text, status, importance, phase, blocked_by, decision_refs
)
SELECT DISTINCT ON (p.workspace_id, p.harness_slug, p.plan_slug, t.e->>'id')
       p.workspace_id, p.harness_slug, p.plan_slug,
       t.e->>'id',
       (t.ord - 1)::integer,
       COALESCE(t.e->>'text', ''),
       COALESCE(NULLIF(t.e->>'status', ''), 'todo'),
       t.e->>'importance',
       t.e->>'phase',
       CASE WHEN jsonb_typeof(t.e->'blockedBy') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(t.e->'blockedBy'))
            ELSE '{}'::text[] END,
       CASE WHEN jsonb_typeof(t.e->'decisionRefs') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(t.e->'decisionRefs'))
            ELSE '{}'::text[] END
  FROM harness_shared.harness_plans p,
       LATERAL jsonb_array_elements(p.items) WITH ORDINALITY AS t(e, ord)
 WHERE jsonb_typeof(p.items) = 'array'
   AND jsonb_typeof(t.e) = 'object'
   AND NULLIF(t.e->>'id', '') IS NOT NULL
 -- keep the LAST occurrence of a duplicate id, matching how a consumer indexing
 -- the jsonb array by id would have resolved it (live data has zero duplicates)
 ORDER BY p.workspace_id, p.harness_slug, p.plan_slug, t.e->>'id', t.ord DESC
ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO UPDATE SET
  seq           = EXCLUDED.seq,
  item_text     = EXCLUDED.item_text,
  status        = EXCLUDED.status,
  importance    = EXCLUDED.importance,
  phase         = EXCLUDED.phase,
  blocked_by    = EXCLUDED.blocked_by,
  decision_refs = EXCLUDED.decision_refs,
  updated_at    = now();

INSERT INTO harness_shared.plan_decisions (
  workspace_id, harness_slug, plan_slug,
  decision_id, seq, title, body, decision_date, item_refs
)
SELECT DISTINCT ON (p.workspace_id, p.harness_slug, p.plan_slug, t.e->>'id')
       p.workspace_id, p.harness_slug, p.plan_slug,
       t.e->>'id',
       (t.ord - 1)::integer,
       COALESCE(t.e->>'title', ''),
       COALESCE(t.e->>'body', ''),
       t.e->>'date',
       CASE WHEN jsonb_typeof(t.e->'itemRefs') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(t.e->'itemRefs'))
            ELSE '{}'::text[] END
  FROM harness_shared.harness_plans p,
       LATERAL jsonb_array_elements(p.decisions) WITH ORDINALITY AS t(e, ord)
 WHERE jsonb_typeof(p.decisions) = 'array'
   AND jsonb_typeof(t.e) = 'object'
   AND NULLIF(t.e->>'id', '') IS NOT NULL
 ORDER BY p.workspace_id, p.harness_slug, p.plan_slug, t.e->>'id', t.ord DESC
ON CONFLICT (workspace_id, harness_slug, plan_slug, decision_id) DO UPDATE SET
  seq           = EXCLUDED.seq,
  title         = EXCLUDED.title,
  body          = EXCLUDED.body,
  decision_date = EXCLUDED.decision_date,
  item_refs     = EXCLUDED.item_refs,
  updated_at    = now();
