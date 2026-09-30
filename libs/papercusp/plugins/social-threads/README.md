# Threads — platform trigger pack

Watches a Threads account for its own posts and for replies in its conversations.

Installing this pack wires the Threads connection once — credential, identifier
and every event Threads emits — instead of binding each event by hand.

## What it binds

| binding | fires on |
|---|---|
| `threads-post` | `ext:threads:post` |
| `threads-reply` | `ext:threads:reply` |

Each event is its OWN binding so you can arm just the ones you want — mentions
without posts, comments without uploads — from the triggers admin without
editing the pack.

Bindings are shipped **disarmed**. Arming is a separate, deliberate step.

## Storm policy

`16` runs per `300`s, derived from this platform's
`read` budget in the social platform registry — not a number chosen here. The
registry is the single source, and `starter-packs.test.ts` recomputes it and
fails if this manifest drifts from it.

## Connection

**No Connect button, deliberately.** Threads authorizes against `graph.threads.net` under a separate app id, and those endpoints are not verified here. Declaring a provider from a guess would fail at consent time rather than at build time. You supply `threadsToken` directly; it is stored encrypted.

## Share semantics

Per-field, per the `configSchema` convention:

- `threadsUserId` — `shareable: true`. The Threads account to watch. Public, so it travels with a share.
- `threadsToken` — `secret: true`, `snapshotPolicy: "strip"`, `shareable: false`.

⚠ These flags are a **declaration**, and today only the plugin-sdk validator
enforces them (and only on an OAuth field). The snapshot exporter that once
acted on them is retired, so nothing strips these values at share time yet —
tracked as EI-21277461137556587. Credentials are encrypted at rest in
`harness_shared.plugin_configs` regardless.

## What it does NOT do

No write path is requested: the plan records the event and stops. For drafting a
reply see `@papercupai/social-mention-triage`; for a periodic roll-up see
`@papercupai/social-comment-digest`.

## Owner-side prerequisite

Threads grants these scopes only after Meta app review. Until that clears, this pack installs and validates but cannot receive live events.
