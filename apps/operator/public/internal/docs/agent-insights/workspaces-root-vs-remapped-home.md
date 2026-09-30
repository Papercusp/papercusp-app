# The workspaces root lives above the HOME-remap boundary
URL: /internal/docs/agent-insights/workspaces-root-vs-remapped-home

Any TS code resolving ~/.papercusp-workspaces via homedir() is fragile when the caller's HOME is remapped (per-workspace child processes under P-051). Resolve the root from PAPERCUSP_WORKSPACES_ROOT instead — main.rs always passes it. Phase E (P-050) moved the sidecar itself to shared_sidecar_home() = real HOME, so the original sidecar-level trap is resolved, but the rule stands for spawned children.

## The trap

`~/.papercusp-workspaces/` holds the workspace **registry.json** plus every
per-workspace directory. It is **bootstrap state that lives above the
per-workspace isolation boundary** — there is exactly one of it per install,
shared by every workspace.

**Historical context (Phase D — before 2026-06):** the packaged desktop used to
spawn the operator sidecar with `HOME` **remapped to the active workspace dir**
(`main.rs`: `.env("HOME", &workspace_home_str)`, where
`workspace_home = ~/.papercusp-workspaces/<current>`). Inside that sidecar:

```ts
import { homedir } from 'node:os';
join(homedir(), '.papercusp-workspaces', 'registry.json')
// → ~/.papercusp-workspaces/<current>/.papercusp-workspaces/registry.json
//   a NESTED registry, one level inside the active workspace
```

This made the sidecar's registry disagree with the Rust shell's, surfacing as
nested junk registries and `switch failed: workspace dir for <id> missing`.

**Current state (Phase E, P-050 / D-008 — landed 2026-06):** the sidecar now
runs under the **real user HOME** via `workspaces::shared_sidecar_home()`
(= `real_home()`). One shared sidecar serves ALL workspaces; per-workspace
credential isolation moves to each **spawned child's** HOME, set operator-side
from the job's workspace (P-051). The sidecar's own `HOME` is no longer
remapped.

The original sidecar-level trap is therefore resolved. **The rule below still
applies** because:

1. `main.rs` still passes `PAPERCUSP_WORKSPACES_ROOT` explicitly (belt-and-
   suspenders: future HOME changes won't silently break registry resolution).
2. Spawned CLI children (claude, git, pi, spawned agents) can have their HOME
   overridden to a per-workspace dir (P-051) — any registry-touching code
   running in those children that uses bare `homedir()` would hit the same
   nested-registry trap.

It is **invisible in dev** regardless of phase: `npm run dev` runs the operator
with the real `HOME`, so `homedir()` happens to resolve correctly. Packaged-
build differences only emerge if HOME-remapping returns for a new context.

## The rule

Resolve the workspaces root from the explicit env the desktop passes, not from
`homedir()`:

```ts
// packages/operator-core/lib/workspace-registry.ts
export function workspacesRoot(): string {
  const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
  if (env && env.trim()) return env;
  return join(homedir(), '.papercusp-workspaces'); // dev fallback — HOME not remapped in sidecar
}
```

`main.rs` always passes `PAPERCUSP_WORKSPACES_ROOT = workspaces::workspaces_root()`
(the real root, derived from the Rust-side `real_home()`) to the sidecar,
regardless of what `HOME` is set to. The `homedir()` fallback keeps dev behavior
identical (and also correct in Phase E, since the sidecar HOME is no longer
remapped). For any child process spawned with a per-workspace HOME (P-051), the
`PAPERCUSP_WORKSPACES_ROOT` env is the only reliable anchor.

**Any path that resolves `~/.papercusp-workspaces` must go through
`workspacesRoot()`** — registry, per-workspace dirs, `clones/`, `backups/`,
hyperbee stores. A bare `join(homedir(), '.papercusp-workspaces', …)` is the
smell.

### The rule currently has live violations (measured 2026-08-09)

Stating the rule is not the same as the tree obeying it.

**Fixed 2026-08-09 (EI-19484521468253560):** the three `packages/plugin-loader/src/index.ts`
sites (registry read, active-workspace `.papercusp` probe, `default` fallback) and
`apps/operator/scripts/voice-stack-check.mjs:42` — all now route through an env-first
(`PAPERCUSP_WORKSPACES_ROOT`) local resolver instead of a bare `homedir()`. That package was
the *exact* residual case reason 2 above describes: a plugin loader runs inside spawned
children, and P-051 gives those children a per-workspace `HOME`. Under a remapped-HOME
child the old code resolved to the nested
`~/.papercusp-workspaces/<current>/.papercusp-workspaces/registry.json` this page opens by
describing — the same nested-junk-registry / `switch failed` class. Invisible in dev for the
reason given above: `npm run dev` never remaps `HOME`, so `homedir()` happened to be right
there.

**Still open (filed 2026-08-09 as WI-37486, split out rather than expanding the ticket
above):** re-running the audit grep while fixing the ones above turned up a substantially
bigger population than the 2026-08-04 measurement recorded —
`libs/papercusp/packages/cli/src/papercusp-root.ts:37,42,48` (a near-identical 3-site
hand-rolled copy in the papercusp CLI), `libs/papercusp/packages/cli/src/operator-cli.ts:41`,
`libs/papercusp/libs/db/scripts/backfill-workspace-id.ts:77`,
`apps/operator/scripts/el-agent-sync.mjs:35` (voice-stack-check.mjs's sibling script, same
shape, not yet fixed), and a THIRD near-duplicate hand-rolled implementation in
`libs/papercusp/plugins/cloudflare-pages/index.ts:62,67,72` (plus a checked-in compiled
`index.js:63,68,75` carrying the same 3 sites — check whether it's generated before editing
both). See WI-37486 for the current per-site detail; this page intentionally does not keep a
line-number inventory in sync by hand.

Categories of hit that are NOT violations and should stay as they are:
`_retired/snapshot-system/**` (retired, per the retired-surfaces convention);
`packages/operator-core/lib/workspace-registry.ts` itself (the canonical `workspacesRoot()` —
its own `homedir()` fallback is the contract, not a breach of it);
`packages/operator-core/lib/workspace-registry.test.ts:230,235` and
`libs/papercusp/packages/orchestrator/src/workspace.test.ts:64`, which assert that fallback on
purpose; and `libs/papercusp/packages/orchestrator/src/workspace.ts`'s `workspaceHomeDir()`
(already correctly env-first — only its unrelated `REGISTRY_PATH` constant at `:18` is a
borderline case, noted but not asserted as a violation in WI-37486).

Four to five independent hand-rolled copies of "resolve `~/.papercusp-workspaces`, env-first"
now exist in the tree — exactly the duplication this page's own fix notes have repeatedly
warned would keep recurring absent a shared helper. WI-37486 proposes a tiny
shared/generic-lib env-first helper for the callers that can't safely depend on
`@papercusp/operator-core` (plugin-loader, scripts, the CLI, plugins).

⚠ Verify before citing this list: it is a point-in-time measurement, and the whole reason this
page exists is that the smell reappears. Re-run
`rg "homedir\(\), *['\"]\.papercusp-workspaces"` (excluding `node_modules`, `dist`, `_retired`)
rather than trusting the paths above.

## Related invariant

A registry entry and its on-disk directory are **two halves of one invariant**:
the Rust `switch()` guard refuses to switch to a registered workspace whose dir
is missing. Any code that adds a registry entry must also provision the dir
(`ensureWorkspaceDir`). See also \[\[forward-defined-registry-entries]].
