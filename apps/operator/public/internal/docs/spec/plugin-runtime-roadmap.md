# Plugin runtime — pre-release hardening + roadmap
URL: /internal/docs/spec/plugin-runtime-roadmap

What landed for v1.0, what was deferred, and what's deliberately not on the path.

This page tracks the plugin-runtime hardening pass driven by feedback
from the Rust-port plugin agent (2026-05-10). The original pass was split
into six batches; A–E shipped pre-release, F was intentionally deferred
(and has since shipped). Two later batches — **G** (out-of-process WASM
and daemon runtimes) and **H** (sandboxed iframe UI surfaces) — landed
after the A–F hardening pass and supersede the original in-process-only
non-goal; see [Post-A–F: out-of-process runtimes](#post-af-out-of-process-runtimes).

## Shipped pre-release

| Batch                                 | Theme                       | Key changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** — Manifest hardening            | Reject silent typos         | `papercusp-plugin.schema.json` + ajv `additionalProperties:false`; plugin id regex is the scoped form `^(@[a-z][a-z0-9_.-]{0,62}/)?[a-z][a-z0-9_.-]{2,62}$` (the validator's `^(@scope/)?…` error hint abbreviates it — the scope segment is itself a bounded `[a-z][a-z0-9_.-]{0,62}`); bare-name length floor of 3; `protocol`/`papercusp` separated; `apiRoutes` is a structural `PluginApiRoutes` not `unknown`.                                                                                                                         |
| **B** — Two-tier capability check     | Biggest security win        | `CapabilityCheckContext.granted` ANDs with manifest. PG-canonical store `harness_shared.plugin_capability_grants` (Migration 051). The upgrade is silent without a boot backfill: when the grant set is empty, `loadGrantedCapsSafe` returns `undefined` (not `[]`), and `hasCapability` treats `granted === undefined` as the legacy single-tier path — manifest-declared caps still pass. Grants are written at install/enable time via `grantCapabilities` (the `/api/plugins/grants` POST), not at boot. `/api/plugins/grants` GET/POST. |
| **C** — Lifecycle + audit correctness | Debuggable in prod          | `init/onLoad` failure rolls back `initialized`/`registries`/`grants` so a retry re-runs cleanly. `recordAudit` is async, `invoke()` awaits it, audit-write failure becomes the action's failure (fail-closed). PgAuditWriter against `harness_shared.plugin_audit_log`; `NODE_ENV=test` keeps in-memory. AuditRow gains `capabilitiesUsed[]`, `killedByTimeout`, `stdout/stderrBytes`, `truncated`. The Batch C `PgAuditWriter` targets `harness_shared.plugin_audit_log` (see [Migration notes](#migration-notes)).                         |
| **D** — Spawn hardening               | Riskiest API tightened      | `FROZEN_PATH` snapshot at host startup; spawn always uses it regardless of `process.env.PATH` mutation. Absolute paths require the manifest to declare the exact path or a covering wildcard like `compute:exec:/usr/bin/*`. Relative paths still rejected.                                                                                                                                                                                                                                                                                  |
| **E** — Author tooling                | Errors at build, not deploy | `PROTOCOL_VERSION = '1.0.0'`; plugins may declare `protocol: '^1.0'` separate from `papercusp` runtime range. `papercusp plugin lint` runs the loader's manifest validation + entry-point check + capabilities sanity at build time.                                                                                                                                                                                                                                                                                                         |

## ~~Deferred to post-v1.0 (Batch F)~~ — all shipped 2026-05-12

* ~~**Typed `ctx.kv` with quotas**~~ — shipped in papercup#46 + papercupai/papercusp#4 (Migration 054). Per-plugin namespace, 10 KiB/key + 1 MiB/plugin defaults, override via `kvQuota` in manifest. PG-backed.
* ~~**Hot-reload state preservation**~~ — shipped in papercup#47 + papercupai/papercusp#5 (Migration 055). Opt-in via `hotReload: { preserveState: true }`; 64 KiB cap; one-shot restore on next init.
* ~~**`papercusp plugin doctor`**~~ — shipped in papercupai/papercusp#3 + papercup#44 (with the `.read` scanner fix in papercupai/papercusp#6 + papercup#49). Regex scanner for `ctx.spawn` / `ctx.fetch` / `ctx.secrets.read` / `ctx.hookBus.{emit,on}` literal arguments; alias-aware (`const spawn = ctx.spawn`); cross-checks against `capabilities[]`; reports missing / unused / dynamic classifications. **Stale pattern:** the doctor still scans `ctx.hookBus.{emit,on}`, but the hookbus was retired (`plugin-system-pot-port-2026-06-11` P-006) — `ctx.hookBus` no longer exists on the SDK ctx. Plugins now hook the host via declarative `reactions` rules keyed on `<namespace>.<event>` topics; those scan patterns target a dead API and should be dropped or repointed at the reactions surface.

## Post-A–F: out-of-process runtimes

The A–F pass shipped an in-process-only TS runtime. Batches **G** and
**H** crossed that boundary deliberately — the original "no WASM hybrid"
non-goal below has been retired. Per code-as-truth, the runtime now ships
full out-of-process runtimes alongside the in-process JS one.

The manifest declares the runtime via `runtime.kind`, an enum of
`'js' | 'wasm' | 'daemon'` (default `{ kind: 'js' }` for existing
plugins). The operator host dispatches on it: `initializeWasmPlugin` for
`'wasm'`, `initializeDaemonPlugin` for `'daemon'`, otherwise the JS
init/hooks/registry path.

* **Batch G — WASM + daemon runtimes.** `'wasm'` loads a
  `wasm32-wasip2` component-model artifact (`runtime.wasmPath`) via
  `@papercusp/plugin-loader/wasm`; WASM plugins skip the JS hook/registry
  path entirely and expose only manifest-declared `actions`, dispatched
  serially through an mpsc actor handle. `runtime.memoryBudgetMb` caps
  linear-memory growth (1–4096 MiB, **default 64**). `'daemon'` loads a
  long-running stdio JSON-RPC peer (`runtime.daemonCommand` argv) via
  `@papercusp/plugin-loader/daemon`, supervised with a restart policy and
  defaulting to `parallel` concurrency. Only the **daemon** path runs under
  `bwrap` sandboxing (Linux-only, runtime-probed via `bwrapWorks()`); the
  **WASM** path is isolated by the WebAssembly sandbox itself (capability-gated
  host imports + the memory budget) and the JS host denies `compute:exec:*`
  outright (that workload is deferred to the Rust runtime).
* **Batch H — sandboxed UI surfaces.** A plugin UI surface may declare
  `iframe` (sandboxed iframe) in addition to the back-compat `react`
  in-bundle component and the `tui-pane` zellij surface.

See `revive-plugin-system-2026-06-04` for the rationale behind reviving
out-of-process plugin execution.

## Standing non-goals

The Rust-port agent flagged things to NOT do; the ones still in force:

* **No unifying the manifest format with the Rust port's TOML.** Rust
  uses TOML, TS uses JSON. Same concepts, different syntax. Convergence,
  if it ever happens, comes after the Rust runtime can host current-TS
  plugins via a shim.
* **No `apiRoutes: unknown` in the SDK.** Already fixed — A4 changed it
  to `PluginApiRoutes` (structural, pinned to host's Hono major).

> **Retired:** the original "No Node sidecar / WASM hybrid before v1.0"
> non-goal. The argument was that crossing a process boundary loses
> same-language hot-reload and inherits the Rust system's sandbox cost.
> Batches G and H above crossed it on purpose; the in-process JS runtime
> remains the default, with WASM/daemon opt-in per `runtime.kind`.

## Migration notes

> The numbered migrations 051 / 054 / 055 were historical incrementals;
> they are now squashed into the frozen `000-baseline.sql` dump (plan
> `self-contained-migration-baseline-2026-06-02`, baseline = migrations
> ≤ 103; schema changes after that are new migrations 104+). The tables
> they created — `harness_shared.{plugin_capability_grants,plugin_kv,plugin_reload_state}`
> — live in the baseline today. Don't expect to find `051-*.sql` on disk.

Plugin tables the runtime depends on:

| Table                                     | Where it lives                                    | Batch / source                         |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| `harness_shared.plugin_capability_grants` | `000-baseline.sql`                                | B (was Migration 051)                  |
| `harness_shared.plugin_kv`                | `000-baseline.sql`                                | F (was Migration 054)                  |
| `harness_shared.plugin_reload_state`      | `000-baseline.sql`                                | F (was Migration 055)                  |
| `harness_shared.plugin_audit_log`         | **Migration 137** (incremental, not the baseline) | C audit store (`PgAuditWriter` target) |

* `plugin_audit_log` is the one plugin table never folded into the
  baseline. It is created by Migration `137-plugin-audit-log.sql`
  (`revive-plugin-system-2026-06-04` D-001), which also replaced the old
  runtime `CREATE TABLE IF NOT EXISTS` in `plugin-audit-writer.ts` and
  granted the least-privilege app role INSERT/SELECT. Because
  `invoke()` is fail-closed on audit, missing this table fails every
  plugin action on a non-superuser PG role.
* Migration 051 (now baselined) populates `plugin_capability_grants`. If
  it has not run, action invocations are **not** denied: the Tier-2
  loader returns `undefined` (not `[]`) on an empty grant set, and
  `hasCapability` treats `granted === undefined` as the legacy
  single-tier path that allows any cap the manifest (Tier-1) already
  declares. There is no boot-time backfill — grants are written at
  install/enable time via `grantCapabilities`. (A
  `backfillGrantsFromEnabledPluginsAndLegacyFile` helper exists in
  `plugin-grants.ts` but has no production caller; the warm-at-boot path
  in `host-bootstrap.ts` does not invoke it.)
* The legacy `~/.papercusp/granted-capabilities.json` is read-only
  fallback for one release cycle. Remove the read path in the cycle
  after the next release.
