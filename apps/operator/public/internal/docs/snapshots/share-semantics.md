# Per-field share semantics
URL: /internal/docs/snapshots/share-semantics

Plugins flag each configSchema field as secret (credential, stripped on snapshot by default), shareable:false (publisher-specific identifier, stripped), or default (config that travels with the snapshot). Schema evolution covered via aliases for renames + removals.

import { Aside } from '@astrojs/starlight/components';

The entire harness-snapshot system was **retired on 2026-06-09** (plan
`retire-snapshots-instance-spec-2026-06-09`, Phase B). Its three jobs were
re-homed: **distribution → blueprints** (the Cupboard now distributes recipes),
**backup → git + PG** (code + state are already durable), and the one remaining
**reproducible-clone** job became the lightweight `InstanceSpec` at
`packages/operator-core/lib/instance-spec/` (`capture` / `boot` / `vary`).

This page documents the now-retired snapshot share-semantics *design*. None of
the live code paths it cites still exist at the locations shown — they were moved
to `_retired/snapshot-system/` (`lint:no-retired` guards re-imports). What **did**
land and remains valid: the share-semantics flags on plugin `configSchema`s
(`secret` / `shareable` / `oauth` / `aliases` / `pattern`) shipped on the
reference plugins. The advisory-check helper (`security-advisories.ts`) also
survives as live code — see the note in [Security advisories at fork time](#security-advisories-at-fork-time).

* `aliases` is a per-property array covering renames AND removals (`null` = removed)
* `snapshotPolicy: "include" \| "strip" \| "warn-and-prompt"` for secret-but-shareable cases
* **`versionPin: { mode: "exact" }` is the reproducible convention** that reference plugins explicitly declare — snapshots fork against the exact version they were published with, eliminating most alias-walk burden (legacy `pluginVersionPinned: true` maps to `mode: "exact"`). Note the substrate's hardcoded *fallback* when a plugin omits both fields is `{ mode: "semver" }`, not `"exact"`.
* **`securityAdvisories` field on the marketplace catalog** — fork-time substrate prompts loudly if pinned version has a known CVE
* `shareable: false` fields use JSON-Schema `pattern` for format validation by convention
* Tarball format change (additive `.shape.json` companions) explicitly acknowledged

## The problem

When today's snapshot system captures a harness, it copies
`~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json` verbatim into
the tarball. That works for any field that's pure configuration, but it
fails two ways:

1. **Credentials leak**: a plugin config containing `github_token: ghp_...` ends up in the snapshot tarball. Anyone with the tarball gets the publisher's GitHub access.
2. **Identifiers force-share**: a plugin config containing `accountId: f896...` (the publisher's Cloudflare account) lands in the forker's plugin-config. The fork is configured to deploy to the publisher's CF account, which the forker doesn't have access to.

Today's baseline mitigation is the `uiSchema`-driven redactor in the
snapshot exporter (`redactPluginConfig`, since retired to
`_retired/snapshot-system/operator-core/snapshot-config-redact.ts`) that
replaces every field whose plugin `uiSchema` marks `{"ui:widget":"password"}`
with `[REDACTED]`. This is fragile:

* Misses any sensitive field the plugin author didn't tag as a password widget.
* Only handles credentials — has no notion of "publisher's identifier".
* Can't distinguish "publisher's identifier" from "config that should travel".

(The key-pattern matching described below — `/token|secret|api[_-]?key/i` —
is the *defense-in-depth fallback* that this proposal adds in `extractShape`,
not the baseline redactor.)

## Proposal

Plugins declare per-field share semantics directly in `configSchema`:

```json
{
  "type": "object",
  "required": ["github_token"],
  "properties": {
    "github_token": {
      "type": "string",
      "secret": true,
      "oauth": { "provider": "github", "scopes": ["repo"] },
      "description": "GitHub PAT or OAuth token. Stripped from snapshots; users re-authorize on fork."
    },
    "owner": {
      "type": "string",
      "shareable": false,
      "description": "GitHub user or org. Different per forker — stripped from snapshots."
    },
    "repo": {
      "type": "string",
      "description": "Repo name. Defaults to harness slug. Travels with the snapshot."
    },
    "visibility": {
      "type": "string",
      "enum": ["private", "public"],
      "default": "private"
    },
    "defaultBranch": {
      "type": "string",
      "default": "main"
    }
  }
}
```

### Three semantics

| Flag                                               | Meaning                                                                        | Snapshot behavior | Fork behavior                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------- | ------------------------------------ |
| `secret: true` (default `snapshotPolicy: "strip"`) | Credential — stripped from snapshot                                            | Stripped          | User re-authorizes (OAuth) or pastes |
| `shareable: false`                                 | Environment-specific identifier (account ID, owner name, project slug, region) | Stripped          | User must supply their own value     |
| (neither flag)                                     | Pure config (default branch, retry count, output dir, format choice)           | Included verbatim | Inherited as-is                      |

### Secret policy: when secrets *should* travel

There are real cases where a publisher wants a credential to travel with
the snapshot:

* A demo Slack webhook for a fictional workspace the publisher controls.
* A read-only public-bucket access key.
* A test-mode Stripe key (`sk_test_...`).

Today, publishers work around this by hardcoding such credentials into
project files — which then leak via git history. Better: surface this as
a first-class capability with safety rails.

```json
{
  "demo_webhook": {
    "type": "string",
    "secret": true,
    "snapshotPolicy": "include",
    "description": "Test-mode Slack webhook. Travels with snapshot for demos."
  }
}
```

Three policies for `secret: true` fields:

| `snapshotPolicy`    | Snapshot behavior                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `"strip"` (default) | Field stripped from snapshot. Forker must supply their own.                                                                                     |
| `"include"`         | Field included in snapshot. **Publish CLI requires `--include-secrets` flag and a per-secret confirmation prompt naming each included secret.** |
| `"warn-and-prompt"` | Publish CLI prompts the publisher per-snapshot: include this credential or strip it?                                                            |

Without the explicit `--include-secrets` flag and per-secret
confirmation, no secret is ever embedded in a snapshot tarball — even
when the plugin's manifest declares `snapshotPolicy: "include"`. The
manifest expresses intent; the publish CLI enforces consent at the
moment of publication.

### Defaults

* `secret`: defaults to `false`. A field is considered secret only if explicitly flagged.
* `shareable`: defaults to `true`. A field is considered shareable unless explicitly flagged otherwise.
* `snapshotPolicy`: defaults to `"strip"` for `secret: true` fields. Has no meaning for non-secret fields (they always travel).

### Format validation via `pattern`

`shareable: false` fields prompt the forker for a value with no inherent
format constraint. Plugin authors should leverage JSON-Schema's existing
`pattern` field to validate format at fork-time:

```json
{
  "accountId": {
    "type": "string",
    "shareable": false,
    "pattern": "^[a-f0-9]{32}$",
    "description": "Cloudflare account ID (32 hex chars)."
  }
}
```

The fork-completion UI shows the pattern's hint, validates input
client-side, refuses save until the value matches. This is convention
rather than a substrate addition — `ajv` (already in operator deps)
handles `pattern` automatically. Plugin docs should call out the
recommended pattern for common identifiers (account IDs, region names,
tokens with known formats, etc.).

The spec encourages **explicit**, but doesn't force it. Existing plugins
that don't update their configSchema continue to work — the pattern-based
redactor stays in place as a fallback safety net for any field a plugin
author hasn't declared.

### Pattern-based fallback

Even with explicit flags, the snapshot exporter applies the pattern-based
redactor as a defense-in-depth check:

* If a field is *not flagged* but matches a known secret pattern (`/token|secret|api[_-]?key|password|pat\b/i`), the exporter logs a **warning** in the snapshot manifest and strips it anyway.
* If a field *is flagged* `secret: false` but matches a secret pattern, the exporter prompts the publisher: "Field `<name>` is flagged shareable but matches a credential pattern. Continue?" — defaulting to "no, strip anyway".

This catches plugin authors who forget to flag a field while still letting
declared-shareable fields override the pattern when the author knows what
they're doing.

## Snapshot tarball structure

A snapshot's tarball stages project files under `source/` and per-harness PG
state under `state/`. Per-plugin redacted config and its share-shape are **not**
written as sibling files in the tarball — they ride inside `manifest.json` as
per-plugin string fields (`plugins[].configJson` holds the redacted config,
`plugins[].shapeJson` holds the shape). The shape route reads them back from the
manifest, not from tarball files.

```text
snapshot.tar.gz
├── manifest.json            ← plugins[].configJson (redacted) + plugins[].shapeJson
├── source/
│   └── ... (project files)
└── state/
    ├── shared-<table>.csv    (one CSV per captured shared PG table)
    └── harness/             (subset copy of the harness's .papercusp/ dir)
```

The `shapeJson` payload (the `SnapshotShape` produced by `extractShape()`)
describes every field the original config carried but the snapshot stripped,
with the configSchema metadata the fork-time UI needs to render the right input
("Connect with GitHub" button vs plain text input). Its shape is a
`fields` map keyed by field name plus a top-level `warnings` array — each entry
carries a `reason` (one of `secret-strip`, `secret-include`, `secret-warn`,
`shareable-false`, `pattern-fallback`) and optional `oauth` / `pattern` /
`description`. Fields that travelled in plaintext are simply absent from the map.

```json
// plugins[].shapeJson for github-repo (parsed)
{
  "fields": {
    "github_token": {
      "reason": "secret-strip",
      "oauth": { "provider": "github", "scopes": ["repo"] },
      "description": "GitHub PAT or OAuth token. Stripped from snapshots..."
    },
    "owner": {
      "reason": "shareable-false",
      "pattern": "...",
      "description": "GitHub user or org..."
    }
  },
  "warnings": []
}
```

## Fork-time UX

When a snapshot is forked, the operator scans every plugin's `.shape.json`,
groups missing-fields by plugin, and shows them in the fork-completion UI:

```text
Snapshot fork: my-store ← from ecommerce-stripe-aws
─────────────────────────────────────────────────────

The following plugins need additional configuration before they can run:

  @papercupai/github-repo
    github_token  [ Connect with GitHub ]      ← oauth-flagged, button instead of paste
    owner         [____________________]       ← shareable:false, plain input

  @papercupai/cloudflare-pages
    api_token     [ Paste token… ]              ← secret-flagged but no oauth, paste field
    accountId     [____________________]       ← shareable:false, plain input
    projectName   [my-store_____________]      ← shareable:false but defaulted to harness slug

  [ Save and continue ]   [ Skip — I'll configure manually later ]
```

The "Connect with GitHub" buttons go through the OAuth flow (see [OAuth integration](./oauth-integration)). Plain inputs save through the same `PUT /api/plugins/config` we already have.

## Implementation

| Surface                                                                                 | Change                                                                                                                          | LOC   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `@papercusp/plugin-sdk`                                                                 | Document field-level extensions (`secret`, `snapshotPolicy`, `shareable`, `oauth`, `aliases`) on the manifest's `configSchema`. | \~15  |
| `_retired/snapshot-system/operator-core/snapshot-shape.ts`                              | `extractShape()` — walk configSchema and apply the share-semantics filter, returning redacted config + shape contents.          | \~80  |
| `_retired/snapshot-system/operator-core/endpoint-route-routes-snapshots/instantiate.ts` | Apply `resolveAliases()` and return list of missing-fields per plugin in the fork response.                                     | \~30  |
| `_retired/snapshot-system/operator-app-ui/snapshots/[id]/fork/ForkClient.tsx`           | The fork-completion UI shown above. Reuses `/settings/plugins`'s field renderer.                                                | \~120 |

Total: **\~265 lines.** Smaller than the build-script work; closer to the OAuth scope.

This section once landed: `extractShape` + `resolveAliases`, the exporter that
called it, the shape route, and the fork-completion UI all shipped. They were
**retired on 2026-06-09** with the rest of the snapshot system and now live under
`_retired/snapshot-system/` — `snapshot-shape.ts`,
`endpoint-route-routes-snapshots/{create,shape,instantiate}.ts`, and
`operator-app-ui/snapshots/[id]/fork/ForkClient.tsx`. The paths in the table above
point at their retired locations; do not expect to find them live under
`packages/operator-core/` or `apps/operator/`.

## Migration story

Existing plugins (cloudflare-pages, github-repo, jira-sync, linear-sync, etc.)
keep working without changes — fields without flags fall through the
pattern-based redactor as today. Plugin authors *opt in* to explicit flags
when they update their schemas.

For papercusp's reference plugins, we'd update their schemas in the same PR
that introduces share-semantics:

| Plugin           | Field               | Current behavior                        | New flag                                                                    |
| ---------------- | ------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| github-repo      | `github_token`      | redacted (matches `/token/`)            | `secret: true, oauth: {provider: github, scopes: [repo]}`                   |
| github-repo      | `owner`             | leaks                                   | `shareable: false`                                                          |
| github-repo      | `repo`              | leaks (becomes harness slug for forker) | (default — shareable)                                                       |
| cloudflare-pages | `accountId`         | leaks                                   | `shareable: false`                                                          |
| cloudflare-pages | `projectName`       | leaks                                   | `shareable: false`                                                          |
| cloudflare-pages | `branch`            | leaks                                   | (default — shareable)                                                       |
| linear-sync      | `LINEAR_API_KEY`    | redacted (matches `/key/`)              | `secret: true, oauth: {provider: linear, scopes: [...]}` (when OAuth ships) |
| linear-sync      | `defaultTeamKey`    | leaks                                   | `shareable: false`                                                          |
| jira-sync        | `JIRA_API_TOKEN`    | redacted                                | `secret: true`                                                              |
| jira-sync        | `JIRA_BASE_URL`     | leaks                                   | `shareable: false` (the publisher's atlassian.net is theirs)                |
| slack-notifier   | `SLACK_WEBHOOK_URL` | leaks                                   | `secret: true` (webhook URL contains the secret token)                      |

## Schema evolution

The `.shape.json` baked into a snapshot is frozen at publish time. If the
plugin's `configSchema` changes between publish and fork, the substrate
needs a deterministic way to translate old field names to new.

The `aliases` field (already used in the spec for capability renames)
extends to config-field renames *and* removals. It's a **per-property
array** of prior names (with `null` marking removal), declared on the
property that supersedes them — `resolveAliases()` walks the *current*
schema's properties and remaps the forked config accordingly.

### Renames

```json
{
  "configSchema": {
    "properties": {
      "account": {
        "type": "string",
        "shareable": false,
        "description": "GitHub user or org.",
        "aliases": ["owner"]
      }
    }
  }
}
```

The plugin author renamed `owner` → `account` in v0.2.0. A snapshot
published with `github-repo@0.1.0` ships `.shape.json` referencing
`owner`. On fork into a `github-repo@0.2.0` install:

1. Substrate reads the snapshot's `.shape.json`, finds an entry for `owner`.
2. Substrate consults the *current installed plugin's* `configSchema` properties.
3. Sees the `account` property declaring `aliases: ["owner"]` — translates `owner` references to `account`.
4. Fork-completion UI prompts for `account` (the current name), with the snapshot's metadata about it (description, validation, etc.) sourced from the new schema, not the frozen one.

### Removals

A plugin may drop a field entirely (e.g., the auth flow changed and
`legacyApiKey` is no longer used). The `.shape.json` from older snapshots
still references it; without a removal hint, the fork-time UI would
prompt for a field the new plugin doesn't read.

```json
{
  "configSchema": {
    "properties": {
      "newApiKey": { "type": "string", "secret": true },
      "legacyApiKey": { "type": "string", "secret": true, "aliases": [null] }
    }
  }
}
```

A `null` entry in a property's `aliases` array declares "this field was
removed" — `resolveAliases()` drops `legacyApiKey` from the forked config,
the user is not prompted, and the plugin's runtime never sees the field.
This is intentionally distinct from carrying the value forward under a new
name via a rename alias (e.g. `newApiKey` declaring `aliases: ["legacyApiKey"]`).

### Combined

Renames and removals coexist by declaring `aliases` arrays across the
schema's properties:

```json
{
  "properties": {
    "account":   { "type": "string", "aliases": ["owner"] },
    "legacyApiKey": { "type": "string", "aliases": [null] },
    "awsRegion": { "type": "string", "aliases": ["region"] }
  }
}
```

### When aliases are walked

Aliases are walked from the **current installed plugin's** manifest, not
the snapshot's. This means:

* A snapshot is forward-compatible automatically: as long as the new
  plugin version declares its aliases, old snapshots fork cleanly.
* Plugin authors are responsible for keeping the per-property `aliases`
  arrays populated for every config-field rename or removal in their
  plugin's lifetime.
* The substrate never auto-infers aliases — explicit declarations only.

If an old snapshot references a field that has neither a current
counterpart nor an alias entry, the fork-time UI surfaces it as
"unknown — this field is no longer recognized by the current plugin
version" and the user can choose to drop it or abort the fork.

## Plugin version pinning (default-on)

A plugin declares its restore pin policy on its manifest via `versionPin`:

```json
// plugin manifest
{
  "name": "@papercupai/github-repo",
  "version": "0.1.0",
  "versionPin": { "mode": "exact" }   // 'semver' | 'exact' | 'hash'
}
```

`versionPin.mode` controls how a fork resolves the plugin version: `'exact'`
restores the exact version captured (the reproducible default this section
argues for), `'semver'` accepts any version satisfying the captured range,
`'hash'` pins by content hash. (The legacy boolean `pluginVersionPinned: true`
is still read for back-compat — it maps to `mode: 'exact'` — but `versionPin`
is the current field and wins when both are set.)

When the fork uses the exact captured version, the substrate doesn't walk
`aliases` because the schema is exactly the one the snapshot expects.

The user can opt into the latest available version per-plugin during
fork ("fork against latest" toggle), in which case the substrate walks
the alias chain from pinned-version → latest. Most users want
"fork-and-it-just-works"; pinning is the right default.

This radically reduces the alias-map maintenance burden: plugin authors
only need to maintain aliases when a user explicitly opts into forward
compatibility, not every time the schema evolves.

### Security advisories at fork time

Pinning a vulnerable version is a vulnerability vector if the user has
no signal about the vuln. The marketplace catalog adds a per-version
field:

```json
{
  "version": "0.1.0",
  "securityAdvisories": [
    {
      "cve": "CVE-2026-12345",
      "severity": "moderate",
      "fixedIn": "0.1.1",
      "summary": "OAuth state nonce reuse on rapid concurrent flows",
      "advisoryUrl": "https://github.com/papercupai/github-repo/security/advisories/GHSA-xxxx-yyyy-zzzz"
    }
  ]
}
```

At fork time, substrate consults the catalog for the pinned version's
advisories. If any advisories exist with severity ≥ moderate, the
fork-completion UI surfaces a loud prompt:

```text
Security advisory
─────────────────
The pinned version of @papercupai/github-repo (0.1.0) has a known issue:

  CVE-2026-12345 (moderate)
  OAuth state nonce reuse on rapid concurrent flows.
  Fixed in 0.1.1.

Continue with pinned version, upgrade to latest, or read advisory?
  [ Pin (vulnerable)  ]   [ Upgrade to 0.1.1  ]   [ Read advisory ]
```

No silent auto-upgrade — the user might have legitimate reasons to pin
(reproducibility for a known-good environment). But the warning is
loud, persistent (returns on next operator boot until acknowledged),
and uncircumventable.

Severity tiers map to UI prominence:

| Severity   | Prompt behavior                                         |
| ---------- | ------------------------------------------------------- |
| `critical` | Modal blocking the fork until addressed                 |
| `high`     | Prominent banner on fork-completion; recommends upgrade |
| `moderate` | Standard advisory prompt as above                       |
| `low`      | Listed in the fork's audit log; no prompt               |

This is the one piece of the design that outlived the snapshot retirement.
`checkPinnedVersionAdvisories` lives at
`packages/operator-core/lib/security-advisories.ts` and is wired to
`POST /api/security-advisories/check`. But there is **no advisory catalog source
configured by default** — the legacy `:3057` marketplace was retired
(`revive-cupboard-distribution` D-004), so with no source the check reports
`clean` and never fetches. A real source can be supplied via the
`PAPERCUSP_MARKETPLACE_URL` http seam. Note the live `SecurityAdvisory` shape
keys the CVE as `cve?` (optional), and `AdvisorySeverity` is the union
`low | moderate | high | critical` — there is no `info` tier.

## Open questions

1. **Should `secret: true` imply `shareable: false`?** A secret is by definition not shareable. We'd have one flag instead of two for credentials. The downside is loss of expressiveness for the rare case where you want "publisher-only secret AND publisher-only-but-not-secret identifier" distinct. Round-1 reviewer said keep them separate; standing.
2. **What about array-shaped configs?** A plugin might have `apiKeys: ["key1", "key2"]`. The current schema applies flags per-property, but arrays-of-strings can't be flagged element-wise. Probably fine to require plugin authors to use objects with named fields instead.
3. **Should the `.shape.json` companion be inside `plugin-configs/` or in a separate `shapes/` dir?** Putting it next to the config is closer to the data; putting it separately makes the redacted config look "complete" in isolation. Slight preference for next-to-the-config.

See [Open Questions](./open-questions) for the consolidated V1 / V1.1 / V2 list.
