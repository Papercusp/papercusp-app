# The PAPERCUSP_WORKSPACE_ID pin silently rebinds every workspace
URL: /internal/docs/agent-insights/workspace-id-pin-and-harness-membership

A host-wide PAPERCUSP_WORKSPACE_ID env pins activeWorkspaceId() above registry.current, so every non-request path (background work, spawn envelope, harness-list tool) resolves to the pinned workspace with NO warning — one stray `=default` made papercusp-workspace surface default's whole harness registry. Plus how harness→workspace membership actually works, and the dev-box native-PG substrate.

## The trap

`activeWorkspaceId()` (`packages/operator-core/lib/workspace-registry.ts`) resolves in three steps:

```
1. request-scoped  — currentRequestWorkspaceId()  (x-papercusp-workspace header → ALS)
2. process pin     — process.env.PAPERCUSP_WORKSPACE_ID            ← sits ABOVE the default
3. global default  — registry.current ?? workspaces[0] ?? 'default'
```

Step 2 is meant for a **deliberately single-workspace process** (an orchestrator
agent, a durable-pipeline dispatcher). But the `:3070` hono-host is inherently
**multi**-workspace — it serves every desktop window. If `PAPERCUSP_WORKSPACE_ID`
is set on *that* host, it pins **every non-request path** to one workspace:

* background work and the operator brain,
* the **spawn envelope** (`packages/operator-core/lib/console-launcher.ts` sets `PAPERCUSP_HOME = papercuspPath()`,
  which resolves against the pinned workspace),
* the **harness-list / features** tools whenever a request didn't stamp
  `x-papercusp-workspace`.

And it does so **silently**: the P-021 "global fallback inside a request" warning
(`warnGlobalFallbackInRequest`) only fires when resolution reaches step 3 — the
env pin returns at step 2, *before* that guard. So a stray pin leaves no trace in
the logs.

### The symptom this actually caused (2026-06-01)

`apps/operator/.env.local` carried a `# TEMPORARY (gate-fix validation)` line:

```
PAPERCUSP_WORKSPACE_ID=default
```

added so the durable pipeline would resolve `sheets` (which lives in `default`).
It was never reverted. Effect: the **`papercusp-workspace`** desktop showed
**default's** entire harness registry (`papercup-org*`, `sheets`, `restart`, …)
instead of its own. It also caused the `resolveProject → papercup 404`
(the dogfood P-026 blocker): with the active workspace forced to `default`,
`papercup` — which is registered only in `papercusp-workspace` — was unreachable.

**Fix:** remove the pin, restart the `:3070` host (no hot-reload — it re-sources
`.env.local` only on restart: `systemctl --user restart papercup-dev-api.service`).
Resolution then falls through to the per-window header, then `registry.current`
(`papercusp-workspace`), and each workspace shows its own set again.

A boot guardrail now warns loudly when the pin is set (`bin/hono-host.ts`,
`serve()` callback) — a bare `# TEMPORARY` comment was not enough to stop it
surviving.

## How harness→workspace membership actually works

A harness "belongs to" a workspace iff that workspace's registry row carries its
slug. The store is **one JSONB row per workspace** in
`harness_shared.harness_registry` (`payload->'projects'[]` = `{slug, path}`):

```sql
SELECT workspace_id,
       (SELECT string_agg(p->>'slug', ', ' ORDER BY p->>'slug')
          FROM jsonb_array_elements(payload->'projects') p) AS slugs
FROM harness_shared.harness_registry ORDER BY workspace_id;
```

The harness LIST a workspace shows = its own row's `projects[]`. Membership ops
live in `packages/operator-core/lib/harness-membership.ts` (`workspacesForHarness`,
`addHarnessToWorkspace`, …) + `POST /harness/:slug/membership`. **Caveat:** until
Phase 2 of `harnesses-across-workspaces` lands, `resolveProject(slug)` resolves
against the *active* workspace only — so a harness registered in a non-active
workspace is a member but **not addressable** from elsewhere. That is exactly why
a wrong active workspace produces both a wrong list *and* 404s.

Note: the `~/.papercusp-workspaces/<ws>/.papercusp/harnesses/<slug>/` directories
are **worktrees**, not the membership source of truth. `default` had \~80 orphaned
worktree dirs (old sheets/org/smoke runs) that the registry does **not** list and
the UI does **not** show — disk cruft, not membership.

## Dev-box substrate reality (don't trust the shipping doc here)

`CLAUDE.md` says the product is **embedded-pg only** and native `papercusp` was
renamed `papercusp_legacy` to fail loud. That describes the **shipping** model.
The standing dev box **diverges**: `apps/operator/.env.local` pins
`DATABASE_URL=postgresql://harness_admin:…@localhost:5432/papercusp`, so the
operator runs against **native PG `papercusp`** (alive, not `_legacy`). Under that
override the per-workspace `~/.papercusp-workspaces/<ws>/.papercusp/embedded-pg-data`
dirs are **vestigial** — the operator never opens them. Before reasoning about
"which PG holds the truth," check `DATABASE_URL` in `.env.local` and which
`postgres:` processes are actually serving (`ps aux | grep papercusp`).

## Diagnosing in 30 seconds

```bash
# 1. Is a pin in effect on the running host?
for p in $(pgrep -f hono-host.ts); do tr '\0' '\n' </proc/$p/environ | grep PAPERCUSP_WORKSPACE_ID; done
# 2. What does each workspace actually resolve to? (SU options endpoint)
TOK=$(cat ~/.papercusp/superuser-token)
curl -s -H "Authorization: Bearer $TOK" \
  'http://127.0.0.1:3070/api/agent-mcp/console/bootstrap-su/options?workspace=papercusp-workspace'
# 3. Ground truth membership
psql "$DATABASE_URL" -c "SELECT workspace_id, jsonb_array_length(payload->'projects') FROM harness_shared.harness_registry;"
```

See also \[\[workspaces-root-vs-remapped-home]] (the *other* workspace-resolution
trap — `homedir()` landing in a nested registry under the desktop's HOME remap)
and \[\[forward-defined-registry-entries]].
