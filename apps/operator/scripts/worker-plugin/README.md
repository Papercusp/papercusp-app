# `papercusp-worker` — Claude Code plugin (progressive packaging)

A **Claude-only progressive enhancement** (papercusp-worker-integration-2026-06-04,
D-005): the worker integration's hooks packaged as one installable Claude plugin, so
a Claude user can wire them up with `claude plugin install` instead of running
`install-standalone-mcp.sh` and hand-merging `~/.claude/settings.json`.

It bundles the **hooks** of the cross-CLI worker integration:

- **file-lock coordination** (Pre/PostToolUse `locks:*`)
- **the activity bridge** (PostToolUse `activity:report` — mirrors every native tool
  call into `harness_shared.agent_activity` → the pui fleet view + curator), which
  ALSO folds in new `coord:inbox` messages mid-turn on the same round trip
  (EI-11405 — the standalone coord-inbox hook this used to pair with is retired)
- **the named-resource Bash gate**

## Scope + honest limitations (read before relying on it)

This plugin is a **thin wiring convenience over an installed Papercusp operator**, not
a self-contained portable artifact. Specifically:

1. **It assumes the operator is installed.** The hook commands reference the worker
   scripts at their stable installed location (`~/.papercusp/hooks/cc/`, populated by
   `install-standalone-mcp.sh`) and those scripts need a running operator (`:3070`) +
   `~/.papercusp/superuser-token`. On a machine without that, the hooks **fail open**
   (no-op) — the plugin degrades gracefully, it just does nothing. So the baseline
   install path remains `install-standalone-mcp.sh`; this plugin never replaces it.
2. **MCP is NOT bundled here.** The `papercusp` MCP server is a localhost HTTP server
   with **dynamic per-session auth** (an env-expanded `${PAPERCUSP_SID}` URL + a bearer
   from `~/.papercusp/superuser-token`), which a static plugin manifest can't bake
   portably. MCP attachment stays with the baseline installer (`~/.claude.json`).
3. **The statusline is NOT bundled here** — Claude statuslines are a user-settings
   concept, not a plugin contribution (verified against current Claude Code docs). The
   fleet statusline ships via `install-standalone-mcp.sh` (non-destructively).
4. **Not yet verified end-to-end against a live `claude plugin install`.** The manifest
   shape is schema-validated by `worker-plugin.test.ts`; the actual marketplace
   install flow + portable distribution (the Cupboard listing, D-008) are the
   remaining distribution work — coupled to the in-flight Cupboard plugin-listing
   infra (`revive-cupboard-distribution-2026-06-04`).

## Layout

```
worker-plugin/
├── .claude-plugin/plugin.json   # the manifest (name, hooks → ./hooks/hooks.json)
├── hooks/hooks.json             # references ${HOME}/.papercusp/hooks/cc/*.sh
└── README.md                    # this file
```

## Cupboard distribution (D-008) — the remaining seam

The worker setup as a Cupboard `kind=plugin` listing (one-fetch install) is the
distribution endgame. It builds on (a) this manifest and (b) the Cupboard plugin
listing + install-from-Cupboard path. That path is hardened against untrusted
manifests (D-007 — `install-plugin-core.ts` rejects path traversal + absolute/`..`
refs) and is being built under `revive-cupboard-distribution-2026-06-04`. Once that
listing schema settles, this manifest is the artifact it points at.
