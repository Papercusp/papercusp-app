# Retired: operator:delegate / delegate_to_claude

Retired on 2026-06-21.

The active `operator:delegate` MCP tool and browser/voice `delegate_to_claude`
command were removed from discovery because the old delegate surface confused
agents after the operator role split into newer Sentinel/Queen/work-item flows.

What replaced it:

- Human-facing conversation: `operator:converse` / `papercup:converse`.
- Durable agent work: `work_items:*`, `coord:*`, and harness placement flows.
- Historical delegate sessions: `delegates.list`, `delegates.get`, and
  `delegates.search` may still read old records, but they do not start work.

The old `/api/agent-mcp/delegate-chat` endpoint remains as a `410 Gone`
tombstone for stale clients.
