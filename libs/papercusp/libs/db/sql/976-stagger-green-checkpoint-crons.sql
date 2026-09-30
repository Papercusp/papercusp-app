-- Stagger each install's hourly green-checkpoint across the full hour.
-- Mirrors greenCheckpointCronForInstall(): position-weighted UTF-8 bytes,
-- reduced into the 3,600 possible seconds of an hour.
WITH schedule AS (
  SELECT
    r.id,
    (
      SELECT mod(
        sum(get_byte(convert_to(r.install_slug, 'UTF8'), position) * (position + 1)),
        3600
      )::integer
      FROM generate_series(
        0,
        octet_length(convert_to(r.install_slug, 'UTF8')) - 1
      ) AS position
    ) AS second_of_hour
  FROM harness_shared.routines AS r
  WHERE r.name = 'green-checkpoint'
    AND r.trigger_kind = 'cron'
)
UPDATE harness_shared.routines AS r
SET trigger_config = jsonb_set(
      coalesce(r.trigger_config, '{}'::jsonb),
      '{cron}',
      to_jsonb(format(
        '%s %s * * * *',
        mod(schedule.second_of_hour, 60),
        floor(schedule.second_of_hour / 60.0)::integer
      ))
    ),
    updated_at = now()
FROM schedule
WHERE r.id = schedule.id;
