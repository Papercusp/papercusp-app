# @papercupai/cloudflare-stack

Provision a full Cloudflare backend (Pages + Workers + D1 + R2 + KV) for a
forked Papercusp harness snapshot. Ships `setup` / `teardown` / `verify`
scripts that create real resources in the forker's CF account and template
the harness's project files with the new IDs.

## What this plugin does

When a user forks a snapshot whose harness includes this plugin, the
substrate runs `provision/setup.sh` against the forker's Cloudflare
account. The script idempotently creates:

| Resource         | Default name               | Purpose                       |
|------------------|----------------------------|-------------------------------|
| D1 database      | `<harness-slug>-db`        | relational data               |
| R2 bucket        | `<harness-slug>-assets`    | file storage                  |
| KV namespace     | `<harness-slug>-sessions`  | sessions / cache              |
| Pages project    | `<harness-slug>`           | static frontend (SPA)         |
| Worker script    | `<harness-slug>-api`       | backend API                   |

After resources exist, setup walks the harness's project directory for
`*.tmpl` files and renders them via `envsubst`, populating
`${OUTPUT_*}` and `${USER_VAR_*}` placeholders with the resource IDs the
forker just provisioned. See [Templating](#templating) below.

`teardown.sh` deletes the resources in reverse order on plugin uninstall.
`verify.sh` health-checks them on operator boot and on demand.

## Using this plugin in your harness snapshot

### 1. Install the plugin in your harness

```bash
papercusp install @papercupai/cloudflare-stack
```

Then enable it for your harness (operator UI → Plugins → Enable, or
edit `~/.papercusp/harnesses/<slug>/enabled-plugins.json`).

### 2. Configure it once for yourself

In the operator UI, set:

- **accountId** — your CF account ID (32 hex chars; from
  dash.cloudflare.com → right sidebar)
- **byoCloudflareToken** — an API token with these scopes:
  `Pages:Edit`, `Workers Scripts:Edit`, `D1:Edit`, `R2:Edit`,
  `Workers KV Storage:Edit`, `User Details:Read`. Create at
  dash.cloudflare.com/profile/api-tokens.
- The other fields default to slug-derived names; override if you
  want different naming.

The token is marked `secret: true` + `snapshotPolicy: "strip"`, so it
never travels with snapshots. Forkers paste their own at fork time.

The account ID is marked `shareable: false`, also stripped from
snapshots; forkers supply theirs.

### 3. Author your harness's project files as templates

The plugin doesn't ship the templates — you do. In your harness's
`project/` dir:

- Commit a `wrangler.toml.tmpl` with `${OUTPUT_*}` / `${USER_VAR_*}`
  placeholders. See [`examples/wrangler.toml.tmpl`](./examples/wrangler.toml.tmpl).
- Commit a `.env.production.tmpl` for any frontend env vars that
  reference the provisioned URLs. See
  [`examples/.env.production.tmpl`](./examples/.env.production.tmpl).
- Add the rendered output paths (`wrangler.toml`, `.env.production`) to
  `.gitignore`.

At fork-time, after CF resources are provisioned, the plugin's setup
walks `$PAPERCUSP_PROJECT_DIR` and renders every `*.tmpl` it finds
(skipping `.git/`, `node_modules/`, `dist/`, `.next/`, `.papercusp/`).

### 4. Publish the snapshot

```bash
papercusp snapshot publish
```

The snapshot exporter respects this plugin's `secret: true` and
`shareable: false` flags — your account ID and token are stripped from
the published snapshot. The shape file (`<plugin>.shape.json`) records
which fields were stripped so the fork-time UI knows to prompt for them.

### 5. Forkers fork your snapshot

When someone runs `papercusp snapshot fork <your-snapshot>`:

1. The substrate restores project files + DB schema.
2. The fork-time UI prompts the forker for `accountId` +
   `byoCloudflareToken` (and any other `shareable: false` fields you
   declared).
3. The substrate invokes `provision/setup.sh` against the forker's
   account.
4. Resources are created idempotently. Each resource is recorded for
   teardown.
5. Project file templates are rendered with the new IDs.
6. The forker's harness is ready to deploy.

## Templating

The plugin populates two namespaces of env vars used in `*.tmpl` files:

### `${USER_VAR_*}` — fork-time form values

Any top-level scalar in the plugin config becomes
`USER_VAR_<UPPER_KEY>`. Examples:

- `accountId` → `${USER_VAR_ACCOUNTID}`
- `projectName` → `${USER_VAR_PROJECTNAME}`
- `r2BucketName` → `${USER_VAR_R2BUCKETNAME}`

### `${OUTPUT_*}` — runtime resource IDs

Set by `setup.sh` via `papercusp_state_set`:

| Variable                      | Source                                     |
|-------------------------------|--------------------------------------------|
| `${OUTPUT_d1DatabaseId}`      | UUID assigned by D1 create API             |
| `${OUTPUT_d1DatabaseName}`    | `<harness>-db` (or your `d1DatabaseName`)  |
| `${OUTPUT_r2BucketName}`      | `<harness>-assets` (or your `r2BucketName`)|
| `${OUTPUT_kvNamespaceId}`     | UUID assigned by KV create API             |
| `${OUTPUT_kvNamespaceTitle}`  | `<harness>-sessions` (or your override)    |
| `${OUTPUT_pagesProjectName}`  | `<harness>` (or your `projectName`)        |
| `${OUTPUT_pagesUrl}`          | `https://<projectName>.pages.dev`          |
| `${OUTPUT_workerName}`        | `<harness>-api` (or your `workerName`)     |
| `${OUTPUT_workerUrl}`         | `https://<workerName>.<acct-subdomain>.workers.dev` |

### Templating syntax

Standard POSIX shell parameter expansion (via `envsubst`):

```toml
account_id = "${USER_VAR_ACCOUNTID}"
worker_name = "${OUTPUT_workerName:-${PAPERCUSP_HARNESS_SLUG}-api}"
required_field = "${USER_VAR_NEVERSET:?must be set}"
```

`${VAR}`, `${VAR:-default}`, and `${VAR:?error}` all work.

## Skipping resources

Set `skipResources` in the plugin config to skip specific resources.
Useful for harnesses that don't need the whole stack:

- Pages-only static site: `["worker", "d1", "r2", "kv"]`
- API-only Worker: `["pages"]`
- Frontend + KV (no DB): `["worker", "d1", "r2"]`

## Idempotency and re-runs

Every resource is created via check-by-name first. Re-running setup
against an already-provisioned harness is safe:

- Existing resources are detected and skipped (with a `step:*-exists`
  progress event).
- New `papercusp_record_resource` calls fire either way, so teardown
  always sees the full set.

If the publisher updates the plugin (`scriptHash` changes), the substrate
forces re-consent before re-running per the build-scripts spec.

## Teardown caveats

- **R2 buckets must be empty before deletion.** If teardown finds a
  non-empty bucket it leaves it in place and surfaces a warning.
  Empty via `wrangler r2 object delete` or the dashboard, then
  re-run teardown.
- **Pages projects with active deployments delete in cascade** — that's
  the CF API's behavior; the plugin doesn't gate this.
- **Workers with active routes** delete cleanly in V1; routes get
  detached automatically.

Resources orphaned in CF after teardown failure are surfaced via the
operator's audit log (`audit.provision-runs/`).

## Required host access

The plugin's manifest declares:

```json
"cloudProvider": { "id": "cloudflare" },
"allowedHosts": ["api.cloudflare.com"]
```

The substrate's network policy floor blocks IMDS, RFC1918, and loopback
unconditionally. `api.cloudflare.com` is the only egress host scripts
can reach in V1.

## Capabilities required

```
secrets:read:CLOUDFLARE_API_TOKEN
http:fetch:api.cloudflare.com
compute:exec:wrangler
compute:exec:curl
compute:exec:jq
compute:exec:envsubst
```

`wrangler` is currently declared but unused (V1 hits the CF REST API
directly via curl). Future versions may use wrangler for richer
operations (smart placement, queues, etc.).

## Versioning

This plugin pins itself with `pluginVersionPinned: true`. Snapshots
published with v0.1.0 fork against v0.1.0. Major-version bumps will
explicitly require re-consent per the substrate's plugin-update flow.

## Comparison to `@papercupai/cloudflare-pages`

Two distinct plugins, different lifecycles, can compose:

- **`cloudflare-pages`** — runtime *publish action*. Listens for
  `mission-done` events and deploys the harness's static export to a
  Pages project. Assumes the project already exists.
- **`cloudflare-stack`** — fork-time *provisioning*. Creates the Pages
  project (and Workers, D1, R2, KV) so cloudflare-pages has somewhere
  to deploy to.

A typical setup uses both: `cloudflare-stack` to provision, then
`cloudflare-pages` for ongoing deploys.

## Related

- [Build scripts spec](/docs/snapshots/build-scripts) — the substrate
  contract this plugin satisfies.
- [Share semantics spec](/docs/snapshots/share-semantics) — how
  `secret` / `shareable: false` flags drive snapshot redaction.
- [`@papercupai/github-repo`](../github-repo) — simpler reference
  plugin demonstrating the same pattern with a single resource type.
