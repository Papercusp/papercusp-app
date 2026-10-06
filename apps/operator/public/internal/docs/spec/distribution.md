# 11. Distribution
URL: /internal/docs/spec/distribution

Retired hosted-marketplace design history, prefaced by the live in-app Cupboard distribution contract.

import { Aside } from '@astrojs/starlight/components';

The hosted `papercuspai.com/marketplace` + `marketplace-api` (`:3057`)
design described below — including the §11.4 "live as of 2026-04-26"
claims, the `marketplace-api`/`marketplace-site` apps, the Gitea/OCI and
`tenantId`/`tenantSecret` ideas elsewhere in the spec, and the
`papercusp publish` / `papercusp install <name>@<ver>` CLI — has been
**superseded** by the in-app **Cupboard** (`apps/operator-public`,
`@papercusp/cupboard-worker` — Cloudflare Workers + D1). The
`marketplace-api`/`marketplace-site` apps are gone; the old
`apps/papercup` reference install is retired to `_retired/papercup/`.

The Cupboard is **one storefront with ten listing kinds**
(`LISTING_KINDS` in `apps/operator-public/src/db.ts`): `harness` →
join; `blueprint` → fork; `plugin`, `pack`, `knowledge-pack`, and
`template` → install; `app` → download or install; and `rubric`, `plan`,
and `recipe` → install through their self-describing stores. Two earlier
kind values survive only as normalized wire aliases for older clients
(`normalizeListingKind`): `tool-pack` → `pack` (the runtime-less
code-tool pack, briefly named `tool-pack` by migration 008 and renamed
back to `pack`) and `learning-pack` → `knowledge-pack` (migration 011).
Listings are keyed on the GitHub-backed project remote.

Instruction/judgment-carrying kinds (`knowledge-pack`, `blueprint`,
`rubric`, `plan`, `recipe`) publish as `pending` and are publicly invisible
until an operator approves them; the remaining kinds (`harness`, `plugin`,
`pack`, `template`, `app`) publish as `approved` immediately. A non-approved row is `not_found` to
everyone except its publisher. See `REVIEW_POLICY_KINDS` in
`apps/operator-public/src/routes/listings.ts`.

Auth is a GitHub bearer (validated against
`https://api.github.com/user`), **not** namespace OAuth +
Ed25519-server-signing as §11.6 describes; publisher trust is the
GitHub repo-permission signal plus an optional Ed25519 device-pubkey ↔
login attestation (gist-bound). The live route surface is broader than
just `/listings`: there is also the `/harnesses*` back-compat view
(`fixedKind: 'harness'`), the repo → harness binding lookup
(`GET /binding/:github_repository_id`), abuse reporting
(`POST /reports`), and an operator moderation surface (`/admin`, with a
publisher-pubkey ban-list). The publish path enforces private-repo
rejection, a 5/hr-per-user publish cap, and pubkey ban-list filtering.
See `apps/operator-public/README.md` and the route handlers under
`apps/operator-public/src/routes/`.

The sections below are **retained as design history**; treat the
namespace-policy / federation / SBOM / webhook material as aspirational,
not current behavior.

A Papercusp install is distributable. The marketplace is a hosted catalog of harness installs (or plugins for installs), distributed as tarballs.

### 11.1 Publish (with secret scrubbing)

```
# Inside an install directory:
papercusp publish

# Substrate runs:
# 1. Validate against the harness contract (4 roles + state schema + capabilities)
# 2. Run secret scrubber across all files (gitleaks regex set + custom patterns)
# 3. If secrets found:
#    - HARD BLOCK by default, list findings
#    - --acknowledge-secrets replaces them with ${SECRET_NAME} placeholders
# 4. Pack into a tarball (excludes node_modules, .git, .harness state, .env*)
# 5. Upload to the marketplace catalog
# 6. Register name + version in the registry
```

Secret scrubber rules borrow from gitleaks (regex set: AWS, GCP, GitHub PAT, Stripe, Anthropic `sk-ant-*`, OpenAI `sk-*`, Cloudflare `cfut_*`) plus harness-specific patterns (anything ending in `_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD` in env-shaped files).

### 11.2 Install

```
# Pull a published install:
papercusp install habit-tracker@0.2.1

# Substrate:
# 1. Download tarball, verify signature
# 2. Show capability manifest, prompt user consent (§10.3)
# 3. Resolve any ${SECRET_NAME} placeholders by prompting
# 4. Apply DB migrations (plugin's Postgres schema)
# 5. Register routines, hooks, UI contributions
# 6. Save granted-capabilities.json
# Project mounted at ~/.papercusp/projects/habit-tracker/
```

### 11.3 Run

```
# In any project dir:
papercusp run

# Substrate boots:
# 1. Reads schema state (creates fresh if not present)
# 2. Loads installed plugins, applies their schemas
# 3. Loops: orchestrator tick → execute decision → repeat
# 4. Honors lifecycle hooks at each phase
# 5. Routine ticker runs in parallel for cron events
```

### 11.4 Live marketplace infrastructure

Historical (superseded — see banner at top): the
marketplace described in §11.1–11.3 briefly ran at
papercuspai.com/marketplace (MVP, 2026-04-26) on the
now-removed marketplace-api/marketplace-site
apps. It has been replaced by the Cupboard. The architecture below is
kept for reference only. Original architecture:

```
papercuspai.com  (Cloudflare Pages — static Next.js export)
   │
   ├──> /  /marketplace/  /marketplace/[slug]/  /docs/
   │
   │ runtime fetch (CORS-allowed origin)
   ▼
api.papercuspai.com  (Cloudflare Tunnel — public ingress)
   │
   │ tunnel → cloudflared (token mode)
   │   tunnel UUID c53515b3-edfe-4e99-813b-e3916ae9d02c (papercupai-api)
   ▼
http://localhost:3057  (marketplace-api — Hono on Node, libs/papercusp/apps/marketplace-api)
   │
   │ filesystem read
   ▼
~/.papercusp/marketplace-storage/<slug>/<version>/
   ├── papercusp.json          (manifest)
   ├── README.md               (rendered on detail page)
   └── <slug>-<version>.tar.gz (the install)
```

Public API endpoints (api.papercuspai.com):

EndpointReturns

`GET /healthz`Plain text `ok` — liveness probe.
`GET /catalog`\{\{ catalog: \[\{...manifest, versions\[]}], storageRoot }} — full catalog with latest manifest per slug.
`GET /catalog/:slug`\{\{ slug, versions, latest: manifest }} — all versions of a single package.
`GET /catalog/:slug/:version`\{\{ slug, version, manifest, readme }} — specific version detail.
`GET /download/:slug/:version`Tarball stream (`application/gzip`). Used by `papercusp install`.
`POST /publish/:slug/:version`Multipart upload (manifest + tarball + readme). PAT-auth-able when `PAPERCUSP_MARKETPLACE_AUTH=pat`; currently runs in `open` mode (see §11.5).
`DELETE /catalog/:slug/:version`Unpublish — currently no-auth, dev-only.

Site routes (papercuspai.com):

RouteWhat it does

`/`Landing page; live-fetches 3 featured packages from `/catalog`.
`/marketplace/`Catalog grid + search. Live-fetches `/catalog` at runtime.
`/marketplace/[slug]/`Detail page (manifest, README, install command, versions, capabilities, **install shape** (§4.1), **declared services with version ranges** (§8.4.1), **capability tier breakdown** (§10.6.1)). Slugs are pre-rendered at build via `generateStaticParams` reading the catalog at build time.
`/docs/`Quickstart placeholder; full reference points to this page.

Two-base build pattern

Cloudflare Pages exports static HTML at build time, then the deployed bundle runs in browsers worldwide. Two API URLs are needed:

```
# Build server-side (generateStaticParams) — uses BUILD_API_BASE
# Client bundle baked-in URL (runtime fetches) — uses NEXT_PUBLIC_API_BASE
BUILD_API_BASE=http://localhost:3057 \\
NEXT_PUBLIC_API_BASE=https://api.papercuspai.com \\
  npm --workspace @papercusp/marketplace-site run build
```

At build, generateStaticParams hits the local marketplace-api (faster, doesn't need DNS). The output static pages reference `https://api.papercuspai.com` for runtime fetches by browsers.

CORS allowlist (in marketplace-api)

```
https://papercuspai.com
https://www.papercuspai.com
*.pages.dev                       (Cloudflare Pages preview deploys)
http://localhost:3060             (local site dev)
http://localhost:3050             (papercup public site dev)
http://192.168.40.216:3060        (LAN dev)
```

Cloudflare deployment specifics

Account`f896982ea2f6d507e4f29eeecbd26e94`
Pages project`papercuspai` (deployed via `wrangler pages deploy`)
Tunnel`papercupai-api` (UUID `c53515b3-edfe-4e99-813b-e3916ae9d02c`) — same tunnel as papercupai.com, with two ingress rules
DNS apex`papercuspai.com` → CNAME `papercuspai.pages.dev` (proxied)
DNS api`api.papercuspai.com` → tunnel ingress (managed via Zero Trust dashboard)

Operational notes

The `marketplace-api` process must be running on `localhost:3057` for the public site to load the catalog. Procfile entry: `marketplace: npm run dev:marketplace`.
New publishes appear immediately at runtime in `/marketplace/` grid (live API fetch), but their `[slug]` detail pages 404 until the site is rebuilt + redeployed (because `dynamicParams = false` on the static export).
The first build of the site requires `marketplace-api` to be reachable (either local for `BUILD_API_BASE`, or the production tunnel must be live).
`cloudflared` runs in token mode → ingress rules are managed via the Zero Trust dashboard, not `~/.cloudflared/config.yml`.

### 11.5 Outstanding marketplace work

The §11.4 deployment is MVP. Production-grade requires:

ConcernStatusWhat's needed

Auth on publish⚠ Open (no auth)GitHub OAuth + namespace claim. Publishing under `@user/name` requires proven ownership of the GitHub user/org. Squatting prevention.
Tarball storage⚠ Local FSMove to Cloudflare R2 with signed download URLs so marketplace-api scales beyond one box. `storageRoot` field in `/catalog` response is already a hint at multi-backend support.
Tarball signing❌ MissingSign at publish with Ed25519 server key; verify at install. CLI rejects unsigned tarballs from untrusted sources.
Search + tags⚠ Client-side only`/catalog` returns the full list; the site filters in-memory. Large catalogs (1k+) need server-side filtering — Typesense index, query API.
Stats❌ MissingDownload counts, popularity ranking, trending. Fed back to ranking on `/marketplace/`.
Author profiles + reviews❌ Missing`/authors/[name]`, `/marketplace/[slug]#reviews`. Trust signals before install.
Update flow❌ Missing`papercusp update &lt;name&gt;` — diff capabilities (prompt for new ones), run new migrations, version-pin previous in case of rollback. Spec'd in §11.7.
Uninstall❌ MissingNo formal teardown of plugin schema, granted-capabilities, routines, registry entry. Spec'd in §11.8.
Size / bandwidth quotas❌ MissingPer-package size limits, per-publisher daily upload quota, per-IP throttling. Spec'd in §11.10.
Catalog webhooks❌ MissingCI / mirror / monitor notifications on `version.published` etc. Spec'd in §11.11.
Offline install❌ Missing`papercusp pack` for vendored mirrors; `file://` registry URLs. Spec'd in §11.12.
Multi-registry resolution❌ MissingScope-based routing across multiple registries; no automatic fallback. Spec'd in §11.13.
Supply chain attestation❌ Missing (optional in v1.0)SPDX / CycloneDX SBOMs at publish; CVE scanning via osv.dev. Spec'd in §11.14.

### 11.6 Authorization & namespace policy

The marketplace is the trust boundary. The spec commits to one namespace policy, two trust tiers, and an explicit federation stance.

Namespace policy

Names are scoped: @\<owner>/\<package>, where `owner` is a verified GitHub user or org. Examples: `@papercusp/coding-project`, `@avi/habit-tracker`, `@anthropic-team/internal-roles`.

To publish under `@avi/foo`, the publisher must prove ownership of GitHub user `avi` via OAuth at publish time. The marketplace verifies via GitHub's token-introspection API and stores the verified login on the package row (`publishedBy: 'avi'`).
No bare names. `papercusp install foo` is rejected; the user must spell the full namespace. This eliminates a whole class of typo-squatting.
Reserved namespaces: `@papercusp/*` for first-party packages, gated by a hard-coded membership list (currently: members of the `Papercusp` GitHub organization — see the canonical identity note below; `papercupai` is a person, not an org, and cannot be an org-membership target). Plus reserved single-word namespaces blocked from claim: `examples`, `test`, `internal`, `system`, `admin`, `root`, `public`, `private`, `papercup`, `cli`, `sdk`, `api`, `ui` — these are reserved at the marketplace server. New first-party reservations are added by patch-version bumps to the spec.
`publishedBy` is immutable. The verified GitHub login stamped on a published version is permanent for that row, even if the user later renames their GitHub account. The marketplace tracks renames separately (a `github_login_rename` audit table) so the spec can answer "who originally published this?" deterministically. Renames don't affect ownership of packages — those follow the GitHub identity (`user.id`, not `user.login`).
Namespace transfer. An owner can transfer `@me/foo` to `@you/foo` via `papercusp transfer @me/foo @you`. Both parties must approve via OAuth-signed challenges within 7 days; on completion, the marketplace inserts a `namespace_transfers` audit row with both verified logins, and future publishes go to the new owner. Existing version rows keep their `publishedBy` (immutable). The CLI shows "transferred from @me to @you on `<date>`" on the package detail page.

Canonical GitHub identity (read this once, link to it elsewhere — don't re-describe it):{' '}
papercupai is a GitHub User account (created 2026-04-25) — the maintainer's personal admin login,
used to sign in and administer the project. Papercusp is a separate GitHub Organization
(created 2026-05-28) that owns the canonical repositories (`Papercusp/papercup`, `Papercusp/papercusp-registry`, …);
papercupai has active admin membership in it. The two are related but distinct identities — a GitHub
user cannot itself be an "org", so any check or doc that talks about "the papercupai org" is describing
an identity that doesn't exist and is a drift bug (see WI-4978). When first-party/org-membership semantics are meant,
the org is always Papercusp; when a personal-account/admin-login is meant, it's papercupai.

Two trust tiers

TierWho's in itWhat changes

VerifiedPackages whose publisher has confirmed email + linked GitHub identity + signed Ed25519 signature on every version.
Shows a checkmark badge in the marketplace UI; CLI doesn't warn at install time.

Unverified
Packages with valid namespace ownership but no signature, OR signed with a key the marketplace hasn't seen before.
CLI prints a warning at install time: `WARNING: @user/foo is unverified (no signature). Continue? [y/N]`

Federation

papercuspai.com is the canonical marketplace for the open standard. Other marketplaces can exist (private, enterprise, regional), but the CLI defaults to [https://api.papercuspai.com](https://api.papercuspai.com) and the spec doesn't define cross-registry resolution. Operators wanting an alternate marketplace use papercusp config set registry \<url>; install commands then resolve against that registry alone. No automatic fallback chain — that's a vector for attacker-controlled mirrors to inject impostor packages.

### 11.7 Update flow

Updating a plugin is structurally different from a fresh install: the substrate has to compare two manifests and reason about migration ordering.

```
$ papercusp update @avi/shareholder-briefings

Currently installed: 1.0.4
Latest available:    1.2.0

Capability changes:
+ secrets:read:OPENAI_API_KEY        (new)
+ http:fetch:openai.com              (new)
- secrets:read:DALL_E_KEY            (no longer requested; revoked)

Migrations to apply:
002_add_summary_table.sql
003_index_message_recipients.sql

Routine changes:
~ weekly-briefings: cron changed from '0 9 * * MON' to '0 9 * * MON,THU'
+ daily-cost-report: NEW (cron '0 8 * * *')

Approve new capabilities? [y/N/per-capability]: y
Apply migrations? [y/N]: y
Updating ... done. Pinned old version 1.0.4 at ~/.papercusp/installed/@avi/shareholder-briefings/.snapshots/1.0.4/
```

The update flow is governed by these rules:

Capability diff prompts only for additions. Removed capabilities are auto-revoked; previously-granted ones aren't re-asked.
Migrations apply in declared order. Plugin manifest lists migration files in `schema[]` (already spec'd in §10.1). The substrate runs only the ones higher than the install's current `applied_migration_index`.
Old version is snapshotted to .snapshots/\<old-version>/ before the new files are unpacked. Includes the granted-capabilities.json, all schema dumps for plugin's tables, and the manifest. Rollback is not automatic (down-migrations are unsafe in general), but the snapshot lets `papercusp rollback &lt;name&gt;` re-mount the old version's files; the user is responsible for any DB rollback.
Routines reconcile. Renamed/removed routines from the old version are deleted from `routines` table; new ones inserted; modified ones updated in place.
Active state preserved. Plugin's data (Postgres tables, granted-capabilities) is never touched by update. Only the code + manifest are replaced.

### 11.8 Uninstall flow

The default uninstall is conservative: stop the code, leave the data.

```
$ papercusp uninstall @avi/shareholder-briefings

Will remove:
- 4 routines (weekly-briefings, daily-cost-report, ...)
- Plugin code: ~/.papercusp/installed/@avi/shareholder-briefings/
- Granted capabilities
- Registry entry
- Hook subscriptions
- UI contributions (1 sidebar item, 1 dashboard tab)

Will KEEP (use --purge-data to also remove):
- Postgres schema "briefings" (4 tables, ~12,300 rows)
- Plugin's secrets references (the secrets themselves are not deleted from the secret store)

Continue? [y/N]: y
Uninstalled. Run with --purge-data later if you want to reclaim DB space.
```

Why not auto-drop the schema? Because uninstall is often "I want to try a different version" or "this plugin is buggy, let me reinstall". Losing the data is a one-way action; preserving it is reversible. Users can `--purge-data` explicitly when they truly want a clean slate.

After uninstall:

The plugin's code is gone; no further routine fires; no further hook handlers run.
The plugin's schema persists; another install of the same plugin (any version) can re-attach to it.
Reference to the schema from `routines` and `granted_capabilities` tables is deleted; those rows are gone.
The `audit.uninstalls` table records: plugin name, version, time, whether `--purge-data` was used.

Reinstall after uninstall. If the user later runs `papercusp install &lt;same-name&gt;` and the plugin's schema still exists, the install flow detects it and prompts: "Schema 'briefings' already exists with 12,300 rows. Adopt existing data, or DROP and start fresh? \[adopt/drop]". Default is `adopt`. The plugin's migrations resume from `applied_migration_index` recorded in the substrate's `installed_plugins` table.

### 11.9 Package retraction (server-side)

Sometimes a published package must be pulled from circulation —
leaked credentials, malicious code, legal request, namespace
ownership transfer. Retraction is server-side only; once a tarball
is on a user's machine, the substrate can't reach in and remove it.

Retraction levels

LevelEffect on marketplaceEffect on installed users

Deprecated
Listed with a "Deprecated" banner. New `papercusp install` shows a warning but proceeds. New version uploads still allowed.
None — existing installs keep running. Updates show "the maintainer marked this package deprecated; consider an alternative" warning.

Yanked
Specific version hidden from listing pages. New installs of that version fail with "yanked: \<reason>". Other versions of the same package unaffected.
None automatically. CLI `papercusp doctor` reports "you have a yanked version installed; consider updating".

Withdrawn
Entire package hidden from listing. New installs at any version fail. Tarballs still downloadable by direct URL (with a 410 Gone status pending grace period).
Substrate emits a `package.withdrawn` notification at next routine fire; user sees an alert in the UI. Code keeps running until the user acts.

Quarantined (security)
Same as Withdrawn, plus tarball returns 410 immediately (no grace period).
Substrate auto-pauses all routines from the quarantined package on next refresh from the catalog. Code is not executed; UI shows "this plugin has been quarantined for security reasons" prominently. User must explicitly `papercusp uninstall` (or `papercusp force-resume` if they accept the risk).

Who can retract

Deprecate / yank — the package owner (verified GitHub identity per §11.6) at any time, via `papercusp deprecate` / `papercusp yank`.
Withdraw — the package owner, OR the marketplace operator (papercuspai.com admins) for ToS violations.
Quarantine — only the marketplace operator. Reserved for active security incidents (leaked credentials in a tarball, confirmed malware, court order). Reason is published to a public audit log at `papercuspai.com/security/quarantines`.

Catalog-poll behavior

The substrate polls the catalog at most once per hour (default;
configurable, but never less than once per day). Each installed plugin
is checked for retraction status; quarantined ones trigger immediate
pause. The substrate does not auto-update plugins —
it only acts on explicit retraction signals.

Tarballs cached at \~/.papercusp/cache/tarballs/\<slug>-\<version>.tar.gz
are kept regardless of retraction state — useful for forensic
analysis after a security event.

Quarantine appeal process

Quarantines are operator decisions; they have a defined appeal path so
owners aren't permanently silenced without recourse:

Owner emails `appeals@papercuspai.com` (or files a GitHub issue against `papercupai/marketplace-appeals`) within 30 days.
Operator publishes the appeal + their original quarantine reasoning to the public audit log within 7 days.
Resolution is one of two outcomes. Upheld: quarantine stays; owner can re-publish at a new namespace if it was a false-positive on identity, or re-publish a fixed version if it was a content issue. Reversed: quarantine downgraded to "withdrawn" (less severe); owner may un-withdraw within 7 days. The audit log records the reversal.
Substrate-side: when a quarantine is reversed, installs that auto-paused on quarantine see a `package.unquarantined` event; routines remain paused (user must explicitly resume) but the UI alert clears.

### 11.10 Package size & bandwidth quotas

The marketplace must enforce limits to prevent abuse: oversized
tarballs filling storage, runaway publishing draining the publisher's
own quota, malicious downloaders fetching high-bandwidth tarballs in
loops to inflate operator costs.

Per-package limits

Tarball size: 50 MB hard limit per version. Larger packages must split — typical mature plugins (papercup-org, sheets-clone) are well under 1 MB compressed.
Manifest size: 64 KB. Forces author to use compact JSON, not bundled assets.
README size: 256 KB. Forces docs to live elsewhere (linked from the package's `homepage`) for any non-trivial documentation.
Total versions per slug: unlimited (kept as audit trail), but only the latest 100 surface in the catalog UI by default.

Per-publisher quotas

Publishes per day: 50 versions across all the publisher's packages, total. Resets at UTC rollover.
Aggregate storage: 1 GB total across all versions of all packages owned by the publisher. Yanked + withdrawn versions still count until purged.
Higher quotas available on operator request (no formal SLA; for first-party packages and verified high-value contributors).

Per-IP download throttling

At the API edge:

`GET /catalog` and read endpoints: 600 requests/minute/IP (matches an internal admin's tunneled mirror; calibrated to allow a busy CI but reject scrapers).
`GET /download/:slug/:version`: 60 tarballs/hour/IP. Caches don't count (signed R2 URLs, see §11.5 outstanding work).
`POST /publish/:slug/:version`: 5/minute/authenticated user. Prevents accidental loops.

Throttle violations return HTTP 429 with `Retry-After` header. CI
clients that hit the limit should back off; their `papercusp.config.json`
can declare a sustained-rate token from the operator.

### 11.11 Catalog webhooks for CI/CD

Operators want to wire their CI pipelines to publish on tag, mirrors
want to pull on new versions, listeners want notifications. The
marketplace exposes outbound webhooks for catalog events.

Subscribe to catalog events

```typescript
// Authenticated; only the namespace owner can subscribe to events for that namespace.
POST /v1/webhooks
{
"owner": "@avi",                           // namespace this webhook subscribes to
"url": "https://hooks.example.com/papercusp",
"events": ["version.published", "version.yanked", "package.withdrawn"],
"secret": "<32-byte-base64-shared-secret>" // for HMAC-SHA-256 signing
}
```

Event payloads

Each delivery is an HTTP POST with header `X-Papercusp-Signature: sha256=<hex>` (HMAC of body using the subscription's secret) and a JSON body:

```json
{
"id": "wh_evt_01J6...",                    // unique per delivery, for dedup
"event": "version.published",
"ts": 1777286087000,
"deliveryAttempt": 1,
"data": {
"slug": "@avi/habit-tracker",
"version": "1.2.0",
"publishedBy": "avi",
"publishedAt": "2026-04-27T14:34:47Z",
"tarballSha256": "abc123...",
"manifestUrl": "https://api.papercuspai.com/catalog/@avi/habit-tracker/1.2.0"
}
}
```

Delivery semantics

At-least-once delivery. Same `id` may be delivered more than once on retry. Receivers must dedup by `id`.
Retry schedule: exponential backoff. Attempts at 0s, 30s, 5min, 1hr, 6hr, 24hr; after 6 attempts (≈31 hours), the delivery is dropped. Subscribers see drops in `papercusp webhooks history`.
Endpoint must respond with 2xx within 10 seconds. Slower or non-2xx → retry per schedule.
Webhook age limit: 90 days inactive (no successful delivery) auto-disables the subscription; owner gets one email reminder before disable.

Cross-event vs single-event subscriptions

Operators can subscribe to the entire catalog (`owner: "*"` requires
operator role) — used by monitoring dashboards and the public audit log.

### 11.12 Offline / vendored install

Enterprise and air-gapped environments can't reach
`api.papercuspai.com`. The substrate supports local mirroring:

Vendoring with `papercusp pack`

```
$ papercusp pack @avi/habit-tracker @avi/habit-tracker@1.2.0 \
--output ./vendored/

Wrote:
./vendored/@avi/habit-tracker/1.2.0/papercusp.json
./vendored/@avi/habit-tracker/1.2.0/README.md
./vendored/@avi/habit-tracker/1.2.0/habit-tracker-1.2.0.tar.gz
./vendored/@avi/habit-tracker/1.2.0/habit-tracker-1.2.0.tar.gz.sig
./vendored/marketplace.pub                              ← public key for verification
./vendored/index.json                                   ← catalog snapshot

Total: 1.1 MB across 5 files.
```

The `vendored/` directory is a self-contained mirror. Drop it on a
USB drive, into S3, or commit to git. The receiving substrate is
configured to use it as the registry.

Configuring the substrate to use a vendored mirror

```
papercusp config set registry file:///mnt/usb/vendored/
# or
papercusp config set registry https://internal-mirror.example.com/papercusp/
# or for a specific install:
papercusp install --registry file:///mnt/usb/vendored/ @avi/habit-tracker
```

File-based registries use the same JSON-blob layout that
`papercuspai.com` serves. The substrate's resolver doesn't care whether
it reads from HTTP or filesystem — only the URL scheme switches.

Limitations of offline mode

No version-discovery beyond what's in the local index — newer versions of installed plugins won't auto-detect until the mirror is refreshed.
Retraction signals (§11.9) don't propagate without a live registry. Offline operators must subscribe to a webhook (§11.11) or refresh the mirror manually.
Stats (downloads, popularity) are not tracked offline.

### 11.13 Mirror & fallback registry resolution

Some operators want to fall back to papercuspai.com for packages not
in their internal mirror. The spec keeps this opt-in and
explicit; no automatic fallback chain (per §11.6).

Multi-registry config

```
# In ~/.papercusp/config.json:
{
"registries": [
{ "url": "https://internal.example.com/papercusp/", "scope": "@example/*" },
{ "url": "https://api.papercuspai.com",              "scope": "*",          "trustOnFail": false }
]
}
```

Scope-based routing. First match wins. `@example/foo` always resolves to internal; `@avi/foo` resolves to papercuspai.com.
Explicit fallback only. No registry can claim packages it doesn't have a scope match for. The CLI errors with "no registry covers @other/foo" rather than searching all configured registries.
`trustOnFail: false` (default): if a higher-priority registry is unreachable, the install fails — never silently falls through to a lower-priority one. Setting `true` requires explicit operator opt-in (logged in audit).

This pattern is borrowed from `pip` and `cargo` after they had to
retroactively retrofit fallback safety. Building it in from day 1
avoids the "what registry does my package come from?" supply-chain
confusion.

### 11.14 Supply chain attestation (SBOM, optional)

Verified packages (per §11.6) may optionally publish a
Software Bill of Materials at publish time. The
marketplace stores it as a separate attestation, displays it on the
detail page, and exposes it via the API.

Attestation format

The substrate accepts SBOMs in SPDX 2.3 or
CycloneDX 1.5 JSON formats — both widely-supported
open standards. Authors can generate them via existing tools
(`syft scan dir:.`, `cdxgen .`) and submit at publish time:

```
$ papercusp publish --sbom ./sbom.spdx.json

Validated against SPDX 2.3 schema. Found 47 dependencies, 0 vulnerabilities.
Attestation published. Detail page at https://papercuspai.com/marketplace/@avi/foo/1.2.0/sbom
```

What it enables

Vulnerability lookup. The marketplace scans new SBOMs against public CVE databases (osv.dev) and flags vulnerable dependencies on the detail page. Operators can subscribe to webhooks for "any installed plugin gets a new CVE matched".
Reproducibility verification. Authors can publish source location for each dependency; sceptics can verify the published tarball was actually built from those sources.
Compliance. Enterprise / regulated industries (healthcare, finance) can require all installed plugins to have published SBOMs.

Discoverability

Detail page surfaces:

"Has SBOM" badge (with link to formatted SBOM viewer at `/marketplace/@avi/foo/1.2.0/sbom`).
"N known vulnerabilities" if any deps have unpatched CVEs (linked to the specific advisories).
SBOM diff between versions (helpful for reviewers to see new dependencies).

SBOMs are optional in v1.0. Mandatory SBOMs are a
v2.0 question pending operator feedback — too aggressive for the
first version, but enterprises will likely require them. Verified
packages without SBOMs aren't penalized; they just don't get the
SBOM badge.
