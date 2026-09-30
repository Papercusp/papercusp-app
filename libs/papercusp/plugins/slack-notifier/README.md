# @papercupai/slack-notifier

Post a message to a Slack incoming webhook. Reference plugin for the action +
secrets + http:fetch primitives.

## Install

```sh
papercusp install @papercupai/slack-notifier --harness <slug>
papercusp plugin enable @papercupai/slack-notifier --harness <slug>
```

You'll be prompted for `defaultChannel`, `username`, `icon`, and `muteOk`.

## Capabilities (consent prompt)

- `secrets:read:SLACK_WEBHOOK_URL` — reads the webhook URL from the substrate
  secrets store. Until the secrets proxy is wired through `ctx`, the plugin
  falls back to reading `SLACK_WEBHOOK_URL` from the substrate process env.
- `http:fetch:hooks.slack.com` — outbound to Slack's webhook host only.
- `events:listen:mission-done` — receives the mission-done event for the
  on-done routine.
- `events:listen:action-failed` — receives the action-failed event so the
  notifier can warn on plugin failures.

## Action: `notify`

```ts
await registry.invoke({
  name: 'notify',
  ctx,
  params: { text: 'Mission complete: 42 features shipped', channel: '#ops' },
  triggerSource: 'cli',
  triggerId: missionRunId,
});
```

Server-runtime, default timeout 10s. Honors `AbortSignal`.

## Manual invocation

```sh
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/xxx \
  papercusp plugin invoke @papercupai/slack-notifier notify \
  --harness <slug> \
  --params '{"text":"hello from papercusp"}'
```

## Notes

- This plugin is best-effort: a 5xx from Slack returns `ok: false` but does
  NOT retry. The action-execution audit row captures the failure for the ops
  dashboard, and a `webhook` subscriber receives the `action.failed` event.
- For higher delivery reliability, subscribe to the action-failed webhook
  directly rather than depending on this plugin's at-most-once semantics.
