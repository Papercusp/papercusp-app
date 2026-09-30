# @papercupai/cloudflare-pages

First server-runtime Papercusp reference plugin. Publishes the harness's static
export to Cloudflare Pages on `mission-done` (or via the toolbar action).

Reference implementation for spec §14.7 P6 — exercises the action primitive +
capability-gated secret reads + outbound HTTP.

## Choosing between this and `cloudflare-pages-hosted`

Two plugins ship with the marketplace and surface a publish button on the
harness toolbar. Pick one (or both — they coexist):

| | `cloudflare-pages` (this plugin) | `cloudflare-pages-hosted` |
|---|---|---|
| Toolbar label | "Publish to Cloudflare Pages" | "Publish website" |
| Default URL | `*.<your-project>.pages.dev` | `*.preview.papercuspai.com` |
| Cloudflare account required | Yes | No (Papercusp hosts) |
| Cloudflare token required | Yes | No (or yes via the BYO eject path) |
| Hops | operator → Cloudflare | operator → publish.papercuspai.com → Cloudflare |
| Best for | You already own a Cloudflare account and want deployments under it | Quick-start; one-click public preview without any credentials |

The hosted plugin's `byoCloudflareToken` config flag turns it into the same
direct-to-Cloudflare path this plugin always uses. If you've already set up
Cloudflare credentials and only want one button on the toolbar, this plugin
is the simpler choice.

## Install

```sh
papercusp install @papercupai/cloudflare-pages --harness <slug>
papercusp plugin enable @papercupai/cloudflare-pages --harness <slug>
```

You'll be prompted for `accountId` + `projectName`.

## Capabilities (consent prompt)

- `secrets:read:CLOUDFLARE_API_TOKEN` — reads the token from the harness
  credential store at runtime.
- `http:fetch:api.cloudflare.com` — outbound to Cloudflare's API only.
- `ui:dashboard-tab` — surfaces a "Cloudflare Pages" tab.
- `events:listen:mission-done` — receives the mission-done event.

## Action: `publish`

- Surfaces: `mission-done`, `harness-toolbar`.
- Server-runtime, default timeout 120s.
- Honors `AbortSignal`: in-flight fetches are cancelled if the substrate
  trips the timeout.
- Idempotent: re-triggering with the same `triggerId` returns the prior
  result without re-publishing.

```ts
// Programmatic call (what the substrate does on mission-done):
await registry.invoke({
  name: 'publish',
  ctx,
  params: { dryRun: false },
  triggerSource: 'routine',
  triggerId: missionRunId,
});
```

## Dry-run

```sh
# Operator can dry-run from the CLI:
papercusp plugin invoke @papercupai/cloudflare-pages publish --harness <slug> --dry-run
```

The handler walks `<projectDir>/<exportDir>` and reports `fileCount` + the
target `*.pages.dev` URL without contacting Cloudflare.

## Token

The handler reads `CLOUDFLARE_API_TOKEN` from (in order):

1. `~/.papercusp/secrets/CLOUDFLARE_API_TOKEN` (preferred — file mode 0600)
2. `process.env.CLOUDFLARE_API_TOKEN` (fallback)

The token needs the `Pages:Edit` scope on the target account.
