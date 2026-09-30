-- WI-4780: dev:restart advertised gateway / bg-host / embed-sidecar as
-- coordinated restart targets, but none of their resource names (nor their
-- cooldown markers) existed in agent_resource_registry. The dry-run and
-- mocked unit tests therefore passed while every real confirmed restart
-- failed at the first lock acquisition with resource_unknown_resource.
--
-- Register the real shared-service resources as enforced command guards and
-- their tool-internal debounce markers as advisory, pattern-free resources.
-- Idempotent: never overwrite an operator-edited registry row.

INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('inference-gateway',
   'The shared inference gateway (:8788). Restarting it interrupts every agent LLM request currently in flight.',
   'Use `dev:restart { target: "gateway", confirm: true }`; it acquires exclusive(inference-gateway), drains current users, restarts the service, and coalesces redundant restarts. Never restart papercup-inference-gateway.service directly.',
   'enforced',
   ARRAY['systemctl.*restart.*papercup-inference-gateway']),
  ('inference-gateway-cooldown',
   'Internal debounce marker for coordinated inference-gateway restarts.',
   'Not for direct use — acquired and left to expire only by `dev:restart { target: "gateway" }`.',
   'advisory',
   ARRAY[]::text[]),
  ('bg-host',
   'The shared background host for routines, git-sync, and DBOS ticks. Restarting it interrupts in-flight background work.',
   'Use `dev:restart { target: "bg-host", confirm: true }`; it acquires exclusive(bg-host), drains current users, restarts the service, and coalesces redundant restarts. Never restart papercup-bg-host.service directly.',
   'enforced',
   ARRAY['systemctl.*restart.*papercup-bg-host']),
  ('bg-host-cooldown',
   'Internal debounce marker for coordinated bg-host restarts.',
   'Not for direct use — acquired and left to expire only by `dev:restart { target: "bg-host" }`.',
   'advisory',
   ARRAY[]::text[]),
  ('embed-sidecar',
   'The shared embedding sidecar (:3384). Restarting it temporarily degrades semantic search and memory recall.',
   'Use `dev:restart { target: "embed-sidecar", confirm: true }`; it acquires exclusive(embed-sidecar), drains current users, restarts the service, and coalesces redundant restarts. Never restart papercup-embed-sidecar.service directly.',
   'enforced',
   ARRAY['systemctl.*restart.*papercup-embed-sidecar']),
  ('embed-sidecar-cooldown',
   'Internal debounce marker for coordinated embed-sidecar restarts.',
   'Not for direct use — acquired and left to expire only by `dev:restart { target: "embed-sidecar" }`.',
   'advisory',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
