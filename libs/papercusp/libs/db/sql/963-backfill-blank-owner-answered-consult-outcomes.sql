-- 963-backfill-blank-owner-answered-consult-outcomes.sql
--
-- Migration 856 repaired expired consultations whose legacy cascade digest
-- contained substantive answers but no durable outcome. Its responder rollup
-- deliberately discarded blank owner ids; when EVERY answer carried a blank
-- owner, that also discarded the conversation itself and left outcome = NULL.
-- The archive then continued to describe an answered consultation as
-- unanswered. Repair that remaining shape while preserving the honest answer
-- count and representing the unavailable responder identities as an empty list.
--
-- This remains a narrow, idempotent historical backfill: explicit outcomes,
-- non-expired rows, genuinely unanswered rows, and malformed digests are never
-- candidates.

WITH answer_events AS (
  SELECT cs.workspace_id,
         cs.conversation_id,
         entry.value ->> 'ownerId' AS owner_id,
         entry.ordinality,
         count(*) OVER (
           PARTITION BY cs.workspace_id, cs.conversation_id
         )::integer AS answers
    FROM harness_shared.consult_state cs
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(cs.cascade_digest) = 'array' THEN cs.cascade_digest
        ELSE '[]'::jsonb
      END
    )
      WITH ORDINALITY AS entry(value, ordinality)
   WHERE cs.state = 'expired'
     AND cs.outcome IS NULL
     AND jsonb_typeof(cs.cascade_digest) = 'array'
     AND entry.value ->> 'kind' = 'answer'
),
answer_counts AS (
  SELECT workspace_id,
         conversation_id,
         max(answers)::integer AS answers
    FROM answer_events
   GROUP BY workspace_id, conversation_id
),
first_answer_by_owner AS (
  SELECT workspace_id,
         conversation_id,
         owner_id,
         min(ordinality) AS first_ordinality
    FROM answer_events
   WHERE nullif(owner_id, '') IS NOT NULL
   GROUP BY workspace_id, conversation_id, owner_id
),
owner_rollup AS (
  SELECT workspace_id,
         conversation_id,
         jsonb_agg(owner_id ORDER BY first_ordinality) AS answered_by
    FROM first_answer_by_owner
   GROUP BY workspace_id, conversation_id
),
rollup AS (
  SELECT counts.workspace_id,
         counts.conversation_id,
         counts.answers,
         COALESCE(owners.answered_by, '[]'::jsonb) AS answered_by
    FROM answer_counts counts
    LEFT JOIN owner_rollup owners
      ON owners.workspace_id = counts.workspace_id
     AND owners.conversation_id = counts.conversation_id
)
UPDATE harness_shared.consult_state cs
   SET outcome = jsonb_build_object(
         'disposition', 'cascade_exhausted_with_answers',
         'answers', rollup.answers,
         'answered_by', rollup.answered_by
       ),
       updated_at = now()
  FROM rollup
 WHERE cs.workspace_id = rollup.workspace_id
   AND cs.conversation_id = rollup.conversation_id
   AND cs.state = 'expired'
   AND cs.outcome IS NULL;
