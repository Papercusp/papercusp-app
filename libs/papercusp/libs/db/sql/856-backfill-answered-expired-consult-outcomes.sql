-- 856-backfill-answered-expired-consult-outcomes.sql
--
-- WI-39862 fixed the expiry writer so a cascade that exhausts after collecting
-- substantive answers records an answered-flavoured outcome. Rows expired by
-- older builds still carry outcome = NULL, which makes archive readers describe
-- those answered consults as unanswered. Repair only that unambiguous legacy
-- shape; preserve every explicit outcome and every genuinely unanswered row.

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
first_answer_by_owner AS (
  SELECT workspace_id,
         conversation_id,
         owner_id,
         min(ordinality) AS first_ordinality,
         max(answers) AS answers
    FROM answer_events
   WHERE nullif(owner_id, '') IS NOT NULL
   GROUP BY workspace_id, conversation_id, owner_id
),
rollup AS (
  SELECT workspace_id,
         conversation_id,
         max(answers)::integer AS answers,
         jsonb_agg(owner_id ORDER BY first_ordinality) AS answered_by
    FROM first_answer_by_owner
   GROUP BY workspace_id, conversation_id
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
