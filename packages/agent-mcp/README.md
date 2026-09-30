# @papercusp/agent-mcp

MCP server exposing workspace state and substrate write verbs to in-app concierges (Operator, Oracle) and out-of-process pi sessions.

See `apps/operator/content/docs/spec/workspace-scoping.mdx` and `system-and-pi-principals.mdx` for the substrate-level amendments this package depends on.

## Adding a tool

Drop a file under `src/tools/<group>/<verb>.ts`:

```ts
/**
 * Description goes in the TSDoc — used by MCP `tools/list`.
 */
import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  capability: 'tasks:read',
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    const rows = await ctx.tx`SELECT id, title FROM harness_shared.... LIMIT ${args.limit}`;
    return { data: rows };
  },
});
```

Then add the import to `src/bootstrap.ts`. The tool name is derived from the file path (`tools/tasks/list.ts` → `tasks:list`); override via `name`.

## Capabilities

Each tool maps to exactly one capability string per spec/capabilities §10. Tier (low/medium/high) is looked up from `capability-tiers.ts`. Multiple tools may share a capability (e.g. `tasks:list` and `tasks:get` both gated by `tasks:read`).

The DI-proxy enforcement is per spec §10.2: the MCP server resolves the call to a capability, checks the principal's grants, and throws `MissingCapabilityError` (returned as `code: 'missing_capability'` to the MCP client) if absent.

## Workspace scoping

Every handler runs inside `withWorkspace(workspaceId, async (tx) => { ... })`. The `tx` parameter is bound to a transaction with `app.workspace_id` set; every query against `harness_shared.*` is RLS-filtered to the calling workspace.

Never reach for the bare-pool `db` import inside a handler. The `tools/eslint-rules/no-bare-db-in-tx.js` rule enforces this.

## Two-tier responses

Every list/get tool takes `detail: 'summary' | 'full'`. Defaults to `summary`. Pagination via `limit` + `cursor`.

## Degraded-response envelope

```ts
return { data: [], degraded: true, degradedReasons: ['hindsight_not_configured'] };
```

Tools never throw on partial-source failure. They throw only on auth/invalid-args (and that's the dispatch layer, not the handler).

## Provisioning

Before first use, the active workspace's `system:operator` and `system:oracle` principals must be provisioned. Either:

```sh
curl -X POST http://localhost:3055/api/agent-mcp/provision
```

…or call `provisionSystemPrincipal()` from server-side code.

pi sessions provision per-session via `POST /api/agent-mcp/spawn-pi` and end via `POST /api/agent-mcp/end-pi`.

## Running standalone

```sh
AGENT_MCP_BEARER=<bearer> node ./dist/server-entry.mjs
```

For pi/external consumption — talks MCP over stdio.

## In-process dispatch

For Operator/Oracle running in the operator process:

```ts
import { dispatch } from '@papercusp/agent-mcp';

const result = await dispatch({
  toolName: 'tasks:list',
  args: { detail: 'summary' },
  bearer: bearerForCallerPrincipal,
});
```

Same contract, no transport overhead.
