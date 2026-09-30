# YouTube — platform trigger pack

Watches a channel for uploads, and its videos for comments and replies.

Installing this pack wires the YouTube connection once — credential, identifier
and every event YouTube emits — instead of binding each event by hand.

## What it binds

| binding | fires on |
|---|---|
| `youtube-upload` | `ext:youtube:upload` |
| `youtube-comment` | `ext:youtube:comment` |
| `youtube-reply` | `ext:youtube:reply` |

Each event is its OWN binding so you can arm just the ones you want — mentions
without posts, comments without uploads — from the triggers admin without
editing the pack.

Bindings are shipped **disarmed**. Arming is a separate, deliberate step.

## Storm policy

`3` runs per `300`s, derived from this platform's
`read` budget in the social platform registry — not a number chosen here. The
registry is the single source, and `starter-packs.test.ts` recomputes it and
fails if this manifest drifts from it.

## Connection

**Connect button.** `googleWorkspace` is an OAuth field bound to the `google` provider, so the install UI offers a Connect button and requests exactly these scopes:

- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/youtube.force-ssl`

## Share semantics

Per-field, per the `configSchema` convention:

- `channelId` — `shareable: true`. The channel to watch, e.g. `UC…`. Public, so it travels with a share.
- `googleWorkspace` — `secret: true`, `snapshotPolicy: "strip"`, `shareable: false`.

⚠ These flags are a **declaration**, and today only the plugin-sdk validator
enforces them (and only on an OAuth field). The snapshot exporter that once
acted on them is retired, so nothing strips these values at share time yet —
tracked as EI-21277461137556587. Credentials are encrypted at rest in
`harness_shared.plugin_configs` regardless.

## What it does NOT do

No write path is requested: the plan records the event and stops. For drafting a
reply see `@papercupai/social-mention-triage`; for a periodic roll-up see
`@papercupai/social-comment-digest`.

