# Plugin authoring quickstart
URL: /internal/docs/spec/plugin-quickstart

Build, lint, install, and publish a Papercusp plugin in five minutes.

You'll go from blank directory to a published plugin running in a harness, in five commands. Run them top-to-bottom in a fresh terminal.

## Prerequisites

* `papercusp` CLI on PATH (`papercusp --version` prints something).
* A running operator on `localhost:3055` (`bin/dev` from the papercup repo) — needed for in-process testing but not for authoring or publishing.
* A running marketplace API on `localhost:3057` (`systemctl --user status marketplace-api`) — needed for publish.

## 1. Scaffold

```bash
papercusp plugin init my-tool
cd my-tool
```

`init` copies the default template `cloudflare-stack` (the most-thoroughly-exercised first-party plugin) and rewrites every reference to your new slug. That template is **provision-only and declarative** — it ships no JS entry point. You'll get:

```
my-tool/
├── papercusp.json          # manifest — declared capabilities + UI surfaces
├── README.md               # user-facing description
├── provision/              # setup.sh / teardown.sh / verify.sh — infra lifecycle
├── examples/               # *.tmpl files rendered at fork time
└── roles/                  # reviewer role markdown
```

There is **no `index.js`** in the default scaffold. A JS entry point is optional — only `runtime.kind: "js"` plugins ship one. `init`'s own next-steps tell you to edit `provision/setup.sh` and the `configSchema`, not an entry point.

The plugin name is always **scoped to a publisher**. `init my-tool` defaults the scope to `@local`, so the generated manifest `name` is `@local/my-tool`. Pass `--publisher <@scope>` (or edit the name afterward) to change it, and use the scoped slug everywhere downstream (publish/install).

Use `--template <slug>` to pick a different starter (e.g. `--template @papercupai/slack-notifier`), or `--from-path <dir>` to fork a local checkout. The target directory (`./<name>`) must be empty.

## 2. Edit the manifest

Open `papercusp.json`. The fields that matter for your first plugin:

```json
{
  "name": "@local/my-tool",
  "version": "0.1.0",
  "kind": "plugin",
  "description": "What this does in one sentence.",
  "author": "you",
  "license": "MIT",
  "papercusp": "^0.1.0",
  "capabilities": [
    "tasks:read",
    "http:fetch:api.example.com",
    "secrets:read:MY_TOOL_API_KEY"
  ],
  "actions": [
    {
      "name": "ping",
      "label": "Ping the API",
      "icon": "Activity",
      "surfaces": ["harness-toolbar"],
      "capabilities": ["http:fetch:api.example.com"]
    }
  ]
}
```

**Capability strings** are namespace:action\[:resource]. Every host-side I/O — fetch, secrets, spawn — is gated by a capability you must declare here. The two-tier check (manifest ∩ user-granted) means users can also revoke any of these per-harness without uninstalling the plugin.

Reserved namespaces:

* `tasks:` / `features:` / `goals:` — substrate read/write
* `http:fetch:<host>` — outbound HTTP. Wildcard `*.foo.com` matches subdomains.
* `secrets:read:<NAME>` / `secrets:write:<NAME>` — per-secret. Wildcard `MY_*` for families.
* `compute:exec:<binary>` — `ctx.spawn(bin, args)` gate.
* `events:emit:<name>` — plugin-emitted events; must be prefixed with your plugin id (`my-tool.foo`).
* `events:listen:<trigger>` — one per reaction-rule trigger key (`events:listen:pipeline:done`, `events:listen:work_items:complete`, or another plugin's `events:listen:other-tool.foo`) — the consent surface for what you watch.
* `ui:dashboard-tab` / `ui:sidebar-item` / `ui:harness-route` — UI surface claims.

**Wildcards** only work in the leaf segment, and only with non-empty heads:

* `*.foo.com` matches subdomains (subdomain form)
* `MY_*` matches prefixes (head must be non-empty)
* Bare `:*` (e.g. `compute:exec:*`) is **not** a wildcard — it only matches the literal cap string. Enumerate or use a non-empty prefix.

### Snapshot version pinning

Plugins can declare how aggressively a snapshot-fork should preserve the installed version:

```json
"versionPin": { "mode": "exact" }
```

* `"mode": "semver"` (default) — fork accepts compatible upgrades.
* `"mode": "exact"` — fork pins to the snapshot's exact version.
* `"mode": "hash"` — fork pins to the snapshot's content hash.

Optional `"allowOverride": "security-patch" | "always" | "never"` controls whether the operator can override the pin (e.g. force a security update). The capture path writes `versionPin` into the snapshot manifest; legacy `pluginVersionPinned: true` is translated to `{ mode: "exact" }` for back-compat.

### Plugin runtime

The optional `"runtime"` field declares which host runtime your plugin needs. It's an **object** with a required `kind` plus kind-specific config:

```json
// WASM plugin
"runtime": {
  "kind": "wasm",
  "wasmPath": "pkg/my-plugin.wasm",
  "memoryBudgetMb": 64,
  "concurrency": "serial"
}

// Daemon plugin
"runtime": {
  "kind": "daemon",
  "daemonCommand": ["/usr/bin/my-daemon", "--stdio"],
  "daemonRestart": { "policy": "on-failure", "maxRestarts": 3 }
}
```

`kind` is one of:

* `"js"` (default) — in-process Node host. Plugin literals exported from `index.cjs`. Omit `runtime` entirely.
* `"wasm"` — WASM component, run via `jco` (TS host) or `wasmtime` (Rust host). See `@papercusp/plugin-wit` for the WIT contract. Requires `wasmPath` relative to the manifest dir. Default `memoryBudgetMb: 64`.
* `"daemon"` — sandboxed subprocess (bubblewrap `bwrap` on Linux) speaking a JSON-RPC stdio bridge to the host. Requires `daemonCommand` (the daemon binary's argv). Optional `daemonRestart` policy. Run by `@papercusp/plugin-loader/daemon`; the loader and operator host runtime instantiate daemon manifests the same way they do WASM ones.

## 3. Lint

```bash
papercusp plugin lint
```

Catches manifest schema errors, missing entry point, malformed capability strings — every check the loader runs at runtime, run at build time. Exits non-zero on any issue.

If you don't run lint, the operator will reject loading at install time with the same error, just later.

### `doctor` — declared vs used capability check

```bash
papercusp plugin doctor
```

Static-analyzes your plugin source against `capabilities[]`. Reports:

* **Missing** caps — `ctx.spawn('git', ...)` in source, no `compute:exec:git` in manifest. Fatal — the loader will deny it at runtime.
* **Unused** caps — declared but no matching call site detected. Warning — review for cap pollution or note false positives (e.g. caps gated through code paths the scanner misses, or `events:listen:` consumed by a manifest `reactions[]` rule rather than a code call site).
* **Dynamic** lookups — `ctx.spawn(varname, ...)` etc. that can't be statically verified. Informational only.

Run both `lint` and `doctor` pre-commit. Together they catch \~80% of "works in dev, breaks on first prod load" issues without an AST walker.

## `ctx.kv` — plugin-private key/value store

For small structured state (counts, timestamps, last-seen markers) use `ctx.kv` instead of writing JSON files under `pluginDataDir`:

```ts
const last = await ctx.kv?.get<number>('lastSync');
await ctx.kv?.set('lastSync', Date.now());
await ctx.kv?.delete('lastSync');
const keys = await ctx.kv?.list({ prefix: 'sync:', limit: 50 });
```

* **Quota** — default 10 KiB per key, 1 MiB total per plugin. Override via `kvQuota: { maxBytesPerKey, maxBytesPerPlugin }` in the manifest.
* **Isolation** — each plugin sees only its own keys; cross-plugin reads are impossible.
* **Backend** — Postgres in the operator (state survives reload, observable in the operator UI). Optional in principle (`ctx.kv?.` guard is still good hygiene), though since the `papercusp-fire-hook` CLI was retired (2026-06-12) every hook fire is in-process and carries it.
* **Errors** — quota violations throw `KvQuotaError` from `@papercusp/plugin-sdk`.

Use `pluginDataDir` for blobs > 10 KiB, code, or anything that doesn't need to be scanned/aggregated.

## Hot-reload state preservation (optional)

Plugins with in-flight state that shouldn't reset on every reload (debounce timers, accumulated counters, live connections) can opt in via the manifest:

```json
{ "hotReload": { "preserveState": true } }
```

Then implement two hooks:

```ts
hooks: {
  async getStateForReload(ctx) {
    return { queue: this.queue, debouncer: this.debouncer.flush() };
  },
  async restoreFromReload(ctx, state) {
    this.queue = (state as Saved).queue;
    this.debouncer.resumeFrom((state as Saved).debouncer);
  },
}
```

* **Lifecycle.** Reload begins → `getStateForReload(ctx)` → host stashes the returned value → reload completes → new module instance's `init()` runs → `restoreFromReload(ctx, state)` runs before any other hook.
* **One-shot.** Restore is destructive. If `restoreFromReload` throws, the host logs + discards; the plugin starts fresh on the next reload.
* **Size cap.** State must be JSON-serialisable and ≤ 64 KiB. Bigger state belongs in `ctx.kv` or `pluginDataDir`.
* **Uninstall.** Doesn't trigger these hooks — use `onUnload` for cleanup. Uninstalled plugins have their stashed state cleared.

## 4. Test locally

`init` is a **scaffold-new** command — `--from-path .` forks your checkout into a *new*, empty plugin dir, it does not iterate in place. For in-place dev, symlink the checkout into the active workspace's `global-plugins` and enable it:

```bash
# Symlink for fast dev. Use the resolved workspace root, NOT ~/.papercusp —
# the substrate now lives under ~/.papercusp-workspaces/<workspace>/.papercusp/.
ln -sf "$PWD" ~/.papercusp-workspaces/<workspace>/.papercusp/global-plugins/@local/my-tool
papercusp plugin enable @local/my-tool --harness <your-harness-slug>
```

(`~/.papercusp/global-plugins` is only the legacy fallback used when no workspace registry exists; on a current install the loader discovers plugins under the resolved workspace root.)

Open the operator's harness dashboard. Your plugin's actions show up in the toolbar (per the `surfaces[]` you declared). Hot reload: edit your code, then restart the **API host** unit that runs the plugin loader — `systemctl --user restart papercup-dev-api` (the Hono host on `:3070`), not the frontend `papercup-dev` (`:3055`). The loader re-discovers from disk on restart.

To run an action without the UI:

```bash
papercusp plugin invoke @local/my-tool ping --harness <your-harness-slug>
```

## React to host events (optional)

To run one of your tools when something happens in the pipeline, declare a
**reaction rule** — no hook code, no subscription plumbing:

```jsonc
// papercusp.json
{
  "capabilities": [
    "tools:my-tool:notify",
    "events:listen:pipeline:done"        // consent for what you watch
  ],
  "reactions": [
    {
      "id": "notify-on-done",
      "on": "pipeline:done",                       // any tool name or host emission
      "when": { "args.harness": { "equals": "my-harness" } },  // data-match, optional
      "fire": "my-tool.notify",                    // must be YOUR tool
      "args": { "via": "reaction" }
    }
  ]
}
```

The host fires `my-tool.notify` through normal dispatch (audited,
capability-scoped to the fired tool, loop-guarded). Entry-point plugins can
declare the same rules in code (`reactions` on the plugin export) with
function `when`/`args`. Trigger vocabulary + the full capability contract:
[Plugins §7.0](/internal/docs/spec/plugins). Inspect what registered via
`plugins:runtime_status` → `reactionRules`.

## 5. Publish

```bash
papercusp publish .
```

This command, in order: auto-compiles `index.ts` → `index.js` (CommonJS, for the substrate loader); scans the tree for secrets; packs a gzip tarball; optionally generates a CycloneDX SBOM; and POSTs a multipart form (manifest + tarball + optional README) to the marketplace at `localhost:3057` with a Bearer auth header. The CLI does **not** sign the tarball — tarball integrity is a `sha256-` hash computed at *install* time, not a signature at publish.

Author-facing flags:

* `--no-compile` — skip the TS → JS compile.
* `--acknowledge-secrets` — the secret scan **blocks publish** on any finding; pass this to substitute placeholders and proceed anyway.
* `--no-sbom` / `--sbom <file>` — skip SBOM generation, or upload a pre-built one.

The catalog refreshes immediately; install on another harness with the scoped slug:

```bash
papercusp install @local/my-tool
```

For a hosted marketplace publish (papercuspai.com), see [Marketplace publishing](/internal/docs/implementation/marketplace).

## Common pitfalls

* **"unknown property X" at lint time** — the manifest validator is strict on top-level keys. Either move the field into a known one (e.g. `configSchema` for config defaults, `provision` for infra setup) or refer to the [schema](https://papercuspai.com/schema/papercusp-plugin.schema.json).
* **"plugin missing capability X"** at runtime — declare it in `capabilities[]`. If users can revoke it, also acquire user grant via the install consent prompt or `/installed/plugins/<slug>/permissions`.
* **`ctx.spawn('foo')` ENOENT** — `foo` is resolved against the host's `$PATH` snapshot, not the plugin's. Either declare the absolute path in your `compute:exec:/abs/path` capability and call with the full path, or rely on the host having `foo` on its boot-time PATH.
* **Event collision warnings** — your `events:emit:foo` got rejected. Plugin events must be prefixed with the plugin id: `events:emit:my-tool.foo`.

## Next: where to look

* [Plugin runtime hardening + roadmap](/internal/docs/spec/plugin-runtime-roadmap) — what's enforced + what's deferred.
* [Marketplace pipeline](/internal/docs/implementation/marketplace) — publish flow, registry, signing, R2.
* First-party plugins under `~/.papercusp-workspaces/<workspace>/.papercusp/global-plugins/@papercupai/*` are the best reference implementations.
