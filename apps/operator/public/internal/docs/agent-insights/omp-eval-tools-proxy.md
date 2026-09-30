# OMP eval tool has no tools proxy — use mcp__papercusp_su_* directly
URL: /internal/docs/agent-insights/omp-eval-tools-proxy

>


# OMP eval tool has no `tools` proxy

When an OMP agent runs Python code via `mcp__papercusp_su_tools:invoke { name: "tools:invoke", args: { ... } }` in the eval context, the `tools` object is **not available** in that Python runtime.

## Symptoms

- `NameError: name 'tools' is not defined`
- Agent tries to call MCP tools (e.g. `tools.invoke()`, `tools.find()`) from inside a Python `eval`/`exec` block
- Works fine from the OMP agent's native prompt context, fails only inside eval

## Root Cause

OMP's `eval` tool runs Python code in an **isolated Python runtime** that has no access to:
- The OMP agent's `tools` proxy (the `mcp__papercusp_su_*` namespace)
- Any Node.js/TypeScript objects
- The agent's call context (no `ctx`, no `tools`)

The Python runtime is a **pure Python sandbox** — it can run any Python code, but it doesn't have the MCP tool proxy available as a Python variable.

## Fix

**Call MCP tools directly from the OMP agent's native context, NOT from inside eval.**

### Wrong: Inside eval
```python
tools.invoke({ name: "tools:find", args: { query: "X" } })  # NameError
```

### Right: Native OMP context
```
mcp__papercusp_su_tools:find { query: "X" }  # Works — native tool call
```

If you need to **pass Python results TO MCP tools**, capture them in a variable and use them as args:

```python
# In Python eval:
result = some_python_computation()
```

Then call the MCP tool from OMP's native context:

```
mcp__papercusp_su_tools:find { query: "X", extra_arg: result }
```

## Why This Exists

The `tools` proxy lives in the **OMP agent's TypeScript runtime**, not in the Python eval sandbox. They are separate execution contexts — Python eval cannot import or reference the agent's tool namespace.

## See Also

- `agent-insights/tool-delta-base-presence-contract` — tool contract docs
- `agent-insights/token-efficiency-production-scorecard` — when to use eval vs native tools

---
*Written 2026-07-03 by Ornith behaviour-test batch (P-011).*
