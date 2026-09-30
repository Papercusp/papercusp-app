-- Recompute the persisted fire after migration 976 changed each cron. Without
-- this, every row retains the old shared next_fire_at and stampedes once more
-- before the scheduler first interprets the new staggered cron.
WITH scheduled AS (
  SELECT
    id,
    date_trunc('hour', now())
      + make_interval(
          mins => split_part(trigger_config->>'cron', ' ', 2)::integer,
          secs => split_part(trigger_config->>'cron', ' ', 1)::double precision
        ) AS candidate
  FROM harness_shared.routines
  WHERE name = 'green-checkpoint'
    AND trigger_kind = 'cron'
)
UPDATE harness_shared.routines AS r
SET next_fire_at = CASE
      WHEN scheduled.candidate > now() THEN scheduled.candidate
      ELSE scheduled.candidate + interval '1 hour'
    END,
    updated_at = now()
FROM scheduled
WHERE r.id = scheduled.id;
