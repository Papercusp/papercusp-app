# `apps/operator-public` — Cupboard server

The public listing service for shared Papercusp harnesses.

A harness owner publishes their (public) GitHub-backed shared harness here; other users browse + install. Mirrors the `papercusp-publish` Worker's deploy pattern.

**Plan:** `apps/operator/docs/plans/papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24.md` (P-051a server endpoints; P-051b deploy).

**Master:** `papercusp-dogfood-v5-2026-05-23.md` §10 (Cupboard server architecture) + addendum 1 (canonical binding by `github_repository_id`).

## Architecture decision (2026-05-25 loop)

Original plan called for "Cloudflare-fronted Next.js + managed Postgres." This loop chose a thinner shape:

- **Cloudflare Workers + Hono** (not Next.js). The Cupboard server is API-only; the desktop operator already owns the listing UI (Phase 9 P-052). A Next.js app would be 80% empty.
- **D1 (SQLite)** instead of managed Postgres. Cupboard data is moderate-scale + relational + low-cost; D1's free tier covers v1 easily. Reusing the `papercusp-publish` pattern keeps the deploy + auth + rate-limit code shapes consistent.
- **GitHub bearer auth** (validate `Authorization: Bearer <gh_token>` against `https://api.github.com/user`). Desktop operator passes the same token produced by Phase 1b `lib/identity/gh-token.ts`.

## Listing kinds (one storefront, fifteen kinds)

Per the distribution plan (`harness-blueprint-distribution-2026-06-03`, D-005/D-008),
extended by `tool-distribution-granularity-2026-06-05`, `learning-packs-2026-06-11`,
`app-templates-2026-07-04`, `cupboard-public-release-2026-07-12`,
`cupboard-app-distribution-2026-07-14`, `cupboard-plan-rubric-recipe-sharing-2026-08-21`,
`work-on-everything-goal-2026-08-23`, `cupboard-themes-2026-09-05`, and
`identities-v1-2026-08-30` (P-027, P-028, P-029, D-010/D-011), the Cupboard is
no longer harness-only. It is ONE storefront with fifteen listing kinds
(`LISTING_KINDS` in `src/db.ts`), each with its own consumer action and review/delivery
semantics:

| `listing_kind` | Consumer action | Review status | Carries |
|----------------|-----------------|---------------|---------|
| `harness`        | **join / view Hive** | **approved** | a Hypercore `topic_hex` (the shared-pot swarm) + optional `hive_pubkey`/`hive_title` repo→Pot binding |
| `blueprint`      | **install** | **pending** | a blueprint stream within a project (`project_ref` + `listing_ref`); a `blueprint_kind: pot` blueprint is a **pot template** |
| `plugin`         | **install** | **approved** | a runtime-bearing pack — a distributable plugin (`listing_ref` = plugin slug); `provides_tools` |
| `pack`           | **install** | **approved** | a runtime-less code-tool pack (`listing_ref`; `provides_tools`) |
| `knowledge-pack` | **install** | **pending** | a distributable set of curated pot learnings (instruction-carrying) |
| `template`       | **install** | **approved** | a first-party app template — an app scaffold, GitHub-repo-backed per `listing_ref` like a blueprint |
| `app`            | **download** (standalone) / **install** (bundle) | **pending** | a whole distributable application; standalone hands off the signed GitHub release installer, while bundle is a Papercusp-native workspace composition |
| `rubric`         | **install** | **pending** | a reusable grading rubric and optional `METHOD.md` runbook |
| `plan`           | **install** | **pending** | a reusable plan template (goal + item DAG + decisions, with live state stripped) |
| `recipe`         | **install** | **pending** | a captured multi-step tool orchestration |
| `goal`           | **install** | **pending** | a goal package with duties, kickoff, schemas, defaults, and tripwires; installing creates an inactive stub |
| `theme`          | **install** | **approved** | an inert semantic-token package selectable by the existing theme runtime |
| `datatype`       | **install** | **pending** | a generic-kind datatype package — the schema + lifecycle a workspace installs so `work_items` accept a new item kind; `datatype_registry` remains the resolution layer |
| `rule`           | **install** | **pending** | an installable behaviour — "when X, fire Y". Fires a capability **class** (`class:<ref>#<verb>`), not a tool id, so the installing pot's own provider binding decides which tool runs and one listing ships across pots with different providers |
| `event`          | **install** | **pending** | an event-key declaration — the versioned key, its payload schema, and its emitter/consumer discovery metadata, so a rule's `on` and an agent's `events:await` RESOLVE against a registered key instead of a hand-authored catalog. Independently useful with no `rule` anywhere |

Retired / aliased: `snapshot` was retired (`retire-snapshots-instance-spec-2026-06-09`
D-005); the interim `tool-pack` value normalizes to `pack` and the pre-rename
`learning-pack` normalizes to `knowledge-pack` (`normalizeListingKind`), so older
clients keep parsing. Review-gated kinds (`knowledge-pack`, `blueprint`, `app`, `rubric`,
`plan`, `recipe`, `goal`, `datatype`, `rule`, and `event`) publish `pending` and are publicly invisible
until an operator approves them (`REVIEW_POLICY_KINDS`); `harness`, `plugin`, `pack`,
`template`, and `theme` publish `approved` immediately. For `app`, `delivery_type` is
`standalone` by default (download handoff); `bundle` is the deferred workspace-install
model.

**Project-centric 1:N (D-008):** listings key on the papercupai **project remote**
(`project_ref`) and a project hosts **N** non-harness listings, discriminated by
`listing_ref`. `github_repository_id` denotes the project remote's repo id and is
**no longer unique on its own** — only one *active harness* listing per repo is
enforced (the old 1:1 invariant, preserved for `kind='harness'`). GitHub-repo-backed
identity stays for v1, so every kind carries the project remote's github fields and
the publisher-collaborator trust signal.

## Endpoints

The canonical surface is `/listings` (kind-aware). `/harnesses*` is the same surface
pinned to `kind='harness'` — the back-compat view the deployed desktop client +
operator proxy use today. Once the operator proxy is cut over to `/listings?kind=harness`,
`/harnesses*` can be dropped (it carries no behavior the generalized surface doesn't).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/healthz` | none | Liveness |
| `GET`  | `/listings` | none | Paginated public listing. Query: `kind` (`harness`/`blueprint`/`plugin`/`pack`/`knowledge-pack`/`template`/`app`/`rubric`/`plan`/`recipe`/`goal`/`theme`/`all`; legacy `tool-pack`/`learning-pack` normalize forward), `project` (project_ref), `q`, `claim`, `limit` (1-100), `cursor` |
| `GET`  | `/listings/:id` | none | Single listing detail |
| `POST` | `/listings` | gh-bearer | Publish (5/hr per user; private GitHub repos rejected). Body `listing_kind` (default `harness`), `project_ref`, `listing_ref` (required for non-harness), `topic_hex` (required for harness), `delivery_type` (`standalone`/`bundle`, app only), `hive_pubkey` + `hive_title` (migration 007 repo→Pot binding; pubkey = raw-32-byte-base64 Ed25519, the pot directory encoding) |
| `DELETE` | `/listings/:id` | gh-bearer | Unlist (publisher or claimant only) |
| `POST` | `/listings/:id/claim` | gh-bearer | Claim by `maintain`/`admin` GitHub perm |
| `GET`/`POST`/`DELETE` | `/harnesses*` | as above | Back-compat: `/listings` pinned to `kind='harness'` |
| `GET`  | `/binding/:github_repository_id` | none | Lookup the harness listing bound to a repo (Entry 2 "join existing" alert). Carries `hive_pubkey`/`hive_title` when the repo is a member of a public Pot (migration 007; one row per member repo, all sharing the hive_pubkey) |
| `POST` | `/reports` | gh-bearer | File abuse report (10/hr per user) |

## Local dev

```bash
cd apps/operator-public
npm install
npm run d1:apply:local          # initialises local D1 schema
npm run dev                     # wrangler dev --local
```

Hit `http://127.0.0.1:8787/healthz` to verify.

To exercise a publish:
```bash
curl -X POST http://127.0.0.1:8787/harnesses \
  -H "Authorization: Bearer $(gh auth token)" \
  -H "Content-Type: application/json" \
  -d '{
    "github_repository_id": 12345,
    "github_owner": "owner",
    "github_name": "repo",
    "github_url": "https://github.com/owner/repo",
    "title": "Test",
    "description": "A test harness",
    "topic_hex": "0000000000000000000000000000000000000000000000000000000000000000"
  }'
```

## Deploy (P-051b — user step)

1. **Provision bindings:**
   ```bash
   wrangler d1 create papercusp-cupboard
   wrangler kv:namespace create papercusp-cupboard-counters
   ```
   Paste the returned `database_id` + KV `id` into `wrangler.toml`.

2. **Apply schema to remote (migrations run in order):**
   ```bash
   wrangler d1 migrations apply papercusp-cupboard --remote
   ```
   This applies every file in `migrations/` that is not yet recorded in the
   database's `d1_migrations` table, in name order, and records each one. It is
   also `npm run deploy`'s `predeploy` step, so the worker can never ship ahead
   of its schema again: on 2026-09-05 the worker was deployed referencing
   `harnesses.visibility` (migration 018) while the remote database was still at
   014 — `/listings` answered `D1_ERROR: no such column: h.visibility` and the
   Cupboard tab was a 500 (WI-2147021). 015–021 were then applied by hand and
   `d1_migrations` was back-filled with 001–021, so the tracking table is
   authoritative from that point on. Do NOT go back to `wrangler d1 execute
   --file` for an incremental migration: it applies the SQL without recording
   it, and the next `migrations apply` would try to re-run it.
   ⚠ `004` is a one-shot table rebuild (adds `listing_kind` + project-centric 1:N
   keying; existing rows preserved as `kind='harness'`). Apply it exactly once.

3. **Install secrets:**
   ```bash
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler secret put IP_HASH_PEPPER       # 32 random bytes, base64
   ```
   Commerce (Stripe) needs two more — see
   [Stripe commerce runbook](#stripe-commerce-runbook-p-038) below. `wrangler
   secret list` is the authoritative check for which are installed; the Worker
   answers `payments_unconfigured` on `/commerce/checkout-sessions` without them.

4. **DNS + Workers route:**
   - Decide the hostname. `cupboard.papercusp.dev` is the v5 default; can also live at `cupboard.papercuspai.com` if the team prefers a single brand.
   - Add a proxied CNAME for the chosen hostname pointing at `100-100-100-100.cdn.cloudflare.net` (Cloudflare placeholder; Worker route binding takes precedence).
   - In Cloudflare dashboard → Workers Routes, add `<hostname>/*` → this Worker.

5. **Deploy:**
   ```bash
   npm run deploy
   ```

6. **Point the desktop operator at the live Cupboard:**
   ```bash
   echo 'PAPERCUSP_CUPBOARD_URL="https://<hostname>"' >> ~/.papercusp/env
   ```

## Stripe commerce runbook (P-038)

How to arm real card payments on a deployed Cupboard Worker, and how to prove
the whole chain works. Verified end to end in Stripe TEST mode on 2026-09-06
against Worker version `011d7af2-42fd-4127-aa88-4542afaba225`.

### 1. Install the two Stripe secrets

```bash
cd apps/operator-public
wrangler secret put STRIPE_SECRET_KEY      # sk_test_… (or sk_live_… in production)
wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_… — from the endpoint created in step 2
wrangler secret list                       # both names must appear
```

Neither secret is ever read from the repo or from `wrangler.toml`; they exist
only as Worker secrets. `STRIPE_WEBHOOK_SECRET` is what
`/commerce/webhooks/stripe` verifies the `stripe-signature` header against, so
an unsigned or wrongly-signed POST is rejected — do not skip it to "test
faster", or the webhook leg is untested.

### 2. Register the webhook endpoint

Create it against the **branded** host (the same origin the Worker route
serves), not the `*.workers.dev` name:

```bash
curl -sS https://api.stripe.com/v1/webhook_endpoints \
  -u "$STRIPE_SECRET_KEY:" \
  -d url="https://cupboard.papercusp.com/commerce/webhooks/stripe" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=checkout.session.expired" \
  -d "enabled_events[]=checkout.session.async_payment_succeeded" \
  -d "enabled_events[]=checkout.session.async_payment_failed"
```

The response's `secret` (`whsec_…`) is what step 1 installs. Then `npm run
deploy`.

⚠ **A dev box that cannot reach the branded host is not evidence the webhook is
broken.** This machine SNI-blackholes `cupboard.papercusp.com` (EI-16742), so a
local `curl` to it fails while Stripe delivers to it perfectly. Prove delivery
from `wrangler tail`, never from a local request.

### 3. Managed Payments must stay OFF

Stripe enables **Managed Payments** by default on new accounts. With it on,
every Checkout Session built from ad-hoc `price_data` line items is a hard 400:

```
Invalid line_items[0]: the product tax code is missing.
Product tax code is required for Managed Payments, which is enabled by default on your account.
```

Ad-hoc products cannot carry a `tax_code`, so **no purchase can ever be
opened**. `buildStripeCheckoutSessionParams`
(`packages/operator-core/lib/cupboard/payment-adapters/stripe.ts`) therefore
sends `managed_payments: { enabled: false }`, covered by regression tests in
`stripe.test.ts`.

This is a correctness requirement, not a workaround: Managed Payments makes
Stripe the merchant of record and gives it settlement, which would bypass the
DAO split manifest and the P-033/P-034 settlement batches. Those need a direct
charge. Do not "simplify" this flag away.

### 4. Drive a real test purchase

The `$10.00` prepaid-credit SKU needs no publishing: an `index.ts` middleware
installs `prepaidCreditCatalogEvents()` on every `POST
/commerce/checkout-sessions`, so offer `papercusp-prepaid-byoc-credits-usd-10`
always exists even though `/commerce/offers` is otherwise empty. Auth is a
GitHub bearer; an operator id in `CUPBOARD_OPERATOR_GITHUB_IDS` passes
`authorizeBuyer` via the SELF branch, so `buyerOrgId` may be its own
`gh:<id>` with no org.

```bash
BASE=https://papercusp-cupboard.ownerhandle.workers.dev
TOK=$(gh auth token)

# start a tail FIRST — it is the only proof Stripe reached the branded host
wrangler tail papercusp-cupboard --format json &

curl -sS -X POST "$BASE/commerce/checkout-sessions" \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"offerId":"papercusp-prepaid-byoc-credits-usd-10","buyerOrgId":"gh:<your-gh-id>"}'
```

A `201` returns the hosted Checkout URL. Open it and pay with test card
`4242 4242 4242 4242`, any future expiry, any CVC, any postcode.

⚠ Per-use offers never reach Stripe at all (they short-circuit in the
microcharge preflight), so only a **one-time or subscription** offer exercises
the real purchase path. Testing with a per-use offer proves nothing here.

### 5. Prove the chain landed

Four independent observations, all of which must hold:

```bash
# entitlement created
curl -s -H "Authorization: Bearer $TOK" "$BASE/commerce/entitlements?buyer=gh:<your-gh-id>"
# credit granted
curl -s -H "Authorization: Bearer $TOK" "$BASE/commerce/prepaid-credits/balance"
```

Recorded 2026-09-06 for `gh:279242982`:

| leg | evidence |
| --- | --- |
| Checkout opened | `POST /commerce/checkout-sessions` → `201`; session `cs_test_a1ejthSt4FuRcTgUzZsGdLRoOHVnGPgNFPa4MurC4LK5vWfjUDngroRY95` |
| Payment taken | session `status=complete`, `payment_status=paid`, `1000 usd`, `livemode=false`, `payment_intent pi_3UCi3GF4bhCZliK30iE6HYLd` |
| Webhook delivered + verified | `wrangler tail`: Stripe `POST https://cupboard.papercusp.com/commerce/webhooks/stripe` → `200`, valid `stripe-signature` (`t=1788708736`, UA `Stripe/1.0`), event `evt_1UCi3IF4bhCZliK3svvZATan` (`checkout.session.completed`) |
| Fulfilment | order `ord_389b6dc3cfbe7ec7db75b4b2fdd89545`; entitlement `ent:ord_389b6dc3cfbe7ec7db75b4b2fdd89545` `state=active`; balance `availableMicros=10000000` / `grantedMicros=10000000` ($10.00) |

A `201` on the checkout session alone proves nothing past step 4 — the webhook
and the entitlement are separate legs, and each has failed independently here.
Check all four.

## P-076 indexer (not yet wired)

Hourly cron in `wrangler.toml` is set up but the handler in `src/index.ts:scheduled` is intentionally a no-op stub. The indexer's job is to call GitHub's repo API for each listed harness and refresh `stars`, `contributor_count`, `last_activity_at`, `languages`. It's a small follow-up — landed separately to keep P-051a's PR diff focused on schema + auth + endpoints.

## Why D1 and not Postgres

- **Cost:** D1 free tier handles v1; Postgres on Neon/Supabase is also free but adds a region pin.
- **Latency:** D1 reads run inside the Worker — single-digit ms p50. PG over the network is 50-100ms even on the best path.
- **Migration ergonomics:** D1's `wrangler d1 execute --file` is the same shape as the publish-worker repo, so dev/prod symmetry is high.
- **Tradeoff:** D1's write throughput cap is ~1k inserts/sec per database. Cupboard publish + report volume is far below that (target: ≤10 publishes/day across the whole user base in v1). Re-evaluate if Cupboard becomes a hot surface — switching to PG-on-Neon is a one-week migration if it ever matters.
