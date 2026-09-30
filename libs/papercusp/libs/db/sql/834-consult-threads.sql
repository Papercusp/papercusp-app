-- 834-consult-threads.sql — the get_feedback consult primitive (plan
-- get-feedback-relevance-consults-2026-08-16, P-001; design decisions D-001–D-009).
--
-- A consult IS a conversation: it reuses the coord_conversations +
-- coord_threads + coord_thread_posts substrate (thread, subscriptions,
-- notify/wake, browse surfaces) and adds only what conversations lack —
-- a typed consult lifecycle with caps/budgets/lineage (consult_state, 1:1
-- with its conversation) and a typed per-post overlay (consult_post_meta,
-- keyed by post id; deliberately LOCAL-ONLY so the federated
-- coord_thread_posts surface is untouched).
--
-- EXPAND-only: one CHECK widened, two tables added. No data rewritten.
-- House style: logical refs, no FK constraints (matches coord_threads /
-- coord_thread_posts).

-- 1) coord_conversations.kind gains 'consult'.
-- FORWARD-COMPAT: coord_conversations_kind_check is dropped only to be
-- immediately re-added WIDENED (adds 'consult' to the allowed set); the
-- currently-deployed release never inserts kind='consult' and its readers do
-- not depend on the constraint's member list, so live code is unaffected.
ALTER TABLE harness_shared.coord_conversations
  DROP CONSTRAINT IF EXISTS coord_conversations_kind_check;
ALTER TABLE harness_shared.coord_conversations
  ADD CONSTRAINT coord_conversations_kind_check
  CHECK (kind = ANY (ARRAY['question'::text, 'discussion'::text, 'consult'::text]));

-- 2) consult_state — the consult's OWN scalars, 1:1 with its conversation row
--    (PK = the conversation key). The conversation's coarse lifecycle `state`
--    (open/resolved/closed/superseded) keeps every existing browse surface
--    coherent; the fine-grained consult state lives here.
CREATE TABLE IF NOT EXISTS harness_shared.consult_state (
  workspace_id     text NOT NULL DEFAULT 'default',
  conversation_id  text NOT NULL,
  requester_id     text NOT NULL,
  responder_id     text,
  state            text NOT NULL DEFAULT 'routing'
    CONSTRAINT consult_state_state_check CHECK (state = ANY (ARRAY[
      'routing'::text,                -- router running / not yet delivered
      'no_qualified_responder'::text, -- terminal: below floor (D-003 first-class result)
      'awaiting_responder'::text,     -- delivered + woken, no responder post yet
      'active'::text,                 -- responder engaged
      'closed_answered'::text,        -- structured outcome present
      'closed_cant_help'::text,       -- responder validated relevance but could not help
      'declined'::text,               -- responder's context does not cover the question
      'graduated'::text,              -- cap hit while deliberating → shared live work (D-004)
      'expired'::text                 -- latency contract expiry with no close
    ])),
  question         text NOT NULL DEFAULT '',
  latency_contract text NOT NULL DEFAULT 'proceed'
    CONSTRAINT consult_state_latency_check
    CHECK (latency_contract = ANY (ARRAY['proceed'::text, 'hard-blocked'::text])),
  max_exchanges    integer NOT NULL DEFAULT 4,
  exchanges_used   integer NOT NULL DEFAULT 0,
  wake_budget      integer NOT NULL DEFAULT 4,
  wakes_used       integer NOT NULL DEFAULT 0,
  depth            integer NOT NULL DEFAULT 0
    CONSTRAINT consult_state_depth_check CHECK (depth >= 0 AND depth <= 2),
  parent_consult_id text,
  origin_task_ref  text,
  routing          jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome          jsonb,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  PRIMARY KEY (workspace_id, conversation_id)
);

COMMENT ON TABLE harness_shared.consult_state IS
  'get_feedback consult lifecycle (plan get-feedback-relevance-consults-2026-08-16). 1:1 side-state for a coord_conversations row of kind=''consult''; the conversation carries thread/subscriptions/coarse lifecycle, this carries routing snapshot, caps/budgets, recursion lineage and the fine-grained consult state.';
COMMENT ON COLUMN harness_shared.consult_state.routing IS
  'Routing snapshot (D-008): { query, floor, candidates: [{ ownerId, score, signals: { similarity, recency, verification, authorship }, evidence: [{ session_id, turn_idx }], liveness }] } — the audit trail and the D-003 honesty-metric feed. Persisted at route time; never recomputed in place.';
COMMENT ON COLUMN harness_shared.consult_state.outcome IS
  'Structured close (D-001): { answer?, confidence?, evidence?: [{ session_id, turn_idx, note? }], reason? } — required for closed_answered / closed_cant_help; decline reason for declined.';
COMMENT ON COLUMN harness_shared.consult_state.depth IS
  'Responder-recursion depth (D-007 §7): 0 = requester-initiated; a consult opened from within a consult turn carries parent depth+1; CHECK caps at 2.';
COMMENT ON COLUMN harness_shared.consult_state.parent_consult_id IS
  'Recursion lineage: the consult (conversation id) whose responder opened this one. Cycle refusal walks this chain (D-005).';
COMMENT ON COLUMN harness_shared.consult_state.origin_task_ref IS
  'Work-item/task the wake budget debits against (D-005): budget is aggregated over all consults sharing this ref, recursion included.';
COMMENT ON COLUMN harness_shared.consult_state.latency_contract IS
  '''proceed'' = requester proceeds on assumption and reconciles when the reply lands; ''hard-blocked'' = requester parks on consult:reply:<conversation_id> (D-005/D-008).';

CREATE INDEX IF NOT EXISTS consult_state_state_idx
  ON harness_shared.consult_state (workspace_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS consult_state_responder_idx
  ON harness_shared.consult_state (workspace_id, responder_id)
  WHERE responder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS consult_state_origin_idx
  ON harness_shared.consult_state (workspace_id, origin_task_ref)
  WHERE origin_task_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS consult_state_parent_idx
  ON harness_shared.consult_state (workspace_id, parent_consult_id)
  WHERE parent_consult_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS consult_state_expiry_idx
  ON harness_shared.consult_state (expires_at)
  WHERE expires_at IS NOT NULL AND closed_at IS NULL;

-- 3) consult_post_meta — the typed overlay on consult posts (D-008 §2): kind +
--    evidence per coord_thread_posts row. Keyed by the post's machine-local id;
--    LOCAL-ONLY by design (no federation columns) so the federated posts
--    surface is untouched. The consult verbs are the only writers; the
--    conversations-post kind gate refuses untyped posts into consult
--    conversations (enforced in code, P-004/P-005).
CREATE TABLE IF NOT EXISTS harness_shared.consult_post_meta (
  workspace_id    text NOT NULL DEFAULT 'default',
  post_id         bigint NOT NULL,
  conversation_id text NOT NULL,
  author_id       text,
  kind            text NOT NULL
    CONSTRAINT consult_post_meta_kind_check CHECK (kind = ANY (ARRAY[
      'question'::text,            -- requester: the opening ask or a follow-up
      'answer'::text,              -- responder: a grounded answer
      'clarifying_question'::text, -- responder asks back
      'new_fact'::text,            -- either side: new information
      'decline'::text,             -- responder: context does not cover this
      'close'::text                -- either side: structured close
    ])),
  evidence        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, post_id)
);

COMMENT ON TABLE harness_shared.consult_post_meta IS
  'Typed per-post overlay for consult conversations (D-001/D-008): every consult post carries a kind (a post that is neither a question nor a new fact is refused by the verbs — termination is structural) and optional grounding evidence [{ session_id, turn_idx, note? }].';

CREATE INDEX IF NOT EXISTS consult_post_meta_conversation_idx
  ON harness_shared.consult_post_meta (workspace_id, conversation_id, post_id);
