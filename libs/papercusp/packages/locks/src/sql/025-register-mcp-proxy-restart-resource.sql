-- EI-21297345529573928: papercup-mcp-proxy.service is a supervised shared
-- service, but dev:restart could not drain or coalesce restarts for it because
-- neither the service resource nor its cooldown marker was registered.
-- Idempotent: never overwrite an operator-edited registry row.

INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('mcp-proxy',
   'The shared MCP proxy (:9071). Restarting it interrupts in-flight MCP requests and briefly makes Papercusp tools unavailable.',
   'Use `dev:restart { target: "mcp-proxy", confirm: true }`; it acquires exclusive(mcp-proxy), drains current users, restarts the service, and coalesces redundant restarts. Never restart papercup-mcp-proxy.service directly.',
   'enforced',
   ARRAY['systemctl.*restart.*papercup-mcp-proxy']),
  ('mcp-proxy-cooldown',
   'Internal debounce marker for coordinated mcp-proxy restarts.',
   'Not for direct use — acquired and left to expire only by `dev:restart { target: "mcp-proxy" }`.',
   'advisory',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
