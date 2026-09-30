# @papercupai/notion-export

Post the harness mission summary to a Notion database. Reference plugin for
`secrets:read` + `http:fetch` against `api.notion.com`.

## Install

```sh
papercusp install @papercupai/notion-export --harness <slug>
papercusp plugin enable @papercupai/notion-export --harness <slug>
```

You'll be prompted for the Notion `databaseId` (32-char UUID).

## Capabilities

- `secrets:read:NOTION_API_KEY` — reads the API key from the substrate
  process env (`NOTION_API_KEY=secret_...`).
- `http:fetch:api.notion.com` — outbound to the Notion API only.
- `events:listen:mission-done` — fires the action when a mission completes.

## Action: `exportMission`

```ts
await registry.invoke({
  name: 'exportMission',
  ctx,
  params: { title: 'Sprint 7 retro', summary: 'shipped 42 features' },
  triggerSource: 'routine',
  triggerId: missionRunId,
});
```

Server-runtime, default timeout 30s. Honors `AbortSignal`.

## Database property assumption

The plugin assumes the target database has a `Name` title property. If your
Notion database uses a differently-named title column, fork this plugin and
edit `properties.Name` accordingly (or wait for v0.2 which will introduce
`titleProperty` config).
