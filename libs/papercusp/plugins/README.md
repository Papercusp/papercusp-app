# Reference plugins

First-party plugins shipped alongside the substrate. All publishable to the
marketplace under the `@papercupai` scope; install at runtime via
`papercusp install <slug> --harness <harness-slug>`.

| Plugin | Spec phase | Surface | Notes |
|---|---|---|---|
| `@papercupai/cloudflare-pages` | P6 | `actions` + `routines` | First server-runtime plugin; secrets + http:fetch. |
| `@papercupai/pi-coding` | P7 | `dashboardTabs` | Replaces legacy hard-coded `pi` tab once feature flag flips. |
| `@papercupai/fumadocs` | P7 | `dashboardTabs` | Replaces legacy hard-coded `docs` tab. |
| `@papercupai/slack-notifier` | P9 | `actions` + `routines` | Slack incoming-webhook integration; secrets:read + http:fetch on a single host. |
| `@papercupai/postgres-manager` | P9 | `actions` only | 3 actions (migrate/inspect/reset) sharing one capability — `db:plugin-schema`. |
| `@papercupai/notion-export` | P9 | `actions` only | Posts mission summary to a Notion database; secrets:read + http:fetch:api.notion.com. |

## Cutover (P7)

The harness UI's hard-coded tab list and the plugin-mounted tab list are gated
by the `PAPERCUSP_TABS_FROM_PLUGINS` env var. While the var is unset (default),
the legacy hard-coded tabs render and these plugins are additive. Setting the
flag to `1` skips the legacy `pi` and `docs` tab definitions and lets the
plugin-loader's `dashboardTabs` collection drive them instead.

The flag toggle in `apps/web/app/harness/HarnessDashboard.tsx` is **not** wired
in this revision because Paperclip agents concurrently rewrite that file. The
plugins are ready; activation is operator-gated until the harness UI tree
quiesces.

## Publishing

```sh
cd libs/papercusp/plugins/<slug>
PAPERCUSP_SERVICE_TOKEN=… papercusp publish
```
