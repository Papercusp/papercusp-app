# Plugin tools after a deploy: the empty-registry window (gitnexus was never down)
URL: /internal/docs/agent-insights/plugin-tools-empty-registry-window

unknown_tool on a plugin tool (gitnexus.*, repomix.pack, design-phase.*) right after an operator restart meant the projected-tool registry hadn't been populated yet — registration was lazy (first getPluginHost() call), and :3070 restarts on every deploy. Fixed by an eager boot warm in host-bootstrap; diagnosis recipe + the misdiagnosis trap.

## The trap

For weeks the fleet treated **gitnexus as down** ("spawn-fails") because calls
to `gitnexus.list_repos` etc. returned:

```
unknown_tool: no tool named "gitnexus.list_repos"
```

gitnexus was **never broken**. The binary resolved, `gitnexus mcp` answered
`initialize` + `tools/list` sub-second, and the bridge's dynamic-tool probe
succeeded whenever it actually ran. The error came from the **operator's
projected-tool registry being empty** at the moment of the call.

## Root cause

Plugin-contributed tools (everything namespaced `<plugin>.<verb>`) are wired
into the projected-tool registry by `registerPluginTools()`, which ran only
inside `getPluginHost()` — **lazily, on the first plugin-dependent request**
(`plugins:runtime_status`, a `/api/plugins/*` hit, …). Boot-time
`mountPluginApiRoutes()` does its own light scan and did NOT build the host.

Meanwhile the `:3070` operator **restarts on every deploy** (the
release-trigger pipeline, roughly hourly when staging is moving). So after
every deploy the host sat with an **empty plugin-tool registry** until
something happened to poke the plugin host. An agent whose first plugin call
landed in that window got `unknown_tool`, concluded the plugin was down, and
the diagnosis stuck (it even made it into the SU playbooks).

The window also made symptoms flap: probing `plugins:runtime_status` (e.g.
while debugging!) populated the registry as a side effect, so the problem
"fixed itself" whenever someone looked closely — the classic heisenbug shape.

## The fix (2026-06-11)

`apps/operator/bin/host-bootstrap.ts` now **eagerly warms the plugin host at
boot** (fire-and-forget `getPluginHost()` right after `mountPluginApiRoutes()`)
and logs:

```
[plugin-host] warmed at boot: loaded=22 errors=0
```

Verified live on `:3170`: cold `gitnexus.list_repos` straight after a restart
returns repo data; `repomix.pack` dispatches.

## How to diagnose plugin-tool failures now

1. `plugins:runtime_status` — is the plugin in `loaded`? Are there
   `loadErrors` or `tool wiring failed` entries? (Dynamic-probe failures —
   e.g. a gitnexus child that genuinely won't spawn — land here as
   `getDynamicTools failed`.)
2. `journalctl --user -u papercup-dev-api.service | grep plugin-host` — the
   boot-warm line tells you registration ran and with how many errors.
3. Only then suspect the plugin itself. For gitnexus specifically: the bridge
   spawns `gitnexus mcp` from PATH (with linuxbrew fallbacks baked in) and
   needs `gitnexus analyze <repo>` to have been run for a repo to be indexed.

## Related gotchas

* A manifest-only plugin (no entry point — provision scripts / declarative
  roles only, e.g. `cloudflare-stack`) **loads** as of 2026-06-11; before
  that it produced a bogus `no entry point found` loadError. Packs and
  manifests that declare `tools` still require an entry.
* **EI-38 ("plugin tools surface only on workspace-scoped sessions") was
  this same bug.** Verified 2026-06-11 on a warmed host: an unscoped
  `?superuser=1` session lists and dispatches every plugin tool. If a
  session is missing them, suspect a partial registration sweep (gitnexus's
  cold child-spawn probe finishes late; tools registered so far are live,
  the rest arrive in the background), not workspace scoping.

Plan: `plugin-system-pot-port-2026-06-11` (P-011/P-012).
