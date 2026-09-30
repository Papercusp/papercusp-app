-- 781-doc-content-canonical.sql
--
-- Plan: claude-md-projection-from-pg-2026-08-10  (P-001, decisions D-005 / D-007 / D-008 / D-010)
--
-- Makes docs PG-canonical, the way plans already are.
--
-- Today `harness_docs` has 22 columns and not one of them holds prose: it is metadata
-- (subject_ref, anchor_paths, freshness) pointing at files on disk, while `doc_sections`
-- holds content synced FROM those files keyed by page_sha. That second shape is the
-- "PG mirror with file primary" the storage policy bans by name. This migration inverts
-- the direction rather than grandfathering it.
--
-- Nothing here is invented. Every column mirrors one that already works:
--   * the content/CAS/search set mirrors `harness_plans`
--   * `harness_doc_parts`  mirrors `harness_plan_parts`
--   * `doc_revisions`      mirrors `plan_revisions`
--
-- PURELY ADDITIVE — no DROP, no RENAME, no SET NOT NULL on an existing column. Every new
-- column is ADD COLUMN ... DEFAULT, which is safe against the release still serving :3070,
-- so no FORWARD-COMPAT acknowledgment is required. Contract (retiring doc_sections and the
-- filesystem lexical leg) is deliberately deferred to P-007/P-009, per expand/contract.
--
-- No top-level BEGIN/COMMIT: the runner supplies the transaction (lint:migrations).

-- ---------------------------------------------------------------------------
-- 1. harness_docs gains canonical content, mirroring harness_plans
-- ---------------------------------------------------------------------------

ALTER TABLE harness_shared.harness_docs
  -- canonical prose + CAS, exactly as harness_plans.{content,content_hash,version}
  ADD COLUMN IF NOT EXISTS content       text   NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS content_hash  text   NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version       bigint NOT NULL DEFAULT 0,

  -- DERIVED from content on write (mirrors the harness_plans.items contract).
  ADD COLUMN IF NOT EXISTS frontmatter   jsonb,

  -- Which side is the source of truth. The two consumers want OPPOSITE directions:
  -- an agent-insights doc is AUTHORED (content canonical, parts derived from it), while
  -- CLAUDE.md is COMPOSED (parts canonical, content is the projector's cached output).
  -- Making that a column rather than a convention is the point: a reader can ask.
  ADD COLUMN IF NOT EXISTS content_mode  text   NOT NULL DEFAULT 'authored',

  -- Search moves in-row, retiring the filesystem lexical adapter (P-007).
  ADD COLUMN IF NOT EXISTS _search        tsvector,
  -- vector(768) to match harness_plans / doc_sections / work_items / session_turn_chunks —
  -- verified against pg_attribute, not assumed. A mismatched dimension would isolate this
  -- column from every other embedding in the system.
  ADD COLUMN IF NOT EXISTS embedding      vector(768),
  ADD COLUMN IF NOT EXISTS embedding_mode text;

COMMENT ON COLUMN harness_shared.harness_docs.content IS
  'Canonical doc prose (D-005). Authoritative when content_mode=''authored''; when '
  '''composed'' this is the projector''s cached output and harness_doc_parts is canonical.';
COMMENT ON COLUMN harness_shared.harness_docs.frontmatter IS
  'Derived index of parsed frontmatter (recomputed from content on write; content is '
  'canonical). Mirrors the harness_plans.items contract.';
COMMENT ON COLUMN harness_shared.harness_docs.content_mode IS
  'Direction of truth (D-010). authored = content canonical, parts derived. composed = '
  'parts canonical, content is projector output (CLAUDE.md / AGENTS.md).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'harness_docs_content_mode_check'
  ) THEN
    ALTER TABLE harness_shared.harness_docs
      ADD CONSTRAINT harness_docs_content_mode_check
      CHECK (content_mode IN ('authored', 'composed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS harness_docs_search_idx
  ON harness_shared.harness_docs USING gin (_search);

CREATE INDEX IF NOT EXISTS harness_docs_embedding_hnsw_idx
  ON harness_shared.harness_docs USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS harness_docs_embedding_mode_idx
  ON harness_shared.harness_docs USING btree (embedding_mode)
  WHERE embedding_mode IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. harness_doc_parts — mirrors harness_plan_parts, plus projection control
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS harness_shared.harness_doc_parts (
  -- ── identity + federation: identical to harness_plan_parts ──
  workspace_id       text    NOT NULL,
  harness_slug       text    NOT NULL,
  doc_id             text    NOT NULL,
  part_key           text    NOT NULL,
  kind               text    NOT NULL,
  body               text    NOT NULL DEFAULT '',
  ordinal            integer NOT NULL DEFAULT 0,
  tombstone          boolean NOT NULL DEFAULT false,
  origin             text    NOT NULL DEFAULT 'local',
  author             text,
  part_fed_key       text,
  fed_ts             bigint  NOT NULL
                       DEFAULT (EXTRACT(epoch FROM now()) * 1000)::bigint,
  fed_hlc            text,
  created_at         bigint  NOT NULL
                       DEFAULT (EXTRACT(epoch FROM now()) * 1000)::bigint,
  updated_at         bigint  NOT NULL
                       DEFAULT (EXTRACT(epoch FROM now()) * 1000)::bigint,

  -- ── projection control: the four columns plans have no need for ──

  -- Which client files this part projects into. Empty = never projected (prose that
  -- lives only in the corpus). '&&'-queried against ARRAY[<client>,'all'].
  client_scope       text[]  NOT NULL DEFAULT '{}',

  -- D-008's budget rank. The projector caps against the LIVE computed threshold
  -- (max(40000, contextTokens*0.05*charsPerToken)); lower rank survives the cut.
  project_rank       integer NOT NULL DEFAULT 1000,

  -- Heading the part lands under in the projected file.
  target_section     text,

  -- D-007: a recipe projects, its rationale moves. This is the link back.
  rationale_part_key text,

  PRIMARY KEY (workspace_id, harness_slug, doc_id, part_key),

  CONSTRAINT harness_doc_parts_kind_check
    CHECK (kind IN ('invariant', 'pointer', 'recipe', 'prose')),

  -- A part that projects must say where it lands; one that doesn't, must not pretend to.
  CONSTRAINT harness_doc_parts_projected_needs_section
    CHECK (cardinality(client_scope) = 0 OR target_section IS NOT NULL),

  -- Only a recipe carries a rationale link (D-007).
  CONSTRAINT harness_doc_parts_rationale_only_on_recipe
    CHECK (rationale_part_key IS NULL OR kind = 'recipe'),

  -- Prose is the corpus, not the projection. Guards the regression this whole plan
  -- exists to prevent: long-form narrative creeping back into CLAUDE.md.
  CONSTRAINT harness_doc_parts_prose_never_projects
    CHECK (kind <> 'prose' OR cardinality(client_scope) = 0)
);

COMMENT ON TABLE harness_shared.harness_doc_parts IS
  'Ordered, kinded, addressable parts of a doc (D-010). Mirrors harness_plan_parts and '
  'adds projection control. Canonical when the parent doc is content_mode=''composed''; '
  'derived from content when ''authored''.';
COMMENT ON COLUMN harness_shared.harness_doc_parts.client_scope IS
  'Client files this part projects into: {claude},{codex},{all}. Empty = corpus only.';
COMMENT ON COLUMN harness_shared.harness_doc_parts.project_rank IS
  'D-008 budget rank; the projector cuts the tail against the live computed threshold.';

CREATE INDEX IF NOT EXISTS harness_doc_parts_by_doc
  ON harness_shared.harness_doc_parts
  USING btree (workspace_id, harness_slug, doc_id, ordinal);

-- The projector's hot path: every part for one client, in emit order.
CREATE INDEX IF NOT EXISTS harness_doc_parts_projection_idx
  ON harness_shared.harness_doc_parts
  USING gin (client_scope)
  WHERE tombstone = false AND cardinality(client_scope) > 0;

-- ---------------------------------------------------------------------------
-- 3. doc_revisions — mirrors plan_revisions
-- ---------------------------------------------------------------------------
-- Not redundant with harness_docs.version: this is the history, and the surface
-- P-013's EI-117 revert guard reads (a doc silently reverting to an older revision
-- while the revision log keeps advancing).

CREATE TABLE IF NOT EXISTS harness_shared.doc_revisions (
  id               bigserial PRIMARY KEY,
  workspace_id     text    NOT NULL DEFAULT 'default',
  harness_slug     text    NOT NULL DEFAULT 'papercup',
  doc_id           text    NOT NULL,
  seq              integer NOT NULL,
  content_hash     text    NOT NULL,
  content_snapshot text    NOT NULL,
  rationale        text,
  author_kind      text    NOT NULL,
  author_id        text    NOT NULL,
  session_id       text,
  session_kind     text,
  created_at       bigint  NOT NULL
                     DEFAULT (EXTRACT(epoch FROM now()) * 1000)::bigint,

  CONSTRAINT doc_revisions_ws_harness_doc_seq_key
    UNIQUE (workspace_id, harness_slug, doc_id, seq)
);

COMMENT ON TABLE harness_shared.doc_revisions IS
  'Append-only revision log for harness_docs.content. Mirrors plan_revisions. Read by '
  'the EI-117 revert guard (P-013): a monotonic seq here alongside a rolled-back '
  'harness_docs.version is the signature of a silent revert.';
