# Instagram — platform trigger pack

Watches an Instagram professional account for comments and replies on its media.

Installing this pack wires the Instagram connection once — credential, identifier
and every event Instagram emits — instead of binding each event by hand.

## What it binds

| binding | fires on |
|---|---|
| `instagram-comment` | `ext:instagram:comment` |
| `instagram-reply` | `ext:instagram:reply` |

Each event is its OWN binding so you can arm just the ones you want — mentions
without posts, comments without uploads — from the triggers admin without
editing the pack.

Bindings are shipped **disarmed**. Arming is a separate, deliberate step.

## Storm policy

`1` runs per `300`s, derived from this platform's
`read` budget in the social platform registry — not a number chosen here. The
registry is the single source, and `starter-packs.test.ts` recomputes it and
fails if this manifest drifts from it.

## Connection

**Connect button.** `facebookInstagram` is an OAuth field bound to the `facebook` provider, so the install UI offers a Connect button and requests exactly these scopes:

- `instagram_basic`
- `instagram_content_publish`
- `instagram_manage_comments`
- `pages_show_list`
- `pages_read_engagement`

## Share semantics

Per-field, per the `configSchema` convention:

- `igUserId` — `shareable: true`. The IG professional account to watch. Public, so it travels with a share.
- `facebookInstagram` — `secret: true`, `snapshotPolicy: "strip"`, `shareable: false`.

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

Instagram grants these scopes only after Meta app review. Until that clears, this pack installs and validates but cannot receive live events.
