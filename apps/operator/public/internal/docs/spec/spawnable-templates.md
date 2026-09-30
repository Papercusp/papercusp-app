# Spawnable templates
URL: /internal/docs/spec/spawnable-templates

Marketplace contract for templates that other harnesses can spawn as children.

> **Webapp retired (2026-05-14).** Any `localhost:3055` or `localhost:3070` URL on this page is only reachable while the **Tauri dev shell** is running. Start it with `cd papercusp-desktop && npm run dev`.

import { Aside } from '@astrojs/starlight/components';

The spawnable-template contract here remains live for the `scaffold_harness`
executor verb (`GET /api/marketplace/spawnable` →
`packages/operator-core/lib/spawnable-templates.ts`). The newer
`harness:create` MCP path instead instantiates a **blueprint** (`blueprintId`
resolved local → installed → built-in, e.g. `coding` / `research`); that is the
preferred way to author a new managed harness going forward.

A marketplace template is **spawnable** if its `papercusp.json` declares a `spawnable` field:

```json
{
  "name": "papercup-coding",
  "version": "0.1.1",
  "spawnable": {
    "kind": "coding",
    "requires": ["spec"]
  }
}
```

Without this field, the template can be installed manually by a user but cannot be spawned by another harness's `scaffold_harness` action — the executor rejects with `400 template_not_spawnable`.

## Recognized `kind` values

* `coding` — a coding harness (scoper / worker / validator loop), drives one project to DONE.
* `service` — a long-running service-shaped harness (e.g. a recurring data pipeline).
* `org` — a parent-of-children harness with director / coordinator / auditor roles. **Org templates are themselves NOT spawnable** — they're top-level installs only. Don't mark org-kind templates as spawnable.

The `kind` is informational for now; the executor doesn't enforce it on the parent's role. v2 may gate which `kind` of children a parent role can spawn.

## `requires` fields

Declarative metadata listing the fields a parent should supply in the `scaffold_harness` action body. Today the executor (`doScaffoldHarness` in `packages/operator-core/lib/execute-action.ts`) hard-validates three fields, in this order: `projectSlug` against `/^[a-z0-9][a-z0-9-]{1,63}$/`, then `template` and `spec` as non-empty. The per-template `requires` list is **not** enforced per-field at the executor, and is **not** read anywhere else — no code consumes `spawnable.requires`. It is purely documentary metadata: it is not surfaced to the spawning role's prompt, and it is not echoed in the `dryRun` result (which returns `slug`, `path`, `template`, `parent_slug`, and `templateKind` — not the `requires` list).

```ts
"requires": ["spec"]
// documents that a parent should pass action.spec; not machine-enforced
```

Prefer declaring `spec` over `goal` in `requires`: `action.goal` is **deprecated** (kept for callers still passing `GOAL.md` content, and merged into `spec` on write), so new spawnable templates should list `spec`.

## Discovery

The substrate exposes spawnable templates via `GET /api/marketplace/spawnable`:

```bash
curl http://localhost:3055/api/marketplace/spawnable
# → { "spawnable": [ { name, version, spawnable: {...}, source: "local"|"catalog" }, ... ] }
```

Local-installed templates (the active workspace's `.papercusp/harnesses/<name>/papercusp.json` — `PAPERCUSP_HARNESSES_DIR`, default `~/.papercusp[-workspaces/<id>]/.papercusp/harnesses`) take precedence over bundled-catalog entries (`source: "catalog"`) with the same name. The catalog source is no longer remote: the legacy `:3057` marketplace server is retired, and `/api/marketplace/catalog` now serves the **bundled fallback catalog** only (revive-cupboard-distribution D-004/D-005).

The merged list is produced by `getSpawnableTemplates` in `packages/operator-core/lib/spawnable-templates.ts` (10s TTL cache with in-flight-promise collapse). It is **not** injected into any prompt — a spawning role does not get the template list embedded in its prompt. The prompt's static Tier 3 section ("Available read capabilities") only lists `curl <base>/api/marketplace/spawnable` as an endpoint the agent may call on demand; the merged list is the *response* of that endpoint, fetched when the role chooses to look.

## Scaffold guards

Before scaffolding, `doScaffoldHarness` runs structural guards (all returned as `validation_error` unless noted):

* **Self-spawn** — a harness cannot spawn itself (caller slug equals requested child slug).
* **Cycles** — it walks the caller's `parent_slug` chain upward and refuses if the requested child is already an ancestor (or if the existing chain already cycles).
* **Max depth** — it refuses to deepen a spawn chain past `MAX_SPAWN_DEPTH` (default `8`, configurable via `PAPERCUSP_MAX_SPAWN_DEPTH`).
* **Slug uniqueness** — the harness slug must be unique. If the slug already exists in `harness_shared.token_index`, or its project path already exists on disk under `PAPERCUSP_PROJECTS_ROOT` (default `~/.papercusp/projects/<slug>`), the executor rejects with `slug_already_in_use`, mapped to `409` by the admin route.

## Versioning

Adding `spawnable` to an existing manifest is an **additive change**; bump the patch version (e.g. `0.1.0` → `0.1.1`) and re-publish. See [marketplace-versioning](/internal/docs/spec/marketplace-versioning).
