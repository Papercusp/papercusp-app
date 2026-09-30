# @papercupai/repomix

Pack a project (or a subset of it) into a single LLM-friendly document. Wraps the official [Repomix](https://repomix.com) npm package.

This is a **first-party Papercusp tool plugin** demonstrating the function-as-truth pattern: one function (`pack`) is auto-projected onto both the HTTP transport (`POST /api/plugins/repomix/pack`) and the MCP transport (tool `repomix.pack`). Plugin author writes only the function and a manifest entry; the framework wires both transports.

## Usage

### From an agent (MCP)

```json
{
  "tool": "repomix.pack",
  "input": {
    "include": ["src/**/*.ts"],
    "format": "xml"
  }
}
```

### From a human via curl

```bash
curl -X POST http://localhost:3070/api/plugins/repomix/pack \
  -H "content-type: application/json" \
  -H "x-papercusp-workspace: default" \
  -H "x-papercusp-harness: sheets" \
  -H "x-papercusp-role: architect" \
  -H "x-papercusp-run: <runId>" \
  -H "x-papercusp-spawn: <spawnId>" \
  -d '{"include":["src/**/*.ts"],"format":"xml"}'
```

### From the operator UI

The harness dashboard's "Pack project for AI" button (Phase 6 of the integration plan) hits the same `/api/plugins/repomix/pack` endpoint.

## Output policy

- **Small outputs (<50,000 chars):** returned inline as text content.
- **Large outputs:** written to `<stateDir>/scratch/repomix-<sha>-<ts>.<ext>` with metadata returned. Agents fetch via `read` when needed.

The threshold is per-harness configurable via `inlineThresholdChars`.

## Per-role quotas

| Role | Quota |
|---|---|
| worker | 1 / chunk (kept tight to discourage workers from over-pulling context) |
| scoper | 3 / run |
| architect | 5 / run |
| reviewer | 2 / run |
| debugger | 5 / run |

Quotas are enforced by the framework's projection dispatcher and recorded in `harness_shared.tool_invocations`.

## Capabilities required

- `tools:repomix:pack` — invoke the tool
- `compute:exec:repomix` — spawn the repomix binary
- `compute:exec:npx` — spawn npx (used to run repomix without a global install)

## Configuration

Per-harness settings live in `<stateDir>/plugins/@papercupai_repomix/config.json`:

```json
{
  "defaultIgnore": ["node_modules/**", "dist/**", ".papercusp/**"],
  "inlineThresholdChars": 50000
}
```

If absent, manifest defaults apply.
