# Reddit — platform trigger pack

Watches posts and comments in the subreddits you name.

Installing this pack wires the Reddit connection once — credential, identifier
and every event Reddit emits — instead of binding each event by hand.

## What it binds

| binding | fires on |
|---|---|
| `reddit-post` | `ext:reddit:post` |
| `reddit-comment` | `ext:reddit:comment` |

Each event is its OWN binding so you can arm just the ones you want — mentions
without posts, comments without uploads — from the triggers admin without
editing the pack.

Bindings are shipped **disarmed**. Arming is a separate, deliberate step.

## Storm policy

`30` runs per `300`s, derived from this platform's
`read` budget in the social platform registry — not a number chosen here. The
registry is the single source, and `starter-packs.test.ts` recomputes it and
fails if this manifest drifts from it.

## Connection

**No Connect button, deliberately.** Reddit uses a self-serve app you register yourself; this operator has no Reddit provider. You supply `redditApp` directly; it is stored encrypted.

## Share semantics

Per-field, per the `configSchema` convention:

- `subreddits` — `shareable: true`. Comma-separated subreddit names. Not a secret and not owner-specific, so it travels with a share.
- `redditApp` — `secret: true`, `snapshotPolicy: "strip"`, `shareable: false`.

⚠ These flags are a **declaration**, and today only the plugin-sdk validator
enforces them (and only on an OAuth field). The snapshot exporter that once
acted on them is retired, so nothing strips these values at share time yet —
tracked as EI-21277461137556587. Credentials are encrypted at rest in
`harness_shared.plugin_configs` regardless.

## What it does NOT do

No write path is requested: the plan records the event and stops. For drafting a
reply see `@papercupai/social-mention-triage`; for a periodic roll-up see
`@papercupai/social-comment-digest`.

