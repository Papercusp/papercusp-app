-- WI-10001674 / WI-10001633: the Email and Calendar app sidecars were added to
-- RESTART_TARGETS so `dev:restart` could load an edit into them (they run tsx
-- from their own checkout with no restart-on-change), but neither service
-- resource nor its cooldown marker was ever registered. dev:restart could
-- therefore not acquire exclusive(...) to drain or coalesce restarts for them,
-- and restart.test.ts — which asserts every RESTART_TARGETS entry is seeded
-- here — red-pinned the green-checkpoint gate.
-- Idempotent: never overwrite an operator-edited registry row.

INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('email-sidecar',
   'The Email app sidecar (:8791). Restarting it makes the Email app unavailable until it is back; Gmail sync resumes on boot.',
   'Use `dev:restart { target: "email-sidecar", confirm: true }`; it acquires exclusive(email-sidecar), drains current users, restarts the service, and coalesces redundant restarts. Never restart papercusp-email-sidecar.service directly.',
   'enforced',
   ARRAY['systemctl.*restart.*papercusp-email-sidecar']),
  ('email-sidecar-cooldown',
   'Internal debounce marker for coordinated email-sidecar restarts.',
   'Not for direct use — acquired and left to expire only by `dev:restart { target: "email-sidecar" }`.',
   'advisory',
   ARRAY[]::text[]),
  ('calendar-sidecar',
   'The Calendar app sidecar (:8792). Restarting it makes the Calendar app unavailable until it is back.',
   'Use `dev:restart { target: "calendar-sidecar", confirm: true }`; it acquires exclusive(calendar-sidecar), drains current users, restarts the service, and coalesces redundant restarts. Never restart papercusp-calendar-sidecar.service directly.',
   'enforced',
   ARRAY['systemctl.*restart.*papercusp-calendar-sidecar']),
  ('calendar-sidecar-cooldown',
   'Internal debounce marker for coordinated calendar-sidecar restarts.',
   'Not for direct use — acquired and left to expire only by `dev:restart { target: "calendar-sidecar" }`.',
   'advisory',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
