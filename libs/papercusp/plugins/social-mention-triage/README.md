# Social mention triage trigger pack

A first-party starter that turns an inbound social mention into a reviewed DRAFT reply. Two
bindings — `ext:bluesky:mention` and `ext:mastodon:mention` — feed one plan target that classifies
the mention, escalates what needs a person, and writes reply text for the owner to send themselves.

**It cannot publish.** The manifest declares no OAuth block, no write scope and no publishing
target, so "never auto-publishes" is a property of the pack rather than a promise in its plan
(see D-001 in `plan.md`).

## Connection

Neither platform declares an `oauthField`, because neither has a platform-wide OAuth provider to
name: Bluesky authenticates with an app password (the registry records an empty scope list) and
Mastodon registers a client per instance. Connect the source through the social trigger-source flow
instead. The connection needs only READ access — `read:statuses` and `read:notifications` on
Mastodon; nothing beyond the app password on Bluesky. Do not grant `write:statuses` for this pack;
it has no use for it.

## Storm policy

`maxRuns: 12` per `windowSeconds: 300`, which is the tightest READ policy that
`socialStormPolicyFor()` derives across the two bound platforms — both land on the conservative
default, because neither publishes a numeric request budget. The number is not hand-chosen: a test
recomputes it from the platform registry and fails if the manifest and the derivation disagree.

Social storm policy is `coalesce-with-cap`, not skip-the-overflow: a mention storm is batched into
the capped runs rather than dropped, so nothing inbound goes unseen.

Cupboard installation only discovers the pack. Connection, instantiation and arming remain explicit.
